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

#[derive(Debug, Clone)]
struct ProjectionTurn {
    header: ReplayTurnHeader,
    next_turn_started_at: Option<String>,
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
        Ok(ProjectionTurn {
            header: ReplayTurnHeader {
                turn_id: row.get(0)?,
                turn_index: row.get(1)?,
                start_sequence: row.get(2)?,
                end_sequence: row.get(3)?,
                started_at: row.get(4)?,
                ended_at: row.get(5)?,
                event_count: row.get::<_, i64>(6)?.max(0) as u64,
            },
            next_turn_started_at: row.get(7)?,
        })
    };

    let mut turns = Vec::new();
    if let Some(requested) = requested_turn_ids {
        let requested = requested.iter().collect::<HashSet<_>>();
        let mut statement = conn
            .prepare(&format!("{select} AND turn_id=?4"))
            .map_err(|err| format!("prepare requested replay metadata turn: {err}"))?;
        for turn_id in requested {
            if let Some(turn) = statement
                .query_row(
                    params![source.as_str(), source_session_id, generation, turn_id],
                    decode,
                )
                .optional()
                .map_err(|err| format!("query requested replay metadata turn: {err}"))?
            {
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
mod tests {
    use core_types::activity::ActivityChunk;
    use rusqlite::Connection;
    use serde_json::json;

    use crate::projectors::turn_metadata::project_activity_chunks;
    use crate::store::sqlite::SqliteRecordStore;

    use super::*;

    const SOURCE_SESSION_ID: &str = "fixture";
    const GENERATION: &str = "generation-1";

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory replay DB");
        SqliteRecordStore::init_source_cache_tables(&conn).expect("replay schema");
        conn
    }

    fn insert_state(conn: &Connection, generation: &str) {
        conn.execute(
            "INSERT INTO imported_replay_state(
                 source,source_session_id,generation,revision,parser_version,
                 source_identity,driver_cursor_json,valid,updated_at
             ) VALUES(?1,?2,?3,1,1,'fixture','{}',1,'2026-07-22T00:00:00Z')
             ON CONFLICT(source,source_session_id) DO UPDATE SET
                 generation=excluded.generation,revision=excluded.revision,
                 updated_at=excluded.updated_at",
            params![
                ImportedHistorySourceId::CodexApp.as_str(),
                SOURCE_SESSION_ID,
                generation
            ],
        )
        .expect("insert replay state");
    }

    fn insert_turn(conn: &Connection, turn_index: i64, chunks: &[ActivityChunk]) {
        let source = ImportedHistorySourceId::CodexApp;
        let first = chunks.first().expect("turn must have an event");
        let last = chunks.last().expect("turn must have an event");
        let start_sequence = if turn_index == 0 { 0 } else { 10_000 };
        conn.execute(
            "INSERT INTO imported_replay_turns(
                 source,source_session_id,generation,turn_index,turn_id,start_sequence,
                 end_sequence,started_at,ended_at,event_count
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                source.as_str(),
                SOURCE_SESSION_ID,
                GENERATION,
                turn_index,
                first.chunk_id,
                start_sequence,
                start_sequence + chunks.len() as i64 - 1,
                first.created_at,
                last.created_at,
                chunks.len() as i64
            ],
        )
        .expect("insert turn header");
        for (offset, chunk) in chunks.iter().enumerate() {
            conn.execute(
                "INSERT INTO imported_replay_events(
                     source,source_session_id,generation,sequence,event_id,turn_index,
                     action_type,function_name,created_at,args_preview_json,result_preview_json,
                     args_size_bytes,result_size_bytes,content_hash
                 ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
                params![
                    source.as_str(),
                    SOURCE_SESSION_ID,
                    GENERATION,
                    start_sequence + offset as i64,
                    chunk.chunk_id,
                    turn_index,
                    chunk.action_type,
                    chunk.function,
                    chunk.created_at,
                    serde_json::to_string(&chunk.args).unwrap(),
                    serde_json::to_string(&chunk.result).unwrap(),
                    chunk.args.to_string().len() as i64,
                    chunk.result.to_string().len() as i64,
                    format!("hash-{turn_index}-{offset}")
                ],
            )
            .expect("insert replay event");
        }
    }

    fn chunk(
        id: &str,
        action_type: &str,
        function: &str,
        timestamp: usize,
        args: Value,
        result: Value,
    ) -> ActivityChunk {
        let mut chunk = ActivityChunk::new("codexapp-fixture", action_type, function);
        chunk.chunk_id = id.to_string();
        chunk.created_at = format!("2026-07-15T00:00:{timestamp:02}Z");
        chunk.args = args;
        chunk.result = result;
        chunk
    }

    fn representative_turn() -> Vec<ActivityChunk> {
        vec![
            chunk(
                "user-1",
                "raw",
                imported_history::FUNCTION_USER_MESSAGE,
                0,
                json!({}),
                json!({"message":{"content":"fix metadata"}}),
            ),
            chunk(
                "assistant-1",
                "assistant",
                "assistant",
                1,
                json!({"impossiblePath":"assistant/should/not/project"}),
                json!({"content":"x".repeat(64 * 1024)}),
            ),
            chunk(
                "thinking-1",
                "thinking",
                "thinking",
                2,
                json!({}),
                json!({"thought":"x".repeat(64 * 1024)}),
            ),
            chunk(
                "edit-1",
                "tool_call",
                "edit_file",
                3,
                json!({"file_path":"src/lib.rs","new_string":"one\ntwo"}),
                json!({"success":{"linesAdded":2,"linesRemoved":1}}),
            ),
            chunk(
                "edit-2",
                "tool_call",
                "edit_file",
                4,
                json!({"file_path":"src/lib.rs","new_string":"three\nfour\nfive"}),
                json!({"success":{"linesAdded":3,"linesRemoved":0}}),
            ),
            chunk(
                "grep-1",
                "tool_call",
                "Grep",
                5,
                json!({"path":"src","pattern":"metadata"}),
                json!({"matches":"x".repeat(128 * 1024)}),
            ),
            chunk(
                "unknown-1",
                "tool_call",
                "future_provider_tool",
                6,
                json!({"command":"gh pr create"}),
                json!({"output":"https://github.com/acme/repo/pull/42"}),
            ),
            chunk(
                "git-1",
                "tool_call",
                "Bash",
                7,
                json!({"command":"git commit -m metadata"}),
                json!({"success":{"command":"git commit -m metadata","stdout":"[feature abc1234] metadata","exitCode":0}}),
            ),
        ]
    }

    #[test]
    fn compact_row_projection_matches_activity_projection() {
        let conn = setup();
        let chunks = representative_turn();
        insert_turn(&conn, 0, &chunks);
        let turns = vec![ProjectionTurn {
            header: ReplayTurnHeader {
                turn_id: "user-1".to_string(),
                turn_index: 0,
                start_sequence: 0,
                end_sequence: Some(chunks.len() as i64 - 1),
                started_at: chunks[0].created_at.clone(),
                ended_at: chunks.last().map(|chunk| chunk.created_at.clone()),
                event_count: chunks.len() as u64,
            },
            next_turn_started_at: None,
        }];

        let expected = project_activity_chunks(&chunks);
        let actual = project_indexed_turns(
            &conn,
            ImportedHistorySourceId::CodexApp,
            SOURCE_SESSION_ID,
            GENERATION,
            &turns,
        )
        .expect("project replay rows");

        assert_eq!(
            serde_json::to_value(&actual).unwrap(),
            serde_json::to_value(&expected).unwrap()
        );
        assert_eq!(actual[0].modified_files[0].additions, 5);
        assert_eq!(actual[0].modified_files[0].deletions, 1);
        assert_eq!(actual[0].git_artifacts.len(), 2);
    }

    #[test]
    fn one_turn_over_wire_limit_projects_every_row() {
        let conn = setup();
        let mut chunks = vec![chunk(
            "user-large",
            "raw",
            imported_history::FUNCTION_USER_MESSAGE,
            0,
            json!({"content":"large turn"}),
            json!({}),
        )];
        for index in 0..250 {
            chunks.push(chunk(
                &format!("edit-{index}"),
                "tool_call",
                "edit_file",
                1,
                json!({"file_path":"src/large.rs"}),
                json!({"linesAdded":1,"linesRemoved":0}),
            ));
        }
        insert_turn(&conn, 0, &chunks);
        let turns = vec![ProjectionTurn {
            header: ReplayTurnHeader {
                turn_id: "user-large".to_string(),
                turn_index: 0,
                start_sequence: 0,
                end_sequence: Some(250),
                started_at: chunks[0].created_at.clone(),
                ended_at: chunks.last().map(|chunk| chunk.created_at.clone()),
                event_count: 251,
            },
            next_turn_started_at: None,
        }];

        let projected = project_indexed_turns(
            &conn,
            ImportedHistorySourceId::CodexApp,
            SOURCE_SESSION_ID,
            GENERATION,
            &turns,
        )
        .expect("project full large turn");

        assert_eq!(projected[0].event_count, 251);
        assert_eq!(projected[0].body_event_count, 250);
        assert_eq!(projected[0].modified_files[0].additions, 250);
    }

    #[test]
    fn requested_pending_turn_uses_successor_boundary_and_newest_is_bounded() {
        let conn = setup();
        let first = vec![
            chunk(
                "user-pending",
                "raw",
                imported_history::FUNCTION_USER_MESSAGE,
                0,
                json!({}),
                json!({"message":{"content":"start work"}}),
            ),
            chunk(
                "lifecycle-start",
                imported_history::ACTION_TYPE_TASK_START,
                imported_history::ACTION_TYPE_TASK_START,
                1,
                json!({}),
                json!({}),
            ),
            chunk(
                "edit-pending",
                "tool_call",
                "edit_file",
                2,
                json!({"file_path":"src/pending.rs"}),
                json!({"linesAdded":1}),
            ),
        ];
        let second = vec![chunk(
            "user-next",
            "raw",
            imported_history::FUNCTION_USER_MESSAGE,
            3,
            json!({}),
            json!({"message":{"content":"next request"}}),
        )];
        insert_turn(&conn, 0, &first);
        insert_turn(&conn, 1, &second);

        let requested_ids = vec!["user-pending".to_string()];
        let requested = select_projection_turns(
            &conn,
            ImportedHistorySourceId::CodexApp,
            SOURCE_SESSION_ID,
            GENERATION,
            Some(&requested_ids),
        )
        .expect("select requested turn");
        let projected = project_indexed_turns(
            &conn,
            ImportedHistorySourceId::CodexApp,
            SOURCE_SESSION_ID,
            GENERATION,
            &requested,
        )
        .expect("project requested turn");
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].status, "interrupted");
        assert_eq!(
            projected[0].ended_at.as_deref(),
            Some(second[0].created_at.as_str())
        );
        assert_eq!(projected[0].event_count, 2);
        assert_eq!(projected[0].body_event_count, 1);

        let newest = select_projection_turns(
            &conn,
            ImportedHistorySourceId::CodexApp,
            SOURCE_SESSION_ID,
            GENERATION,
            None,
        )
        .expect("select newest turn");
        assert_eq!(newest.len(), 1);
        assert_eq!(newest[0].header.turn_id, "user-next");
    }

    #[test]
    fn projection_rejects_a_concurrent_generation_replacement() {
        let conn = setup();
        insert_state(&conn, GENERATION);
        load_projection_state_for_generation(
            &conn,
            ImportedHistorySourceId::CodexApp,
            SOURCE_SESSION_ID,
            GENERATION,
            "testing metadata projection",
        )
        .expect("matching generation");

        // Simulate another connection atomically publishing a replacement
        // between header selection and body projection.
        insert_state(&conn, "generation-2");
        let error = load_projection_state_for_generation(
            &conn,
            ImportedHistorySourceId::CodexApp,
            SOURCE_SESSION_ID,
            GENERATION,
            "testing metadata projection",
        )
        .expect_err("mixed generations must be rejected");

        assert!(error.contains("expected generation-1, found generation-2"));
    }
}
