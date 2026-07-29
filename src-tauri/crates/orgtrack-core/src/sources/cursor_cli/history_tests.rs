use super::*;
use rusqlite::Connection;
use serde_json::Value;

const SESSION_UUID: &str = "659c70e0-7bc7-461d-addf-58a2d0db851b";
const ROOT_BLOB_ID_BYTE: u8 = 0xAA;

fn blob_id(id_byte: u8) -> [u8; 32] {
    [id_byte; 32]
}

fn push_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

/// Encode the root manifest: repeated field 1 message hashes, field 5 token
/// usage `{1: used, 2: window}`, field 9 workspace `file://` URI.
fn manifest_bytes(message_ids: &[[u8; 32]], context_tokens: u64, workspace_uri: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for hash in message_ids {
        out.push(0x0a); // field 1, wire type 2
        out.push(32);
        out.extend_from_slice(hash);
    }
    let mut usage = Vec::new();
    usage.push(0x08); // field 1, varint
    push_varint(&mut usage, context_tokens);
    usage.push(0x10); // field 2, varint
    push_varint(&mut usage, 200_000);
    out.push(0x2a); // field 5, wire type 2
    out.push(usage.len() as u8);
    out.extend_from_slice(&usage);
    out.push(0x4a); // field 9, wire type 2
    out.push(workspace_uri.len() as u8);
    out.extend_from_slice(workspace_uri.as_bytes());
    out
}

fn insert_blob(conn: &Connection, id: &[u8; 32], data: &[u8]) {
    conn.execute(
        "INSERT OR REPLACE INTO blobs (id, data) VALUES (?1, ?2)",
        rusqlite::params![hex_encode(id), data],
    )
    .expect("insert blob");
}

fn insert_json_blob(conn: &Connection, id_byte: u8, json: &str) -> [u8; 32] {
    let id = blob_id(id_byte);
    insert_blob(conn, &id, json.as_bytes());
    id
}

/// In-memory replica of a cursor-agent `store.db` with a small conversation:
/// system prompt, `<user_info>` injection, a real `<user_query>` turn, an
/// assistant think+text+tool-call, the tool result, the agent loop's
/// re-injection of the same user query, and a final assistant message.
fn fixture_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory store");
    conn.execute_batch(
        "CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
         CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);",
    )
    .expect("create store schema");

    let system = insert_json_blob(
        &conn,
        0x01,
        r#"{"role":"system","content":"You are a powerful agentic AI coding assistant."}"#,
    );
    let user_info = insert_json_blob(
        &conn,
        0x02,
        r#"{"role":"user","content":"<user_info>\nOS Version: darwin\n</user_info>"}"#,
    );
    let user_query = insert_json_blob(
        &conn,
        0x03,
        r#"{"role":"user","content":[{"type":"text","text":"<user_query>\nUSER REQUEST:\nFix the login bug\n\n---\nModel: auto\n\nSELECTED COMPONENT:\nclassName=\"login\"\n---\n</user_query>"}]}"#,
    );
    let assistant = insert_json_blob(
        &conn,
        0x04,
        r#"{"id":"1","role":"assistant","content":[{"type":"text","text":"<think>\nFind the login handler first.\n</think>\nSearching for the login handler.\n"},{"type":"tool-call","toolCallId":"tool_1","toolName":"search_replace","args":{"file_path":"src/login.ts","old_string":"old line","new_string":"new line\nextra line"}}]}"#,
    );
    let tool_result = insert_json_blob(
        &conn,
        0x05,
        r#"{"role":"tool","id":"tool_1","content":[{"type":"tool-result","toolCallId":"tool_1","toolName":"search_replace","result":"The file src/login.ts has been edited."}]}"#,
    );
    let assistant_done = insert_json_blob(
        &conn,
        0x06,
        r#"{"role":"assistant","content":[{"type":"text","text":"Done."}]}"#,
    );

    let root = manifest_bytes(
        &[
            system,
            user_info,
            user_query,
            assistant,
            tool_result,
            user_query, // agent-loop re-injection (same content-addressed blob)
            assistant_done,
        ],
        27_287,
        "file:///tmp/cursor%20repo",
    );
    let root_id = blob_id(ROOT_BLOB_ID_BYTE);
    insert_blob(&conn, &root_id, &root);

    let meta_json = format!(
        r#"{{"agentId":"{SESSION_UUID}","latestRootBlobId":"{}","name":"New Agent","mode":"default","createdAt":1764743137943,"lastUsedModel":"composer-1"}}"#,
        hex_encode(&root_id),
    );
    // Real stores hex-encode the meta JSON; the fixture does the same so the
    // decode path is exercised.
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('0', ?1)",
        [hex_encode(meta_json.as_bytes())],
    )
    .expect("insert meta");

    conn
}

fn fixture_record() -> ImportedHistoryDiscoveredRecord {
    ImportedHistoryDiscoveredRecord {
        source_session_id: SESSION_UUID.to_string(),
        source_path: PathBuf::from(format!("/tmp/.cursor/chats/hash/{SESSION_UUID}/store.db")),
        source_record_key: SESSION_UUID.to_string(),
        source_mtime_ms: 1_764_743_137_943_000_000,
        source_size_bytes: 4096,
        source_fingerprint: "-wal:1:2|-shm:-".to_string(),
        parser_version: CURSOR_CLI_METADATA_PARSER_VERSION,
    }
}

#[test]
fn parses_store_meta_and_manifest_into_cache_input() {
    let conn = fixture_conn();

    let meta = session_meta_from_store_conn(&conn, &fixture_record(), 1_764_743_200_000)
        .expect("parse meta")
        .expect("session meta present");
    let input = session_meta_to_cache_input(meta);

    assert_eq!(input.source, SOURCE_CURSOR_CLI);
    assert_eq!(input.source_session_id, SESSION_UUID);
    assert_eq!(input.session_id, format!("cursorcliapp-{SESSION_UUID}"));
    // "New Agent" is the store placeholder — the first prompt wins.
    assert_eq!(input.name, "Fix the login bug");
    assert_eq!(input.created_at_ms, 1_764_743_137_943);
    assert_eq!(input.updated_at_ms, 1_764_743_200_000);
    assert_eq!(input.model.as_deref(), Some("composer-1"));
    assert_eq!(input.input_tokens, 27_287);
    assert_eq!(input.output_tokens, 0);
    // Workspace URI is percent-decoded.
    assert_eq!(input.repo_path.as_deref(), Some("/tmp/cursor repo"));
    assert!(input.listable);
    assert!(input.parent_session_id.is_none());
    // Impact from the normalized search_replace edit.
    assert_eq!(input.impact.touched_files, vec!["src/login.ts"]);
    assert_eq!(input.impact.lines_added, 2);
    assert_eq!(input.impact.lines_removed, 1);
}

#[test]
fn parses_store_messages_into_replay_chunks() {
    let conn = fixture_conn();
    let session_id = format!("cursorcliapp-{SESSION_UUID}");

    let chunks = load_history_from_store_conn(&conn, &session_id).expect("load chunks");

    let kinds = chunks
        .iter()
        .map(|chunk| chunk.function.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        kinds,
        vec![
            imported_history::FUNCTION_USER_MESSAGE,
            imported_history::FUNCTION_THINKING,
            imported_history::FUNCTION_ASSISTANT,
            imported_history::FUNCTION_EDIT_FILE,
            imported_history::FUNCTION_ASSISTANT,
        ],
    );

    // User bubble carries only the request — wrapper and element-picker
    // scaffold are stripped, and the loop re-injection is collapsed.
    assert_eq!(
        chunks[0]
            .result
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str),
        Some("Fix the login bug"),
    );
    assert_eq!(
        chunks[1].result.get("thought").and_then(Value::as_str),
        Some("Find the login handler first."),
    );
    assert_eq!(
        chunks[2].result.get("content").and_then(Value::as_str),
        Some("Searching for the login handler."),
    );
    assert_eq!(
        chunks[3].action_type,
        imported_history::ACTION_TYPE_TOOL_CALL
    );
    assert_eq!(
        chunks[3].args.get("file_path").and_then(Value::as_str),
        Some("src/login.ts"),
    );
    assert_eq!(
        chunks[3].result.get("output").and_then(Value::as_str),
        Some("The file src/login.ts has been edited."),
    );
    assert_eq!(
        chunks[3]
            .result
            .get("raw_tool_name")
            .and_then(Value::as_str),
        Some("search_replace"),
    );
    assert_eq!(
        chunks[4].result.get("content").and_then(Value::as_str),
        Some("Done."),
    );
}

#[test]
fn cleans_user_query_wrapper_variants() {
    // Simple form: inline element metadata is kept with the text.
    assert_eq!(
        clean_user_text(
            "<user_query>\nChange to 24 x 24 [Element: <button> 29x26px]\n</user_query>"
        )
        .as_deref(),
        Some("Change to 24 x 24 [Element: <button> 29x26px]"),
    );
    // Element-picker form: request extracted, injected scaffold dropped.
    assert_eq!(
        clean_user_text(
            "<user_query>\nUSER REQUEST:\nChange to text 1\n\n---\nModel: auto\n\nSELECTED COMPONENT:\nfoo\n---\n</user_query>"
        )
        .as_deref(),
        Some("Change to text 1"),
    );
    // Some builds serialize the wrapper with literal `\n` sequences.
    assert_eq!(
        clean_user_text(
            "<user_query>\nUSER REQUEST:\\nEdit the text to purple\\n\\n---\\nModel: auto\\n---\n</user_query>"
        )
        .as_deref(),
        Some("Edit the text to purple"),
    );
    // Environment injection is not a user turn.
    assert_eq!(
        clean_user_text("<user_info>\nOS: darwin\n</user_info>"),
        None
    );
    // Unwrapped text degrades to the raw prompt instead of dropping it.
    assert_eq!(
        clean_user_text("plain prompt with no wrapper").as_deref(),
        Some("plain prompt with no wrapper"),
    );
    assert_eq!(clean_user_text("   "), None);
}

#[test]
fn splits_think_blocks_from_assistant_text() {
    let (thoughts, visible) =
        split_think_blocks("<think>\nplan a\n</think>\nvisible text\n<think>plan b</think> tail");
    assert_eq!(thoughts, vec!["plan a", "plan b"]);
    assert_eq!(visible.trim(), "visible text\n tail".trim());

    // An unclosed block swallows the rest as thought.
    let (thoughts, visible) = split_think_blocks("lead <think>never closed");
    assert_eq!(thoughts, vec!["never closed"]);
    assert_eq!(visible.trim(), "lead");
}

#[test]
fn decodes_meta_from_hex_and_raw_json() {
    // Raw JSON (future-proofing) is accepted as-is.
    let raw = decode_meta_bytes(br#"{"agentId":"x"}"#).expect("raw json");
    assert_eq!(raw, br#"{"agentId":"x"}"#.to_vec());
    // Hex-encoded JSON (the observed on-disk shape) round-trips.
    let hex = hex_encode(br#"{"agentId":"x"}"#);
    let decoded = decode_meta_bytes(hex.as_bytes()).expect("hex json");
    assert_eq!(decoded, br#"{"agentId":"x"}"#.to_vec());
    // Non-hex garbage yields None instead of a bogus parse.
    assert!(decode_meta_bytes(b"not-hex-not-json").is_none());
}

#[test]
fn missing_meta_or_root_yields_no_session() {
    let conn = Connection::open_in_memory().expect("open");
    conn.execute_batch(
        "CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
         CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);",
    )
    .expect("schema");

    // No meta row at all.
    assert!(session_meta_from_store_conn(&conn, &fixture_record(), 0)
        .expect("parse")
        .is_none());
    assert!(load_history_from_store_conn(&conn, "cursorcliapp-x")
        .expect("load")
        .is_empty());

    // Meta present but the root blob is missing: metadata still imports
    // (title falls back to the uuid), transcript is empty.
    let meta_json = format!(
        r#"{{"agentId":"{SESSION_UUID}","latestRootBlobId":"{}","name":"New Agent","createdAt":5,"lastUsedModel":"composer-1"}}"#,
        hex_encode(&blob_id(0x99)),
    );
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('0', ?1)",
        [hex_encode(meta_json.as_bytes())],
    )
    .expect("insert meta");
    let meta = session_meta_from_store_conn(&conn, &fixture_record(), 7)
        .expect("parse")
        .expect("meta");
    assert_eq!(meta.name, SESSION_UUID);
    assert_eq!(meta.created_at_ms, 5);
    assert!(load_history_from_store_conn(&conn, "cursorcliapp-x")
        .expect("load")
        .is_empty());
}

#[test]
fn rejects_invalid_cursor_cli_prefixed_ids() {
    assert!(cursor_cli_source_id_from_session_id("cursoride-abc").is_err());
    assert!(cursor_cli_source_id_from_session_id("cursorcliapp-").is_err());
    assert_eq!(
        cursor_cli_source_id_from_session_id("cursorcliapp-abc").expect("source id"),
        "abc",
    );
}

#[test]
fn candidate_paths_include_home_chats_root() {
    let paths = cursor_cli_history_candidate_paths();
    assert!(paths.iter().any(|path| path.ends_with(".cursor/chats")));
    // Managed roots (`~/.orgii/cursor-cli-profiles/<account>/chats`,
    // `~/.orgii/cursor-config/<session>/chats`) only appear when those
    // profile dirs exist on the machine, so they can't be asserted here —
    // but any that do appear must use the CLI's real `<config-dir>/chats`
    // layout, never a `.cursor` component under a profile dir.
    assert!(!paths.iter().any(
        |path| path.to_string_lossy().contains("cursor-cli-profiles")
            && path.to_string_lossy().contains(".cursor")
    ));
}

#[test]
fn candidate_paths_include_explicit_xdg_config_chats_root() {
    // cursor-agent honors `$XDG_CONFIG_HOME/cursor` even on macOS, where
    // `dirs::config_dir()` ignores XDG — the explicit env probe must appear
    // as its own candidate. Restore the var afterwards so parallel tests on
    // XDG-configured machines keep their real environment.
    let key = "XDG_CONFIG_HOME";
    let original = std::env::var_os(key);
    std::env::set_var(key, "/orgii-test-xdg/config-home");

    let paths = cursor_cli_history_candidate_paths();

    match original {
        Some(value) => std::env::set_var(key, value),
        None => std::env::remove_var(key),
    }

    assert!(paths.contains(
        &PathBuf::from("/orgii-test-xdg/config-home")
            .join("cursor")
            .join("chats")
    ));
}

#[test]
fn decodes_file_uris_with_percent_escapes() {
    assert_eq!(
        file_uri_to_path("file:///Users/dev/my%20repo").as_deref(),
        Some("/Users/dev/my repo"),
    );
    assert_eq!(
        file_uri_to_path("file:///C:/work/repo").as_deref(),
        Some("C:/work/repo"),
    );
    assert_eq!(file_uri_to_path("not-a-uri"), None);
}
