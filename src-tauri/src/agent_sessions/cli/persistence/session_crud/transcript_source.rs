//! Where a session's transcript of record lives: the frozen
//! `transcript_source` gate and the append-only native-transcript id ledger.

use rusqlite::{params, OptionalExtension, Result as SqliteResult};

use database::db::get_connection;

use crate::agent_sessions::cli::native_transcript;

/// Whether this session persists transcript chunks to `code_session_chunks`
/// (legacy mode) or relies on the CLI's native store (`transcript_source =
/// 'native'`). The column is frozen at creation, so the answer is memoized
/// process-wide — chunk gates on the hot streaming path never re-query.
pub fn session_persists_chunks(session_id: &str) -> bool {
    use std::collections::HashMap;
    use std::sync::{OnceLock, RwLock};
    static CACHE: OnceLock<RwLock<HashMap<String, bool>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| RwLock::new(HashMap::new()));
    if let Some(&persists) = cache
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(session_id)
    {
        return persists;
    }
    let source: Option<String> = (|| -> SqliteResult<Option<String>> {
        let conn = get_connection()?;
        conn.query_row(
            "SELECT COALESCE(transcript_source, 'chunks') FROM code_sessions WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )
        .optional()
    })()
    // Fail toward persisting: losing a transcript is worse than a redundant
    // chunk row for a native session.
    .unwrap_or(None);
    let Some(source) = source else {
        // Row not visible yet (or DB error): persist, but don't memoize a
        // guess — the next call after creation sees the real value.
        return true;
    };
    let persists = source != native_transcript::TRANSCRIPT_SOURCE_NATIVE;
    cache
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(session_id.to_string(), persists);
    persists
}

/// Latest native transcript id bound to this managed session for `source`
/// (account switches / message-edit forks append; replay follows the newest).
pub fn latest_native_transcript_id(session_id: &str, source: &str) -> SqliteResult<Option<String>> {
    let conn = get_connection()?;
    conn.query_row(
        "SELECT source_session_id
         FROM code_session_native_transcript_ids
         WHERE session_id = ?1 AND source = ?2
         ORDER BY bound_at DESC
         LIMIT 1",
        params![session_id, source],
        |row| row.get(0),
    )
    .optional()
}

/// Every native transcript id ever bound to this managed session, newest
/// first. Replay walks this list until it finds a fork whose store is
/// actually readable — the newest binding can point at a file the CLI never
/// flushed (killed right after the resume rotation).
pub fn native_transcript_ids_newest_first(
    session_id: &str,
    source: &str,
) -> SqliteResult<Vec<String>> {
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT source_session_id
         FROM code_session_native_transcript_ids
         WHERE session_id = ?1 AND source = ?2
         ORDER BY bound_at DESC",
    )?;
    let rows = stmt.query_map(params![session_id, source], |row| row.get(0))?;
    rows.collect()
}
