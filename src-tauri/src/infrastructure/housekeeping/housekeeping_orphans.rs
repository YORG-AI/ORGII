//! Orphan-eviction helpers for [`super::housekeeping`].
//!
//! All functions are `pub(super)` — only the housekeeping orchestrator
//! (`run_deferred_cleanup`) calls them.

use std::fs;
use std::time::{Duration, SystemTime};

use app_paths as paths;
use core_types::session::CLI_SESSION_PREFIX;

/// An unreferenced image must stay untouched for at least this long. Producers
/// write the file before committing its durable owner, so immediate eviction
/// would race an active turn even with a complete reference index.
const SESSION_IMAGE_ORPHAN_GRACE: Duration = Duration::from_secs(24 * 60 * 60);

/// Fetch every session_id currently present in both the `agent_sessions`
/// table (Rust-native agents) and the `code_sessions` table (CLI agents).
///
/// Agent worktrees are created exclusively for CLI agent sessions
/// (`code_sessions`), so omitting that table would cause every active
/// CLI worktree to be classified as orphaned and evicted prematurely.
///
/// Used by the orphan sweep to decide whether a per-session directory
/// still has a live owner. Returns an empty set if neither table exists
/// (fresh install / DB migration in progress) — callers treat `Err` as
/// "skip sweep".
pub(super) fn list_known_session_ids() -> Result<std::collections::HashSet<String>, String> {
    let conn =
        session_persistence::get_connection().map_err(|err| format!("get_connection: {}", err))?;

    let mut known = std::collections::HashSet::new();

    // Rust-native agent sessions
    let mut stmt = conn
        .prepare("SELECT session_id FROM agent_sessions")
        .map_err(|err| format!("prepare agent_sessions: {}", err))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| format!("query_map agent_sessions: {}", err))?;
    for row in rows {
        match row {
            Ok(id) => {
                known.insert(id);
            }
            Err(err) => tracing::warn!("[housekeeping] agent_sessions row decode failed: {}", err),
        }
    }

    // CLI agent sessions — worktrees are only created for these
    let cli_table_exists: bool = conn
        .prepare("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='code_sessions'")
        .and_then(|mut s| s.query_row([], |row| row.get::<_, i64>(0)))
        .map(|n| n > 0)
        .unwrap_or(false);

    if cli_table_exists {
        let mut cli_stmt = conn
            .prepare("SELECT session_id FROM code_sessions")
            .map_err(|err| format!("prepare code_sessions: {}", err))?;
        let cli_rows = cli_stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|err| format!("query_map code_sessions: {}", err))?;
        for row in cli_rows {
            match row {
                Ok(id) => {
                    known.insert(id);
                }
                Err(err) => {
                    tracing::warn!("[housekeeping] code_sessions row decode failed: {}", err)
                }
            }
        }
    }

    Ok(known)
}

/// Evict every subdirectory of `root` whose name is a session_id that no
/// longer exists in `known_session_ids`. Files directly under `root`
/// (if any) are untouched.
pub(super) fn evict_orphan_session_dirs(
    root: std::path::PathBuf,
    known_session_ids: &std::collections::HashSet<String>,
) -> std::io::Result<usize> {
    if !root.exists() {
        return Ok(0);
    }

    let mut removed = 0;
    for entry in fs::read_dir(&root)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if known_session_ids.contains(name) {
            continue;
        }
        if let Err(err) = fs::remove_dir_all(&path) {
            tracing::warn!(
                "[housekeeping] failed to evict orphan session dir {}: {}",
                path.display(),
                err
            );
            continue;
        }
        removed += 1;
    }

    if removed > 0 {
        tracing::info!(
            "[housekeeping] evicted {} orphan session dir(s) under {}",
            removed,
            root.display()
        );
    }

    Ok(removed)
}

/// Evict hosted Claude Code per-session profile dirs (`cliagent-*`) whose
/// backing CLI session no longer exists. Account-scoped BYOK profile dirs are
/// intentionally retained.
pub(super) fn evict_orphan_cli_session_profiles(
    root: std::path::PathBuf,
    known_session_ids: &std::collections::HashSet<String>,
) -> std::io::Result<usize> {
    if !root.exists() {
        return Ok(0);
    }

    let mut removed = 0;
    for entry in fs::read_dir(&root)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.starts_with(CLI_SESSION_PREFIX) || known_session_ids.contains(name) {
            continue;
        }
        if let Err(err) = fs::remove_dir_all(&path) {
            tracing::warn!(
                "[housekeeping] failed to evict orphan CLI session profile {}: {}",
                path.display(),
                err
            );
            continue;
        }
        removed += 1;
    }

    if removed > 0 {
        tracing::info!(
            "[housekeeping] evicted {} orphan CLI session profile dir(s) under {}",
            removed,
            root.display()
        );
    }

    Ok(removed)
}

/// Evict hosted Kiro proxy HOME dirs keyed by CLI session id.
pub(super) fn evict_orphan_kiro_proxy_homes(
    known_session_ids: &std::collections::HashSet<String>,
) -> std::io::Result<usize> {
    evict_orphan_session_dirs(paths::kiro_proxy_home_root(), known_session_ids)
}

/// Walk `/tmp/orgii-{uid}/{workspace}/{session_id}/` and remove session temp
/// dirs whose session id no longer exists in the durable session tables.
pub(super) fn evict_orphan_scratchpads(
    known_session_ids: &std::collections::HashSet<String>,
) -> std::io::Result<usize> {
    let root = paths::orgii_temp_root();
    if !root.exists() {
        return Ok(0);
    }

    let mut removed = 0;
    for workspace_entry in fs::read_dir(&root)? {
        let workspace_entry = workspace_entry?;
        let workspace_path = workspace_entry.path();
        if !workspace_path.is_dir() {
            continue;
        }
        for session_entry in fs::read_dir(&workspace_path)? {
            let session_entry = session_entry?;
            let session_path = session_entry.path();
            if !session_path.is_dir() {
                continue;
            }
            let Some(name) = session_path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if known_session_ids.contains(name) {
                continue;
            }
            if let Err(err) = fs::remove_dir_all(&session_path) {
                tracing::warn!(
                    "[housekeeping] failed to evict orphan scratchpad {}: {}",
                    session_path.display(),
                    err
                );
                continue;
            }
            removed += 1;
        }
        if fs::read_dir(&workspace_path)?.next().is_none() {
            let _ = fs::remove_dir(&workspace_path);
        }
    }

    if removed > 0 {
        tracing::info!(
            "[housekeeping] evicted {} orphan scratchpad dir(s) under {}",
            removed,
            root.display()
        );
    }

    Ok(removed)
}

/// Walk `~/.orgii/agent-worktrees/<repo_hash>/<session_id>/` two levels
/// deep and remove every `session_id` directory whose id is not in
/// `known_session_ids`.
///
/// Unlike the flat `cursor-config/<sid>/` layout, worktrees are grouped
/// by repo hash one level above the session id, which is why we can't
/// reuse `evict_orphan_session_dirs` directly. Empty repo-hash parents
/// are *not* pruned because `git worktree` expects the directory to
/// survive across session lifetimes.
pub(super) fn evict_orphan_agent_worktrees(
    root: std::path::PathBuf,
    known_session_ids: &std::collections::HashSet<String>,
) -> std::io::Result<usize> {
    if !root.exists() {
        return Ok(0);
    }

    let mut removed = 0;
    for repo_entry in fs::read_dir(&root)? {
        let repo_entry = repo_entry?;
        let repo_path = repo_entry.path();
        if !repo_path.is_dir() {
            continue;
        }
        for sid_entry in fs::read_dir(&repo_path)? {
            let sid_entry = sid_entry?;
            let sid_path = sid_entry.path();
            if !sid_path.is_dir() {
                continue;
            }
            let Some(name) = sid_path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if known_session_ids.contains(name) {
                continue;
            }
            if let Err(err) = fs::remove_dir_all(&sid_path) {
                tracing::warn!(
                    "[housekeeping] failed to evict orphan worktree {}: {}",
                    sid_path.display(),
                    err
                );
                continue;
            }
            removed += 1;
        }
    }

    if removed > 0 {
        tracing::info!(
            "[housekeeping] evicted {} orphan agent-worktree dir(s) under {}",
            removed,
            root.display()
        );
    }

    Ok(removed)
}

/// Delete aged files under `~/.orgii/session-images/` whose `file_name()` is
/// absent from every durable image-reference source.
///
/// Image filenames are global content hashes, not session-owned files. The
/// sweep therefore considers Rust-agent messages and the CLI session image
/// registry together. It also retains pre-registry files conservatively
/// because an older native transcript may be their only owner.
///
/// Returns the number of files actually removed.
pub(super) fn evict_orphan_session_images() -> std::io::Result<usize> {
    let images_dir = paths::session_images_dir();
    if !images_dir.exists() {
        return Ok(0);
    }

    // Collect every image filename still referenced by a surviving message.
    let referenced = match live_session_image_filenames() {
        Ok(set) => set,
        Err(err) => {
            tracing::warn!(
                "[housekeeping] could not enumerate live image refs: {}; skipping",
                err
            );
            return Ok(0);
        }
    };
    let legacy_cutoff = match session_image_registry_cutoff() {
        Ok(cutoff) => cutoff,
        Err(err) => {
            tracing::warn!(
                "[housekeeping] could not read image-registry cutoff: {}; skipping",
                err
            );
            return Ok(0);
        }
    };

    let mut removed = 0;
    for entry in fs::read_dir(&images_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if referenced.contains(name) {
            continue;
        }
        let modified = match entry.metadata().and_then(|metadata| metadata.modified()) {
            Ok(modified) => modified,
            Err(err) => {
                tracing::warn!(
                    "[housekeeping] could not read session-image mtime {}: {}; retaining",
                    path.display(),
                    err
                );
                continue;
            }
        };
        if modified <= legacy_cutoff {
            continue;
        }
        if SystemTime::now()
            .duration_since(modified)
            .map_or(true, |age| age < SESSION_IMAGE_ORPHAN_GRACE)
        {
            continue;
        }
        if let Err(err) = fs::remove_file(&path) {
            tracing::warn!(
                "[housekeeping] failed to remove orphan session image {}: {}",
                path.display(),
                err
            );
            continue;
        }
        removed += 1;
    }

    if removed > 0 {
        tracing::info!(
            "[housekeeping] evicted {} orphan session-image file(s) under {}",
            removed,
            images_dir.display()
        );
    }

    Ok(removed)
}

/// Collect the `file_name()` of every path currently stored in a durable chat
/// image reference. We compare filenames rather than full paths because old
/// rows may be rooted at a previous install location; the content hash remains
/// stable across moves.
pub(super) fn live_session_image_filenames() -> Result<std::collections::HashSet<String>, String> {
    let conn =
        session_persistence::get_connection().map_err(|err| format!("get_connection: {}", err))?;
    let mut names = std::collections::HashSet::new();

    // Rust-native agent transcript owners.
    let mut stmt = conn
        .prepare("SELECT images FROM agent_messages WHERE images IS NOT NULL")
        .map_err(|err| format!("prepare agent message refs: {}", err))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| format!("query agent message refs: {}", err))?;
    for row in rows {
        let row = row.map_err(|err| format!("decode agent message ref row: {}", err))?;
        let image_paths = serde_json::from_str::<Vec<String>>(&row)
            .map_err(|err| format!("decode agent message image refs: {}", err))?;
        for p in image_paths {
            insert_image_filename(&mut names, &p);
        }
    }

    // Immediate provider-independent owners for every newly persisted CLI
    // attachment, including native-transcript sessions and in-flight turns.
    if table_exists(&conn, "code_session_image_refs")? {
        let mut stmt = conn
            .prepare("SELECT image_path FROM code_session_image_refs")
            .map_err(|err| format!("prepare CLI image registry: {}", err))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|err| format!("query CLI image registry: {}", err))?;
        for row in rows {
            let image_path = row.map_err(|err| format!("decode CLI image registry: {}", err))?;
            insert_image_filename(&mut names, &image_path);
        }
    }

    Ok(names)
}

fn insert_image_filename(names: &mut std::collections::HashSet<String>, image_path: &str) {
    if image_path.starts_with("data:") {
        return;
    }
    if let Some(name) = std::path::Path::new(image_path)
        .file_name()
        .and_then(|name| name.to_str())
    {
        names.insert(name.to_string());
    }
}

fn table_exists(conn: &rusqlite::Connection, table_name: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
         )",
        [table_name],
        |row| row.get(0),
    )
    .map_err(|err| format!("check table {table_name}: {err}"))
}

/// Timestamp when immediate CLI image ownership was introduced. Files older
/// than this may still belong to native transcripts written by prior builds,
/// so the orphan sweep keeps them rather than guessing destructively.
fn session_image_registry_cutoff() -> Result<SystemTime, String> {
    let conn =
        session_persistence::get_connection().map_err(|err| format!("get_connection: {}", err))?;
    if !table_exists(&conn, "_migrations")? {
        return Err("image registry migration table is absent".to_string());
    }
    let applied_at = match conn.query_row(
        "SELECT applied_at FROM _migrations WHERE name = 'code_session_image_refs_v1'",
        [],
        |row| row.get::<_, String>(0),
    ) {
        Ok(value) => value,
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            return Err("image registry migration marker is absent".to_string())
        }
        Err(err) => return Err(format!("read image registry migration: {err}")),
    };
    let parsed = chrono::DateTime::parse_from_rfc3339(&applied_at)
        .map_err(|err| format!("parse image registry migration timestamp: {err}"))?;
    Ok(SystemTime::from(parsed.to_utc()))
}

/// Delete `gateway_bindings` rows whose `target_session_id` is not in
/// `known_session_ids`.
///
/// # Memory-vs-DB tradeoff
///
/// [`BindingStore`] holds an in-memory cache keyed by `session_key`.
/// Housekeeping runs from `spawn_blocking` with no handle to the async
/// `AgentAppState` (and no `tokio::Runtime` context to acquire the
/// store's `RwLock`), so we delete straight from SQLite here.
///
/// This is **intentionally permitted** because:
/// 1. The row we evict points at a session already removed from
///    `agent_sessions` — `Tier-0` routing for it would fail anyway.
/// 2. If the in-memory cache still has the orphan entry, the next
///    inbound hit resolves to a missing target session → handler
///    falls back to Tier-1 LLM routing (graceful degradation, no
///    data corruption, no cross-session leak).
/// 3. [`BindingStore::load_from_db`] rehydrates from SQLite at every
///    gateway startup, so at worst the stale cache entry survives
///    until the next process restart.
///
/// [`BindingStore`]: agent_core::integrations::gateway::binding::BindingStore
/// [`BindingStore::load_from_db`]: agent_core::integrations::gateway::binding::BindingStore::load_from_db
pub(super) fn evict_orphan_gateway_bindings(
    known_session_ids: &std::collections::HashSet<String>,
) -> Result<usize, String> {
    let conn =
        session_persistence::get_connection().map_err(|err| format!("get_connection: {}", err))?;

    // Only consider the table present — first bootable gateway migration
    // creates it. When absent we simply report zero evictions.
    let has_table: bool = conn
        .prepare(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='gateway_bindings'",
        )
        .and_then(|mut stmt| stmt.query_row([], |row| row.get::<_, i64>(0)))
        .map(|n| n > 0)
        .unwrap_or(false);
    if !has_table {
        return Ok(0);
    }

    let mut stmt = conn
        .prepare("SELECT session_key, target_session_id FROM gateway_bindings")
        .map_err(|err| format!("prepare: {}", err))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| format!("query_map: {}", err))?;

    let orphans: Vec<String> = rows
        .flatten()
        .filter_map(|(key, target)| {
            if known_session_ids.contains(&target) {
                None
            } else {
                Some(key)
            }
        })
        .collect();

    for key in &orphans {
        if let Err(err) = conn.execute("DELETE FROM gateway_bindings WHERE session_key = ?1", [key])
        {
            tracing::warn!(
                "[housekeeping] failed to delete orphan gateway_binding {}: {}",
                key,
                err
            );
        }
    }

    if !orphans.is_empty() {
        tracing::info!(
            "[housekeeping] evicted {} orphan gateway_binding row(s)",
            orphans.len()
        );
    }

    Ok(orphans.len())
}
