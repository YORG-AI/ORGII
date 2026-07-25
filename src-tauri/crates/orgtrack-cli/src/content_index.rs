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

use orgtrack_core::sources::imported_history::{
    replay::{
        self, ImportedHistorySourceId, ReplayIndexedChunk, ReplayLimits, ReplayPayloadDescriptor,
        ReplayPayloadRange,
    },
    router as replay_router,
};

use crate::plugin_exec::load_plugin_session_chunks;
use crate::plugins::LoaderPlugin;
use crate::scan::target_source_ids;
use crate::Options;

/// Max characters of transcript text indexed per session.
const MAX_BODY_CHARS: usize = 256 * 1024;
/// Compact-index rows read per FTS page. The byte limit is the second bound.
const CONTENT_PAGE_EVENTS: usize = 32;
const CONTENT_PAGE_IPC_BYTES: usize = 512 * 1024;
/// Sessions re-indexed per write transaction.
const BATCH: usize = 64;
/// One retry absorbs a source replacement or transient plugin/IPC failure.
/// Persistent failures remain uncommitted so the next search retries them.
const SESSION_BODY_ATTEMPTS: usize = 2;

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
        // Replay synchronization needs the writable connection and may create
        // its own transaction. Build bounded bodies before opening the FTS
        // transaction; at most BATCH * MAX_BODY_CHARS are retained here.
        let mut bodies = Vec::with_capacity(batch.len());
        for (candidate_index, (session_id, _, _, _)) in batch.iter().enumerate() {
            match retry_session_body(session_id, || {
                session_body(conn, session_id, plugins, timeout)
            }) {
                Ok(body) => bodies.push((candidate_index, body)),
                Err(error) => {
                    // Keep this session's previous FTS row and stale
                    // fingerprint. One malformed/deleted source must not make
                    // every healthy session unsearchable, and the unchanged
                    // state row makes the next command retry this session.
                    eprintln!("warning: skipped content index for {session_id}: {error}");
                }
            }
        }
        if bodies.is_empty() {
            continue;
        }
        let tx = conn.transaction().map_err(|err| err.to_string())?;
        for (candidate_index, body) in bodies {
            let (session_id, source, name, fingerprint) = &batch[candidate_index];
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

fn retry_session_body(
    session_id: &str,
    mut load: impl FnMut() -> Result<String, String>,
) -> Result<String, String> {
    let mut last_error = None;
    for _ in 0..SESSION_BODY_ATTEMPTS {
        match load() {
            Ok(body) => return Ok(body),
            Err(error) => last_error = Some(error),
        }
    }
    Err(format!(
        "content body failed after {SESSION_BODY_ATTEMPTS} attempts for {session_id}: {}",
        last_error.unwrap_or_else(|| "unknown content loader failure".to_string())
    ))
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
    conn: &mut Connection,
    session_id: &str,
    plugins: &[LoaderPlugin],
    timeout: std::time::Duration,
) -> Result<String, String> {
    if let Some(source) = replay_router::source_for_session(session_id) {
        return replay_session_body(conn, source, session_id);
    }

    // The full-vector protocol is confined to third-party loaders. Built-in
    // prefixes are handled above and can never fall through to it.
    let chunks =
        load_plugin_session_chunks(conn, session_id, plugins, timeout)?.unwrap_or_default();
    Ok(body_from_chunks(chunks, MAX_BODY_CHARS))
}

fn replay_session_body(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
) -> Result<String, String> {
    let mut body = String::new();
    let mut remaining_chars = MAX_BODY_CHARS;
    let mut cursor = None;
    while remaining_chars > 0 {
        let previous_sequence = cursor
            .as_ref()
            .map_or(-1, |cursor: &replay::ReplayCursor| cursor.through_sequence);
        let scan = replay_router::scan_activity_chunks_for_session(
            conn,
            session_id,
            cursor.as_ref(),
            ReplayLimits {
                max_turns: replay::HARD_MAX_TURNS,
                max_events: CONTENT_PAGE_EVENTS,
                max_ipc_bytes: CONTENT_PAGE_IPC_BYTES,
            },
        )?
        .ok_or_else(|| format!("Unknown built-in imported session id: {session_id}"))?;
        if scan.chunks.is_empty()
            && scan.has_more
            && scan.cursor.through_sequence <= previous_sequence
        {
            return Err(format!(
                "Bounded replay content scan made no progress for {session_id} after sequence {}",
                scan.cursor.through_sequence
            ));
        }
        let scan_has_more = scan.has_more;
        let scan_cursor = scan.cursor;
        for indexed in &scan.chunks {
            append_indexed_chunk_text(
                conn,
                source,
                session_id,
                &scan_cursor.generation,
                &mut body,
                &mut remaining_chars,
                indexed,
            )?;
            if remaining_chars == 0 {
                return Ok(body);
            }
        }
        cursor = Some(scan_cursor);
        if !scan_has_more {
            break;
        }
    }
    Ok(body)
}

fn body_from_chunks(chunks: impl IntoIterator<Item = ActivityChunk>, max_chars: usize) -> String {
    let mut body = String::new();
    let mut remaining_chars = max_chars;
    for chunk in chunks {
        append_chunk_text(&mut body, &mut remaining_chars, &chunk);
        if remaining_chars == 0 {
            break;
        }
    }
    body
}

/// Pull the human-readable text out of a chunk (message content, tool command,
/// tool output) into `body`.
fn append_chunk_text(body: &mut String, remaining_chars: &mut usize, chunk: &ActivityChunk) {
    for value in [&chunk.result, &chunk.args] {
        if let Some(text) = text_of(value) {
            append_text_with_budget(body, remaining_chars, &text);
            if *remaining_chars == 0 {
                return;
            }
        }
    }
}

fn append_indexed_chunk_text(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    generation: &str,
    body: &mut String,
    remaining_chars: &mut usize,
    indexed: &ReplayIndexedChunk,
) -> Result<(), String> {
    append_indexed_chunk_text_with_reader(
        body,
        remaining_chars,
        indexed,
        |payload, offset, max_bytes| {
            replay::read_payload_range(
                conn,
                source,
                session_id,
                generation,
                &indexed.chunk.chunk_id,
                &payload.field_path,
                offset,
                Some(max_bytes),
            )
        },
    )
}

fn append_indexed_chunk_text_with_reader(
    body: &mut String,
    remaining_chars: &mut usize,
    indexed: &ReplayIndexedChunk,
    mut read_range: impl FnMut(
        &ReplayPayloadDescriptor,
        u64,
        usize,
    ) -> Result<ReplayPayloadRange, String>,
) -> Result<(), String> {
    // Preserve the old transcript root order (result, then args), but remove
    // every deferred path from the compact projection before indexing it.
    // A preview can be a head or a Shell tail, so it must never be treated as
    // an already-consumed prefix of the canonical payload.
    for (root, value) in [
        ("result", &indexed.chunk.result),
        ("args", &indexed.chunk.args),
    ] {
        let root_payloads = indexed
            .payloads
            .iter()
            .filter(|payload| payload_belongs_to_root(&payload.field_path, root))
            .collect::<Vec<_>>();
        let mut projected = value.clone();
        for payload in &root_payloads {
            remove_deferred_path(&mut projected, root, &payload.field_path);
        }
        if let Some(text) = text_of(&projected) {
            append_text_with_budget(body, remaining_chars, &text);
        }
        for payload in root_payloads {
            if *remaining_chars == 0 {
                return Ok(());
            }
            let mut offset = 0u64;
            loop {
                let max_bytes = remaining_chars
                    .saturating_mul(4)
                    .clamp(1, replay::HARD_MAX_PAYLOAD_RANGE_BYTES);
                let range = read_range(payload, offset, max_bytes)?;
                if range.offset != offset {
                    return Err(format!(
                        "Replay payload {}:{} skipped from {offset} to {}",
                        indexed.chunk.chunk_id, payload.field_path, range.offset
                    ));
                }
                append_text_with_budget(body, remaining_chars, &range.text);
                if *remaining_chars == 0 || range.eof {
                    break;
                }
                if range.next_offset <= offset {
                    return Err(format!(
                        "Replay payload {}:{} made no progress at {offset}",
                        indexed.chunk.chunk_id, payload.field_path
                    ));
                }
                offset = range.next_offset;
            }
        }
    }
    Ok(())
}

fn payload_belongs_to_root(field_path: &str, root: &str) -> bool {
    field_path == root
        || field_path
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('.'))
}

fn remove_deferred_path(value: &mut serde_json::Value, root: &str, field_path: &str) {
    let Some(relative) = field_path.strip_prefix(root) else {
        return;
    };
    if relative.is_empty() {
        *value = serde_json::Value::Null;
        return;
    }
    let keys = relative
        .trim_start_matches('.')
        .split('.')
        .collect::<Vec<_>>();
    remove_json_path(value, &keys);
}

fn remove_json_path(value: &mut serde_json::Value, keys: &[&str]) {
    let Some((key, rest)) = keys.split_first() else {
        return;
    };
    match value {
        serde_json::Value::Object(object) => {
            if rest.is_empty() {
                object.remove(*key);
            } else if let Some(child) = object.get_mut(*key) {
                remove_json_path(child, rest);
            }
        }
        serde_json::Value::Array(items) => {
            let Some(index) = key.parse::<usize>().ok() else {
                return;
            };
            let Some(child) = items.get_mut(index) else {
                return;
            };
            if rest.is_empty() {
                *child = serde_json::Value::Null;
            } else {
                remove_json_path(child, rest);
            }
        }
        _ => {}
    }
}

fn append_text_with_budget(body: &mut String, remaining_chars: &mut usize, text: &str) {
    if *remaining_chars == 0 {
        return;
    }
    let mut written = 0usize;
    for ch in text.chars().take(*remaining_chars) {
        body.push(ch);
        written += 1;
    }
    *remaining_chars = (*remaining_chars).saturating_sub(written);
    if *remaining_chars > 0 {
        body.push('\n');
        *remaining_chars -= 1;
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
    use std::cell::Cell;

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

    #[test]
    fn virtual_three_hundred_mib_transcript_stops_at_the_character_budget() {
        const ONE_MIB: usize = 1024 * 1024;
        let generated = Cell::new(0usize);
        let chunks = (0..300).map(|_| {
            generated.set(generated.get() + 1);
            ActivityChunk::new("plugin-session", "assistant", "assistant")
                .with_result(serde_json::Value::String("x".repeat(ONE_MIB)))
        });

        let body = body_from_chunks(chunks, MAX_BODY_CHARS);

        assert_eq!(body.chars().count(), MAX_BODY_CHARS);
        assert_eq!(
            generated.get(),
            1,
            "the lazy 300 MiB generator must stop after the first bounded chunk"
        );
    }

    #[test]
    fn character_budget_never_splits_utf8() {
        let mut body = String::new();
        let mut remaining = 3usize;
        append_text_with_budget(&mut body, &mut remaining, "é你🙂tail");
        assert_eq!(body, "é你🙂");
        assert_eq!(remaining, 0);
        assert!(std::str::from_utf8(body.as_bytes()).is_ok());
    }

    #[test]
    fn compact_content_pages_are_stricter_than_replay_hard_limits() {
        const {
            assert!(CONTENT_PAGE_EVENTS <= replay::HARD_MAX_EVENTS);
            assert!(CONTENT_PAGE_IPC_BYTES <= replay::HARD_MAX_IPC_BYTES);
        }
    }

    #[test]
    fn session_body_retry_recovers_transient_failures_and_bounds_persistent_ones() {
        let attempts = Cell::new(0usize);
        let body = retry_session_body("transient", || {
            attempts.set(attempts.get() + 1);
            if attempts.get() == 1 {
                Err("source changed".to_string())
            } else {
                Ok("indexed body".to_string())
            }
        })
        .expect("second attempt succeeds");
        assert_eq!(body, "indexed body");
        assert_eq!(attempts.get(), SESSION_BODY_ATTEMPTS);

        attempts.set(0);
        let error = retry_session_body("broken", || {
            attempts.set(attempts.get() + 1);
            Err("still broken".to_string())
        })
        .expect_err("persistent failure stays isolated");
        assert_eq!(attempts.get(), SESSION_BODY_ATTEMPTS);
        assert!(error.contains("still broken"));
    }

    #[test]
    fn deferred_payload_replaces_tail_preview_and_keeps_legacy_root_order() {
        let canonical = "FULL_START-full-result-FULL_END";
        let indexed = ReplayIndexedChunk {
            sequence: 0,
            turn_index: 0,
            chunk: ActivityChunk::new("codex-test", "tool_call", "shell")
                .with_args(serde_json::json!({"command": "later-command"}))
                .with_result(serde_json::json!({"observation": "TAIL_PREVIEW"})),
            payloads: vec![ReplayPayloadDescriptor {
                field_path: "result.observation".to_string(),
                kind: replay::ReplayPayloadKind::ToolOutput,
                encoding: replay::ReplayPayloadEncoding::Utf8Text,
                body_projection: None,
                spans: Vec::new(),
                total_bytes: canonical.len() as u64,
                source_ordinal: None,
                source_key: None,
            }],
        };
        let mut body = String::new();
        let mut remaining = canonical.chars().count() + "later-command".chars().count() + 2;
        let mut offsets = Vec::new();

        append_indexed_chunk_text_with_reader(
            &mut body,
            &mut remaining,
            &indexed,
            |payload, offset, max_bytes| {
                assert_eq!(payload.field_path, "result.observation");
                offsets.push(offset);
                let start = offset as usize;
                let end = (start + max_bytes).min(canonical.len());
                Ok(ReplayPayloadRange {
                    event_id: indexed.chunk.chunk_id.clone(),
                    field_path: payload.field_path.clone(),
                    offset,
                    next_offset: end as u64,
                    eof: end == canonical.len(),
                    total_bytes: canonical.len() as u64,
                    text: canonical[start..end].to_string(),
                })
            },
        )
        .expect("deferred payload should stream");

        assert_eq!(offsets.first(), Some(&0), "a tail preview is not a prefix");
        assert_eq!(body.matches(canonical).count(), 1);
        assert!(!body.contains("TAIL_PREVIEW"));
        assert!(
            body.find(canonical).expect("canonical result")
                < body.find("later-command").expect("later args")
        );
    }

    #[test]
    fn deferred_payload_gets_the_body_budget_before_later_roots() {
        let canonical = "canonical-result";
        let indexed = ReplayIndexedChunk {
            sequence: 0,
            turn_index: 0,
            chunk: ActivityChunk::new("codex-test", "tool_call", "shell")
                .with_args(serde_json::json!({"command": "must-not-starve-result"}))
                .with_result(serde_json::json!({"observation": "preview-must-not-count"})),
            payloads: vec![ReplayPayloadDescriptor {
                field_path: "result.observation".to_string(),
                kind: replay::ReplayPayloadKind::ToolOutput,
                encoding: replay::ReplayPayloadEncoding::Utf8Text,
                body_projection: None,
                spans: Vec::new(),
                total_bytes: canonical.len() as u64,
                source_ordinal: None,
                source_key: None,
            }],
        };
        let mut body = String::new();
        let mut remaining = canonical.len();

        append_indexed_chunk_text_with_reader(
            &mut body,
            &mut remaining,
            &indexed,
            |_payload, offset, max_bytes| {
                let start = offset as usize;
                let end = (start + max_bytes).min(canonical.len());
                Ok(ReplayPayloadRange {
                    event_id: indexed.chunk.chunk_id.clone(),
                    field_path: "result.observation".to_string(),
                    offset,
                    next_offset: end as u64,
                    eof: end == canonical.len(),
                    total_bytes: canonical.len() as u64,
                    text: canonical[start..end].to_string(),
                })
            },
        )
        .expect("deferred payload should stream");

        assert_eq!(body, canonical);
        assert_eq!(remaining, 0);
    }

    #[test]
    fn deferred_path_removal_descends_numeric_array_segments() {
        let mut result = serde_json::json!({
            "content": [
                {"text": "ARRAY_TAIL_PREVIEW", "kind": "text"},
                {"text": "keep-me"}
            ]
        });

        remove_deferred_path(&mut result, "result", "result.content.0.text");

        assert_eq!(result["content"][0]["text"], serde_json::Value::Null);
        assert_eq!(result["content"][0]["kind"], "text");
        assert_eq!(result["content"][1]["text"], "keep-me");

        // Bad or out-of-range indices are a no-op, not a panic or an
        // accidental deletion of an adjacent array item.
        let unchanged = result.clone();
        remove_deferred_path(&mut result, "result", "result.content.99.text");
        remove_deferred_path(&mut result, "result", "result.content.nope.text");
        assert_eq!(result, unchanged);
    }

    #[test]
    fn nested_array_deferred_payload_indexes_only_the_canonical_body() {
        let canonical = "FULL_ARRAY_BODY";
        let indexed = ReplayIndexedChunk {
            sequence: 0,
            turn_index: 0,
            chunk: ActivityChunk::new("codex-test", "assistant", "assistant").with_result(
                serde_json::json!({
                    "content": [{"text": "ARRAY_TAIL_PREVIEW", "kind": "text"}]
                }),
            ),
            payloads: vec![ReplayPayloadDescriptor {
                field_path: "result.content.0.text".to_string(),
                kind: replay::ReplayPayloadKind::AssistantContent,
                encoding: replay::ReplayPayloadEncoding::Utf8Text,
                body_projection: None,
                spans: Vec::new(),
                total_bytes: canonical.len() as u64,
                source_ordinal: None,
                source_key: None,
            }],
        };
        let mut body = String::new();
        let mut remaining = 128;

        append_indexed_chunk_text_with_reader(
            &mut body,
            &mut remaining,
            &indexed,
            |payload, offset, max_bytes| {
                assert_eq!(payload.field_path, "result.content.0.text");
                let start = offset as usize;
                let end = (start + max_bytes).min(canonical.len());
                Ok(ReplayPayloadRange {
                    event_id: indexed.chunk.chunk_id.clone(),
                    field_path: payload.field_path.clone(),
                    offset,
                    next_offset: end as u64,
                    eof: end == canonical.len(),
                    total_bytes: canonical.len() as u64,
                    text: canonical[start..end].to_string(),
                })
            },
        )
        .expect("nested deferred payload should stream");

        assert!(body.contains(canonical));
        assert!(!body.contains("ARRAY_TAIL_PREVIEW"));
    }
}
