//! Full-text **content** search over session transcripts, backed by SQLite
//! FTS5. `search --content` matches inside the conversation (messages, tool
//! commands, tool output), not just titles/paths.
//!
//! Designed to stay RAM/CPU-light:
//! - **Incremental** — an `orgtrack_fts_state` table records the fingerprint
//!   each session was indexed at; only sessions whose `source_fingerprint`
//!   changed are re-parsed. The first index is the only expensive pass.
//! - **Streaming** — one session's chunks are loaded, flattened to text,
//!   inserted, and dropped before the next; never more than one transcript in
//!   memory at a time.
//! - **Bounded body** — each session contributes at most [`MAX_BODY_CHARS`] of
//!   text, so a pathological megatranscript can't blow up RAM or the index.
//! - **Disk-backed queries** — FTS5 `MATCH` is an index scan; `snippet()` is
//!   computed only for the `LIMIT`-ed rows actually returned.
//! - **Batched writes** — re-indexing commits in transactions of
//!   [`BATCH`] sessions.

use core_types::activity::ActivityChunk;
use rusqlite::{params, Connection};

use crate::plugin_exec::load_session_chunks;
use crate::plugins::LoaderPlugin;
use crate::scan::target_source_ids;
use crate::Options;

/// Max characters of transcript text indexed per session.
const MAX_BODY_CHARS: usize = 256 * 1024;
/// Sessions re-indexed per write transaction.
const BATCH: usize = 64;

/// One full-text hit: a session plus a highlighted snippet around the match.
pub(crate) struct ContentHit {
    pub(crate) session_id: String,
    pub(crate) source: String,
    pub(crate) name: String,
    pub(crate) snippet: String,
}

/// Create the FTS5 table + the incremental-state table. Errors clearly if the
/// linked SQLite lacks FTS5.
pub(crate) fn init(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS orgtrack_fts USING fts5(
             session_id UNINDEXED,
             source     UNINDEXED,
             name,
             body,
             tokenize = 'porter unicode61'
         );
         CREATE TABLE IF NOT EXISTS orgtrack_fts_state (
             session_id  TEXT PRIMARY KEY,
             fingerprint TEXT NOT NULL
         );",
    )
    .map_err(|err| format!("could not initialize FTS5 index (is FTS5 built in?): {err}"))
}

/// Incrementally (re)index every in-scope listable session whose fingerprint
/// changed since last time. Returns the number of sessions re-parsed.
pub(crate) fn update(
    conn: &mut Connection,
    opts: &Options,
    plugins: &[LoaderPlugin],
    timeout: std::time::Duration,
) -> Result<usize, String> {
    init(conn)?;
    let targets = target_source_ids(opts, plugins);

    // Candidate sessions with their current source fingerprint.
    let candidates: Vec<(String, String, String, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT session_id, source, name, source_fingerprint
                 FROM imported_history_session_cache
                 WHERE listable = 1",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|err| err.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|err| err.to_string())?
    };

    // What we've already indexed, by fingerprint.
    let already: std::collections::HashMap<String, String> = {
        let mut stmt = conn
            .prepare("SELECT session_id, fingerprint FROM orgtrack_fts_state")
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|err| err.to_string())?;
        rows.collect::<rusqlite::Result<_>>()
            .map_err(|err| err.to_string())?
    };

    let stale: Vec<(String, String, String, String)> = candidates
        .into_iter()
        .filter(|(_, source, _, _)| targets.iter().any(|target| target == source))
        .filter(|(session_id, _, _, fingerprint)| {
            already.get(session_id).map(String::as_str) != Some(fingerprint.as_str())
        })
        .collect();

    if stale.is_empty() {
        return Ok(0);
    }
    eprintln!("Indexing {} session(s) for content search…", stale.len());

    let mut indexed = 0usize;
    for batch in stale.chunks(BATCH) {
        let tx = conn.transaction().map_err(|err| err.to_string())?;
        for (session_id, source, name, fingerprint) in batch {
            let body = session_body(&tx, session_id, plugins, timeout);
            tx.execute(
                "DELETE FROM orgtrack_fts WHERE session_id = ?1",
                [session_id],
            )
            .map_err(|err| err.to_string())?;
            tx.execute(
                "INSERT INTO orgtrack_fts (session_id, source, name, body)
                 VALUES (?1, ?2, ?3, ?4)",
                params![session_id, source, name, body],
            )
            .map_err(|err| err.to_string())?;
            tx.execute(
                "INSERT OR REPLACE INTO orgtrack_fts_state (session_id, fingerprint)
                 VALUES (?1, ?2)",
                params![session_id, fingerprint],
            )
            .map_err(|err| err.to_string())?;
            indexed += 1;
        }
        tx.commit().map_err(|err| err.to_string())?;
        eprint!("\r  indexed {indexed}/{}   ", stale.len());
    }
    eprintln!();
    Ok(indexed)
}

/// Run the FTS5 query and return ranked hits with highlighted snippets.
pub(crate) fn search(
    conn: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<ContentHit>, String> {
    let match_expr = sanitize_query(query);
    if match_expr.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT session_id, source, name,
                    snippet(orgtrack_fts, 3, '[', ']', '…', 12)
             FROM orgtrack_fts
             WHERE orgtrack_fts MATCH ?1
             ORDER BY rank
             LIMIT ?2",
        )
        .map_err(|err| err.to_string())?;
    let hits = stmt
        .query_map(params![match_expr, limit as i64], |row| {
            Ok(ContentHit {
                session_id: row.get(0)?,
                source: row.get(1)?,
                name: row.get(2)?,
                snippet: row.get(3)?,
            })
        })
        .map_err(|err| format!("content search failed: {err}"))?;
    hits.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|err| err.to_string())
}

/// Flatten a session's chunks into a bounded plain-text body for indexing.
fn session_body(
    conn: &Connection,
    session_id: &str,
    plugins: &[LoaderPlugin],
    timeout: std::time::Duration,
) -> String {
    let chunks = load_session_chunks(conn, session_id, plugins, timeout)
        .ok()
        .flatten()
        .unwrap_or_default();
    let mut body = String::new();
    for chunk in &chunks {
        if body.len() >= MAX_BODY_CHARS {
            break;
        }
        append_chunk_text(&mut body, chunk);
    }
    body.truncate(MAX_BODY_CHARS);
    body
}

/// Pull the human-readable text out of a chunk (message content, tool command,
/// tool output) into `body`.
fn append_chunk_text(body: &mut String, chunk: &ActivityChunk) {
    for value in [&chunk.result, &chunk.args] {
        if let Some(text) = text_of(value) {
            body.push_str(&text);
            body.push('\n');
        }
    }
}

fn text_of(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
        serde_json::Value::Object(map) if !map.is_empty() => {
            if let Some(text) = map
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(|content| content.as_str())
            {
                return non_blank(text);
            }
            for key in [
                "content",
                "text",
                "observation",
                "cmd",
                "command",
                "summary",
            ] {
                if let Some(text) = map.get(key).and_then(|value| value.as_str()) {
                    if let Some(found) = non_blank(text) {
                        return Some(found);
                    }
                }
            }
            None
        }
        _ => None,
    }
}

fn non_blank(text: &str) -> Option<String> {
    if text.trim().is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

/// Turn free-text into a safe FTS5 MATCH expression: each whitespace token
/// becomes a quoted term, AND-ed together. Quoting sidesteps FTS5 syntax
/// errors from stray punctuation and makes multi-word queries an implicit AND.
fn sanitize_query(query: &str) -> String {
    query
        .split_whitespace()
        .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_into_anded_quoted_terms() {
        assert_eq!(sanitize_query("rate limit"), "\"rate\" \"limit\"");
        // Punctuation that would break raw FTS syntax is neutralized by quoting.
        assert_eq!(sanitize_query("foo() OR bar"), "\"foo()\" \"OR\" \"bar\"");
        assert_eq!(sanitize_query(r#"a"b"#), "\"a\"\"b\"");
        assert_eq!(sanitize_query("   "), "");
    }

    #[test]
    fn text_extraction_finds_message_and_tool_fields() {
        let msg = serde_json::json!({"message": {"content": "hello", "role": "user"}});
        assert_eq!(text_of(&msg).as_deref(), Some("hello"));
        assert_eq!(
            text_of(&serde_json::json!({"cmd": "ls -la"})).as_deref(),
            Some("ls -la")
        );
        assert!(text_of(&serde_json::json!({})).is_none());
        assert!(text_of(&serde_json::json!("")).is_none());
    }
}
