use rusqlite::Connection;

use super::{ensure_tables_with, query_session_file_tool_rows, SESSION_FILE_MODIFY_TOOLS};
use crate::persistence::db_helpers::AgentSessionStatus;
use crate::persistence::session_snapshots::extract_paths_from_tool_input;

// -- AgentSessionStatus::parse --

#[test]
fn parse_all_known_statuses() {
    assert_eq!(
        AgentSessionStatus::parse("idle"),
        Some(AgentSessionStatus::Idle)
    );
    assert_eq!(
        AgentSessionStatus::parse("running"),
        Some(AgentSessionStatus::Running)
    );
    assert_eq!(
        AgentSessionStatus::parse("completed"),
        Some(AgentSessionStatus::Completed)
    );
    assert_eq!(
        AgentSessionStatus::parse("failed"),
        Some(AgentSessionStatus::Failed)
    );
    assert_eq!(
        AgentSessionStatus::parse("cancelled"),
        Some(AgentSessionStatus::Cancelled)
    );
}

#[test]
fn parse_unknown_returns_none() {
    assert!(AgentSessionStatus::parse("unknown").is_none());
    assert!(AgentSessionStatus::parse("").is_none());
    assert!(AgentSessionStatus::parse("IDLE").is_none());
    assert!(
        AgentSessionStatus::parse("error").is_none(),
        "legacy 'error' alias should no longer round-trip"
    );
    assert!(
        AgentSessionStatus::parse("active").is_none(),
        "legacy 'active' alias should no longer round-trip"
    );
}

// -- is_terminal --

#[test]
fn terminal_statuses() {
    assert!(AgentSessionStatus::Completed.is_terminal());
    assert!(AgentSessionStatus::Failed.is_terminal());
    assert!(AgentSessionStatus::Cancelled.is_terminal());
}

#[test]
fn non_terminal_statuses() {
    assert!(!AgentSessionStatus::Idle.is_terminal());
    assert!(!AgentSessionStatus::Running.is_terminal());
}

// -- Display / AsRef<str> --

#[test]
fn display_matches_as_ref() {
    for status in &[
        AgentSessionStatus::Idle,
        AgentSessionStatus::Running,
        AgentSessionStatus::Completed,
        AgentSessionStatus::Failed,
        AgentSessionStatus::Cancelled,
    ] {
        assert_eq!(format!("{}", status), status.as_ref());
    }
}

#[test]
fn as_ref_round_trips() {
    for status in &[
        AgentSessionStatus::Idle,
        AgentSessionStatus::Running,
        AgentSessionStatus::Completed,
        AgentSessionStatus::Failed,
        AgentSessionStatus::Cancelled,
    ] {
        let str_val = status.as_ref();
        let parsed = AgentSessionStatus::parse(str_val).unwrap();
        assert_eq!(parsed, *status);
    }
}

#[test]
fn schema_normalizes_project_exec_mode_without_assuming_migration_order() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_tables_with(&conn).expect("initialize schema");
    conn.execute(
        "INSERT INTO agent_sessions
            (session_id, name, status, created_at, updated_at, product_mode, agent_exec_mode)
         VALUES ('project-session', 'Project', 'idle', 'now', 'now', 'project', NULL)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO agent_sessions
            (session_id, name, status, created_at, updated_at, product_mode, agent_exec_mode)
         VALUES ('legacy-build', 'Build', 'idle', 'now', 'now', NULL, NULL)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO agent_sessions
            (session_id, name, status, created_at, updated_at, work_item_id, product_mode, agent_exec_mode)
         VALUES ('legacy-work-item', 'Work Item', 'idle', 'now', 'now', 'WI-1', 'build', 'ask')",
        [],
    )
    .unwrap();

    ensure_tables_with(&conn).expect("rerun migrations");
    let mode: String = conn
        .query_row(
            "SELECT agent_exec_mode FROM agent_sessions WHERE session_id = 'project-session'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(mode, "build");
    let axes = conn
        .prepare(
            "SELECT session_id, product_mode, agent_exec_mode
             FROM agent_sessions
             WHERE session_id IN ('legacy-build', 'legacy-work-item')
             ORDER BY session_id",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        axes,
        vec![
            (
                "legacy-build".to_string(),
                "build".to_string(),
                "build".to_string(),
            ),
            (
                "legacy-work-item".to_string(),
                "project".to_string(),
                "build".to_string(),
            ),
        ]
    );
}

// -- extract_paths_from_tool_input --

#[test]
fn extract_paths_edit_tool() {
    let input = r#"{"file_path": "src/main.rs", "old_string": "a", "new_string": "b"}"#;
    let paths = extract_paths_from_tool_input("edit_file", input);
    assert_eq!(paths, vec!["src/main.rs"]);
}

#[test]
fn extract_paths_edit_file_path_key() {
    // edit_file in create mode uses "file_path", legacy fallback to "path"
    let input = r#"{"path": "/tmp/output.txt", "content": "hello"}"#;
    let paths = extract_paths_from_tool_input("edit_file", input);
    assert_eq!(paths, vec!["/tmp/output.txt"]);
}

#[test]
fn extract_paths_edit_file_file_path_key() {
    let input = r#"{"file_path": "/tmp/output.txt", "content": "hello"}"#;
    let paths = extract_paths_from_tool_input("edit_file", input);
    assert_eq!(paths, vec!["/tmp/output.txt"]);
}

#[test]
fn extract_paths_delete_file() {
    let input = r#"{"path": "src/obsolete.rs"}"#;
    let paths = extract_paths_from_tool_input("delete_file", input);
    assert_eq!(paths, vec!["src/obsolete.rs"]);
}

#[test]
fn extract_paths_apply_patch() {
    let input = r#"{"patch_text": "*** Update File: src/a.rs\n@@\n*** Add File: src/b.rs\n"}"#;
    let paths = extract_paths_from_tool_input("apply_patch", input);
    assert!(paths.contains(&"src/a.rs".to_string()));
    assert!(paths.contains(&"src/b.rs".to_string()));
}

#[test]
fn extract_paths_invalid_json() {
    let paths = extract_paths_from_tool_input("edit_file", "not json");
    assert!(paths.is_empty());
}

#[test]
fn extract_paths_unknown_tool() {
    let paths = extract_paths_from_tool_input("custom_tool", r#"{"a": "b"}"#);
    assert!(paths.is_empty());
}

#[test]
fn query_session_file_tool_rows_reads_cli_chunks() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE code_session_chunks (
            chunk_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            action_type TEXT NOT NULL,
            function TEXT NOT NULL,
            args_json TEXT,
            result_json TEXT,
            sequence INTEGER NOT NULL
        );",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO code_session_chunks
            (chunk_id, session_id, action_type, function, args_json, result_json, sequence)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            "chunk-1",
            "cli-session",
            "tool_call",
            "Edit",
            r#"{"file_path":"src/cli.rs","old_string":"a","new_string":"b"}"#,
            r#"{"success":true}"#,
            1,
        ],
    )
    .unwrap();

    let rows = query_session_file_tool_rows(
        &conn,
        "code_session_chunks",
        "function",
        "args_json",
        "result_json",
        "sequence ASC",
        "cli-session",
        SESSION_FILE_MODIFY_TOOLS,
        None,
    )
    .unwrap();

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, "Edit");
    assert_eq!(
        extract_paths_from_tool_input(&rows[0].0, &rows[0].1),
        vec!["src/cli.rs"]
    );
}

// -- Serde --

#[test]
fn serde_round_trip() {
    let status = AgentSessionStatus::Running;
    let json = serde_json::to_string(&status).unwrap();
    assert_eq!(json, "\"running\"");
    let parsed: AgentSessionStatus = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, status);
}
