//! Bounded turn-metadata projection over the compact imported replay index.
//!
//! This intentionally does not use [`super::read_turn_window`]. A rendered
//! replay window is capped at 200 events and 4 MiB, while metadata must fold
//! every event in the requested turn. Rows are therefore streamed directly
//! from SQLite and only payload columns required by the tool classifier are
//! copied out of SQLite.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::projectors::turn_metadata::{
    metadata_projection_requirements, ProjectedTurnMetadata, TurnMetadataAccumulator,
};
use crate::sources::imported_history;

use super::{index, ImportedHistorySourceId, ReplayTurnHeader};

const MAX_REQUESTED_TURNS: usize = 500;
const TURN_INDEX_SELECTOR_PREFIX: &str = "__external_replay_turn_index__:";

#[derive(Debug, Clone)]
struct ProjectionTurn {
    header: ReplayTurnHeader,
    next_turn_started_at: Option<String>,
    source_turn_id: String,
}

/// Synchronize the compact replay index and project only the requested turns.
///
/// `None` selects at most the newest turn, which keeps legacy callers that do
/// not yet send visible turn ids bounded. `Some(&[])` performs no source read.
/// The returned turns are ordered by their source turn index, independently of
/// the caller's id order.
pub(super) fn project_turn_metadata(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    requested_turn_ids: Option<&[String]>,
) -> Result<Vec<ProjectedTurnMetadata>, String> {
    source.validate_session_id(session_id)?;
    if requested_turn_ids.is_some_and(|ids| ids.is_empty()) {
        return Ok(Vec::new());
    }
    if requested_turn_ids.is_some_and(|ids| ids.len() > MAX_REQUESTED_TURNS) {
        return Err(format!(
            "At most {MAX_REQUESTED_TURNS} turn summaries can be loaded at once"
        ));
    }

    index::sync_index(conn, source, session_id)?;
    let resolved = index::resolve_source(conn, source, session_id)?;
    let state = index::load_state(conn, source, &resolved.source_session_id)?
        .ok_or_else(|| "Replay index state disappeared after synchronization".to_string())?;
    let projection_generation = state.generation.clone();
    let turns = select_projection_turns(
        conn,
        source,
        &resolved.source_session_id,
        &projection_generation,
        requested_turn_ids,
    )?;

    // Cursor IDE and Windsurf cold indexes retain compact headers for all
    // turns but materialize only a recent body. Hydrate exactly the selected
    // body before projection; re-read state each time because hydration may
    // advance the replay revision. The generation itself is immutable for
    // this projection: mixing new event rows with old turn headers would
    // silently attach metadata to the wrong turn after a replace/truncate.
    for turn in &turns {
        let current_state = load_projection_state_for_generation(
            conn,
            source,
            &resolved.source_session_id,
            &projection_generation,
            "hydrating replay turn metadata",
        )?;
        index::hydrate_turn_if_needed(
            conn,
            source,
            session_id,
            &resolved.source_session_id,
            &current_state,
            &turn.header,
        )?;
        load_projection_state_for_generation(
            conn,
            source,
            &resolved.source_session_id,
            &projection_generation,
            "finishing replay turn hydration",
        )?;
    }

    load_projection_state_for_generation(
        conn,
        source,
        &resolved.source_session_id,
        &projection_generation,
        "projecting replay turn metadata",
    )?;
    project_indexed_turns(
        conn,
        source,
        &resolved.source_session_id,
        &projection_generation,
        &turns,
    )
}

/// Project metadata from the last atomically published compact index without
/// synchronizing the provider or taking a write transaction.
///
/// Foreground ChatHistory calls this after a bounded replay window has
/// already supplied a generation. JSONL, row-store SQLite, structured SQLite,
/// and whole-JSON adapters project their already-indexed rows. Cursor IDE and
/// Windsurf retain every turn header but lazily materialize old bodies, so
/// their storage-specific path performs exact, read-only user-bubble lookups
/// and never indexes assistant/tool content.
pub(super) fn project_cached_turn_metadata(
    conn: &Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    requested_turn_ids: Option<&[String]>,
) -> Result<Option<Vec<ProjectedTurnMetadata>>, String> {
    source.validate_session_id(session_id)?;
    if requested_turn_ids.is_some_and(|ids| ids.is_empty()) {
        return Ok(Some(Vec::new()));
    }
    if requested_turn_ids.is_some_and(|ids| ids.len() > MAX_REQUESTED_TURNS) {
        return Err(format!(
            "At most {MAX_REQUESTED_TURNS} turn summaries can be loaded at once"
        ));
    }

    let resolved = index::resolve_source(conn, source, session_id)?;
    let Some(state) = index::load_state(conn, source, &resolved.source_session_id)? else {
        return Ok(None);
    };
    let turns = select_projection_turns(
        conn,
        source,
        &resolved.source_session_id,
        &state.generation,
        requested_turn_ids,
    )?;
    let mut projected = project_indexed_turns(
        conn,
        source,
        &resolved.source_session_id,
        &state.generation,
        &turns,
    )?;
    if matches!(
        source,
        ImportedHistorySourceId::CursorIde | ImportedHistorySourceId::Windsurf
    ) {
        apply_compact_kv_turn_previews(
            &resolved.path,
            source,
            &resolved.source_session_id,
            &turns,
            &mut projected,
        )?;
    }
    load_projection_state_for_generation(
        conn,
        source,
        &resolved.source_session_id,
        &state.generation,
        "finishing cached replay metadata projection",
    )?;
    Ok(Some(projected))
}

fn apply_compact_kv_turn_previews(
    source_path: &std::path::Path,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    turns: &[ProjectionTurn],
    projected: &mut [ProjectedTurnMetadata],
) -> Result<(), String> {
    let requested = turns
        .iter()
        .map(|turn| (turn.header.turn_index, turn.source_turn_id.clone()))
        .collect::<Vec<_>>();
    let previews = super::sqlite_driver::read_kv_turn_previews(
        source_path,
        source,
        source_session_id,
        &requested,
    )?
    .into_iter()
    .map(|preview| (preview.turn_index, preview))
    .collect::<std::collections::HashMap<_, _>>();

    for (turn, metadata) in turns.iter().zip(projected) {
        if metadata.event_count == 0 {
            metadata.event_count = turn.header.event_count.min(i64::MAX as u64) as i64;
            metadata.body_event_count = turn
                .header
                .event_count
                .saturating_sub(1)
                .min(i64::MAX as u64) as i64;
        }
        let Some(preview) = previews.get(&turn.header.turn_index) else {
            continue;
        };
        if metadata.user_preview.is_empty() {
            metadata.user_preview = preview.user_preview.clone();
        }
        if !preview.created_at.is_empty()
            && chrono::DateTime::parse_from_rfc3339(&preview.created_at).is_ok()
        {
            metadata.started_at = preview.created_at.clone();
            if metadata.ended_at.as_deref() == Some(turn.header.started_at.as_str()) {
                metadata.ended_at = Some(preview.created_at.clone());
            }
        }
    }
    Ok(())
}

fn load_projection_state_for_generation(
    conn: &Connection,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    expected_generation: &str,
    context: &str,
) -> Result<index::ReplayIndexState, String> {
    let state = index::load_state(conn, source, source_session_id)?
        .ok_or_else(|| format!("Replay index state disappeared while {context}"))?;
    if state.generation != expected_generation {
        return Err(format!(
            "Replay generation changed while {context}: expected {expected_generation}, found {}. Retry against the new generation.",
            state.generation
        ));
    }
    Ok(state)
}

fn select_projection_turns(
    conn: &Connection,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    requested_turn_ids: Option<&[String]>,
) -> Result<Vec<ProjectionTurn>, String> {
    let select =
        "SELECT turn_id,turn_index,start_sequence,end_sequence,started_at,ended_at,event_count,
                (SELECT next.started_at FROM imported_replay_turns AS next
                  WHERE next.source=current.source
                    AND next.source_session_id=current.source_session_id
                    AND next.generation=current.generation
                    AND next.turn_index=current.turn_index+1)
           FROM imported_replay_turns AS current
          WHERE source=?1 AND source_session_id=?2 AND generation=?3";
    let decode = |row: &rusqlite::Row<'_>| {
        let source_turn_id: String = row.get(0)?;
        Ok(ProjectionTurn {
            header: ReplayTurnHeader {
                turn_id: source_turn_id.clone(),
                turn_index: row.get(1)?,
                start_sequence: row.get(2)?,
                end_sequence: row.get(3)?,
                started_at: row.get(4)?,
                ended_at: row.get(5)?,
                event_count: row.get::<_, i64>(6)?.max(0) as u64,
            },
            next_turn_started_at: row.get(7)?,
            source_turn_id,
        })
    };

    let mut turns = Vec::new();
    if let Some(requested) = requested_turn_ids {
        let requested = requested.iter().collect::<HashSet<_>>();
        let mut id_statement = conn
            .prepare(&format!("{select} AND turn_id=?4"))
            .map_err(|err| format!("prepare requested replay metadata turn: {err}"))?;
        let mut index_statement = conn
            .prepare(&format!("{select} AND turn_index=?4"))
            .map_err(|err| format!("prepare requested replay metadata index: {err}"))?;
        for requested_turn_id in requested {
            let turn_index = requested_turn_id
                .strip_prefix(TURN_INDEX_SELECTOR_PREFIX)
                .and_then(|value| value.parse::<i64>().ok())
                .filter(|value| *value >= 0);
            let selected = if let Some(turn_index) = turn_index {
                index_statement
                    .query_row(
                        params![source.as_str(), source_session_id, generation, turn_index],
                        decode,
                    )
                    .optional()
                    .map_err(|err| format!("query requested replay metadata index: {err}"))?
                    .map(|mut turn| {
                        // The selector is a renderer catalog locator, not the
                        // provider's turn id. Echo it so a batched response can
                        // be joined to virtual rows without hydrating bodies.
                        turn.header.turn_id = requested_turn_id.clone();
                        turn
                    })
            } else {
                id_statement
                    .query_row(
                        params![
                            source.as_str(),
                            source_session_id,
                            generation,
                            requested_turn_id
                        ],
                        decode,
                    )
                    .optional()
                    .map_err(|err| format!("query requested replay metadata turn: {err}"))?
            };
            if let Some(turn) = selected {
                turns.push(turn);
            }
        }
    } else if let Some(turn) = conn
        .query_row(
            &format!("{select} ORDER BY turn_index DESC LIMIT 1"),
            params![source.as_str(), source_session_id, generation],
            decode,
        )
        .optional()
        .map_err(|err| format!("query newest replay metadata turn: {err}"))?
    {
        turns.push(turn);
    }
    turns.sort_by_key(|turn| turn.header.turn_index);
    Ok(turns)
}

fn project_indexed_turns(
    conn: &Connection,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    turns: &[ProjectionTurn],
) -> Result<Vec<ProjectedTurnMetadata>, String> {
    let mut statement = conn
        .prepare(
            "SELECT action_type,function_name,created_at,
                    args_preview_json,result_preview_json
               FROM imported_replay_events
              WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND turn_index=?4
              ORDER BY sequence ASC",
        )
        .map_err(|err| format!("prepare replay metadata row stream: {err}"))?;
    let mut projected = Vec::with_capacity(turns.len());
    for turn in turns {
        let mut rows = statement
            .query(params![
                source.as_str(),
                source_session_id,
                generation,
                turn.header.turn_index
            ])
            .map_err(|err| format!("query replay metadata rows: {err}"))?;
        let mut metadata = TurnMetadataAccumulator::new();
        let mut status = "completed".to_string();
        let mut ended_at = Some(turn.header.started_at.clone());
        let mut user_preview = String::new();
        let mut event_count = 0_i64;
        let mut body_event_count = 0_i64;

        while let Some(row) = rows
            .next()
            .map_err(|err| format!("read replay metadata row: {err}"))?
        {
            // Read the light classification fields first. For assistant,
            // thinking, Node REPL, and other known no-metadata rows, the two
            // JSON text columns below are never copied into Rust Strings.
            let action_type: String = row.get(0).map_err(|err| err.to_string())?;
            let function_name: String = row.get(1).map_err(|err| err.to_string())?;
            let created_at: String = row.get(2).map_err(|err| err.to_string())?;

            if function_name == imported_history::FUNCTION_USER_MESSAGE {
                let args_json: String = row.get(3).map_err(|err| err.to_string())?;
                let result_json: String = row.get(4).map_err(|err| err.to_string())?;
                if user_preview.is_empty() {
                    user_preview = user_preview_from_json(&args_json, &result_json);
                }
                event_count = event_count.saturating_add(1);
                continue;
            }

            match action_type.as_str() {
                imported_history::ACTION_TYPE_TASK_START => {
                    status = "pending".to_string();
                    ended_at = None;
                    continue;
                }
                imported_history::ACTION_TYPE_TASK_COMPLETED => {
                    status = "completed".to_string();
                    ended_at = Some(created_at);
                    continue;
                }
                imported_history::ACTION_TYPE_TASK_FAILED => {
                    status = "failed".to_string();
                    ended_at = Some(created_at);
                    continue;
                }
                _ => {}
            }

            event_count = event_count.saturating_add(1);
            body_event_count = body_event_count.saturating_add(1);
            if status != "pending"
                && !created_at.is_empty()
                && ended_at
                    .as_deref()
                    .is_none_or(|ended| created_at.as_str() > ended)
            {
                ended_at = Some(created_at.clone());
            }

            let requirements = metadata_projection_requirements(Some(&function_name));
            if requirements.is_empty() {
                continue;
            }
            let args_json = if requirements.needs_args_json() {
                row.get::<_, String>(3).map_err(|err| err.to_string())?
            } else {
                String::new()
            };
            let result_json = if requirements.needs_result_json() {
                row.get::<_, String>(4).map_err(|err| err.to_string())?
            } else {
                String::new()
            };
            metadata.add_event_at(Some(&function_name), &args_json, &result_json, &created_at);
        }

        if status == "pending" {
            if let Some(next_started_at) = turn.next_turn_started_at.as_ref() {
                status = "interrupted".to_string();
                ended_at = Some(next_started_at.clone());
            }
        }
        projected.push(ProjectedTurnMetadata {
            turn_id: turn.header.turn_id.clone(),
            start_sequence: turn.header.start_sequence,
            started_at: turn.header.started_at.clone(),
            ended_at,
            status,
            user_preview,
            event_count,
            body_event_count,
            modified_files: metadata.modified_files().to_vec(),
            resource_interactions: metadata.resource_interactions().to_vec(),
            git_artifacts: metadata.git_artifacts().to_vec(),
        });
    }
    Ok(projected)
}

fn user_preview_from_json(args_json: &str, result_json: &str) -> String {
    let args = serde_json::from_str::<Value>(args_json).unwrap_or(Value::Null);
    for field in ["content", "message", "prompt", "text", "query"] {
        if let Some(text) = args.get(field).and_then(Value::as_str) {
            return text.to_string();
        }
    }
    if let Some(text) = args.as_str() {
        return text.to_string();
    }
    let result = serde_json::from_str::<Value>(result_json).unwrap_or(Value::Null);
    result
        .pointer("/message/content")
        .or_else(|| result.get("content"))
        .or_else(|| result.get("message"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests;
