//! Managed-session mirror detection shared by the imported-history readers.
//!
//! A GUI-launched ("managed") CLI session and its imported transcript are the
//! same conversation seen twice: the managed `code_sessions` row is the UI
//! identity (live status, worktree, proxy, drafts), so the imported twin is
//! marked `listable = false`. Recognition unions two id sets:
//!
//! - `code_sessions.cli_session_id` — the current binding (overwritten on
//!   account switch, cleared on message edit), and
//! - `code_session_native_transcript_ids.source_session_id` — the append-only
//!   ledger, so superseded forks stay hidden forever.
//!
//! Both tables are owned by the desktop app; a bare cache DB (tests, CLI use
//! of orgtrack-core) simply yields an empty set.

use std::collections::HashSet;

use rusqlite::Connection;

use super::client_origin::ImportedClientOrigin;

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [name],
        |_| Ok(()),
    )
    .is_ok()
}

/// Native CLI session ids belonging to managed sessions of `cli_agent_type`
/// (a `code_sessions.cli_agent_type` value) / `source` (the imported-history
/// source id, used against the binding ledger).
pub fn managed_source_session_ids_from_conn(
    conn: &Connection,
    cli_agent_type: &str,
    source: &str,
) -> Result<HashSet<String>, String> {
    let mut ids = HashSet::new();

    if table_exists(conn, "code_sessions") {
        let mut stmt = conn
            .prepare(
                "SELECT cli_session_id FROM code_sessions
                 WHERE cli_agent_type = ?1
                   AND cli_session_id IS NOT NULL AND cli_session_id != ''",
            )
            .map_err(|err| format!("Failed to prepare managed session query: {err}"))?;
        let rows = stmt
            .query_map([cli_agent_type], |row| row.get::<_, String>(0))
            .map_err(|err| format!("Failed to query managed sessions: {err}"))?;
        for row in rows {
            let id = row
                .map_err(|err| format!("Failed to read managed session row: {err}"))?
                .trim()
                .to_string();
            if !id.is_empty() {
                ids.insert(id);
            }
        }
    }

    if table_exists(conn, "code_session_native_transcript_ids") {
        let mut stmt = conn
            .prepare(
                "SELECT source_session_id FROM code_session_native_transcript_ids
                 WHERE source = ?1",
            )
            .map_err(|err| format!("Failed to prepare native transcript-id query: {err}"))?;
        let rows = stmt
            .query_map([source], |row| row.get::<_, String>(0))
            .map_err(|err| format!("Failed to query native transcript ids: {err}"))?;
        for row in rows {
            let id = row
                .map_err(|err| format!("Failed to read native transcript-id row: {err}"))?
                .trim()
                .to_string();
            if !id.is_empty() {
                ids.insert(id);
            }
        }
    }

    Ok(ids)
}

/// Whether an imported record belongs to a managed session.
///
/// Exact match covers sources whose imported key IS the CLI-native id
/// (Claude uuid, OpenCode `ses_*`). Codex imports key on the rollout file
/// stem (`rollout-<timestamp>-<thread-uuid>`) while the runner binds the
/// bare thread uuid — matched here by a `-`-bounded suffix so an unrelated
/// id can never partially collide.
pub fn is_managed_source_session_id(
    managed_ids: &HashSet<String>,
    source_session_id: &str,
) -> bool {
    if managed_ids.contains(source_session_id) {
        return true;
    }
    managed_ids.iter().any(|id| {
        source_session_id.len() > id.len() + 1
            && source_session_id.ends_with(id.as_str())
            && source_session_id.as_bytes()[source_session_id.len() - id.len() - 1] == b'-'
    })
}

/// Whether an imported transcript is only the native-provider mirror of a
/// session ORGII already owns.
///
/// The binding ledger is the strongest signal, but it cannot be the only
/// signal: an isolated test home, a moved profile, or a rebuilt local DB can
/// leave an ORGII-authored transcript in the provider's real native store
/// after the ledger row is gone. Both Codex (`originator`) and Claude
/// (`entrypoint` / managed profile path) persist ORGII provenance in the
/// transcript itself, so that provenance is the durable fallback.
pub fn is_managed_history_mirror(
    managed_ids: &HashSet<String>,
    source_session_id: &str,
    client_origin: Option<ImportedClientOrigin>,
) -> bool {
    is_managed_source_session_id(managed_ids, source_session_id)
        || client_origin == Some(ImportedClientOrigin::Org2)
}

/// Repair already-cached ORGII mirrors without requiring their native file to
/// change and trigger a reparse. New parses are hidden by
/// [`is_managed_history_mirror`]; this closes the same invariant for cache rows
/// written by an older build or by a process whose binding ledger disappeared.
pub fn demote_org2_origin_mirrors_from_conn(
    conn: &Connection,
    source: &str,
) -> Result<usize, String> {
    conn.execute(
        "UPDATE imported_history_session_cache
         SET listable = 0
         WHERE source = ?1 AND client_origin = 'org2' AND listable != 0",
        [source],
    )
    .map_err(|err| format!("Failed to demote ORGII history mirrors: {err}"))
}

/// Fold the managed verdict into a discovery fingerprint so a session that
/// becomes managed (or stops being) re-parses on the next scan and its
/// `listable` flag flips.
pub fn append_managed_fingerprint(fingerprint: &mut String, is_managed: bool) {
    fingerprint.push_str(if is_managed {
        "|managed=1"
    } else {
        "|managed=0"
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_db_yields_empty_set() {
        let conn = Connection::open_in_memory().expect("open");
        let ids = managed_source_session_ids_from_conn(&conn, "claude_code", "claude_code")
            .expect("query");
        assert!(ids.is_empty());
    }

    #[test]
    fn stem_suffix_matches_managed_id_with_boundary() {
        let ids = HashSet::from(["019f6e88-3bc8-77b3".to_string()]);
        // Exact and rollout-stem forms match.
        assert!(is_managed_source_session_id(&ids, "019f6e88-3bc8-77b3"));
        assert!(is_managed_source_session_id(
            &ids,
            "rollout-2026-07-17T13-24-09-019f6e88-3bc8-77b3"
        ));
        // No '-' boundary or partial overlap must NOT match.
        assert!(!is_managed_source_session_id(&ids, "xx019f6e88-3bc8-77b3"));
        assert!(!is_managed_source_session_id(&ids, "019f6e88"));
        assert!(!is_managed_source_session_id(&HashSet::new(), "anything"));
    }

    #[test]
    fn org2_provenance_survives_a_missing_binding_ledger() {
        let no_ids = HashSet::new();
        assert!(is_managed_history_mirror(
            &no_ids,
            "native-id-from-an-isolated-run",
            Some(ImportedClientOrigin::Org2),
        ));
        assert!(!is_managed_history_mirror(
            &no_ids,
            "ordinary-cli-session",
            Some(ImportedClientOrigin::Cli),
        ));
        assert!(!is_managed_history_mirror(
            &no_ids,
            "unknown-origin-session",
            None,
        ));
    }

    #[test]
    fn repairs_cached_org2_mirror_without_hiding_other_clients() {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch(
            "CREATE TABLE imported_history_session_cache (
                 source TEXT NOT NULL,
                 source_session_id TEXT NOT NULL,
                 client_origin TEXT NOT NULL,
                 listable INTEGER NOT NULL
             );
             INSERT INTO imported_history_session_cache VALUES
                 ('claude_code', 'org2-copy', 'org2', 1),
                 ('claude_code', 'terminal-session', 'cli', 1),
                 ('codex_app', 'other-source', 'org2', 1);",
        )
        .expect("seed");

        assert_eq!(
            demote_org2_origin_mirrors_from_conn(&conn, "claude_code").expect("demote"),
            1
        );
        let rows = conn
            .prepare(
                "SELECT source_session_id, listable
                 FROM imported_history_session_cache ORDER BY source_session_id",
            )
            .expect("prepare")
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .expect("query")
            .collect::<Result<Vec<_>, _>>()
            .expect("rows");
        assert_eq!(
            rows,
            vec![
                ("org2-copy".to_string(), 0),
                ("other-source".to_string(), 1),
                ("terminal-session".to_string(), 1),
            ]
        );
    }

    #[test]
    fn unions_current_binding_and_ledger() {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch(
            "CREATE TABLE code_sessions (
                 session_id TEXT PRIMARY KEY,
                 cli_agent_type TEXT,
                 cli_session_id TEXT
             );
             CREATE TABLE code_session_native_transcript_ids (
                 session_id TEXT, source TEXT, source_session_id TEXT, bound_at TEXT
             );
             INSERT INTO code_sessions VALUES ('m1', 'claude_code', 'live-id');
             INSERT INTO code_sessions VALUES ('m2', 'codex', 'other-agent-id');
             INSERT INTO code_session_native_transcript_ids
                 VALUES ('m1', 'claude_code', 'old-fork-id', '2026-07-17T00:00:00Z');
             INSERT INTO code_session_native_transcript_ids
                 VALUES ('m2', 'codex_app', 'codex-id', '2026-07-17T00:00:00Z');",
        )
        .expect("seed");
        let ids = managed_source_session_ids_from_conn(&conn, "claude_code", "claude_code")
            .expect("query");
        assert_eq!(
            ids,
            HashSet::from(["live-id".to_string(), "old-fork-id".to_string()])
        );
    }
}
