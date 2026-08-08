use super::*;

const TOOL_SESSION_ID: &str = "1a2b3c4d-1111-4222-8333-444455556666";
const TEXT_SESSION_ID: &str = "9f8e7d6c-aaaa-4bbb-8ccc-ddddeeeeffff";
const FIXTURE_CWD: &str = "/tmp/copilot-fixture-repo";

fn fixture_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    crate::store::sqlite::SqliteRecordStore::init_tables(&conn).expect("init core tables");
    crate::store::sqlite::SqliteRecordStore::init_source_cache_tables(&conn)
        .expect("init source cache tables");
    conn
}

fn unique_temp_dir(tag: &str) -> PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("orgii-copilot-{tag}-{unique}"));
    fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn write_session(root: &Path, id: &str, workspace_yaml: &str, event_lines: &[&str]) {
    let dir = root.join(id);
    fs::create_dir_all(&dir).expect("create session dir");
    fs::write(dir.join(WORKSPACE_FILENAME), workspace_yaml).expect("write workspace.yaml");
    fs::write(dir.join(EVENTS_FILENAME), event_lines.join("\n")).expect("write events.jsonl");
}

/// Fixture root: one tool-using session, one text-only session (quoted name
/// with a colon), plus every junk-dir shape discovery must skip.
fn build_fixture_root(tag: &str) -> PathBuf {
    let root = unique_temp_dir(tag);

    // Tool-using session. No `name:` key so the display name falls back to
    // the first user message. Skip-type and malformed lines are sprinkled in.
    write_session(
        &root,
        TOOL_SESSION_ID,
        &format!(
            "id: {TOOL_SESSION_ID}\ncwd: {FIXTURE_CWD}\nclient_name: github/cli\nuser_named: false\nsummary_count: 0\ncreated_at: 2026-07-29T09:00:00.000Z\nupdated_at: 2026-07-29T09:00:02.000Z\n"
        ),
        &[
            r#"{"type":"session.start","data":{"sessionId":"ignored","startTime":"2026-07-29T09:00:00.000Z","context":{"cwd":"/tmp/from-session-start"}},"id":"e1","timestamp":"2026-07-29T09:00:00.100Z","parentId":null}"#,
            r#"{"type":"session.model_change","data":{"newModel":"auto","reasoningEffort":null},"id":"e2","timestamp":"2026-07-29T09:00:00.200Z","parentId":"e1"}"#,
            r#"{"type":"system.message","data":{"role":"system","content":"SYSTEM PROMPT MUST NOT LEAK"},"id":"e3","timestamp":"2026-07-29T09:00:00.300Z","parentId":"e2"}"#,
            r#"{"type":"hook.start","data":{"hookInvocationId":"h1","hookType":"userPromptSubmitted"},"id":"e4","timestamp":"2026-07-29T09:00:00.400Z","parentId":"e3"}"#,
            r#"{"type":"hook.end","data":{"hookInvocationId":"h1","success":true},"id":"e5","timestamp":"2026-07-29T09:00:00.500Z","parentId":"e4"}"#,
            r#"{"type":"user.message","data":{"content":"Run the build","transformedContent":"<current_datetime>x</current_datetime>\n\nRun the build\n\n<system_reminder>injected</system_reminder>"},"id":"e6","timestamp":"2026-07-29T09:00:01.000Z","parentId":"e5"}"#,
            r#"{"type":"assistant.turn_start","data":{"turnId":"t1"},"id":"e7","timestamp":"2026-07-29T09:00:01.500Z","parentId":"e6"}"#,
            r#"{"type":"assistant.message","data":{"messageId":"m1","model":"gpt-5-mini","content":"Running it.","toolRequests":[{"toolCallId":"call_1","name":"bash","arguments":{"command":"echo hi","description":"Echo"},"type":"function"},{"toolCallId":"call_2","name":"str_replace","arguments":{"path":"/tmp/x.rs","old_str":"a\nb","new_str":"c"},"type":"function"}]},"id":"e8","timestamp":"2026-07-29T09:00:02.000Z","parentId":"e7"}"#,
            r#"{"type":"tool.execution_start","data":{"toolCallId":"call_1","toolName":"bash","arguments":{"command":"echo hi","description":"Echo"}},"id":"e9","timestamp":"2026-07-29T09:00:02.100Z","parentId":"e8"}"#,
            r#"{"type":"tool.execution_complete","data":{"toolCallId":"call_1","success":true,"result":{"content":"hi\nexit-ok"}},"id":"e10","timestamp":"2026-07-29T09:00:02.500Z","parentId":"e9"}"#,
            r#"{"type":"tool.execution_complete","data":{"toolCallId":"call_2","success":true,"result":{"content":"edited"}},"id":"e11","timestamp":"2026-07-29T09:00:03.000Z","parentId":"e10"}"#,
            r#"{"type":"future.unknown_type","data":{"whatever":[1,2,3]},"id":"e12","timestamp":"2026-07-29T09:00:04.000Z","parentId":"e11"}"#,
            r#"this line is not JSON and must be skipped"#,
            r#"{"type":"assistant.message","data":{"messageId":"m2","model":"gpt-5-mini","content":"Done: hi","toolRequests":[]},"id":"e13","timestamp":"2026-07-29T09:00:05.000Z","parentId":"e12"}"#,
            r#"{"type":"session.shutdown","data":{"shutdownType":"exit"},"id":"e14","timestamp":"2026-07-29T09:00:06.000Z","parentId":"e13"}"#,
        ],
    );

    // Text-only session with the CLI's single-quoted name style (embedded
    // colon must survive the flat-YAML hand-parse).
    write_session(
        &root,
        TEXT_SESSION_ID,
        &format!(
            "id: {TEXT_SESSION_ID}\ncwd: {FIXTURE_CWD}\nclient_name: github/cli\nname: 'Reply with exactly: OK'\nuser_named: false\nsummary_count: 0\ncreated_at: 2026-07-29T08:00:00.000Z\nupdated_at: 2026-07-29T08:00:05.000Z\n"
        ),
        &[
            r#"{"type":"session.start","data":{"startTime":"2026-07-29T08:00:00.000Z","context":{"cwd":"/tmp/copilot-fixture-repo"}},"id":"f1","timestamp":"2026-07-29T08:00:00.100Z","parentId":null}"#,
            r#"{"type":"user.message","data":{"content":"Reply with exactly: OK","transformedContent":"wrapped"},"id":"f2","timestamp":"2026-07-29T08:00:01.000Z","parentId":"f1"}"#,
            r#"{"type":"assistant.message","data":{"messageId":"m1","model":"gpt-4.1","content":"OK","toolRequests":[]},"id":"f3","timestamp":"2026-07-29T08:00:05.000Z","parentId":"f2"}"#,
        ],
    );

    // Junk: uuid-suffixed but not a plain session id — even WITH an
    // events.jsonl it must be skipped by the name-shape check.
    write_session(
        &root,
        "optimistic-chat-2af9b20e-82db-412b-b638-e2a1b250fcec",
        "id: junk\n",
        &[
            r#"{"type":"user.message","data":{"content":"junk"},"id":"j1","timestamp":"2026-07-29T08:00:00.000Z","parentId":null}"#,
        ],
    );
    // Junk: draft placeholder dir. The exact macOS shape uses ':', which NTFS
    // cannot create (it denotes an alternate data stream), so Windows
    // exercises the same not-a-plain-session-id rejection with a legal
    // separator while unix keeps the literal provider shape.
    #[cfg(unix)]
    let draft_junk = "pending-session:draft:1966e2f4-b455-4969-a6ed-bcbc28a59056";
    #[cfg(not(unix))]
    let draft_junk = "pending-session-draft-1966e2f4-b455-4969-a6ed-bcbc28a59056";
    fs::create_dir_all(root.join(draft_junk)).expect("create draft junk dir");
    // Metadata-only dir (aborted/help invocation): plain id, no events.jsonl.
    let aborted = root.join("3c3c3c3c-1234-4123-8123-123412341234");
    fs::create_dir_all(&aborted).expect("create aborted dir");
    fs::write(aborted.join(WORKSPACE_FILENAME), "id: aborted\n").expect("write aborted sidecar");
    // A stray file in the root must be ignored.
    fs::write(root.join("stray.json"), "{}").expect("write stray file");

    root
}

#[test]
fn unquotes_workspace_yaml_scalars() {
    assert_eq!(
        unquote_yaml_scalar(" 'Reply with exactly: OK'"),
        "Reply with exactly: OK"
    );
    assert_eq!(unquote_yaml_scalar(" 'it''s quoted'"), "it's quoted");
    assert_eq!(unquote_yaml_scalar(" \"say \\\"hi\\\"\""), "say \"hi\"");
    assert_eq!(unquote_yaml_scalar("  plain value "), "plain value");
    assert_eq!(unquote_yaml_scalar(""), "");
}

#[test]
fn parses_flat_workspace_yaml_with_quoted_name() {
    let meta = parse_workspace_yaml(
        "id: abc\ncwd: /tmp/repo\nname: 'Reply with exactly: OK'\ncreated_at: 2026-07-29T08:00:00.000Z\nupdated_at: 2026-07-29T08:00:05.000Z\n",
    );
    assert_eq!(meta.cwd.as_deref(), Some("/tmp/repo"));
    assert_eq!(meta.name.as_deref(), Some("Reply with exactly: OK"));
    assert_eq!(meta.created_at.as_deref(), Some("2026-07-29T08:00:00.000Z"));
    assert_eq!(meta.updated_at.as_deref(), Some("2026-07-29T08:00:05.000Z"));
}

#[test]
fn plain_session_dir_name_rejects_junk_shapes() {
    assert!(is_plain_session_dir_name(TOOL_SESSION_ID));
    assert!(is_plain_session_dir_name(
        "e40a5c3d-0d6a-43e0-8b61-4dad2de32f90"
    ));
    assert!(!is_plain_session_dir_name(
        "optimistic-chat-2af9b20e-82db-412b-b638-e2a1b250fcec"
    ));
    assert!(!is_plain_session_dir_name(
        "pending-session:draft:1966e2f4-b455-4969-a6ed-bcbc28a59056"
    ));
    assert!(!is_plain_session_dir_name("not-a-uuid"));
    assert!(!is_plain_session_dir_name(""));
}

#[test]
fn source_id_round_trips_through_prefix() {
    let session_id = super::super::canonical_session_id(TOOL_SESSION_ID);
    assert_eq!(
        copilot_source_id_from_session_id(&session_id).unwrap(),
        TOOL_SESSION_ID
    );
    assert!(copilot_source_id_from_session_id("bogus").is_err());
    assert!(copilot_source_id_from_session_id(COPILOT_SESSION_PREFIX).is_err());
    assert!(copilot_source_id_from_session_id("copilotapp-../../events.jsonl").is_err());
}

#[test]
fn session_state_dir_candidate_points_at_copilot_store() {
    let home = Path::new("/home/u");
    assert_eq!(
        copilot_session_state_dir_candidates(home),
        vec![home.join(".copilot").join("session-state")]
    );
}

#[test]
fn discovery_skips_junk_and_eventsless_dirs() {
    let root = build_fixture_root("discover");
    let conn = fixture_conn();

    let records =
        discover_copilot_history_records(&conn, std::slice::from_ref(&root)).expect("discover");

    let mut ids = records
        .iter()
        .map(|record| record.record.source_session_id.clone())
        .collect::<Vec<_>>();
    ids.sort();
    assert_eq!(ids, vec![TOOL_SESSION_ID, TEXT_SESSION_ID]);
    for record in &records {
        assert!(record.record.source_path.ends_with(EVENTS_FILENAME));
        assert!(record.record.source_mtime_ms > 0);
        assert!(record.record.source_size_bytes > 0);
    }

    fs::remove_dir_all(root).expect("remove temp dir");
}

#[cfg(unix)]
#[test]
fn discovery_rejects_symlinked_session_paths() {
    use std::os::unix::fs::symlink;

    let root = unique_temp_dir("symlink-root");
    let outside = unique_temp_dir("symlink-outside");
    write_session(
        &outside,
        TOOL_SESSION_ID,
        "cwd: /tmp/outside\n",
        &[
            r#"{"type":"user.message","data":{"content":"outside"},"timestamp":"2026-07-29T09:00:00Z"}"#,
        ],
    );
    symlink(outside.join(TOOL_SESSION_ID), root.join(TOOL_SESSION_ID))
        .expect("symlink session directory");

    let conn = fixture_conn();
    let records = discover_copilot_history_records(&conn, std::slice::from_ref(&root))
        .expect("symlink entries are skipped safely");
    assert!(records.is_empty());
    assert!(ensure_exact_copilot_events_file(
        &root.join(TOOL_SESSION_ID).join(EVENTS_FILENAME),
        &root,
        TOOL_SESSION_ID
    )
    .is_err());

    fs::remove_dir_all(root).expect("remove root");
    fs::remove_dir_all(outside).expect("remove outside");
}

#[test]
fn oversized_workspace_sidecar_is_ignored() {
    let root = unique_temp_dir("workspace-cap");
    write_session(
        &root,
        TOOL_SESSION_ID,
        "cwd: /tmp/valid\nname: valid\n",
        &[
            r#"{"type":"session.start","data":{"context":{"cwd":"/tmp/from-event"}},"timestamp":"2026-07-29T09:00:00Z"}"#,
            r#"{"type":"user.message","data":{"content":"bounded fallback"},"timestamp":"2026-07-29T09:00:01Z"}"#,
        ],
    );
    fs::write(
        root.join(TOOL_SESSION_ID).join(WORKSPACE_FILENAME),
        format!("name: {}\n", "x".repeat(MAX_WORKSPACE_BYTES as usize)),
    )
    .expect("write oversized workspace");

    let mut conn = fixture_conn();
    sync_copilot_history_cache_in_roots(&mut conn, std::slice::from_ref(&root), None)
        .expect("sync");
    let cached =
        imported_cache::query_cached_session_from_conn(&conn, SOURCE_COPILOT, TOOL_SESSION_ID)
            .expect("query")
            .expect("cached row");
    assert_eq!(cached.name, "bounded fallback");
    assert_eq!(cached.repo_path.as_deref(), Some("/tmp/from-event"));

    fs::remove_dir_all(root).expect("remove root");
}

#[test]
fn append_scan_resumes_from_complete_line_watermark() {
    let root = unique_temp_dir("watermark");
    write_session(
        &root,
        TOOL_SESSION_ID,
        "cwd: /tmp/watermark\n",
        &[
            r#"{"type":"user.message","data":{"content":"first"},"timestamp":"2026-07-29T09:00:00Z"}"#,
            r#"{"type":"assistant.message","data":{"model":"gpt-4.1","content":"one"},"timestamp":"2026-07-29T09:00:01Z"}"#,
        ],
    );
    let events_path = root.join(TOOL_SESSION_ID).join(EVENTS_FILENAME);
    let mut conn = fixture_conn();
    sync_copilot_history_cache_in_roots(&mut conn, std::slice::from_ref(&root), None)
        .expect("cold sync");
    let first = imported_history::watermark::read_parse_watermark_from_conn(
        &conn,
        SOURCE_COPILOT,
        TOOL_SESSION_ID,
    )
    .expect("read watermark")
    .expect("watermark");
    assert!(first.byte_offset > 0);
    assert!(first.byte_offset < first.source_size_bytes);

    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(&events_path)
        .expect("open append");
    file.write_all(
        b"\n{\"type\":\"assistant.message\",\"data\":{\"model\":\"gpt-5-mini\",\"content\":\"two\"},\"timestamp\":\"2026-07-29T09:00:02Z\"}\n",
    )
    .expect("append event");
    sync_copilot_history_cache_in_roots(&mut conn, std::slice::from_ref(&root), None)
        .expect("append sync");
    let second = imported_history::watermark::read_parse_watermark_from_conn(
        &conn,
        SOURCE_COPILOT,
        TOOL_SESSION_ID,
    )
    .expect("read watermark")
    .expect("watermark");
    assert!(second.byte_offset > first.byte_offset);
    let cached =
        imported_cache::query_cached_session_from_conn(&conn, SOURCE_COPILOT, TOOL_SESSION_ID)
            .expect("query")
            .expect("cached");
    assert_eq!(cached.model.as_deref(), Some("gpt-5-mini"));

    fs::remove_dir_all(root).expect("remove root");
}

#[test]
fn changed_session_budget_progresses_across_scans() {
    let root = unique_temp_dir("batch-budget");
    for index in 0..=MAX_CHANGED_SESSIONS_PER_SYNC {
        let id = format!("00000000-0000-4000-8000-{index:012x}");
        write_session(
            &root,
            &id,
            "cwd: /tmp/batch\n",
            &[
                r#"{"type":"user.message","data":{"content":"batch"},"timestamp":"2026-07-29T09:00:00Z"}"#,
            ],
        );
    }
    let mut conn = fixture_conn();
    sync_copilot_history_cache_in_roots(&mut conn, std::slice::from_ref(&root), None)
        .expect("first bounded sync");
    let first_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM imported_history_session_cache WHERE source = ?1",
            [SOURCE_COPILOT],
            |row| row.get(0),
        )
        .expect("first count");
    assert_eq!(first_count, MAX_CHANGED_SESSIONS_PER_SYNC as i64);

    sync_copilot_history_cache_in_roots(&mut conn, std::slice::from_ref(&root), None)
        .expect("second bounded sync");
    let second_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM imported_history_session_cache WHERE source = ?1",
            [SOURCE_COPILOT],
            |row| row.get(0),
        )
        .expect("second count");
    assert_eq!(second_count, (MAX_CHANGED_SESSIONS_PER_SYNC + 1) as i64);

    fs::remove_dir_all(root).expect("remove root");
}

#[test]
fn replay_rejects_more_than_the_chunk_budget() {
    let root = unique_temp_dir("replay-budget");
    let session_dir = root.join(TOOL_SESSION_ID);
    fs::create_dir_all(&session_dir).expect("create session");
    let mut lines = String::new();
    for index in 0..=MAX_REPLAY_CHUNKS {
        lines.push_str(&format!(
            "{{\"type\":\"user.message\",\"data\":{{\"content\":\"{index}\"}},\"timestamp\":\"2026-07-29T09:00:00Z\"}}\n"
        ));
    }
    let path = session_dir.join(EVENTS_FILENAME);
    fs::write(&path, lines).expect("write bounded replay fixture");
    let error = load_copilot_history_from_path("copilotapp-test", &path)
        .expect_err("chunk cap must reject the replay");
    assert!(error.contains("bounded in-memory safety limit"));

    fs::remove_dir_all(root).expect("remove root");
}

#[test]
fn list_returns_rows_with_name_cwd_and_timestamps() {
    let root = build_fixture_root("list");
    let mut conn = fixture_conn();

    sync_copilot_history_cache_in_roots(&mut conn, std::slice::from_ref(&root), None)
        .expect("sync");
    let page = imported_cache::query_imported_session_page_from_conn(&conn, SOURCE_COPILOT, 10, 0)
        .expect("page");

    assert!(!page.has_more);
    assert_eq!(page.sessions.len(), 2);

    // Newest-updated first: the tool session's last event is 09:00:06.
    let tool_row = &page.sessions[0];
    assert_eq!(
        tool_row.session_id,
        super::super::canonical_session_id(TOOL_SESSION_ID)
    );
    // No `name:` in workspace.yaml → first user message becomes the title.
    assert_eq!(tool_row.name, "Run the build");
    assert_eq!(tool_row.repo_path.as_deref(), Some(FIXTURE_CWD));
    assert_eq!(tool_row.model.as_deref(), Some("gpt-5-mini"));
    assert_eq!(
        tool_row.created_at,
        imported_history::epoch_ms_to_iso(
            imported_history::parse_iso_to_epoch_ms_opt("2026-07-29T09:00:00.000Z").unwrap()
        )
    );
    assert_eq!(
        tool_row.updated_at,
        imported_history::epoch_ms_to_iso(
            imported_history::parse_iso_to_epoch_ms_opt("2026-07-29T09:00:06.000Z").unwrap()
        )
    );
    // The successful str_replace maps to an edit chunk and feeds impact.
    assert_eq!(tool_row.files_changed, 1);
    assert_eq!(tool_row.touched_files, vec!["/tmp/x.rs"]);
    assert_eq!(tool_row.lines_removed, 2);
    assert_eq!(tool_row.lines_added, 1);

    let text_row = &page.sessions[1];
    assert_eq!(text_row.name, "Reply with exactly: OK");
    assert_eq!(text_row.model.as_deref(), Some("gpt-4.1"));
    assert_eq!(text_row.repo_path.as_deref(), Some(FIXTURE_CWD));

    fs::remove_dir_all(root).expect("remove temp dir");
}

#[test]
fn chunks_have_roles_paired_tool_results_and_survive_unknown_events() {
    let root = build_fixture_root("chunks");
    let mut conn = fixture_conn();
    sync_copilot_history_cache_in_roots(&mut conn, std::slice::from_ref(&root), None)
        .expect("sync");

    let session_id = super::super::canonical_session_id(TOOL_SESSION_ID);
    let chunks = load_copilot_history_from_path(
        &session_id,
        &root.join(TOOL_SESSION_ID).join(EVENTS_FILENAME),
    )
    .expect("load chunks");

    // user + assistant + bash + str_replace + assistant; skip-types, the
    // unknown event, and the malformed line contribute nothing.
    assert_eq!(chunks.len(), 5);

    assert_eq!(chunks[0].function, imported_history::FUNCTION_USER_MESSAGE);
    // `content`, not `transformedContent` — no injected wrappers in replay.
    assert_eq!(chunks[0].result["message"]["content"], "Run the build");
    assert_eq!(chunks[0].created_at, "2026-07-29T09:00:01.000Z");

    assert_eq!(
        chunks[1].action_type,
        imported_history::ACTION_TYPE_ASSISTANT
    );
    assert_eq!(chunks[1].result["content"], "Running it.");

    let bash = &chunks[2];
    assert_eq!(bash.action_type, imported_history::ACTION_TYPE_TOOL_CALL);
    assert_eq!(bash.function, imported_history::FUNCTION_RUN_COMMAND_LINE);
    assert_eq!(bash.args["command"], "echo hi");
    assert_eq!(bash.result["output"], "hi\nexit-ok");
    assert_eq!(bash.result["call_id"], "call_1");
    assert_eq!(bash.result["raw_tool_name"], "bash");

    let edit = &chunks[3];
    assert_eq!(edit.function, imported_history::FUNCTION_EDIT_FILE);
    assert_eq!(edit.args["file_path"], "/tmp/x.rs");
    assert_eq!(edit.args["old_string"], "a\nb");
    assert_eq!(edit.args["new_string"], "c");
    assert_eq!(edit.result["output"], "edited");

    assert_eq!(chunks[4].result["content"], "Done: hi");

    // No system/hook/lifecycle text may leak into replay.
    for chunk in &chunks {
        assert!(!chunk
            .result
            .to_string()
            .contains("SYSTEM PROMPT MUST NOT LEAK"));
    }

    fs::remove_dir_all(root).expect("remove temp dir");
}

#[test]
fn failed_tool_completion_marks_chunk_failed() {
    let events = [
        r#"{"type":"assistant.message","data":{"model":"gpt-5-mini","content":"","toolRequests":[{"toolCallId":"call_9","name":"bash","arguments":{"command":"false"}}]},"id":"a1","timestamp":"2026-07-29T09:00:00.000Z","parentId":null}"#,
        r#"{"type":"tool.execution_complete","data":{"toolCallId":"call_9","success":false,"result":{"content":"exit 1"}},"id":"a2","timestamp":"2026-07-29T09:00:01.000Z","parentId":"a1"}"#,
    ]
    .iter()
    .map(|line| serde_json::from_str::<CopilotEventLine>(line).expect("event parses"))
    .collect::<Vec<_>>();

    let chunks = events_to_chunks("copilotapp-x", &events);
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].result["success"], false);
    assert_eq!(chunks[0].result["status"], "failed");
    assert_eq!(chunks[0].result["output"], "exit 1");
}

#[test]
fn managed_mirror_hides_managed_session_from_listing() {
    let root = build_fixture_root("managed");
    let mut conn = fixture_conn();
    // Desktop-owned tables; a bare cache db does not have them, so create the
    // binding ledger the same way the managed_mirror tests do.
    conn.execute_batch(
        "CREATE TABLE code_session_native_transcript_ids (
             session_id TEXT, source TEXT, source_session_id TEXT, bound_at TEXT
         );",
    )
    .expect("create managed ledger");
    conn.execute(
        "INSERT INTO code_session_native_transcript_ids VALUES ('m1', 'copilot', ?1, '2026-07-29T00:00:00Z')",
        [TOOL_SESSION_ID],
    )
    .expect("insert managed binding");

    sync_copilot_history_cache_in_roots(&mut conn, std::slice::from_ref(&root), None)
        .expect("sync");

    let page = imported_cache::query_imported_session_page_from_conn(&conn, SOURCE_COPILOT, 10, 0)
        .expect("page");
    assert_eq!(page.sessions.len(), 1);
    assert_eq!(
        page.sessions[0].session_id,
        super::super::canonical_session_id(TEXT_SESSION_ID)
    );

    // The managed twin stays cached (replay still works) but unlistable.
    let cached =
        imported_cache::query_cached_session_from_conn(&conn, SOURCE_COPILOT, TOOL_SESSION_ID)
            .expect("query cached")
            .expect("managed row cached");
    assert!(!cached.listable);

    fs::remove_dir_all(root).expect("remove temp dir");
}

#[test]
fn rescan_with_unchanged_files_is_a_noop() {
    let root = build_fixture_root("noop");
    let mut conn = fixture_conn();
    sync_copilot_history_cache_in_roots(&mut conn, std::slice::from_ref(&root), None)
        .expect("first sync");

    // Re-discover with identical inputs and fold the same (unmanaged)
    // fingerprint suffix the sync applies; every signature must match the
    // cache, so nothing re-parses.
    let mut discovered =
        discover_copilot_history_records(&conn, std::slice::from_ref(&root)).expect("rediscover");
    let cached_fingerprints = read_cached_copilot_fingerprints(&conn).expect("fingerprints");
    for record in &mut discovered {
        record.record.source_fingerprint = cached_fingerprints
            .get(&record.record.source_session_id)
            .map(|fingerprint| strip_managed_fingerprint(fingerprint).to_string())
            .expect("cached fingerprint");
        managed_mirror::append_managed_fingerprint(&mut record.record.source_fingerprint, false);
    }
    let changed =
        imported_cache::changed_records_from_conn(&conn, SOURCE_COPILOT, &discovered, |record| {
            record.signature()
        })
        .expect("diff signatures");
    assert!(changed.is_empty(), "unchanged files must not re-parse");

    fs::remove_dir_all(root).expect("remove temp dir");
}

#[test]
fn store_db_enriches_totals_branch_and_round_usage() {
    let root = build_fixture_root("enrich");
    let db_path = root.join("session-store.db");
    {
        let store = Connection::open(&db_path).expect("create store db");
        store
            .execute_batch(
                "CREATE TABLE sessions (
                     id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT,
                     branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT
                 );
                 CREATE TABLE assistant_usage_events (
                     id INTEGER PRIMARY KEY AUTOINCREMENT,
                     session_id TEXT NOT NULL, turn_index INTEGER, model TEXT NOT NULL,
                     input_tokens INTEGER, output_tokens INTEGER,
                     cache_read_tokens INTEGER, cache_write_tokens INTEGER,
                     reasoning_tokens INTEGER, created_at TEXT
                 );",
            )
            .expect("create store schema");
        store
            .execute(
                "INSERT INTO sessions (id, cwd, repository, host_type, branch, summary, created_at, updated_at)
                 VALUES (?1, ?2, 'org2AI/ORGII', 'github.com', 'develop', 'Run the build',
                         '2026-07-29T09:00:00.000Z', '2026-07-29T09:00:06.000Z')",
                (TOOL_SESSION_ID, FIXTURE_CWD),
            )
            .expect("insert session row");
        // The real e40a5c3d numbers: db input_tokens is cache-inclusive
        // (10601 fresh + 2176 cached = 12777) and output already includes
        // reasoning (437 includes 320).
        store
            .execute(
                "INSERT INTO assistant_usage_events
                     (session_id, turn_index, model, input_tokens, output_tokens,
                      cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at)
                 VALUES (?1, 0, 'gpt-5-mini', 12777, 437, 2176, 0, 320, '2026-07-29T09:00:02.000Z')",
                [TOOL_SESSION_ID],
            )
            .expect("insert usage row 1");
        store
            .execute(
                "INSERT INTO assistant_usage_events
                     (session_id, turn_index, model, input_tokens, output_tokens,
                      cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at)
                 VALUES (?1, 0, 'gpt-5-mini', 13243, 12, 1664, 0, 0, '2026-07-29T09:00:05.000Z')",
                [TOOL_SESSION_ID],
            )
            .expect("insert usage row 2");
    }

    let mut conn = fixture_conn();
    sync_copilot_history_cache_in_roots(&mut conn, std::slice::from_ref(&root), Some(&db_path))
        .expect("sync");

    // Cache row: cache-inclusive input (26020) + output (449), branch from db.
    let (input_tokens, output_tokens, cache_read, cache_write, branch): (
        i64,
        i64,
        i64,
        i64,
        String,
    ) = conn
        .query_row(
            "SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, branch
             FROM imported_history_session_cache WHERE source = ?1 AND source_session_id = ?2",
            (SOURCE_COPILOT, TOOL_SESSION_ID),
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .expect("cache row");
    assert_eq!(input_tokens, 26_020);
    assert_eq!(output_tokens, 449);
    assert_eq!(cache_read, 3_840);
    assert_eq!(cache_write, 0);
    assert_eq!(branch, "develop");

    let page = imported_cache::query_imported_session_page_from_conn(&conn, SOURCE_COPILOT, 10, 0)
        .expect("page");
    let tool_row = page
        .sessions
        .iter()
        .find(|row| row.session_id == super::super::canonical_session_id(TOOL_SESSION_ID))
        .expect("tool session row");
    assert_eq!(tool_row.total_tokens, 26_020 + 449);
    assert_eq!(tool_row.branch.as_deref(), Some("develop"));

    // Round rows carry FRESH input (cache unfolded from the inclusive column).
    let session_id = super::super::canonical_session_id(TOOL_SESSION_ID);
    let mut stmt = conn
        .prepare(
            "SELECT seq, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
             FROM imported_history_round_usage WHERE session_id = ?1 ORDER BY seq",
        )
        .expect("prepare rounds query");
    let rounds = stmt
        .query_map([session_id.as_str()], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .expect("query rounds")
        .collect::<Result<Vec<_>, _>>()
        .expect("read rounds");
    assert_eq!(
        rounds,
        vec![(0, 10_601, 437, 2_176, 0), (1, 11_579, 12, 1_664, 0)]
    );
    drop(stmt);

    // A second sync sees the same db usage signature — still a no-op.
    let session_ids = vec![TOOL_SESSION_ID.to_string(), TEXT_SESSION_ID.to_string()];
    let mut enrichment =
        read_copilot_store_enrichment(Some(&db_path), &session_ids).expect("read enrichment");
    let mut discovered =
        discover_copilot_history_records(&conn, std::slice::from_ref(&root)).expect("rediscover");
    for record in &mut discovered {
        record.enrichment = enrichment
            .remove(&record.record.source_session_id)
            .unwrap_or_default();
        record.record.source_fingerprint =
            format!("copilot-events-v2|{}", record.enrichment.fingerprint());
        managed_mirror::append_managed_fingerprint(&mut record.record.source_fingerprint, false);
    }
    let changed =
        imported_cache::changed_records_from_conn(&conn, SOURCE_COPILOT, &discovered, |record| {
            record.signature()
        })
        .expect("diff signatures");
    assert!(changed.is_empty());

    // A transiently unreadable live store must not erase enrichment that was
    // already committed to the imported-history cache.
    fs::write(&db_path, "temporarily unavailable").expect("replace store with bogus contents");
    sync_copilot_history_cache_in_roots(&mut conn, std::slice::from_ref(&root), Some(&db_path))
        .expect("cached enrichment survives an unreadable live store");
    let preserved: (i64, i64, i64, String) = conn
        .query_row(
            "SELECT input_tokens, output_tokens, cache_read_tokens, branch
             FROM imported_history_session_cache WHERE source = ?1 AND source_session_id = ?2",
            (SOURCE_COPILOT, TOOL_SESSION_ID),
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("preserved cache row");
    assert_eq!(preserved, (26_020, 449, 3_840, "develop".to_string()));

    fs::remove_dir_all(root).expect("remove temp dir");
}

#[test]
fn missing_or_bogus_store_db_degrades_to_zero_usage() {
    let root = build_fixture_root("degrade");
    // Not a SQLite file at all.
    let bogus = root.join("session-store.db");
    fs::write(&bogus, "this is not sqlite").expect("write bogus db");

    let mut conn = fixture_conn();
    sync_copilot_history_cache_in_roots(&mut conn, std::slice::from_ref(&root), Some(&bogus))
        .expect("sync must not fail on a bogus db");
    let page = imported_cache::query_imported_session_page_from_conn(&conn, SOURCE_COPILOT, 10, 0)
        .expect("page");
    assert_eq!(page.sessions.len(), 2);
    assert!(page.sessions.iter().all(|row| row.total_tokens == 0));
    assert!(page.sessions.iter().all(|row| row.branch.is_none()));

    fs::remove_dir_all(root).expect("remove temp dir");
}

/// Manual sanity harness against the developer's real local store:
/// `cargo test -p orgtrack_core real_copilot_store -- --ignored --nocapture`.
#[test]
#[ignore = "reads the real ~/.copilot store on the developer machine"]
fn real_copilot_store_smoke() {
    let mut conn = fixture_conn();
    let roots = copilot_session_state_dirs().expect("session-state roots");
    let db = copilot_session_store_db_path();
    sync_copilot_history_cache_in_roots(&mut conn, &roots, db.as_deref()).expect("sync real store");
    let page = imported_cache::query_imported_session_page_from_conn(&conn, SOURCE_COPILOT, 50, 0)
        .expect("page");
    for row in &page.sessions {
        println!(
            "{} | upd {} | {:?} | model {:?} | tokens {} | branch {:?} | cwd {:?}",
            row.session_id,
            row.updated_at,
            row.name,
            row.model,
            row.total_tokens,
            row.branch,
            row.repo_path
        );
        let chunks = load_copilot_history_for_session(&conn, &row.session_id).expect("chunks");
        for chunk in &chunks {
            println!(
                "    [{}] {} @ {}",
                chunk.action_type, chunk.function, chunk.created_at
            );
        }
    }
    assert!(!page.sessions.is_empty(), "expected real sessions");
}
