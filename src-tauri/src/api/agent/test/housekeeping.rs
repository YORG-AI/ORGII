//! `/agent/test/housekeeping/*` endpoints (debug-only).
//!
//! These let the e2e binary exercise the deferred disk-cleanup pass
//! (`infrastructure::housekeeping::run_deferred_cleanup`) synchronously,
//! without waiting for the 10-minute startup delay. Seed endpoints plant
//! synthetic manifests / aged session dirs / orphan DB rows so the
//! cleanup path has something to chew on; the matching `-exists` query
//! endpoints let Rule-9 scenarios assert both the positive (evicted)
//! and negative (survived) branch directly against the DB.
//!
//! All handlers are `#[cfg(debug_assertions)]`-gated — not compiled into
//! release builds.

#![cfg(debug_assertions)]

use axum::Json;
use serde::Deserialize;

pub async fn test_housekeeping_run() -> Json<serde_json::Value> {
    // A JoinError here means the spawn_blocking worker panicked.
    // Defaulting to zero-stats would make the E2E test see
    // `ok: true` with all-zero counters — indistinguishable from
    // a genuinely already-clean system. Surface the panic via
    // `error` so the test runner can fail loudly.
    let stats = match tokio::task::spawn_blocking(
        crate::infrastructure::housekeeping::run_deferred_cleanup,
    )
    .await
    {
        Ok(s) => s,
        Err(err) => {
            tracing::warn!(
                error = %err,
                "test::housekeeping: run_deferred_cleanup task panicked"
            );
            return Json(serde_json::json!({
                "ok": false,
                "error": format!("housekeeping task panicked: {}", err),
            }));
        }
    };
    Json(serde_json::json!({
        "ok": true,
        "file_history_sessions_removed": stats.file_history.sessions_removed,
        "file_history_db_rows_removed": stats.file_history.db_rows_removed,
        "sessions_capped": stats.sessions_capped,
        "manifests_capped": stats.manifests_capped,
        "blobs_capped": stats.blobs_capped,
        "log_files_removed": stats.log_files_removed,
        "cursor_configs_evicted": stats.cursor_configs_evicted,
        "screenshots_removed": stats.screenshots_removed,
        "plans_removed": stats.plans_removed,
        "merkle_snapshots_removed": stats.merkle_snapshots_removed,
        "agent_worktrees_evicted": stats.agent_worktrees_evicted,
        "session_images_evicted": stats.session_images_evicted,
        "gateway_bindings_evicted": stats.gateway_bindings_evicted,
        "session_cache_rows_evicted": stats.session_cache_rows_evicted,
    }))
}

#[derive(Debug, Deserialize)]
pub struct SeedSnapshotsRequest {
    session_id: String,
    count: usize,
}

pub async fn test_housekeeping_seed_snapshots(
    Json(request): Json<SeedSnapshotsRequest>,
) -> Json<serde_json::Value> {
    let session_id = request.session_id.clone();
    let count = request.count;
    // Stagger offsets so the first seed is the oldest and
    // `get_oldest_snapshot_ids` returns a deterministic order.
    let offsets: Vec<i64> = (0..count).map(|i| i as i64).collect();
    let result = tokio::task::spawn_blocking(move || {
        agent_core::tools::file_history::debug_seed_manifests(&session_id, count, &offsets)
    })
    .await;
    match result {
        Ok(Ok(ids)) => Json(serde_json::json!({
            "ok": true,
            "seeded": ids.len(),
            "session_id": request.session_id,
        })),
        Ok(Err(err)) => Json(serde_json::json!({ "error": err.to_string() })),
        Err(join) => Json(serde_json::json!({ "error": join.to_string() })),
    }
}

#[derive(Debug, Deserialize)]
pub struct SeedAgedRequest {
    session_id: String,
    age_days: u64,
}

pub async fn test_housekeeping_seed_aged(
    Json(request): Json<SeedAgedRequest>,
) -> Json<serde_json::Value> {
    let session_id = request.session_id.clone();
    let age_days = request.age_days;
    let result = tokio::task::spawn_blocking(move || {
        agent_core::tools::file_history::debug_seed_aged_session(&session_id, age_days)
    })
    .await;
    match result {
        Ok(Ok(path)) => Json(serde_json::json!({
            "ok": true,
            "session_id": request.session_id,
            "path": path.display().to_string(),
        })),
        Ok(Err(err)) => Json(serde_json::json!({ "error": err.to_string() })),
        Err(join) => Json(serde_json::json!({ "error": join.to_string() })),
    }
}

#[derive(Debug, Deserialize)]
pub struct SeedSessionDirRequest {
    /// Must be `"cursor-config"`; other values are rejected so we don't
    /// accidentally seed into an unrelated root.
    root: String,
    /// Directory name under the root. For orphan tests this is a fresh uuid
    /// that is NOT inserted into `agent_sessions`; for the negative branch,
    /// the caller sets `insert_session_row=true` so the sweep leaves it alone.
    session_id: String,
    /// If true, inserts a matching row in `agent_sessions` so the orphan
    /// sweep treats this dir as live and preserves it.
    #[serde(default)]
    insert_session_row: bool,
}

/// Seed a `~/.orgii/<root>/<session_id>/` subdirectory for
/// `housekeeping-cursor-config-orphan-evict`. When
/// `insert_session_row=false`, the dir is an orphan and the sweep should
/// delete it; when `true`, the dir has a live owner and must survive.
pub async fn test_housekeeping_seed_session_dir(
    Json(request): Json<SeedSessionDirRequest>,
) -> Json<serde_json::Value> {
    let result = tokio::task::spawn_blocking(move || -> Result<std::path::PathBuf, String> {
        let root = match request.root.as_str() {
            "cursor-config" => app_paths::cursor_config_root(),
            other => return Err(format!("invalid root {:?}: expected cursor-config", other)),
        };
        let dir = root.join(&request.session_id);
        std::fs::create_dir_all(&dir).map_err(|err| format!("create_dir_all: {}", err))?;
        std::fs::write(dir.join("marker"), b"debug-orphan")
            .map_err(|err| format!("marker write: {}", err))?;

        if request.insert_session_row {
            // Schema lives in
            // `agent_core/foundation/persistence/session_snapshots.rs`:
            // session_id + created_at + updated_at are the only mandatory
            // columns; everything else has a default. `list_known_session_ids`
            // only reads `session_id` so a minimal row suffices.
            let conn = session_persistence::get_connection()
                .map_err(|err| format!("get_connection: {}", err))?;
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT OR IGNORE INTO agent_sessions (session_id, created_at, updated_at)
                 VALUES (?1, ?2, ?2)",
                rusqlite::params![request.session_id, now],
            )
            .map_err(|err| format!("DB insert: {}", err))?;
        }
        Ok(dir)
    })
    .await;
    match result {
        Ok(Ok(path)) => Json(serde_json::json!({
            "ok": true,
            "path": path.display().to_string(),
        })),
        Ok(Err(err)) => Json(serde_json::json!({ "error": err })),
        Err(join) => Json(serde_json::json!({ "error": join.to_string() })),
    }
}

#[derive(Debug, Deserialize)]
pub struct SeedAgedFileRequest {
    /// Which known `~/.orgii/` subdir to seed into. Accepts `"screenshots"` or
    /// `"merkle"` — a flat TTL sweep directory.
    root: String,
    /// File name under the root (caller should use a uuid prefix so re-runs
    /// don't clash).
    name: String,
    /// Backdate the mtime by this many days. `0` = fresh.
    age_days: u64,
}

/// Seed a single flat TTL file under `screenshots/` or `merkle/` with a
/// controlled mtime. Used by `housekeeping-screenshots-ttl` and
/// `housekeeping-merkle-ttl` scenarios.
pub async fn test_housekeeping_seed_aged_file(
    Json(request): Json<SeedAgedFileRequest>,
) -> Json<serde_json::Value> {
    let result = tokio::task::spawn_blocking(move || -> Result<std::path::PathBuf, String> {
        let dir = match request.root.as_str() {
            "screenshots" => app_paths::screenshots_dir(),
            "merkle" => app_paths::merkle_root(),
            other => {
                return Err(format!(
                    "invalid root {:?}: expected screenshots or merkle",
                    other
                ))
            }
        };
        std::fs::create_dir_all(&dir).map_err(|err| format!("create_dir_all: {}", err))?;
        let path = dir.join(&request.name);
        std::fs::write(&path, b"debug-aged-file").map_err(|err| format!("write: {}", err))?;
        if request.age_days > 0 {
            let target = std::time::SystemTime::now()
                .checked_sub(std::time::Duration::from_secs(
                    request.age_days.saturating_mul(86_400),
                ))
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            let handle = std::fs::File::options()
                .read(true)
                .write(true)
                .open(&path)
                .map_err(|err| format!("open: {}", err))?;
            handle
                .set_modified(target)
                .map_err(|err| format!("set_modified: {}", err))?;
        }
        Ok(path)
    })
    .await;
    match result {
        Ok(Ok(path)) => Json(serde_json::json!({
            "ok": true,
            "path": path.display().to_string(),
        })),
        Ok(Err(err)) => Json(serde_json::json!({ "error": err })),
        Err(join) => Json(serde_json::json!({ "error": join.to_string() })),
    }
}

#[derive(Debug, Deserialize)]
pub struct SeedPlanFileRequest {
    /// Agent-id subdir under `~/.orgii/plans/`. Mirrors the real layout
    /// (`plans/<agent_id>/*.plan.md`).
    agent_subdir: String,
    /// File name inside that subdir.
    name: String,
    /// Backdate the mtime by this many days. `0` = fresh.
    age_days: u64,
}

/// Seed a file under `~/.orgii/plans/<agent_subdir>/<name>` with a
/// controlled mtime. Tests `prune_old_files_recursive` — both the file
/// eviction and the empty-dir cleanup.
pub async fn test_housekeeping_seed_plan_file(
    Json(request): Json<SeedPlanFileRequest>,
) -> Json<serde_json::Value> {
    let result = tokio::task::spawn_blocking(move || -> Result<std::path::PathBuf, String> {
        let dir = app_paths::orgii_root()
            .join("plans")
            .join(&request.agent_subdir);
        std::fs::create_dir_all(&dir).map_err(|err| format!("create_dir_all: {}", err))?;
        let path = dir.join(&request.name);
        std::fs::write(&path, b"# debug plan").map_err(|err| format!("write: {}", err))?;
        if request.age_days > 0 {
            let target = std::time::SystemTime::now()
                .checked_sub(std::time::Duration::from_secs(
                    request.age_days.saturating_mul(86_400),
                ))
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            let handle = std::fs::File::options()
                .read(true)
                .write(true)
                .open(&path)
                .map_err(|err| format!("open: {}", err))?;
            handle
                .set_modified(target)
                .map_err(|err| format!("set_modified: {}", err))?;
        }
        Ok(path)
    })
    .await;
    match result {
        Ok(Ok(path)) => Json(serde_json::json!({
            "ok": true,
            "path": path.display().to_string(),
        })),
        Ok(Err(err)) => Json(serde_json::json!({ "error": err })),
        Err(join) => Json(serde_json::json!({ "error": join.to_string() })),
    }
}

#[derive(Debug, Deserialize)]
pub struct SeedWorktreeDirRequest {
    /// Hash-shaped directory name at the first level under
    /// `agent-worktrees/<repo_hash>/`. Any stable string works; the sweep
    /// keys purely off the session_id level.
    repo_hash: String,
    /// Session id subdir at the second level.
    session_id: String,
    /// If true, insert a matching `agent_sessions` row so the sweep treats
    /// this worktree as live (negative branch).
    #[serde(default)]
    insert_session_row: bool,
}

/// Seed a `~/.orgii/agent-worktrees/<repo_hash>/<session_id>/` subdirectory
/// for the `housekeeping-agent-worktrees-orphan-evict` scenario.
pub async fn test_housekeeping_seed_worktree_dir(
    Json(request): Json<SeedWorktreeDirRequest>,
) -> Json<serde_json::Value> {
    let result = tokio::task::spawn_blocking(move || -> Result<std::path::PathBuf, String> {
        let dir = app_paths::agent_worktrees_root()
            .join(&request.repo_hash)
            .join(&request.session_id);
        std::fs::create_dir_all(&dir).map_err(|err| format!("create_dir_all: {}", err))?;
        std::fs::write(dir.join("marker"), b"debug-worktree")
            .map_err(|err| format!("marker write: {}", err))?;

        if request.insert_session_row {
            agent_core::foundation::persistence::session_snapshots::ensure_tables()
                .map_err(|err| format!("ensure_tables: {}", err))?;
            let conn = session_persistence::get_connection()
                .map_err(|err| format!("get_connection: {}", err))?;
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT OR IGNORE INTO agent_sessions (session_id, created_at, updated_at)
                 VALUES (?1, ?2, ?2)",
                rusqlite::params![request.session_id, now],
            )
            .map_err(|err| format!("DB insert: {}", err))?;
        }
        Ok(dir)
    })
    .await;
    match result {
        Ok(Ok(path)) => Json(serde_json::json!({
            "ok": true,
            "path": path.display().to_string(),
        })),
        Ok(Err(err)) => Json(serde_json::json!({ "error": err })),
        Err(join) => Json(serde_json::json!({ "error": join.to_string() })),
    }
}

#[derive(Debug, Deserialize)]
pub struct SeedSessionImageRequest {
    /// File name under `~/.orgii/session-images/`.
    name: String,
    /// If true, insert a matching `agent_messages.images` row referencing
    /// this filename so the sweep treats it as live.
    #[serde(default)]
    reference_in_message: bool,
}

/// Seed a file under `~/.orgii/session-images/`, optionally inserting a
/// live reference in `agent_messages.images`. Used by
/// `housekeeping-session-images-orphan-evict`.
pub async fn test_housekeeping_seed_session_image(
    Json(request): Json<SeedSessionImageRequest>,
) -> Json<serde_json::Value> {
    let result = tokio::task::spawn_blocking(move || -> Result<std::path::PathBuf, String> {
        let dir = app_paths::session_images_dir();
        std::fs::create_dir_all(&dir).map_err(|err| format!("create_dir_all: {}", err))?;
        let path = dir.join(&request.name);
        std::fs::write(&path, b"debug-image").map_err(|err| format!("write: {}", err))?;

        if request.reference_in_message {
            // Make sure the schema (incl. the `images` migration column) is
            // in place before we insert. `ensure_tables()` is idempotent.
            agent_core::foundation::persistence::session_snapshots::ensure_tables()
                .map_err(|err| format!("ensure_tables: {}", err))?;

            let conn = session_persistence::get_connection()
                .map_err(|err| format!("get_connection: {}", err))?;
            let sid = format!("e2e-img-{}", uuid::Uuid::new_v4());
            let mid = uuid::Uuid::new_v4().to_string();
            let now = chrono::Utc::now().to_rfc3339();
            // Serializing a `Vec<String>` is infallible (Rule 41).
            // A failure here would be a logic bug — surface it via
            // `expect` instead of silently inserting an empty
            // images_json that would later look like "no image
            // attached" in the cleanup target.
            let images_json = serde_json::to_string(&vec![path.display().to_string()])
                .expect("test::housekeeping: Vec<String> must serialize");
            conn.execute(
                "INSERT OR IGNORE INTO agent_sessions (session_id, created_at, updated_at)
                 VALUES (?1, ?2, ?2)",
                rusqlite::params![sid, now],
            )
            .map_err(|err| format!("sessions insert: {}", err))?;
            conn.execute(
                "INSERT INTO agent_messages
                    (id, session_id, role, content, images, sequence, created_at)
                 VALUES (?1, ?2, 'user', '', ?3, 0, ?4)",
                rusqlite::params![mid, sid, images_json, now],
            )
            .map_err(|err| format!("messages insert: {}", err))?;
        }
        Ok(path)
    })
    .await;
    match result {
        Ok(Ok(path)) => Json(serde_json::json!({
            "ok": true,
            "path": path.display().to_string(),
            "filename": path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string(),
        })),
        Ok(Err(err)) => Json(serde_json::json!({ "error": err })),
        Err(join) => Json(serde_json::json!({ "error": join.to_string() })),
    }
}

#[derive(Debug, Deserialize)]
pub struct SeedGatewayBindingRequest {
    session_key: String,
    target_session_id: String,
    /// If true, insert a matching `agent_sessions` row so the sweep treats
    /// the binding target as live (negative branch).
    #[serde(default)]
    insert_session_row: bool,
}

/// Seed a `gateway_bindings` row. When `insert_session_row=false`, the
/// target session is missing from `agent_sessions` and the binding
/// becomes an orphan. Used by `housekeeping-gateway-bindings-orphan-evict`.
pub async fn test_housekeeping_seed_gateway_binding(
    Json(request): Json<SeedGatewayBindingRequest>,
) -> Json<serde_json::Value> {
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        agent_core::foundation::persistence::session_snapshots::ensure_tables()
            .map_err(|err| format!("ensure_tables: {}", err))?;
        let conn = session_persistence::get_connection()
            .map_err(|err| format!("get_connection: {}", err))?;

        // Ensure the table exists — the housekeeping sweep tolerates its
        // absence by returning 0, but a seed endpoint must create it.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS gateway_bindings (
                session_key        TEXT PRIMARY KEY,
                target_session_id  TEXT NOT NULL,
                updated_at         TEXT NOT NULL
            )",
            [],
        )
        .map_err(|err| format!("create table: {}", err))?;
        let _ = conn.execute(
            "ALTER TABLE gateway_bindings ADD COLUMN last_activity_at TEXT",
            [],
        );

        let now = chrono::Utc::now().to_rfc3339();
        if request.insert_session_row {
            conn.execute(
                "INSERT OR IGNORE INTO agent_sessions (session_id, created_at, updated_at)
                 VALUES (?1, ?2, ?2)",
                rusqlite::params![request.target_session_id, now],
            )
            .map_err(|err| format!("sessions insert: {}", err))?;
        }
        conn.execute(
            "INSERT OR REPLACE INTO gateway_bindings (session_key, target_session_id, updated_at, last_activity_at)
             VALUES (?1, ?2, ?3, ?3)",
            rusqlite::params![request.session_key, request.target_session_id, now],
        )
        .map_err(|err| format!("binding insert: {}", err))?;
        Ok(())
    })
    .await;
    match result {
        Ok(Ok(())) => Json(serde_json::json!({ "ok": true })),
        Ok(Err(err)) => Json(serde_json::json!({ "error": err })),
        Err(join) => Json(serde_json::json!({ "error": join.to_string() })),
    }
}

#[derive(Debug, Deserialize)]
pub struct SeedSessionCacheRequest {
    session_id: String,
    /// Backdate the session's `cached_at` by this many days. `0` = fresh.
    /// The TTL sweep (`clear_old_sessions`) keys off `cached_at`.
    age_days: u64,
}

/// Seed a row in the `sessions` cache table with a controlled `cached_at`.
/// Used by `housekeeping-session-cache-ttl`.
pub async fn test_housekeeping_seed_session_cache(
    Json(request): Json<SeedSessionCacheRequest>,
) -> Json<serde_json::Value> {
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let conn = session_persistence::get_connection()
            .map_err(|err| format!("get_connection: {}", err))?;

        // Ensure the cache table exists (real init path lives in
        // `session_persistence::schema`; defensive create covers the
        // case where no session-list call has fired yet in this boot).
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                event_count INTEGER NOT NULL DEFAULT 0,
                cached_at INTEGER NOT NULL,
                time_range_start TEXT,
                time_range_end TEXT,
                specs_json TEXT
            )",
            [],
        )
        .map_err(|err| format!("create sessions: {}", err))?;

        // `cached_at` is stored as epoch seconds (i64).
        let now = chrono::Utc::now().timestamp();
        let cached_at = now.saturating_sub((request.age_days as i64).saturating_mul(86_400));
        conn.execute(
            "INSERT OR REPLACE INTO sessions
                (session_id, event_count, cached_at, time_range_start, time_range_end, specs_json)
             VALUES (?1, 0, ?2, NULL, NULL, NULL)",
            rusqlite::params![request.session_id, cached_at],
        )
        .map_err(|err| format!("sessions insert: {}", err))?;
        Ok(())
    })
    .await;
    match result {
        Ok(Ok(())) => Json(serde_json::json!({ "ok": true })),
        Ok(Err(err)) => Json(serde_json::json!({ "error": err })),
        Err(join) => Json(serde_json::json!({ "error": join.to_string() })),
    }
}

#[derive(Debug, Deserialize)]
pub struct SessionCacheExistsQuery {
    session_id: String,
}

/// Return `{exists: bool}` for a `sessions` cache row. Used by
/// `housekeeping-session-cache-ttl` to confirm the aged row was evicted
/// while the fresh row survived.
pub async fn test_housekeeping_session_cache_exists(
    axum::extract::Query(q): axum::extract::Query<SessionCacheExistsQuery>,
) -> Json<serde_json::Value> {
    let result = tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let conn = session_persistence::get_connection()
            .map_err(|err| format!("get_connection: {}", err))?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE session_id = ?1",
                rusqlite::params![q.session_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        Ok(count > 0)
    })
    .await;
    match result {
        Ok(Ok(exists)) => Json(serde_json::json!({ "exists": exists })),
        Ok(Err(err)) => Json(serde_json::json!({ "error": err })),
        Err(join) => Json(serde_json::json!({ "error": join.to_string() })),
    }
}

#[derive(Debug, Deserialize)]
pub struct GatewayBindingExistsQuery {
    session_key: String,
}

/// Return `{exists: bool}` for a `gateway_bindings` row. Used by
/// `housekeeping-gateway-bindings-orphan-evict` to confirm the orphan
/// binding was dropped while the live one survived.
pub async fn test_housekeeping_gateway_binding_exists(
    axum::extract::Query(q): axum::extract::Query<GatewayBindingExistsQuery>,
) -> Json<serde_json::Value> {
    let result = tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let conn = session_persistence::get_connection()
            .map_err(|err| format!("get_connection: {}", err))?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM gateway_bindings WHERE session_key = ?1",
                rusqlite::params![q.session_key],
                |row| row.get(0),
            )
            .unwrap_or(0);
        Ok(count > 0)
    })
    .await;
    match result {
        Ok(Ok(exists)) => Json(serde_json::json!({ "exists": exists })),
        Ok(Err(err)) => Json(serde_json::json!({ "error": err })),
        Err(join) => Json(serde_json::json!({ "error": join.to_string() })),
    }
}
pub async fn test_housekeeping_snapshot_count(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let Some(session_id) = params.get("session_id").cloned() else {
        return Json(serde_json::json!({ "error": "missing session_id" }));
    };
    let sid_for_task = session_id.clone();
    let count = tokio::task::spawn_blocking(move || {
        agent_core::persistence::session_snapshots::count_snapshots_for_session(&sid_for_task)
    })
    .await;
    match count {
        Ok(Ok(n)) => Json(serde_json::json!({
            "ok": true,
            "session_id": session_id,
            "count": n,
        })),
        Ok(Err(err)) => Json(serde_json::json!({ "error": err.to_string() })),
        Err(join) => Json(serde_json::json!({ "error": join.to_string() })),
    }
}
