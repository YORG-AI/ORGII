use prost_reflect::prost::Message as _;

use super::*;
use crate::projectors::turn_metadata::TurnMetadataAccumulator;

fn temp_db(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "orgii-structured-replay-{name}-{}-{}.db",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ))
}

fn update_test_hash(mut hash: u64, text: &str) -> u64 {
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn read_full_payload(
    cache: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
) -> String {
    let mut restored = String::new();
    let mut offset = 0_u64;
    loop {
        let range = crate::sources::imported_history::replay::read_payload_range(
            cache,
            source,
            session_id,
            generation,
            event_id,
            field_path,
            offset,
            Some(crate::sources::imported_history::replay::HARD_MAX_PAYLOAD_RANGE_BYTES),
        )
        .expect("structured replay payload range");
        assert_eq!(range.offset, offset);
        assert!(range.next_offset > offset || range.eof);
        restored.push_str(&range.text);
        offset = range.next_offset;
        if range.eof {
            assert_eq!(offset, range.total_bytes);
            break;
        }
    }
    restored
}

fn cache_for(
    source: ImportedHistorySourceId,
    source_session_id: &str,
    source_path: &Path,
) -> (Connection, String) {
    use crate::store::sqlite::SqliteRecordStore;

    let cache = Connection::open_in_memory().expect("replay cache");
    SqliteRecordStore::init_tables(&cache).expect("replay tables");
    SqliteRecordStore::init_source_cache_tables(&cache).expect("source cache tables");
    let session_id = format!(
        "{}{}",
        source.descriptor().session_prefix,
        source_session_id
    );
    cache
        .execute(
            "INSERT INTO imported_history_session_cache(
                     source,source_session_id,session_id,source_path
                 ) VALUES(?1,?2,?3,?4)",
            params![
                source.as_str(),
                source_session_id,
                session_id,
                source_path.to_string_lossy()
            ],
        )
        .expect("cache source binding");
    (cache, session_id)
}

fn cursor_manifest(ids: &[String]) -> Vec<u8> {
    let mut manifest = Vec::new();
    for id in ids {
        manifest.extend_from_slice(&[0x0a, 32]);
        manifest.extend_from_slice(&hex_decode(id).expect("blob id"));
    }
    manifest
}

fn put_cursor_blob(conn: &Connection, byte: u8, data: &[u8]) -> String {
    let id = hex_encode(&[byte; 32]);
    conn.execute(
        "INSERT OR REPLACE INTO blobs(id,data) VALUES(?1,?2)",
        params![id, data],
    )
    .expect("insert Cursor blob");
    id
}

fn publish_cursor_root(conn: &Connection, root_byte: u8, ids: &[String]) {
    let root_id = put_cursor_blob(conn, root_byte, &cursor_manifest(ids));
    let meta = json!({
        "agentId":"cursor-1",
        "latestRootBlobId":root_id,
        "createdAt":1_700_000_000_000_i64,
    })
    .to_string();
    conn.execute(
        "INSERT INTO meta(key,value) VALUES('0',?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [hex_encode(meta.as_bytes())],
    )
    .expect("publish Cursor root");
}

fn encode_warp_fixture(value: Value) -> Vec<u8> {
    let pool = match &*WARP_DESCRIPTOR_POOL {
        Ok(pool) => pool,
        Err(error) => panic!("Warp descriptor: {error}"),
    };
    let descriptor = pool
        .get_message_by_name(WARP_TASK_PROTO_NAME)
        .expect("Warp task descriptor");
    let encoded = value.to_string();
    let mut deserializer = serde_json::Deserializer::from_str(&encoded);
    DynamicMessage::deserialize(descriptor, &mut deserializer)
        .expect("Warp task JSON")
        .encode_to_vec()
}

fn metadata_from_chunks(chunks: &[ActivityChunk]) -> TurnMetadataAccumulator {
    let mut metadata = TurnMetadataAccumulator::new();
    for chunk in chunks {
        metadata.add_event_values_at(
            Some(&chunk.function),
            &chunk.args,
            &chunk.result,
            &chunk.created_at,
        );
    }
    metadata
}

fn assert_projected_metadata_matches(
    cache: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    expected: &TurnMetadataAccumulator,
) {
    let projected = crate::sources::imported_history::replay::project_turn_metadata(
        cache, source, session_id, None,
    )
    .expect("project compact replay metadata");
    assert_eq!(projected.len(), 1);
    assert_eq!(projected[0].modified_files, expected.modified_files());
    assert_eq!(
        serde_json::to_value(&projected[0].resource_interactions).unwrap(),
        serde_json::to_value(expected.resource_interactions()).unwrap()
    );
    let mut actual_artifacts = projected[0]
        .git_artifacts
        .iter()
        .map(|artifact| serde_json::to_string(artifact).unwrap())
        .collect::<Vec<_>>();
    let mut expected_artifacts = expected
        .git_artifacts()
        .iter()
        .map(|artifact| serde_json::to_string(artifact).unwrap())
        .collect::<Vec<_>>();
    actual_artifacts.sort();
    expected_artifacts.sort();
    assert_eq!(actual_artifacts, expected_artifacts);
}

#[test]
fn cursor_manifest_prefix_hash_detects_reorder() {
    fn manifest(ids: &[[u8; 32]]) -> Vec<u8> {
        let mut out = Vec::new();
        for id in ids {
            out.extend_from_slice(&[0x0a, 32]);
            out.extend_from_slice(id);
        }
        out
    }
    let first = manifest(&[[1; 32], [2; 32]]);
    let appended = manifest(&[[1; 32], [2; 32], [3; 32]]);
    let reordered = manifest(&[[2; 32], [1; 32], [3; 32]]);
    let (_, expected) = manifest_prefix_hash(&first, 2).expect("prefix");
    assert_eq!(manifest_prefix_hash(&appended, 2).unwrap().1, expected);
    assert_ne!(manifest_prefix_hash(&reordered, 2).unwrap().1, expected);
}

#[test]
fn range_reader_preserves_utf8_boundaries() {
    let text = "你".repeat(100);
    let range = range_from_text("event", "result.output", &text, 1, 17).expect("range");
    assert!(range.text.is_char_boundary(range.text.len()));
    assert!(range.next_offset > range.offset);

    let one_byte = range_from_text("event", "result.output", &text, 0, 1).expect("small range");
    assert_eq!(one_byte.text, "你");
    assert_eq!(one_byte.next_offset, 3);
}

#[test]
fn structured_compaction_keeps_edit_scalars_and_full_git_summary() {
    let mut edit = ActivityChunk::new(
        "structured",
        "tool_call",
        imported_history::FUNCTION_EDIT_FILE,
    );
    edit.args = json!({
        "file_path":"src/large.rs",
        "action":"replace",
        "operation":"update",
        "linesAdded":17,
        "linesRemoved":9,
        "content":"line\n".repeat(4_000),
    });
    edit.result = json!({"output":"updated"});
    compact_chunk(&mut edit, "edit-locator");
    assert_eq!(edit.args["linesAdded"], 17);
    assert_eq!(edit.args["linesRemoved"], 9);
    assert_eq!(edit.args["operation"], "update");
    assert_eq!(edit.result["linesAdded"], 17);
    assert_eq!(edit.result["linesRemoved"], 9);

    let mut shell = ActivityChunk::new(
        "structured",
        "tool_call",
        imported_history::FUNCTION_RUN_COMMAND_LINE,
    );
    shell.args = json!({"command":"git commit -m metadata"});
    shell.result = json!({
        "output":format!(
            "[feature abc1234] metadata\n{}\nhttps://github.com/acme/repo/pull/42",
            "middle".repeat(14 * 1024)
        )
    });
    assert!(shell.result["output"].as_str().unwrap().len() > 80 * 1024);
    compact_chunk(&mut shell, "shell-locator");
    let metadata = metadata_from_chunks(&[edit, shell]);
    assert_eq!(metadata.modified_files()[0].additions, 17);
    assert_eq!(metadata.modified_files()[0].deletions, 9);
    assert!(metadata
        .git_artifacts()
        .iter()
        .any(|artifact| artifact.sha.as_deref() == Some("abc1234")));
    assert!(metadata
        .git_artifacts()
        .iter()
        .any(|artifact| artifact.pr_number == Some(42)));
}

#[test]
fn structured_path_plus_ten_mib_content_round_trips_exact_root_args() {
    let path = temp_db("cursor-root-args");
    let source = Connection::open(&path).expect("Cursor root-args source");
    source
        .execute_batch(
            "PRAGMA journal_mode=WAL;
                 CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB);
                 CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);",
        )
        .expect("Cursor root-args schema");
    let user = put_cursor_blob(
        &source,
        71,
        br#"{"role":"user","content":"<user_query>large args</user_query>"}"#,
    );
    let original_args = json!({
        "path":"src/structured-huge.txt",
        "content":format!("BEGIN{}END", "你".repeat((10 * 1024 * 1024) / 3)),
    });
    let expected_json = serde_json::to_string(&original_args).expect("baseline args JSON");
    let tool_call = put_cursor_blob(
        &source,
        72,
        json!({
            "role":"assistant",
            "content":[{
                "type":"tool-call",
                "toolCallId":"large-args-call",
                "toolName":"custom_tool",
                "args":original_args
            }]
        })
        .to_string()
        .as_bytes(),
    );
    let tool_result = put_cursor_blob(
            &source,
            73,
            br#"{"role":"tool","content":[{"type":"tool-result","toolCallId":"large-args-call","result":"ok"}]}"#,
        );
    publish_cursor_root(&source, 74, &[user, tool_call, tool_result]);
    drop(source);

    let (mut cache, session_id) = cache_for(ImportedHistorySourceId::CursorCli, "cursor-1", &path);
    let legacy = crate::sources::cursor_cli::history::load_cursor_cli_history_for_session(
        &cache,
        &session_id,
    )
    .expect("old full Cursor history baseline");
    let expected_args = legacy
        .iter()
        .find(|chunk| chunk.function == "custom_tool")
        .expect("legacy custom tool")
        .args
        .clone();
    assert_eq!(
        expected_args,
        serde_json::from_str::<Value>(&expected_json).unwrap()
    );

    let opened = crate::sources::imported_history::replay::open_window(
        &mut cache,
        ImportedHistorySourceId::CursorCli,
        &session_id,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("open structured root args fixture");
    let indexed = opened
        .chunks
        .iter()
        .find(|event| event.chunk.function == "custom_tool")
        .expect("bounded custom tool event");
    assert_eq!(indexed.chunk.args["path"], "src/structured-huge.txt");
    assert_eq!(indexed.chunk.args["_replayTruncated"], true);
    assert!(indexed.chunk.args.get("content").is_none());
    assert_eq!(indexed.payloads.len(), 1);
    assert_eq!(indexed.payloads[0].field_path, "args");

    reset_payload_fallback_decodes();
    let restored = read_full_payload(
        &mut cache,
        ImportedHistorySourceId::CursorCli,
        &session_id,
        &opened.cursor.generation,
        &indexed.chunk.chunk_id,
        "args",
    );
    assert_eq!(restored.len(), expected_json.len());
    assert_eq!(
        update_test_hash(0xcbf29ce484222325, &restored),
        update_test_hash(0xcbf29ce484222325, &expected_json)
    );
    assert_eq!(
        serde_json::from_str::<Value>(&restored).expect("restored structured args"),
        expected_args
    );
    assert!(!restored.contains("_replayTruncated"));
    assert!(!restored.contains("[payload truncated]"));
    assert_eq!(payload_fallback_decodes(), 0);
    let _ = std::fs::remove_file(path);
}

#[test]
fn cursor_cli_public_replay_is_bounded_incremental_and_resets_on_reorder() {
    let path = temp_db("cursor");
    let source = Connection::open(&path).expect("Cursor source");
    source
        .execute_batch(
            "PRAGMA journal_mode=WAL;
                 CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB);
                 CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);",
        )
        .expect("Cursor schema");
    let user = put_cursor_blob(
        &source,
        1,
        br#"{"role":"user","content":"<user_query>hello</user_query>"}"#,
    );
    let large_text = "cursor-large-".repeat(900_000);
    let assistant = put_cursor_blob(
        &source,
        2,
        json!({"role":"assistant","content":[{"type":"text","text":large_text}]})
            .to_string()
            .as_bytes(),
    );
    let tool_call = put_cursor_blob(
            &source,
            4,
            br#"{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call-1","toolName":"shell","args":{"command":"pwd"}}]}"#,
        );
    publish_cursor_root(
        &source,
        20,
        &[user.clone(), assistant.clone(), tool_call.clone()],
    );
    drop(source);

    let (mut cache, session_id) = cache_for(ImportedHistorySourceId::CursorCli, "cursor-1", &path);
    let opened = crate::sources::imported_history::replay::open_window(
        &mut cache,
        ImportedHistorySourceId::CursorCli,
        &session_id,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("open Cursor bounded replay");
    assert_eq!(opened.chunks.len(), 3);
    assert!(opened.stats.parsed_bytes > 0);
    let assistant_event = opened
        .chunks
        .iter()
        .find(|event| event.chunk.function == imported_history::FUNCTION_ASSISTANT)
        .expect("assistant event");
    assert!(
        assistant_event.chunk.result["content"]
            .as_str()
            .unwrap_or_default()
            .len()
            < NORMAL_PAYLOAD_PREVIEW_BYTES + 64
    );
    let artifact_count = cache
        .query_row(
            "SELECT COUNT(*) FROM imported_replay_payload_artifacts
                 WHERE source='cursor_cli' AND generation=?1",
            [&opened.cursor.generation],
            |row| row.get::<_, i64>(0),
        )
        .expect("Cursor payload artifact count");
    assert_eq!(artifact_count, 1);
    reset_payload_fallback_decodes();
    let mut cursor_payload_hash = 0xcbf29ce484222325_u64;
    let mut cursor_payload_bytes = 0_usize;
    let mut payload_offset = 0_u64;
    loop {
        let range = crate::sources::imported_history::replay::read_payload_range(
            &mut cache,
            ImportedHistorySourceId::CursorCli,
            &session_id,
            &opened.cursor.generation,
            &assistant_event.chunk.chunk_id,
            "result.content",
            payload_offset,
            Some(crate::sources::imported_history::replay::HARD_MAX_PAYLOAD_RANGE_BYTES),
        )
        .expect("Cursor payload artifact page");
        assert!(
            range.text.len()
                <= crate::sources::imported_history::replay::HARD_MAX_PAYLOAD_RANGE_BYTES
        );
        assert!(range.next_offset > payload_offset || range.eof);
        cursor_payload_hash = update_test_hash(cursor_payload_hash, &range.text);
        cursor_payload_bytes = cursor_payload_bytes.saturating_add(range.text.len());
        payload_offset = range.next_offset;
        if range.eof {
            break;
        }
    }
    assert_eq!(cursor_payload_bytes, large_text.len());
    assert_eq!(
        cursor_payload_hash,
        update_test_hash(0xcbf29ce484222325, &large_text)
    );
    assert_eq!(payload_fallback_decodes(), 0);
    let pending_tool_id = opened
        .chunks
        .iter()
        .find(|event| event.chunk.function == imported_history::FUNCTION_RUN_COMMAND_LINE)
        .expect("pending Cursor tool")
        .chunk
        .chunk_id
        .clone();

    let unchanged = crate::sources::imported_history::replay::poll_delta(
        &mut cache,
        ImportedHistorySourceId::CursorCli,
        &session_id,
        &opened.cursor,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("unchanged Cursor poll");
    assert_eq!(unchanged.stats.parsed_rows, 0);
    assert_eq!(unchanged.stats.upserted_events, 0);

    let source = Connection::open(&path).expect("reopen Cursor source");
    let second_user = put_cursor_blob(
        &source,
        3,
        br#"{"role":"user","content":"<user_query>second</user_query>"}"#,
    );
    publish_cursor_root(
        &source,
        21,
        &[
            user.clone(),
            assistant.clone(),
            tool_call.clone(),
            second_user.clone(),
        ],
    );
    drop(source);
    let appended = crate::sources::imported_history::replay::poll_delta(
        &mut cache,
        ImportedHistorySourceId::CursorCli,
        &session_id,
        &opened.cursor,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("Cursor append delta");
    assert!(!appended.reset_required);
    assert_eq!(appended.chunks.len(), 1);
    assert_eq!(appended.stats.parsed_rows, 1);

    let source = Connection::open(&path).expect("reopen Cursor result source");
    let tool_result = put_cursor_blob(
            &source,
            5,
            br#"{"role":"tool","content":[{"type":"tool-result","toolCallId":"call-1","result":"/repo"}]}"#,
        );
    publish_cursor_root(
        &source,
        22,
        &[
            user.clone(),
            assistant.clone(),
            tool_call.clone(),
            second_user.clone(),
            tool_result.clone(),
        ],
    );
    drop(source);
    let completed_tool = crate::sources::imported_history::replay::poll_delta(
        &mut cache,
        ImportedHistorySourceId::CursorCli,
        &session_id,
        &appended.cursor,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("Cursor cross-root tool result delta");
    assert!(!completed_tool.reset_required);
    assert_eq!(completed_tool.chunks.len(), 1);
    assert_eq!(completed_tool.chunks[0].chunk.chunk_id, pending_tool_id);
    assert!(completed_tool.chunks[0]
        .chunk
        .result
        .to_string()
        .contains("/repo"));

    let source = Connection::open(&path).expect("reopen Cursor source for fork");
    publish_cursor_root(
        &source,
        23,
        &[second_user, user, assistant, tool_call, tool_result],
    );
    drop(source);
    let reset = crate::sources::imported_history::replay::poll_delta(
        &mut cache,
        ImportedHistorySourceId::CursorCli,
        &session_id,
        &completed_tool.cursor,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("Cursor reorder reset");
    assert!(reset.reset_required);
    assert_ne!(reset.cursor.generation, completed_tool.cursor.generation);
    let _ = std::fs::remove_file(path);
}

#[test]
fn cursor_cli_compact_projection_matches_full_large_edit_and_git_output() {
    let path = temp_db("cursor-metadata");
    let source = Connection::open(&path).expect("Cursor metadata source");
    source
        .execute_batch(
            "PRAGMA journal_mode=WAL;
                 CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB);
                 CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);",
        )
        .expect("Cursor metadata schema");
    let user = put_cursor_blob(
        &source,
        31,
        br#"{"role":"user","content":"<user_query>metadata</user_query>"}"#,
    );
    let edit_args = json!({
        "file_path":"src/cursor-large.rs",
        "old_string":"old\nvalue",
        "new_string":"new line\n".repeat(2_000),
        "operation":"replace",
    });
    assert!(edit_args.to_string().len() > NORMAL_PAYLOAD_PREVIEW_BYTES);
    let edit_call = put_cursor_blob(
        &source,
        32,
        json!({
            "role":"assistant",
            "content":[{
                "type":"tool-call","toolCallId":"edit-1",
                "toolName":"search_replace","args":edit_args
            }]
        })
        .to_string()
        .as_bytes(),
    );
    let edit_result = put_cursor_blob(
            &source,
            33,
            br#"{"role":"tool","content":[{"type":"tool-result","toolCallId":"edit-1","result":"done"}]}"#,
        );
    let shell_call = put_cursor_blob(
            &source,
            34,
            br#"{"role":"assistant","content":[{"type":"tool-call","toolCallId":"git-1","toolName":"shell","args":{"command":"git commit -m metadata"}}]}"#,
        );
    let git_output = format!(
        "[feature abc1234] metadata\n{}\nhttps://github.com/acme/cursor/pull/77",
        "middle".repeat(14 * 1024)
    );
    assert!(git_output.len() > 80 * 1024);
    let shell_result = put_cursor_blob(
        &source,
        35,
        json!({
            "role":"tool",
            "content":[{"type":"tool-result","toolCallId":"git-1","result":git_output}]
        })
        .to_string()
        .as_bytes(),
    );
    publish_cursor_root(
        &source,
        36,
        &[user, edit_call, edit_result, shell_call, shell_result],
    );
    drop(source);

    let (mut cache, session_id) = cache_for(ImportedHistorySourceId::CursorCli, "cursor-1", &path);
    let legacy = crate::sources::cursor_cli::history::load_cursor_cli_history_for_session(
        &cache,
        &session_id,
    )
    .expect("load full Cursor metadata baseline");
    let expected_shell_result = legacy
        .iter()
        .find(|chunk| chunk.function == imported_history::FUNCTION_RUN_COMMAND_LINE)
        .expect("legacy Cursor shell")
        .result
        .clone();
    let expected = metadata_from_chunks(&legacy);
    assert!(expected
        .modified_files()
        .iter()
        .any(|file| file.path == "src/cursor-large.rs"));
    assert!(expected
        .git_artifacts()
        .iter()
        .any(|artifact| artifact.sha.as_deref() == Some("abc1234")));
    assert!(expected
        .git_artifacts()
        .iter()
        .any(|artifact| artifact.pr_number == Some(77)));
    assert_projected_metadata_matches(
        &mut cache,
        ImportedHistorySourceId::CursorCli,
        &session_id,
        &expected,
    );
    let opened = crate::sources::imported_history::replay::open_window(
        &mut cache,
        ImportedHistorySourceId::CursorCli,
        &session_id,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("open compact Cursor metadata replay");
    let compact_shell = opened
        .chunks
        .iter()
        .find(|event| event.chunk.function == imported_history::FUNCTION_RUN_COMMAND_LINE)
        .expect("compact Cursor shell");
    assert!(compact_shell
        .chunk
        .result
        .get("_replayGitArtifacts")
        .is_some());
    assert!(compact_shell
        .payloads
        .iter()
        .any(|payload| payload.field_path == "result"));
    assert!(!compact_shell
        .payloads
        .iter()
        .any(|payload| payload.field_path.starts_with("result.")));
    let restored_result = read_full_payload(
        &mut cache,
        ImportedHistorySourceId::CursorCli,
        &session_id,
        &opened.cursor.generation,
        &compact_shell.chunk.chunk_id,
        "result",
    );
    let restored_result: Value =
        serde_json::from_str(&restored_result).expect("exact Cursor shell result");
    assert_eq!(restored_result, expected_shell_result);
    assert!(restored_result.get("_replayGitArtifacts").is_none());
    let _ = std::fs::remove_file(path);
}

#[test]
fn warp_task_rows_reconcile_insert_delete_rowid_reuse_and_schema_reset() {
    let path = temp_db("warp");
    let source = Connection::open(&path).expect("Warp source");
    source
        .execute_batch(
            "PRAGMA journal_mode=WAL;
                 CREATE TABLE agent_conversations(
                     id INTEGER PRIMARY KEY,conversation_id TEXT,conversation_data TEXT,
                     last_modified_at TEXT,summary TEXT
                 );
                 CREATE TABLE agent_tasks(
                     id INTEGER PRIMARY KEY,conversation_id TEXT,task_id TEXT,
                     task BLOB,last_modified_at TEXT
                 );",
        )
        .expect("Warp schema");
    source
        .execute(
            "INSERT INTO agent_conversations(
                     id,conversation_id,conversation_data,last_modified_at,summary
                 ) VALUES(1,'conversation-1','{}','2026-07-14 01:00:06','{}')",
            [],
        )
        .expect("Warp conversation");
    let mut fixture: Value = serde_json::from_str(include_str!("../../../fixtures/warp_task.json"))
        .expect("Warp fixture JSON");
    fixture["messages"][2]["toolCall"]["runShellCommand"]["command"] =
        Value::String("git commit -m metadata".to_string());
    let git_output = format!(
        "[feature def5678] metadata\n{}\nhttps://github.com/acme/warp/pull/88",
        "middle".repeat(14 * 1024)
    );
    assert!(git_output.len() > 80 * 1024);
    fixture["messages"][3]["toolCallResult"]["runShellCommand"]["commandFinished"]["output"] =
        Value::String(git_output);
    fixture["messages"][4]["toolCall"]["applyFileDiffs"]["diffs"][0]["replace"] =
        Value::String("new line\n".repeat(2_000));
    assert!(
        fixture["messages"][4]["toolCall"]["applyFileDiffs"]
            .to_string()
            .len()
            > NORMAL_PAYLOAD_PREVIEW_BYTES
    );
    let large_text = "warp-large-".repeat(900_000);
    fixture["messages"][6]["agentOutput"]["text"] = Value::String(large_text.clone());
    let blob = encode_warp_fixture(fixture.clone());
    let legacy_chunks = normalize_warp_task("warpapp-conversation-1", &blob, 0)
        .expect("normalize full Warp metadata baseline");
    let legacy_edit = legacy_chunks
        .iter()
        .find(|chunk| chunk.function == imported_history::FUNCTION_EDIT_FILE)
        .expect("Warp edit chunk");
    assert_eq!(legacy_edit.args["file_path"], "src/importer.rs");
    let expected = metadata_from_chunks(&legacy_chunks);
    assert!(expected
        .modified_files()
        .iter()
        .any(|file| file.path == "src/importer.rs"));
    assert!(expected
        .git_artifacts()
        .iter()
        .any(|artifact| artifact.sha.as_deref() == Some("def5678")));
    assert!(expected
        .git_artifacts()
        .iter()
        .any(|artifact| artifact.pr_number == Some(88)));
    source
        .execute(
            "INSERT INTO agent_tasks(
                     id,conversation_id,task_id,task,last_modified_at
                 ) VALUES(1,'conversation-1','task-root',?1,'2026-07-14 01:00:06')",
            [&blob],
        )
        .expect("Warp task");
    drop(source);

    let (mut cache, session_id) = cache_for(ImportedHistorySourceId::Warp, "conversation-1", &path);
    let opened = crate::sources::imported_history::replay::open_window(
        &mut cache,
        ImportedHistorySourceId::Warp,
        &session_id,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("open Warp bounded replay");
    assert_eq!(opened.chunks.len(), 5);
    assert_projected_metadata_matches(
        &mut cache,
        ImportedHistorySourceId::Warp,
        &session_id,
        &expected,
    );
    let assistant_event = opened
        .chunks
        .iter()
        .find(|event| event.chunk.function == imported_history::FUNCTION_ASSISTANT)
        .expect("Warp assistant");
    let assistant_artifacts = cache
        .query_row(
            "SELECT COUNT(DISTINCT content_hash) FROM imported_replay_payload_artifact_refs
                 WHERE source='warp' AND generation=?1 AND event_id=?2",
            params![&opened.cursor.generation, &assistant_event.chunk.chunk_id],
            |row| row.get::<_, i64>(0),
        )
        .expect("Warp payload artifact ref count");
    assert_eq!(
        assistant_artifacts, 1,
        "duplicate compatibility fields share one body"
    );
    reset_payload_fallback_decodes();
    let mut warp_payload_hash = 0xcbf29ce484222325_u64;
    let mut warp_payload_bytes = 0_usize;
    let mut payload_offset = 0_u64;
    loop {
        let range = crate::sources::imported_history::replay::read_payload_range(
            &mut cache,
            ImportedHistorySourceId::Warp,
            &session_id,
            &opened.cursor.generation,
            &assistant_event.chunk.chunk_id,
            "result.content",
            payload_offset,
            Some(crate::sources::imported_history::replay::HARD_MAX_PAYLOAD_RANGE_BYTES),
        )
        .expect("Warp payload artifact page");
        assert!(
            range.text.len()
                <= crate::sources::imported_history::replay::HARD_MAX_PAYLOAD_RANGE_BYTES
        );
        assert!(range.next_offset > payload_offset || range.eof);
        warp_payload_hash = update_test_hash(warp_payload_hash, &range.text);
        warp_payload_bytes = warp_payload_bytes.saturating_add(range.text.len());
        payload_offset = range.next_offset;
        if range.eof {
            break;
        }
    }
    assert_eq!(warp_payload_bytes, large_text.len());
    assert_eq!(
        warp_payload_hash,
        update_test_hash(0xcbf29ce484222325, &large_text)
    );
    assert_eq!(payload_fallback_decodes(), 0);

    let unchanged = crate::sources::imported_history::replay::poll_delta(
        &mut cache,
        ImportedHistorySourceId::Warp,
        &session_id,
        &opened.cursor,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("unchanged Warp poll");
    assert_eq!(unchanged.stats.parsed_rows, 0);
    assert_eq!(unchanged.stats.upserted_events, 0);

    let source = Connection::open(&path).expect("reopen Warp source");
    source
        .execute(
            "UPDATE agent_tasks SET last_modified_at='2026-07-14 01:00:06.5' WHERE id=1",
            [],
        )
        .expect("update Warp row metadata");
    drop(source);
    let metadata_only = crate::sources::imported_history::replay::poll_delta(
        &mut cache,
        ImportedHistorySourceId::Warp,
        &session_id,
        &unchanged.cursor,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("Warp metadata-only poll");
    assert_eq!(metadata_only.stats.parsed_rows, 0);
    assert_eq!(metadata_only.stats.upserted_events, 0);
    assert_eq!(metadata_only.cursor.revision, unchanged.cursor.revision);

    let source = Connection::open(&path).expect("reopen Warp source");
    fixture["messages"][6]["agentOutput"]["text"] = Value::String(format!("{large_text}-changed"));
    let updated_blob = encode_warp_fixture(fixture);
    source
        .execute(
            "UPDATE agent_tasks SET task=?1,last_modified_at='2026-07-14 01:00:07' WHERE id=1",
            [&updated_blob],
        )
        .expect("update one Warp event inside task BLOB");
    drop(source);
    let updated = crate::sources::imported_history::replay::poll_delta(
        &mut cache,
        ImportedHistorySourceId::Warp,
        &session_id,
        &metadata_only.cursor,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("Warp task update delta");
    assert_eq!(updated.stats.parsed_rows, 1);
    assert_eq!(updated.stats.upserted_events, 1);
    assert_eq!(updated.chunks.len(), 1);
    let updated_assistant = updated
        .chunks
        .iter()
        .find(|event| event.chunk.function == imported_history::FUNCTION_ASSISTANT)
        .expect("updated Warp assistant");
    let updated_tail = crate::sources::imported_history::replay::read_payload_range(
        &mut cache,
        ImportedHistorySourceId::Warp,
        &session_id,
        &updated.cursor.generation,
        &updated_assistant.chunk.chunk_id,
        "result.content",
        large_text.len() as u64,
        Some(32),
    )
    .expect("updated Warp artifact tail");
    assert_eq!(updated_tail.text, "-changed");
    assert_eq!(payload_fallback_decodes(), 0);

    let source = Connection::open(&path).expect("reopen Warp source");
    source
        .execute("DELETE FROM agent_tasks WHERE id=1", [])
        .expect("delete Warp task");
    drop(source);
    let deleted = crate::sources::imported_history::replay::poll_delta(
        &mut cache,
        ImportedHistorySourceId::Warp,
        &session_id,
        &updated.cursor,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("Warp delete delta");
    assert_eq!(deleted.removed_event_ids.len(), 5);

    let source = Connection::open(&path).expect("reopen Warp rowid source");
    source
        .execute(
            "INSERT INTO agent_tasks(
                     id,conversation_id,task_id,task,last_modified_at
                 ) VALUES(1,'conversation-1','task-root',?1,'2026-07-14 01:00:07')",
            [&blob],
        )
        .expect("reuse Warp rowid");
    drop(source);
    let reinserted = crate::sources::imported_history::replay::poll_delta(
        &mut cache,
        ImportedHistorySourceId::Warp,
        &session_id,
        &deleted.cursor,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("Warp rowid reuse delta");
    assert_eq!(reinserted.chunks.len(), 5);

    let source = Connection::open(&path).expect("reopen Warp schema source");
    source
        .execute("ALTER TABLE agent_tasks ADD COLUMN extra TEXT", [])
        .expect("change Warp schema");
    drop(source);
    let reset = crate::sources::imported_history::replay::poll_delta(
        &mut cache,
        ImportedHistorySourceId::Warp,
        &session_id,
        &reinserted.cursor,
        crate::sources::imported_history::replay::ReplayLimits::default(),
    )
    .expect("Warp schema reset");
    assert!(reset.reset_required);
    let _ = std::fs::remove_file(path);
}
