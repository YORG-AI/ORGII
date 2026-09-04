//! Turn-window queries over the normalized session event cache.
//!
//! These functions intentionally return `CachedEvent` rows from `events`; the
//! app crate converts them to `SessionEvent` at the existing cache bridge layer.

use std::collections::HashSet;

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Result as SqliteResult};
use serde::{Deserialize, Serialize};

use super::connection::get_connection;
use super::turn_index;
use super::types::CachedEvent;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedTurnBodyWindow {
    pub turn_id: String,
    pub events: Vec<CachedEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedInitialTurnWindow {
    pub turns: Vec<turn_index::CachedTurnSummary>,
    pub events: Vec<CachedEvent>,
}

fn cached_event_from_row(row: &rusqlite::Row<'_>) -> SqliteResult<CachedEvent> {
    Ok(CachedEvent {
        id: row.get(0)?,
        session_id: row.get(1)?,
        event_type: row.get(2)?,
        function_name: row.get(3)?,
        thread_id: row.get(4)?,
        args_json: row.get(5)?,
        result_json: row.get(6)?,
        content: row.get(7)?,
        created_at: row.get(8)?,
        meta_json: row.get(9)?,
        history_sequence: row.get(10)?,
    })
}

fn load_events_for_turn_ranges(
    session_id: &str,
    ranges: &[(String, Option<String>)],
) -> SqliteResult<Vec<CachedEvent>> {
    if ranges.is_empty() {
        return Ok(Vec::new());
    }

    let conn = get_connection()?;
    let mut events = Vec::new();
    for (start, end) in ranges {
        if let Some(end) = end {
            let mut stmt = conn.prepare_cached(
                "SELECT id, session_id, event_type, function_name, thread_id,
                        args_json, result_json, content, created_at, meta_json, history_sequence
                 FROM events
                 WHERE session_id = ?1
                   AND created_at >= ?2
                   AND created_at < ?3
                 ORDER BY created_at ASC, COALESCE(history_sequence, rowid) ASC, id ASC",
            )?;
            let rows = stmt
                .query_map(params![session_id, start, end], cached_event_from_row)?
                .collect::<SqliteResult<Vec<_>>>()?;
            events.extend(rows);
        } else {
            let mut stmt = conn.prepare_cached(
                "SELECT id, session_id, event_type, function_name, thread_id,
                        args_json, result_json, content, created_at, meta_json, history_sequence
                 FROM events
                 WHERE session_id = ?1
                   AND created_at >= ?2
                 ORDER BY created_at ASC, COALESCE(history_sequence, rowid) ASC, id ASC",
            )?;
            let rows = stmt
                .query_map(params![session_id, start], cached_event_from_row)?
                .collect::<SqliteResult<Vec<_>>>()?;
            events.extend(rows);
        }
    }

    Ok(events)
}

fn load_events_by_ids(session_id: &str, ids: &[String]) -> SqliteResult<Vec<CachedEvent>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let conn = get_connection()?;
    let placeholders = std::iter::repeat_n("?", ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let query = format!(
        "SELECT id, session_id, event_type, function_name, thread_id,
                args_json, result_json, content, created_at, meta_json, history_sequence
         FROM events
         WHERE session_id = ? AND id IN ({placeholders})
         ORDER BY created_at ASC, COALESCE(history_sequence, rowid) ASC, id ASC"
    );
    let params = std::iter::once(session_id).chain(ids.iter().map(String::as_str));
    let mut stmt = conn.prepare(&query)?;
    let rows = stmt
        .query_map(params_from_iter(params), cached_event_from_row)?
        .collect::<SqliteResult<Vec<_>>>()?;

    Ok(rows)
}

/// Load the most recent `limit` events whose `function_name` is one of
/// `function_names`, returned in ascending timeline order.
///
/// Used to pin artifact-producing events (inline-Canvas renders/revisions)
/// into the initial turn window: older turns collapse into placeholders,
/// but the canvas projection and `revise_inline_canvas` target validation
/// address those events by id regardless of which turn produced them.
pub fn load_session_pinned_artifact_events(
    session_id: &str,
    function_names: &[&str],
    limit: usize,
) -> SqliteResult<Vec<CachedEvent>> {
    let conn = get_connection()?;
    load_pinned_artifact_events(&conn, session_id, function_names, limit)
}

fn load_pinned_artifact_events(
    conn: &Connection,
    session_id: &str,
    function_names: &[&str],
    limit: usize,
) -> SqliteResult<Vec<CachedEvent>> {
    if function_names.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }

    let placeholders = std::iter::repeat_n("?", function_names.len())
        .collect::<Vec<_>>()
        .join(",");
    let query = format!(
        "SELECT id, session_id, event_type, function_name, thread_id,
                args_json, result_json, content, created_at, meta_json, history_sequence
         FROM events
         WHERE session_id = ? AND function_name IN ({placeholders})
         ORDER BY created_at DESC, COALESCE(history_sequence, rowid) DESC, id DESC
         LIMIT {limit}"
    );
    let params = std::iter::once(session_id).chain(function_names.iter().copied());
    let mut stmt = conn.prepare(&query)?;
    let mut events = stmt
        .query_map(params_from_iter(params), cached_event_from_row)?
        .collect::<SqliteResult<Vec<_>>>()?;
    events.reverse();
    Ok(events)
}

const TURN_PREVIEW_ARG_KEY: &str = "turnPreviewOnly";

fn mark_turn_preview(mut event: CachedEvent) -> CachedEvent {
    let mut args = serde_json::from_str::<serde_json::Value>(&event.args_json)
        .unwrap_or_else(|_| serde_json::json!({}));
    if let Some(args_object) = args.as_object_mut() {
        args_object.insert(
            TURN_PREVIEW_ARG_KEY.to_string(),
            serde_json::Value::Bool(true),
        );
        event.args_json = serde_json::to_string(&args).unwrap_or_else(|_| "{}".to_string());
    }
    event
}

fn load_final_assistant_event_for_range(
    conn: &Connection,
    session_id: &str,
    start: &str,
    end: Option<&str>,
) -> SqliteResult<Option<CachedEvent>> {
    let message_filter = "
      AND (
        event_type = 'assistant'
        OR function_name IN ('assistant_message', 'agent_message', 'message')
        OR json_extract(meta_json, '$.uiCanonical') IN ('assistant_message', 'agent_message')
      )
      AND COALESCE(json_extract(meta_json, '$.displayVariant'), 'message') = 'message'
      AND COALESCE(json_extract(meta_json, '$.displayStatus'), 'completed') = 'completed'";
    let order_and_limit = "
      ORDER BY created_at DESC, COALESCE(history_sequence, rowid) DESC, id DESC
      LIMIT 1";
    let select = "SELECT id, session_id, event_type, function_name, thread_id,
                         args_json, result_json, content, created_at, meta_json, history_sequence
                  FROM events
                  WHERE session_id = ?1 AND created_at >= ?2";

    let event = if let Some(end) = end {
        let query = format!("{select} AND created_at < ?3 {message_filter} {order_and_limit}");
        conn.query_row(
            &query,
            params![session_id, start, end],
            cached_event_from_row,
        )
        .optional()?
    } else {
        let query = format!("{select} {message_filter} {order_and_limit}");
        conn.query_row(&query, params![session_id, start], cached_event_from_row)
            .optional()?
    };

    Ok(event.map(mark_turn_preview))
}

pub fn load_turn_body_window(
    session_id: &str,
    turn_id: &str,
) -> SqliteResult<CachedTurnBodyWindow> {
    turn_index::ensure_turn_index_fresh(session_id)?;
    let conn = get_connection()?;
    let Some(summary) = turn_index::get_turn_summary(&conn, session_id, turn_id)? else {
        return Ok(CachedTurnBodyWindow {
            turn_id: turn_id.to_string(),
            events: Vec::new(),
        });
    };

    let next_started_at = summary
        .next_turn_id
        .as_deref()
        .and_then(|next_turn_id| {
            turn_index::get_turn_summary(&conn, session_id, next_turn_id)
                .ok()
                .flatten()
        })
        .map(|next_turn| next_turn.started_at);
    let events =
        load_events_for_turn_ranges(session_id, &[(summary.started_at.clone(), next_started_at)])?;

    Ok(CachedTurnBodyWindow {
        turn_id: turn_id.to_string(),
        events,
    })
}

pub fn load_initial_turn_window(
    session_id: &str,
    recent_turn_count: usize,
) -> SqliteResult<CachedInitialTurnWindow> {
    let turns = turn_index::load_turn_index(session_id)?;
    let recent_start = turns.len().saturating_sub(recent_turn_count);
    let recent_turn_ids = turns[recent_start..]
        .iter()
        .map(|turn| turn.turn_id.as_str())
        .collect::<HashSet<_>>();

    let header_event_ids = turns[..recent_start]
        .iter()
        .flat_map(|turn| turn.user_event_ids.iter().cloned())
        .collect::<Vec<_>>();
    let historical_ranges = turns[..recent_start]
        .iter()
        .enumerate()
        .map(|(turn_index, turn)| {
            let next_started_at = turns
                .get(turn_index + 1)
                .map(|next_turn| next_turn.started_at.as_str());
            (turn.started_at.as_str(), next_started_at)
        })
        .collect::<Vec<_>>();
    let recent_ranges = turns[recent_start..]
        .iter()
        .enumerate()
        .map(|(offset, turn)| {
            let turn_index = recent_start + offset;
            let next_started_at = turns
                .get(turn_index + 1)
                .map(|next_turn| next_turn.started_at.clone());
            (turn.started_at.clone(), next_started_at)
        })
        .collect::<Vec<_>>();

    let mut events = load_events_by_ids(session_id, &header_event_ids)?;
    let conn = get_connection()?;
    for (start, end) in historical_ranges {
        if let Some(preview) = load_final_assistant_event_for_range(&conn, session_id, start, end)?
        {
            events.push(preview);
        }
    }
    events.extend(load_events_for_turn_ranges(session_id, &recent_ranges)?);
    events.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.history_sequence.cmp(&right.history_sequence))
            .then_with(|| left.id.cmp(&right.id))
    });
    events.retain(|event| {
        turns
            .iter()
            .find(|turn| turn.turn_id == event.id)
            .map(|turn| recent_turn_ids.contains(turn.turn_id.as_str()))
            .unwrap_or(true)
            || !recent_turn_ids.contains(event.id.as_str())
    });

    Ok(CachedInitialTurnWindow { turns, events })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn events_test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory database");
        crate::schema::init_session_tables(&conn).expect("init session schema");
        conn
    }

    fn insert_event(
        conn: &Connection,
        session_id: &str,
        id: &str,
        function_name: &str,
        created_at: &str,
    ) {
        conn.execute(
            "INSERT INTO events (id, session_id, event_type, function_name,
                                 args_json, result_json, content, created_at)
             VALUES (?1, ?2, 'tool_call', ?3, '{}', '{}', '', ?4)",
            params![id, session_id, function_name, created_at],
        )
        .expect("insert event");
    }

    #[test]
    fn pinned_artifact_events_survive_outside_the_recent_turn_window() {
        // A canvas rendered in turn 1 must be loadable even though the
        // initial turn window only materializes the most recent turn's body.
        let conn = events_test_conn();
        insert_event(
            &conn,
            "session-a",
            "tool-call-canvas-1",
            "render_inline_canvas",
            "2026-08-01T00:00:01.000Z",
        );
        insert_event(
            &conn,
            "session-a",
            "tool-call-canvas-2",
            "revise_inline_canvas",
            "2026-08-01T00:10:00.000Z",
        );
        insert_event(
            &conn,
            "session-a",
            "tool-call-read-1",
            "read_file",
            "2026-08-01T00:20:00.000Z",
        );
        insert_event(
            &conn,
            "session-b",
            "tool-call-canvas-other",
            "render_inline_canvas",
            "2026-08-01T00:00:02.000Z",
        );

        let events = load_pinned_artifact_events(
            &conn,
            "session-a",
            &["render_inline_canvas", "revise_inline_canvas"],
            64,
        )
        .expect("load pinned artifact events");

        let ids: Vec<&str> = events.iter().map(|event| event.id.as_str()).collect();
        assert_eq!(ids, vec!["tool-call-canvas-1", "tool-call-canvas-2"]);
    }

    #[test]
    fn pinned_artifact_events_cap_keeps_the_most_recent() {
        let conn = events_test_conn();
        for index in 0..5 {
            insert_event(
                &conn,
                "session-a",
                &format!("tool-call-canvas-{index}"),
                "render_inline_canvas",
                &format!("2026-08-01T00:00:0{index}.000Z"),
            );
        }

        let events = load_pinned_artifact_events(&conn, "session-a", &["render_inline_canvas"], 2)
            .expect("load pinned artifact events");

        let ids: Vec<&str> = events.iter().map(|event| event.id.as_str()).collect();
        assert_eq!(ids, vec!["tool-call-canvas-3", "tool-call-canvas-4"]);
    }

    #[test]
    fn pinned_artifact_events_with_no_names_or_zero_cap_are_empty() {
        let conn = events_test_conn();
        insert_event(
            &conn,
            "session-a",
            "tool-call-canvas-1",
            "render_inline_canvas",
            "2026-08-01T00:00:01.000Z",
        );

        assert!(load_pinned_artifact_events(&conn, "session-a", &[], 64)
            .expect("empty name list")
            .is_empty());
        assert!(
            load_pinned_artifact_events(&conn, "session-a", &["render_inline_canvas"], 0)
                .expect("zero cap")
                .is_empty()
        );
    }
}
