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
        source_turn_id: "user-1".to_string(),
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
        source_turn_id: "user-large".to_string(),
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
fn virtual_turn_index_selectors_return_compact_previews_without_body_windows() {
    let conn = setup();
    let first = vec![chunk(
        "provider-user-0",
        "raw",
        imported_history::FUNCTION_USER_MESSAGE,
        0,
        json!({}),
        json!({"message":{"content":"first compact prompt"}}),
    )];
    let second = vec![chunk(
        "provider-user-1",
        "raw",
        imported_history::FUNCTION_USER_MESSAGE,
        1,
        json!({}),
        json!({"message":{"content":"second compact prompt"}}),
    )];
    insert_turn(&conn, 0, &first);
    insert_turn(&conn, 1, &second);

    let selector = format!("{TURN_INDEX_SELECTOR_PREFIX}0");
    let requested = vec![selector.clone()];
    let turns = select_projection_turns(
        &conn,
        ImportedHistorySourceId::CodexApp,
        SOURCE_SESSION_ID,
        GENERATION,
        Some(&requested),
    )
    .expect("select virtual catalog row by turn index");
    let projected = project_indexed_turns(
        &conn,
        ImportedHistorySourceId::CodexApp,
        SOURCE_SESSION_ID,
        GENERATION,
        &turns,
    )
    .expect("project compact catalog preview");

    assert_eq!(projected.len(), 1);
    assert_eq!(projected[0].turn_id, selector);
    assert_eq!(projected[0].user_preview, "first compact prompt");
    assert_eq!(projected[0].event_count, 1);
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
