use prost::Message as _;
use prost_reflect::DynamicMessage;
use rusqlite::{params, Connection};

use super::*;
use crate::sources::imported_history::metadata::ImportedHistoryRecordSignature;

fn fixture_task_blob() -> Vec<u8> {
    let descriptor = warp_multi_agent_api::get_descriptor_pool()
        .get_message_by_name(WARP_TASK_PROTO_NAME)
        .expect("Warp Task descriptor");
    let mut deserializer =
        serde_json::Deserializer::from_str(include_str!("../fixtures/warp_task.json"));
    DynamicMessage::deserialize(descriptor, &mut deserializer)
        .expect("valid Warp task fixture")
        .encode_to_vec()
}

fn fixture_db() -> Connection {
    let conn = Connection::open_in_memory().expect("in-memory db");
    conn.execute_batch(
        "CREATE TABLE agent_conversations (
            id INTEGER PRIMARY KEY NOT NULL,
            conversation_id TEXT NOT NULL,
            conversation_data TEXT NOT NULL,
            last_modified_at TIMESTAMP NOT NULL,
            summary TEXT
        );
        CREATE TABLE agent_tasks (
            id INTEGER PRIMARY KEY NOT NULL,
            conversation_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            task BLOB NOT NULL,
            last_modified_at TIMESTAMP NOT NULL
        );",
    )
    .expect("schema");
    conn.execute(
        "INSERT INTO agent_conversations (
            conversation_id, conversation_data, last_modified_at, summary
         ) VALUES (?1, ?2, ?3, ?4)",
        params![
            "conversation-1",
            r#"{
              "conversation_usage_metadata": {
                "token_usage": [{
                  "model_id": "claude-opus-4-6",
                  "warp_tokens": 120,
                  "byok_tokens": 30,
                  "custom_endpoint_tokens": 0
                }]
              },
              "parent_conversation_id": "parent-1"
            }"#,
            "2026-07-14 01:00:06",
            r#"{
              "initial_query": "Please add Warp history import",
              "title": "Warp importer",
              "initial_working_directory": "/work/orgii",
              "is_restorable": true
            }"#,
        ],
    )
    .expect("conversation");
    conn.execute(
        "INSERT INTO agent_tasks (
            conversation_id, task_id, task, last_modified_at
         ) VALUES (?1, ?2, ?3, ?4)",
        params![
            "conversation-1",
            "task-root",
            fixture_task_blob(),
            "2026-07-14 01:00:06"
        ],
    )
    .expect("task");
    conn
}

#[test]
fn discovers_official_cross_platform_database_paths() {
    let paths = warp_db_candidate_paths_for_home(Path::new("/home/tester"));
    assert!(paths.iter().any(|path| {
        path.ends_with(
            "Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Stable/warp.sqlite",
        )
    }));
    assert!(paths
        .iter()
        .any(|path| path.ends_with(".local/state/warp-terminal/warp.sqlite")));
    assert!(paths
        .iter()
        .any(|path| path.ends_with("AppData/Local/warp/Warp/data/warp.sqlite")));
}

#[test]
fn session_prefix_round_trips() {
    assert_eq!(
        warp_conversation_id_from_session_id("warpapp-conversation-1").unwrap(),
        "conversation-1"
    );
    assert!(warp_conversation_id_from_session_id("warpapp-").is_err());
    assert!(warp_conversation_id_from_session_id("conversation-1").is_err());
}

#[test]
fn reads_real_shaped_sqlite_rows_and_maps_fixture_events() {
    let conn = fixture_db();
    let records = list_conversation_records(&conn).expect("records");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].conversation_id, "conversation-1");
    assert_eq!(records[0].task_count, 1);

    let blobs = load_task_blobs(&conn, "conversation-1").expect("task blobs");
    let analysis = analyze_task_blobs("warpapp-conversation-1", &blobs, 0);
    assert_eq!(analysis.chunks.len(), 5);
    assert_eq!(analysis.chunks[0].function, "user_message");
    assert_eq!(analysis.chunks[1].function, "thinking");
    assert_eq!(analysis.chunks[2].function, "run_command_line");
    assert_eq!(analysis.chunks[3].function, "edit_file_by_replace");
    assert_eq!(analysis.chunks[4].function, "assistant");
    assert!(analysis.chunks[2].result["output"]
        .as_str()
        .unwrap_or_default()
        .contains("agent_conversations"));
    assert_eq!(analysis.model.as_deref(), Some("Claude Opus 4.6"));
    assert_eq!(analysis.impact.files_changed, 2);
    assert_eq!(analysis.impact.lines_removed, 1);
    assert_eq!(analysis.impact.lines_added, 4);
    assert_eq!(
        analysis.impact.touched_files,
        vec!["src/importer.rs".to_string(), "src/warp.rs".to_string()]
    );
}

#[test]
fn metadata_uses_summary_usage_parent_and_invalidates_cache_signatures() {
    let conn = fixture_db();
    let record = list_conversation_records(&conn)
        .expect("records")
        .pop()
        .expect("record");
    let blobs = load_task_blobs(&conn, "conversation-1").expect("task blobs");
    let analysis = analyze_task_blobs("warpapp-conversation-1", &blobs, 0);
    let input =
        conversation_to_cache_input(record.clone(), analysis, Path::new("/tmp/warp.sqlite"));

    assert_eq!(input.session_id, "warpapp-conversation-1");
    assert_eq!(input.name, "Warp importer");
    assert_eq!(input.repo_path.as_deref(), Some("/work/orgii"));
    assert_eq!(input.model.as_deref(), Some("Claude Opus 4.6"));
    assert_eq!(input.input_tokens, 150);
    assert_eq!(input.parent_session_id.as_deref(), Some("warpapp-parent-1"));
    assert!(input.listable);
    assert_eq!(input.parser_version, WARP_METADATA_PARSER_VERSION);

    let cached_signature = ImportedHistoryRecordSignature {
        source_session_id: input.source_session_id.clone(),
        source_path: input.source_path.clone(),
        source_mtime_ms: input.source_mtime_ms,
        source_size_bytes: input.source_size_bytes,
        source_fingerprint: input.source_fingerprint.clone(),
        parser_version: input.parser_version,
    };
    assert!(imported_cache::record_matches_cached_signature(
        &cached_signature,
        &cached_signature
    ));

    let mut parser_changed = cached_signature.clone();
    parser_changed.parser_version += 1;
    assert!(!imported_cache::record_matches_cached_signature(
        &cached_signature,
        &parser_changed
    ));

    let changed = WarpConversationRecord {
        task_bytes: record.task_bytes + 1,
        ..record
    };
    let mut content_changed = cached_signature.clone();
    content_changed.source_fingerprint = warp_source_fingerprint(&changed);
    assert!(!imported_cache::record_matches_cached_signature(
        &cached_signature,
        &content_changed
    ));
    assert!(imported_history::metadata::is_imported_history_source(
        SOURCE_WARP
    ));
}

#[test]
fn missing_tables_and_malformed_tasks_are_safe() {
    let empty = Connection::open_in_memory().expect("in-memory db");
    assert!(list_conversation_records(&empty).unwrap().is_empty());

    let analysis = analyze_task_blobs("warpapp-bad", &[vec![0xff, 0x00]], 0);
    assert!(analysis.chunks.is_empty());
}

#[test]
fn supports_pre_summary_agent_conversations_schema() {
    let conn = Connection::open_in_memory().expect("in-memory db");
    conn.execute_batch(
        "CREATE TABLE agent_conversations (
            id INTEGER PRIMARY KEY NOT NULL,
            conversation_id TEXT NOT NULL,
            conversation_data TEXT NOT NULL,
            last_modified_at TIMESTAMP NOT NULL
        );
        CREATE TABLE agent_tasks (
            id INTEGER PRIMARY KEY NOT NULL,
            conversation_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            task BLOB NOT NULL,
            last_modified_at TIMESTAMP NOT NULL
        );
        INSERT INTO agent_conversations (
            conversation_id, conversation_data, last_modified_at
        ) VALUES ('legacy', '{}', '2026-07-14 00:00:00');",
    )
    .expect("legacy schema");

    let rows = list_conversation_records(&conn).expect("legacy records");
    assert_eq!(rows.len(), 1);
    assert!(rows[0].summary_json.is_none());
}
