use super::*;
use rusqlite::Connection;
use serde_json::Value;

/// Build an in-memory database mirroring the ZCode CLI schema: a `session`
/// table (no token columns), plus `message`, `part`, `turn_usage` and
/// `model_usage`. One interactive session with a user turn, a bash tool call,
/// reasoning and an assistant reply.
fn fixture_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    conn.execute(
        "CREATE TABLE session (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            directory TEXT NOT NULL,
            parent_id TEXT,
            task_type TEXT NOT NULL DEFAULT 'interactive',
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            time_archived INTEGER
        )",
        [],
    )
    .expect("create session");
    conn.execute(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL)",
        [],
    )
    .expect("create message");
    conn.execute(
        "CREATE TABLE part (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            data TEXT NOT NULL,
            time_created INTEGER NOT NULL
        )",
        [],
    )
    .expect("create part");
    conn.execute(
        "CREATE TABLE turn_usage (
            session_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            reasoning_tokens INTEGER NOT NULL DEFAULT 0,
            cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_input_tokens INTEGER NOT NULL DEFAULT 0
        )",
        [],
    )
    .expect("create turn_usage");
    conn.execute(
        "CREATE TABLE model_usage (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            model_id TEXT NOT NULL,
            started_at INTEGER NOT NULL
        )",
        [],
    )
    .expect("create model_usage");

    conn.execute(
        "INSERT INTO session (id, title, directory, parent_id, task_type, time_created, time_updated, time_archived)
         VALUES ('sess_1', 'Check npm status', '/tmp/zcode-repo', NULL, 'interactive', 1770000000000, 1770000005000, NULL)",
        [],
    )
    .expect("insert session");
    // input = 100 + cache_read 90 + cache_creation 10 = 200; output = 30 + reasoning 5 = 35
    conn.execute(
        "INSERT INTO turn_usage (session_id, turn_id, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens)
         VALUES ('sess_1', 'turn_1', 100, 30, 5, 10, 90)",
        [],
    )
    .expect("insert turn_usage");
    conn.execute(
        "INSERT INTO model_usage (id, session_id, model_id, started_at) VALUES ('mu_1', 'sess_1', 'GLM-5.2', 1770000001000)",
        [],
    )
    .expect("insert model_usage");

    conn.execute(
        "INSERT INTO message (id, session_id, data) VALUES ('msg_user', 'sess_1', '{\"role\":\"user\"}')",
        [],
    )
    .expect("insert user message");
    conn.execute(
        "INSERT INTO message (id, session_id, data) VALUES ('msg_assistant', 'sess_1', '{\"role\":\"assistant\"}')",
        [],
    )
    .expect("insert assistant message");

    conn.execute(
        "INSERT INTO part (id, message_id, session_id, data, time_created)
         VALUES ('prt_user', 'msg_user', 'sess_1', '{\"type\":\"text\",\"text\":\"check my npm status\"}', 1770000000001)",
        [],
    )
    .expect("insert user part");
    conn.execute(
        "INSERT INTO part (id, message_id, session_id, data, time_created)
         VALUES ('prt_tool', 'msg_assistant', 'sess_1', '{\"type\":\"tool\",\"tool\":\"Bash\",\"callID\":\"call_1\",\"state\":{\"status\":\"completed\",\"input\":{\"command\":\"npm --version\"},\"output\":\"11.15.0\\n\"}}', 1770000001000)",
        [],
    )
    .expect("insert tool part");
    conn.execute(
        "INSERT INTO part (id, message_id, session_id, data, time_created)
         VALUES ('prt_reasoning', 'msg_assistant', 'sess_1', '{\"type\":\"reasoning\",\"text\":\"I should report npm status.\"}', 1770000002000)",
        [],
    )
    .expect("insert reasoning part");
    conn.execute(
        "INSERT INTO part (id, message_id, session_id, data, time_created)
         VALUES ('prt_text', 'msg_assistant', 'sess_1', '{\"type\":\"text\",\"text\":\"npm is installed.\"}', 1770000003000)",
        [],
    )
    .expect("insert assistant text part");

    conn
}

fn to_row(input: &ImportedHistoryCacheInput) -> ImportedHistorySessionRow {
    imported_cache::ImportedHistoryCachedSession {
        source_session_id: input.source_session_id.clone(),
        session_id: input.session_id.clone(),
        source_path: input.source_path.clone(),
        source_record_key: input.source_record_key.clone(),
        source_mtime_ms: input.source_mtime_ms,
        source_size_bytes: input.source_size_bytes,
        source_fingerprint: input.source_fingerprint.clone(),
        parser_version: input.parser_version,
        name: input.name.clone(),
        created_at_ms: input.created_at_ms,
        updated_at_ms: input.updated_at_ms,
        model: input.model.clone(),
        input_tokens: input.input_tokens,
        output_tokens: input.output_tokens,
        repo_path: input.repo_path.clone(),
        branch: input.branch.clone(),
        impact: input.impact.clone(),
        listable: input.listable,
        source_metadata_json: input.source_metadata_json.clone(),
        parent_session_id: input.parent_session_id.clone(),
    }
    .to_row()
}

#[test]
fn includes_zcode_cli_db_path() {
    let home = std::path::Path::new("/Users/example");
    let rendered = zcode_history_candidate_paths_for_home(home)
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    assert!(rendered
        .iter()
        .any(|p| p.contains(".zcode/cli/db/db.sqlite")));
    assert!(rendered.iter().all(|p| p.ends_with("db.sqlite")));
}

#[test]
fn maps_zcode_session_metadata_to_cache_input() {
    let conn = fixture_conn();
    let metas = list_all_zcode_session_meta_from_conn(
        &conn,
        std::path::Path::new("/tmp/db.sqlite"),
        1770000006000,
        4096,
    )
    .expect("list session metadata");
    assert_eq!(metas.len(), 1);
    let row = to_row(&session_meta_to_cache_input(metas.into_iter().next().unwrap()));

    assert_eq!(row.session_id, "zcodeapp-sess_1");
    assert_eq!(row.name, "Check npm status");
    assert!(row.read_only);
    assert_eq!(row.model.as_deref(), Some("GLM-5.2"));
    // input 200 (100 + 90 cache_read + 10 cache_creation) + output 35 (30 + 5 reasoning)
    assert_eq!(row.total_tokens, 235);
    assert_eq!(row.repo_path.as_deref(), Some("/tmp/zcode-repo"));
    assert_eq!(row.repo_name.as_deref(), Some("zcode-repo"));
}

#[test]
fn parses_zcode_parts_into_replay_chunks() {
    let conn = fixture_conn();
    let chunks =
        load_zcode_history_from_conn(&conn, "zcodeapp-sess_1", "sess_1").expect("load chunks");

    assert_eq!(chunks.len(), 4);
    assert_eq!(chunks[0].function, imported_history::FUNCTION_USER_MESSAGE);
    assert_eq!(
        chunks[1].function,
        imported_history::FUNCTION_RUN_COMMAND_LINE
    );
    assert_eq!(
        chunks[1].args.get("command").and_then(Value::as_str),
        Some("npm --version")
    );
    assert_eq!(
        chunks[1].result.get("output").and_then(Value::as_str),
        Some("11.15.0\n")
    );
    assert_eq!(chunks[2].action_type, imported_history::ACTION_TYPE_THINKING);
    assert_eq!(chunks[3].function, imported_history::FUNCTION_ASSISTANT);
}

#[test]
fn subagent_child_is_hidden_and_linked_to_parent() {
    let conn = fixture_conn();
    conn.execute(
        "INSERT INTO session (id, title, directory, parent_id, task_type, time_created, time_updated, time_archived)
         VALUES ('sess_sub', 'Investigate worktrees', '/tmp/zcode-repo', 'sess_1', 'subagent_child', 1770000006000, 1770000009000, NULL)",
        [],
    )
    .expect("insert subagent session");

    let inputs: Vec<ImportedHistoryCacheInput> = list_all_zcode_session_meta_from_conn(
        &conn,
        std::path::Path::new("/tmp/db.sqlite"),
        0,
        0,
    )
    .expect("list sessions")
    .into_iter()
    .map(session_meta_to_cache_input)
    .collect();

    let parent = inputs
        .iter()
        .find(|i| i.source_session_id == "sess_1")
        .expect("parent");
    assert!(parent.listable, "interactive parent stays listable");
    assert!(parent.parent_session_id.is_none());

    let child = inputs
        .iter()
        .find(|i| i.source_session_id == "sess_sub")
        .expect("child");
    assert!(!child.listable, "subagent_child is hidden from the list");
    assert_eq!(child.parent_session_id.as_deref(), Some("zcodeapp-sess_1"));
}

#[test]
fn rejects_invalid_zcode_prefixed_ids() {
    assert!(zcode_source_id_from_session_id("opencodeapp-sess_1").is_err());
    assert!(zcode_source_id_from_session_id("zcodeapp-").is_err());
    assert_eq!(
        zcode_source_id_from_session_id("zcodeapp-sess_1").expect("source id"),
        "sess_1"
    );
}
