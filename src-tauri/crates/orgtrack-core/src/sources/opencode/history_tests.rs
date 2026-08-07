use super::*;
use rusqlite::Connection;
use serde_json::Value;
use std::collections::HashSet;

fn fixture_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    conn.execute(
        "CREATE TABLE session (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            directory TEXT NOT NULL,
            model TEXT,
            tokens_input INTEGER NOT NULL,
            tokens_output INTEGER NOT NULL,
            tokens_reasoning INTEGER NOT NULL,
            tokens_cache_read INTEGER NOT NULL,
            tokens_cache_write INTEGER NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            time_archived INTEGER,
            parent_id TEXT
        )",
        [],
    )
    .expect("create session");
    conn.execute(
        "CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            data TEXT NOT NULL
        )",
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
        "INSERT INTO session (
            id, title, directory, model, tokens_input, tokens_output,
            tokens_reasoning, tokens_cache_read, tokens_cache_write,
            time_created, time_updated, time_archived
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL)",
        (
            "ses_1",
            "Check npm status",
            "/tmp/opencode-repo",
            r#"{"id":"deepseek-v4-pro","providerID":"deepseek","variant":"default"}"#,
            10_i64,
            20_i64,
            3_i64,
            4_i64,
            5_i64,
            1770000000000_i64,
            1770000005000_i64,
        ),
    )
    .expect("insert session");
    conn.execute(
        "INSERT INTO message (id, session_id, data) VALUES (?1, ?2, ?3)",
        (
            "msg_user",
            "ses_1",
            r#"{"role":"user","time":{"created":1770000000000}}"#,
        ),
    )
    .expect("insert user message");
    conn.execute(
        "INSERT INTO message (id, session_id, data) VALUES (?1, ?2, ?3)",
        (
            "msg_assistant",
            "ses_1",
            r#"{"role":"assistant","modelID":"deepseek-v4-pro"}"#,
        ),
    )
    .expect("insert assistant message");

    conn.execute(
        "INSERT INTO part (id, message_id, session_id, data, time_created) VALUES (?1, ?2, ?3, ?4, ?5)",
        (
            "prt_user",
            "msg_user",
            "ses_1",
            r#"{"type":"text","text":"check my npm status"}"#,
            1770000000001_i64,
        ),
    )
    .expect("insert user part");
    conn.execute(
        "INSERT INTO part (id, message_id, session_id, data, time_created) VALUES (?1, ?2, ?3, ?4, ?5)",
        (
            "prt_tool",
            "msg_assistant",
            "ses_1",
            r#"{"type":"tool","tool":"bash","callID":"call_1","state":{"status":"completed","input":{"command":"npm --version"},"output":"11.15.0\n","title":"Check npm"},"time":{"start":1770000001000,"end":1770000001100}}"#,
            1770000001000_i64,
        ),
    )
    .expect("insert tool part");
    conn.execute(
        "INSERT INTO part (id, message_id, session_id, data, time_created) VALUES (?1, ?2, ?3, ?4, ?5)",
        (
            "prt_reasoning",
            "msg_assistant",
            "ses_1",
            r#"{"type":"reasoning","text":"I should summarize npm status."}"#,
            1770000002000_i64,
        ),
    )
    .expect("insert reasoning part");
    conn.execute(
        "INSERT INTO part (id, message_id, session_id, data, time_created) VALUES (?1, ?2, ?3, ?4, ?5)",
        (
            "prt_text",
            "msg_assistant",
            "ses_1",
            r#"{"type":"text","text":"npm is installed."}"#,
            1770000003000_i64,
        ),
    )
    .expect("insert assistant text part");

    conn
}

#[test]
fn includes_opencode_candidate_db_paths() {
    let home = std::path::Path::new("/Users/example");
    let paths = opencode_db_candidate_paths_for_home(home);
    let rendered = paths
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    assert!(rendered
        .iter()
        .any(|path| path.contains(".local/share/opencode/opencode.db")));
    assert!(rendered.iter().all(|path| path.ends_with("opencode.db")));

    #[cfg(target_os = "macos")]
    {
        assert!(rendered
            .iter()
            .any(|path| path.contains("Library/Application Support/opencode/opencode.db")));
        assert!(rendered.iter().any(
            |path| path.contains("Library/Application Support/ai.opencode.desktop/opencode.db")
        ));
    }

    #[cfg(target_os = "windows")]
    {
        assert!(rendered
            .iter()
            .any(|path| path.contains("AppData/Roaming/opencode/opencode.db")));
        assert!(rendered
            .iter()
            .any(|path| path.contains("AppData/Local/opencode/opencode.db")));
    }
}

#[test]
fn maps_opencode_session_metadata_to_cache_input() {
    let conn = fixture_conn();

    let metas = list_all_opencode_session_meta_from_conn(
        &conn,
        std::path::Path::new("/tmp/opencode.db"),
        1770000006000,
        4096,
    )
    .expect("list session metadata");
    let inputs = metas
        .into_iter()
        .map(|meta| session_meta_to_cache_input(meta, &HashSet::new(), &HashSet::new()))
        .collect::<Vec<_>>();

    assert_eq!(inputs.len(), 1);
    let row = imported_cache::ImportedHistoryCachedSession {
        source_session_id: inputs[0].source_session_id.clone(),
        session_id: inputs[0].session_id.clone(),
        source_path: inputs[0].source_path.clone(),
        source_record_key: inputs[0].source_record_key.clone(),
        source_mtime_ms: inputs[0].source_mtime_ms,
        source_size_bytes: inputs[0].source_size_bytes,
        source_fingerprint: inputs[0].source_fingerprint.clone(),
        parser_version: inputs[0].parser_version,
        name: inputs[0].name.clone(),
        created_at_ms: inputs[0].created_at_ms,
        updated_at_ms: inputs[0].updated_at_ms,
        model: inputs[0].model.clone(),
        input_tokens: inputs[0].input_tokens,
        output_tokens: inputs[0].output_tokens,
        repo_path: inputs[0].repo_path.clone(),
        branch: inputs[0].branch.clone(),
        impact: inputs[0].impact.clone(),
        listable: inputs[0].listable,
        source_metadata_json: inputs[0].source_metadata_json.clone(),
        parent_session_id: inputs[0].parent_session_id.clone(),
    }
    .to_row();
    assert_eq!(row.session_id, "opencodeapp-ses_1");
    assert_eq!(row.name, "Check npm status");
    assert_eq!(row.category, imported_history::IMPORTED_HISTORY_CATEGORY);
    assert!(row.read_only);
    assert_eq!(row.model.as_deref(), Some("deepseek-v4-pro"));
    assert_eq!(row.total_tokens, 42);
    assert_eq!(row.repo_path.as_deref(), Some("/tmp/opencode-repo"));
    assert_eq!(row.repo_name.as_deref(), Some("opencode-repo"));
}

#[test]
fn opencode_recent_paths_use_all_sessions_before_limiting() {
    let conn = fixture_conn();
    conn.execute(
        "INSERT INTO session (
            id, title, directory, model, tokens_input, tokens_output,
            tokens_reasoning, tokens_cache_read, tokens_cache_write,
            time_created, time_updated, time_archived
        ) VALUES (?1, ?2, ?3, ?4, 0, 0, 0, 0, 0, ?5, ?6, NULL)",
        (
            "ses_2",
            "Newer repo",
            "/tmp/newer-opencode-repo",
            "gpt-5",
            1770000010000_i64,
            1770000015000_i64,
        ),
    )
    .expect("insert newer session");

    let rows = list_all_opencode_session_meta_from_conn(&conn, std::path::Path::new(""), 0, 0)
        .expect("list all sessions")
        .into_iter()
        .map(|meta| session_meta_to_cache_input(meta, &HashSet::new(), &HashSet::new()))
        .map(|input| {
            imported_cache::ImportedHistoryCachedSession {
                source_session_id: input.source_session_id,
                session_id: input.session_id,
                source_path: input.source_path,
                source_record_key: input.source_record_key,
                source_mtime_ms: input.source_mtime_ms,
                source_size_bytes: input.source_size_bytes,
                source_fingerprint: input.source_fingerprint,
                parser_version: input.parser_version,
                name: input.name,
                created_at_ms: input.created_at_ms,
                updated_at_ms: input.updated_at_ms,
                model: input.model,
                input_tokens: input.input_tokens,
                output_tokens: input.output_tokens,
                repo_path: input.repo_path,
                branch: input.branch,
                impact: input.impact,
                listable: input.listable,
                source_metadata_json: input.source_metadata_json,
                parent_session_id: input.parent_session_id,
            }
            .to_row()
        })
        .collect::<Vec<_>>();
    let paths = imported_history::recent_paths_from_rows(&rows)
        .into_iter()
        .take(imported_history::effective_limit(1))
        .collect::<Vec<_>>();

    assert_eq!(paths.len(), 1);
    assert_eq!(paths[0].path, "/tmp/newer-opencode-repo");
}

#[test]
fn parses_opencode_parts_into_replay_chunks() {
    let conn = fixture_conn();

    let chunks =
        load_opencode_history_from_conn(&conn, "opencodeapp-ses_1", "ses_1").expect("load chunks");

    assert_eq!(chunks.len(), 4);
    assert_eq!(chunks[0].action_type, imported_history::ACTION_TYPE_RAW);
    assert_eq!(chunks[0].function, imported_history::FUNCTION_USER_MESSAGE);
    assert_eq!(
        chunks[1].action_type,
        imported_history::ACTION_TYPE_TOOL_CALL
    );
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
    assert_eq!(
        chunks[2].action_type,
        imported_history::ACTION_TYPE_THINKING
    );
    assert_eq!(
        chunks[3].action_type,
        imported_history::ACTION_TYPE_ASSISTANT
    );
    assert_eq!(chunks[3].function, imported_history::FUNCTION_ASSISTANT);
}

#[test]
fn strips_orgii_exec_mode_bridge_from_opencode_user_parts() {
    let make_row = |text_json: &str| OpenCodePartRow {
        part_id: "prt_bridge".to_string(),
        message_id: "msg_user".to_string(),
        role: "user".to_string(),
        part: serde_json::from_str::<OpenCodePart>(text_json).expect("parse part"),
        time_created: 1_770_000_000_000,
    };

    // Bridge-prefixed user part → bubble carries only the user text.
    let row = make_row(
        r#"{"type":"text","text":"<orgii_cli_exec_mode_bridge>\nbriefing\n</orgii_cli_exec_mode_bridge>\n\nfix the login bug"}"#,
    );
    let chunk = text_to_user_chunk("opencodeapp-ses_1", 0, &row).expect("user chunk");
    assert_eq!(
        chunk
            .result
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str),
        Some("fix the login bug")
    );

    // Bridge-only user part → no bubble at all.
    let row = make_row(
        r#"{"type":"text","text":"<orgii_cli_exec_mode_bridge>\nbriefing\n</orgii_cli_exec_mode_bridge>"}"#,
    );
    assert!(text_to_user_chunk("opencodeapp-ses_1", 1, &row).is_none());
}

#[test]
fn strips_ide_context_from_opencode_user_parts() {
    let make_row = |text_json: &str| OpenCodePartRow {
        part_id: "prt_ide_ctx".to_string(),
        message_id: "msg_user".to_string(),
        role: "user".to_string(),
        part: serde_json::from_str::<OpenCodePart>(text_json).expect("parse part"),
        time_created: 1_770_000_000_000,
    };

    // Bridge + ide_context prefixed user part → bubble carries only the
    // user-authored text.
    let row = make_row(
        r#"{"type":"text","text":"<orgii_cli_exec_mode_bridge>\nbriefing\n</orgii_cli_exec_mode_bridge>\n\n<ide_context>\nopen file: src/app.ts\n</ide_context>\n\nfix the login bug"}"#,
    );
    let chunk = text_to_user_chunk("opencodeapp-ses_1", 0, &row).expect("user chunk");
    assert_eq!(
        chunk
            .result
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str),
        Some("fix the login bug")
    );

    // ide_context-only user part → no bubble at all.
    let row = make_row(
        r#"{"type":"text","text":"<ide_context>\nopen file: src/app.ts\n</ide_context>"}"#,
    );
    assert!(text_to_user_chunk("opencodeapp-ses_1", 1, &row).is_none());
}

#[test]
fn derives_opencode_impact_from_session_edit_parts() {
    let conn = fixture_conn();
    conn.execute(
        "INSERT INTO part (id, message_id, session_id, data, time_created) VALUES (?1, ?2, ?3, ?4, ?5)",
        (
            "prt_edit",
            "msg_assistant",
            "ses_1",
            r#"{"type":"tool","tool":"edit","callID":"call_edit","state":{"status":"completed","input":{"filePath":"src/main.ts","oldString":"old","newString":"new\nextra"},"output":"done"}}"#,
            1770000002500_i64,
        ),
    )
    .expect("insert edit part");

    let chunks = load_opencode_history_from_conn(&conn, "opencodeapp-ses_1", "ses_1")
        .expect("load session chunks");
    let impact = imported_history::impact_from_edit_chunks(&chunks);

    assert_eq!(impact.touched_files, vec!["src/main.ts"]);
    assert_eq!(impact.lines_added, 2);
    assert_eq!(impact.lines_removed, 1);
}

#[test]
fn rejects_invalid_opencode_prefixed_ids() {
    assert!(opencode_source_id_from_session_id("codexapp-ses_1").is_err());
    assert!(opencode_source_id_from_session_id("opencodeapp-").is_err());
    assert_eq!(
        opencode_source_id_from_session_id("opencodeapp-ses_1").expect("source id"),
        "ses_1"
    );
}

#[test]
fn maps_opencode_parent_id_to_parent_session_id() {
    let conn = fixture_conn();
    conn.execute(
        "INSERT INTO session (
            id, title, directory, model, tokens_input, tokens_output,
            tokens_reasoning, tokens_cache_read, tokens_cache_write,
            time_created, time_updated, time_archived, parent_id
        ) VALUES (?1, ?2, ?3, ?4, 0, 0, 0, 0, 0, ?5, ?6, NULL, ?7)",
        (
            "ses_child",
            "Subagent run",
            "/tmp/opencode-repo",
            "gpt-5",
            1770000020000_i64,
            1770000025000_i64,
            "ses_1",
        ),
    )
    .expect("insert child session");

    let metas = list_all_opencode_session_meta_from_conn(
        &conn,
        std::path::Path::new("/tmp/opencode.db"),
        0,
        0,
    )
    .expect("list sessions");

    let container_parent_ids = container_parent_ids_from_metas(&metas);

    let inputs: Vec<ImportedHistoryCacheInput> = metas
        .into_iter()
        .map(|meta| session_meta_to_cache_input(meta, &container_parent_ids, &HashSet::new()))
        .collect();

    let container = inputs
        .iter()
        .find(|input| input.source_session_id == "ses_1")
        .expect("container input");
    assert!(
        !container.listable,
        "referenced container row must be hidden from sidebar"
    );
    assert!(container.parent_session_id.is_none());

    let task = inputs
        .iter()
        .find(|input| input.source_session_id == "ses_child")
        .expect("task input");
    assert!(
        task.listable,
        "task row remains listable and carries parent relation"
    );
    assert_eq!(task.parent_session_id.as_deref(), Some("opencodeapp-ses_1"));
}

#[test]
fn reads_managed_opencode_source_session_ids_from_code_sessions() {
    let conn = fixture_conn();
    conn.execute(
        "CREATE TABLE code_sessions (
            session_id TEXT PRIMARY KEY,
            cli_agent_type TEXT,
            cli_session_id TEXT
        )",
        [],
    )
    .expect("create code_sessions");
    conn.execute(
        "INSERT INTO code_sessions (session_id, cli_agent_type, cli_session_id)
         VALUES (?1, ?2, ?3), (?4, ?5, ?6), (?7, ?8, ?9)",
        (
            "cliagent-opencode",
            "opencode",
            "ses_managed",
            "cliagent-empty",
            "opencode",
            "",
            "cliagent-codex",
            "codex",
            "ses_codex",
        ),
    )
    .expect("insert code sessions");

    let ids = managed_opencode_source_session_ids_from_conn(&conn).expect("managed ids");

    assert_eq!(ids.len(), 1);
    assert!(ids.contains("ses_managed"));
}

#[test]
fn managed_opencode_source_session_is_hidden_but_preserved() {
    let conn = fixture_conn();
    let metas = list_all_opencode_session_meta_from_conn(
        &conn,
        std::path::Path::new("/tmp/opencode.db"),
        0,
        0,
    )
    .expect("list sessions");
    let managed_source_session_ids = ["ses_1".to_string()].into_iter().collect::<HashSet<_>>();
    let inputs = metas
        .into_iter()
        .map(|meta| session_meta_to_cache_input(meta, &HashSet::new(), &managed_source_session_ids))
        .collect::<Vec<_>>();

    assert_eq!(inputs.len(), 1);
    assert_eq!(inputs[0].source_session_id, "ses_1");
    assert_eq!(inputs[0].session_id, "opencodeapp-ses_1");
    assert!(!inputs[0].listable);
    assert!(inputs[0].parent_session_id.is_none());
}

#[test]
fn external_unmanaged_opencode_source_session_stays_listable() {
    let conn = fixture_conn();
    let metas = list_all_opencode_session_meta_from_conn(
        &conn,
        std::path::Path::new("/tmp/opencode.db"),
        0,
        0,
    )
    .expect("list sessions");
    let inputs = metas
        .into_iter()
        .map(|meta| session_meta_to_cache_input(meta, &HashSet::new(), &HashSet::new()))
        .collect::<Vec<_>>();

    assert_eq!(inputs.len(), 1);
    assert!(inputs[0].listable);
    assert!(inputs[0].parent_session_id.is_none());
}

#[test]
fn ignores_missing_parent_id_so_orphan_history_stays_visible() {
    let conn = fixture_conn();
    conn.execute(
        "INSERT INTO session (
            id, title, directory, model, tokens_input, tokens_output,
            tokens_reasoning, tokens_cache_read, tokens_cache_write,
            time_created, time_updated, time_archived, parent_id
        ) VALUES (?1, ?2, ?3, ?4, 0, 0, 0, 0, 0, ?5, ?6, NULL, ?7)",
        (
            "ses_orphan",
            "Orphan parent history",
            "/tmp/opencode-repo",
            "gpt-5",
            1770000030000_i64,
            1770000035000_i64,
            "ses_missing",
        ),
    )
    .expect("insert orphan session");

    let metas = list_all_opencode_session_meta_from_conn(
        &conn,
        std::path::Path::new("/tmp/opencode.db"),
        0,
        0,
    )
    .expect("list sessions");
    let container_parent_ids = container_parent_ids_from_metas(&metas);
    let orphan = metas
        .into_iter()
        .find(|meta| meta.source_session_id == "ses_orphan")
        .expect("orphan meta");
    let input = session_meta_to_cache_input(orphan, &container_parent_ids, &HashSet::new());

    assert!(input.listable);
    assert!(input.parent_session_id.is_none());
}

#[test]
fn ignores_self_parent_id() {
    let conn = fixture_conn();
    conn.execute(
        "INSERT INTO session (
            id, title, directory, model, tokens_input, tokens_output,
            tokens_reasoning, tokens_cache_read, tokens_cache_write,
            time_created, time_updated, time_archived, parent_id
        ) VALUES (?1, ?2, ?3, ?4, 0, 0, 0, 0, 0, ?5, ?6, NULL, ?7)",
        (
            "ses_self",
            "Self parent history",
            "/tmp/opencode-repo",
            "gpt-5",
            1770000040000_i64,
            1770000045000_i64,
            "ses_self",
        ),
    )
    .expect("insert self-parent session");

    let metas = list_all_opencode_session_meta_from_conn(
        &conn,
        std::path::Path::new("/tmp/opencode.db"),
        0,
        0,
    )
    .expect("list sessions");
    let container_parent_ids = container_parent_ids_from_metas(&metas);
    let self_parent = metas
        .into_iter()
        .find(|meta| meta.source_session_id == "ses_self")
        .expect("self parent meta");
    let input = session_meta_to_cache_input(self_parent, &container_parent_ids, &HashSet::new());

    assert!(input.listable);
    assert!(input.parent_session_id.is_none());
}

#[test]
fn ignores_mutual_parent_cycle() {
    let conn = fixture_conn();
    for (id, parent_id, created_at) in [
        ("ses_cycle_a", "ses_cycle_b", 1770000050000_i64),
        ("ses_cycle_b", "ses_cycle_a", 1770000051000_i64),
    ] {
        conn.execute(
            "INSERT INTO session (
                id, title, directory, model, tokens_input, tokens_output,
                tokens_reasoning, tokens_cache_read, tokens_cache_write,
                time_created, time_updated, time_archived, parent_id
            ) VALUES (?1, ?2, ?3, ?4, 0, 0, 0, 0, 0, ?5, ?6, NULL, ?7)",
            (
                id,
                format!("Cycle {id}"),
                "/tmp/opencode-repo",
                "gpt-5",
                created_at,
                created_at + 5000,
                parent_id,
            ),
        )
        .expect("insert cycle session");
    }

    let metas = list_all_opencode_session_meta_from_conn(
        &conn,
        std::path::Path::new("/tmp/opencode.db"),
        0,
        0,
    )
    .expect("list sessions");
    let container_parent_ids = container_parent_ids_from_metas(&metas);
    let inputs = metas
        .into_iter()
        .filter(|meta| meta.source_session_id.starts_with("ses_cycle_"))
        .map(|meta| session_meta_to_cache_input(meta, &container_parent_ids, &HashSet::new()))
        .collect::<Vec<_>>();

    assert_eq!(inputs.len(), 2);
    assert!(inputs.iter().all(|input| input.listable));
    assert!(inputs.iter().all(|input| input.parent_session_id.is_none()));
}
