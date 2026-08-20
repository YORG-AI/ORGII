use super::*;

#[test]
fn includes_claude_project_dir_candidates() {
    let home = std::path::Path::new("/Users/example");
    let paths = claude_projects_dir_candidates(home);
    let rendered = paths
        .iter()
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .collect::<Vec<_>>();

    assert!(rendered
        .iter()
        .any(|path| path.contains(".claude/projects")));

    #[cfg(target_os = "macos")]
    {
        assert!(rendered
            .iter()
            .any(|path| path.contains("Library/Application Support/Claude Code/projects")));
        assert!(rendered
            .iter()
            .any(|path| path.contains("Library/Application Support/claude-code/projects")));
    }

    #[cfg(target_os = "windows")]
    {
        assert!(rendered
            .iter()
            .any(|path| path.contains("AppData/Roaming/Claude Code/projects")));
        assert!(rendered
            .iter()
            .any(|path| path.contains("AppData/Local/Claude Code/projects")));
    }
}

#[test]
fn parses_claude_jsonl_into_replay_chunks() {
    let temp_dir =
        std::env::temp_dir().join(format!("orgii-claude-history-test-{}", std::process::id()));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-replay.jsonl");
    let content = r#"{"type":"user","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:46.543Z","message":{"role":"user","content":"hello claude"}}
{"type":"assistant","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:47.000Z","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"pwd"}}],"usage":{"input_tokens":10,"output_tokens":2}}}
{"type":"user","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:48.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"/tmp/project"}]}}
{"type":"assistant","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:49.000Z","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":3,"output_tokens":5}}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_claude_code_history_from_path("claudecodeapp-abc", &path).expect("parse");

    assert_eq!(chunks.len(), 3);
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
        Some("pwd")
    );
    assert_eq!(
        chunks[1].result.get("output").and_then(Value::as_str),
        Some("/tmp/project")
    );
    assert_eq!(
        chunks[2].action_type,
        imported_history::ACTION_TYPE_ASSISTANT
    );
    assert_eq!(chunks[2].function, imported_history::FUNCTION_ASSISTANT);

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn byte_index_discovers_rounds_without_parsing_tool_result_bodies() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-window-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-window.jsonl");
    let large_output = "x".repeat(200_000);
    let content = format!(
        "{{\"type\":\"user\",\"timestamp\":\"2026-04-01T07:00:00Z\",\"message\":{{\"role\":\"user\",\"content\":\"first\"}}}}\n\
         {{\"type\":\"assistant\",\"timestamp\":\"2026-04-01T07:00:01Z\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"Bash\",\"input\":{{\"command\":\"build\"}}}}]}}}}\n\
         {{\"type\":\"user\",\"timestamp\":\"2026-04-01T07:00:02Z\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_1\",\"content\":\"{large_output}\"}}]}}}}\n\
         {{\"type\":\"assistant\",\"timestamp\":\"2026-04-01T07:00:03Z\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"first done\"}}]}}}}\n\
         {{\"type\":\"user\",\"timestamp\":\"2026-04-01T07:01:00Z\",\"message\":{{\"role\":\"user\",\"content\":\"second\"}}}}\n\
         {{\"type\":\"assistant\",\"timestamp\":\"2026-04-01T07:01:01Z\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"second done\"}}]}}}}\n\
         {{\"type\":\"user\",\"timestamp\":\"2026-04-01T07:02:00Z\",\"message\":{{\"role\":\"user\",\"content\":\"third\"}}}}\n\
         {{\"type\":\"assistant\",\"timestamp\":\"2026-04-01T07:02:01Z\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"third done\"}}]}}}}\n"
    );
    std::fs::write(&path, content).expect("write fixture");

    let indexed = index_claude_user_turns("claudecodeapp-window", &path).expect("index user turns");
    assert_eq!(indexed.len(), 3);
    assert!(indexed.iter().all(|turn| turn
        .user_chunk
        .chunk_id
        .starts_with(CLAUDE_WINDOW_TURN_ID_PREFIX)));

    let second = &indexed[1];
    let third = &indexed[2];
    let mut file = std::fs::File::open(&path).expect("open fixture");
    let chunks = load_claude_turn_range(
        &mut file,
        "claudecodeapp-window",
        second.start_offset,
        third.start_offset,
        &second.user_chunk.chunk_id,
    )
    .expect("load second round");

    assert_eq!(
        chunks.first().map(|chunk| chunk.chunk_id.as_str()),
        Some(second.user_chunk.chunk_id.as_str())
    );
    let rendered = chunks
        .iter()
        .map(|chunk| format!("{} {}", chunk.args, chunk.result))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(rendered.contains("second"));
    assert!(rendered.contains("second done"));
    assert!(!rendered.contains("first done"));
    assert!(!rendered.contains("third"));
    assert!(!rendered.contains(&large_output));

    let full = load_claude_code_history_from_path("claudecodeapp-window", &path)
        .expect("load full transcript");
    let turn_ids = indexed
        .iter()
        .map(|turn| claude_window_turn_id(turn.start_offset))
        .collect::<Vec<_>>();
    let cloud =
        load_claude_code_cloud_turn_windows_from_path("claudecodeapp-window", &path, &turn_ids, 0)
            .expect("load exact cloud turns")
            .into_iter()
            .flat_map(|window| window.chunks)
            .collect::<Vec<_>>();
    assert_eq!(
        serde_json::to_value(cloud).expect("serialize cloud chunks"),
        serde_json::to_value(full).expect("serialize full chunks")
    );

    // Body-size surrogate: round 1 is followed by tool_use + tool_result +
    // text (3 lines); rounds 2 and 3 by one assistant line each. Placeholder
    // rounds surface these as bodyEventCount — without them the flat-view
    // collapse bar (the only expand affordance when pagination is off) never
    // renders and unloaded bodies are unreachable.
    assert_eq!(
        indexed
            .iter()
            .map(|turn| turn.following_line_count)
            .collect::<Vec<_>>(),
        vec![3, 1, 1]
    );

    let user_chunks = indexed
        .iter()
        .map(|turn| turn.user_chunk.clone())
        .collect::<Vec<_>>();
    let mut projected = project_activity_chunks(&user_chunks);
    assert!(projected.iter().all(|turn| turn.body_event_count == 0));
    overlay_indexed_body_counts(&mut projected, &indexed, indexed.len());
    assert_eq!(
        projected
            .iter()
            .map(|turn| (turn.body_event_count, turn.event_count))
            .collect::<Vec<_>>(),
        vec![(3, 4), (1, 2), (1, 2)]
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn harness_injected_user_lines_do_not_open_rounds() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-synthetic-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-synthetic.jsonl");
    let content = r#"{"type":"user","timestamp":"2026-04-01T07:00:00Z","origin":{"kind":"human"},"message":{"role":"user","content":"real prompt"}}
{"type":"assistant","timestamp":"2026-04-01T07:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"working"}]}}
{"type":"user","timestamp":"2026-04-01T07:00:02Z","origin":{"kind":"task-notification"},"message":{"role":"user","content":"<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n</task-notification>"}}
{"type":"assistant","timestamp":"2026-04-01T07:00:03Z","message":{"role":"assistant","content":[{"type":"text","text":"task consumed"}]}}
{"type":"user","timestamp":"2026-04-01T07:00:04Z","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>Caveat: the following was run</local-command-caveat>"}}
{"type":"assistant","timestamp":"2026-04-01T07:00:05Z","message":{"role":"assistant","content":[{"type":"text","text":"caveat consumed"}]}}
{"type":"user","timestamp":"2026-04-01T07:01:00Z","message":{"role":"user","content":"second prompt"}}
{"type":"assistant","timestamp":"2026-04-01T07:01:01Z","message":{"role":"assistant","content":[{"type":"text","text":"second done"}]}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let indexed =
        index_claude_user_turns("claudecodeapp-synthetic", &path).expect("index user turns");
    let previews = indexed
        .iter()
        .map(|turn| {
            turn.user_chunk
                .result
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        })
        .collect::<Vec<_>>();
    assert_eq!(previews, vec!["real prompt", "second prompt"]);
    assert_eq!(
        indexed
            .iter()
            .map(|turn| turn.following_line_count)
            .collect::<Vec<_>>(),
        vec![5, 1]
    );

    let chunks =
        load_claude_code_history_from_path("claudecodeapp-synthetic", &path).expect("parse");
    let user_texts = chunks
        .iter()
        .filter(|chunk| chunk.function == imported_history::FUNCTION_USER_MESSAGE)
        .map(|chunk| {
            chunk
                .result
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        })
        .collect::<Vec<_>>();
    assert_eq!(user_texts, vec!["real prompt", "second prompt"]);
    let rendered = chunks
        .iter()
        .map(|chunk| chunk.result.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!rendered.contains("task-notification"));
    assert!(!rendered.contains("local-command-caveat"));
    assert!(rendered.contains("task consumed"));

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn user_image_blocks_surface_as_data_url_attachments() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-image-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-images.jsonl");
    let content = r#"{"type":"user","timestamp":"2026-04-01T07:00:00Z","message":{"role":"user","content":[{"type":"text","text":"make a pet from this"},{"type":"image","source":{"type":"base64","media_type":"image/webp","data":"UklGRg=="}}]}}
{"type":"assistant","timestamp":"2026-04-01T07:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"working"}]}}
{"type":"user","timestamp":"2026-04-01T07:01:00Z","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw=="}}]}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_claude_code_history_from_path("claudecodeapp-images", &path).expect("parse");
    let user_chunks = chunks
        .iter()
        .filter(|chunk| chunk.function == imported_history::FUNCTION_USER_MESSAGE)
        .collect::<Vec<_>>();
    assert_eq!(user_chunks.len(), 2);

    let first_images = user_chunks[0]
        .result
        .get("images")
        .and_then(Value::as_array)
        .expect("first user chunk images");
    assert_eq!(
        first_images
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>(),
        vec!["data:image/webp;base64,UklGRg=="]
    );
    assert_eq!(
        user_chunks[0]
            .result
            .pointer("/message/content")
            .and_then(Value::as_str),
        Some("make a pet from this")
    );

    let second_images = user_chunks[1]
        .result
        .get("images")
        .and_then(Value::as_array)
        .expect("image-only user chunk images");
    assert_eq!(
        second_images
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>(),
        vec!["data:image/png;base64,iVBORw=="]
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn harness_injected_first_line_does_not_title_session() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-synthetic-title-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-synthetic-title.jsonl");
    let content = r#"{"type":"user","timestamp":"2026-04-01T07:00:00Z","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>Caveat: the following was run</local-command-caveat>"}}
{"type":"user","timestamp":"2026-04-01T07:00:01Z","origin":{"kind":"human"},"message":{"role":"user","content":"actual request"}}
{"type":"assistant","timestamp":"2026-04-01T07:00:02Z","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":1,"output_tokens":1}}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Claude").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "claude-synthetic-title".to_string(),
        source_path: path.clone(),
        source_record_key: "claude-synthetic-title".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
    };
    let meta = parse_claude_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    assert_eq!(meta.name, "actual request");

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn claude_initial_window_placeholders_advertise_fetchable_bodies() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-window-counts-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-window-counts.jsonl");
    let mut content = String::new();
    for round in 1..=3 {
        content.push_str(&format!(
            "{{\"type\":\"user\",\"timestamp\":\"2026-04-01T07:0{round}:00Z\",\"message\":{{\"role\":\"user\",\"content\":\"round {round}\"}}}}\n\
             {{\"type\":\"assistant\",\"timestamp\":\"2026-04-01T07:0{round}:01Z\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"tool_use\",\"id\":\"toolu_{round}\",\"name\":\"Bash\",\"input\":{{\"command\":\"go\"}}}}]}}}}\n\
             {{\"type\":\"user\",\"timestamp\":\"2026-04-01T07:0{round}:02Z\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_{round}\",\"content\":\"ok\"}}]}}}}\n\
             {{\"type\":\"assistant\",\"timestamp\":\"2026-04-01T07:0{round}:03Z\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"round {round} done\"}}]}}}}\n",
        ));
    }
    std::fs::write(&path, content).expect("write fixture");

    let window =
        load_claude_code_initial_window_from_path("claudecodeapp-counts", &path, 1)
            .expect("load initial window");

    assert_eq!(window.total_turn_count, 3);
    assert_eq!(window.loaded_turn_count, 1);
    let placeholders = window
        .chunks
        .iter()
        .filter(|chunk| chunk.chunk_id.starts_with("imported-unloaded-turn-"))
        .collect::<Vec<_>>();
    assert_eq!(placeholders.len(), 2);
    for (round, placeholder) in placeholders.iter().enumerate() {
        let round = round + 1;
        let body_event_count = placeholder.result["unloadedTurn"]["bodyEventCount"]
            .as_i64()
            .expect("bodyEventCount");
        assert_eq!(body_event_count, 3);
        // The unloaded round's placeholder carries the final-reply preview so
        // the collapsed turn still shows its closing agent message…
        assert_eq!(
            placeholder.args.get("turnPreviewOnly"),
            Some(&Value::Bool(true))
        );
        assert_eq!(
            placeholder.result.get("observation").and_then(Value::as_str),
            Some(format!("round {round} done").as_str())
        );
        // …and a real end timestamp so the collapse bar shows the round's
        // duration and time range instead of "<1min".
        let started_at = placeholder.result["unloadedTurn"]["startedAt"]
            .as_str()
            .expect("startedAt");
        let ended_at = placeholder.result["unloadedTurn"]["endedAt"]
            .as_str()
            .expect("endedAt");
        assert!(ended_at > started_at, "{ended_at} must be after {started_at}");
    }
    // The loaded newest round keeps its exact projected counts (no overlay).
    assert_eq!(window.turns[2].body_event_count, 2);

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn claude_initial_window_previews_skip_tool_use_only_assistant_lines() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-window-preview-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-window-preview.jsonl");
    // Round 1's real reply is followed by a tool_use-only assistant line and
    // its tool_result: the preview must come from the newest TEXT line, and
    // the trailing unmatched tool_use must not leak a tool-call chunk into
    // the placeholder preview.
    let content = "\
{\"type\":\"user\",\"timestamp\":\"2026-04-01T07:00:00Z\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n\
{\"type\":\"assistant\",\"timestamp\":\"2026-04-01T07:00:01Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"hmm\"},{\"type\":\"text\",\"text\":\"first reply\"}]}}\n\
{\"type\":\"assistant\",\"timestamp\":\"2026-04-01T07:00:02Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"Bash\",\"input\":{\"command\":\"go\"}}]}}\n\
{\"type\":\"user\",\"timestamp\":\"2026-04-01T07:00:03Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_1\",\"content\":\"ok\"}]}}\n\
{\"type\":\"user\",\"timestamp\":\"2026-04-01T07:01:00Z\",\"message\":{\"role\":\"user\",\"content\":\"second\"}}\n\
{\"type\":\"assistant\",\"timestamp\":\"2026-04-01T07:01:01Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"second reply\"}]}}\n";
    std::fs::write(&path, content).expect("write fixture");

    let indexed =
        index_claude_user_turns("claudecodeapp-preview", &path).expect("index user turns");
    assert_eq!(indexed.len(), 2);
    // The tool_use-only line and the tool_result line after the text reply
    // must not displace the text line as the round's preview candidate.
    let (offset, _) = indexed[0]
        .last_assistant_text_line
        .expect("round 1 preview candidate");
    assert!(offset > indexed[0].start_offset);

    let window = load_claude_code_initial_window_from_path("claudecodeapp-preview", &path, 1)
        .expect("load initial window");
    let placeholder = window
        .chunks
        .iter()
        .find(|chunk| chunk.chunk_id.starts_with("imported-unloaded-turn-"))
        .expect("round 1 placeholder");
    assert_eq!(
        placeholder.result.get("observation").and_then(Value::as_str),
        Some("first reply")
    );
    // No stray body chunks may survive next to an unloaded round: its user
    // header and placeholder are the only wire representation.
    assert_eq!(
        window
            .chunks
            .iter()
            .filter(|chunk| chunk.function != imported_history::FUNCTION_USER_MESSAGE
                && !chunk.chunk_id.starts_with("imported-unloaded-turn-"))
            .count(),
        1 // the loaded newest round's single assistant reply
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn parses_claude_session_metadata() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-meta-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-meta.jsonl");
    let content = r#"{"type":"user","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:46.543Z","message":{"role":"user","content":"build this"}}
{"type":"assistant","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:49.000Z","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":12,"output_tokens":34,"cache_read_input_tokens":5,"cache_creation_input_tokens":6}}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Claude").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "claude-meta".to_string(),
        source_path: path.clone(),
        source_record_key: "claude-meta".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
    };
    let meta = parse_claude_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    assert_eq!(meta.session_id, "claudecodeapp-claude-meta");
    assert_eq!(meta.name, "build this");
    assert_eq!(meta.model.as_deref(), Some("claude-sonnet-4"));
    assert_eq!(meta.repo_path.as_deref(), Some("/tmp/project"));
    assert_eq!(meta.branch.as_deref(), Some("main"));
    assert_eq!(meta.input_tokens, 23);
    assert_eq!(meta.output_tokens, 34);

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn counts_repeated_message_id_usage_once() {
    // Claude Code writes one API response across several assistant lines that
    // each repeat the cumulative usage; tokens + rounds must count it once.
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-dedup-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-dedup.jsonl");
    let content = r#"{"type":"user","sessionId":"d","timestamp":"2026-04-01T07:06:46.543Z","message":{"role":"user","content":"hi"}}
{"type":"assistant","sessionId":"d","timestamp":"2026-04-01T07:06:49.000Z","message":{"id":"msg_1","role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"a"}],"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":5,"cache_creation_input_tokens":6}}}
{"type":"assistant","sessionId":"d","timestamp":"2026-04-01T07:06:49.010Z","message":{"id":"msg_1","role":"assistant","model":"claude-sonnet-4","content":[{"type":"tool_use","id":"t","name":"x","input":{}}],"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":5,"cache_creation_input_tokens":6}}}
{"type":"assistant","sessionId":"d","timestamp":"2026-04-01T07:06:59.000Z","message":{"id":"msg_1","role":"assistant","content":[{"type":"text","text":"b"}],"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":5,"cache_creation_input_tokens":6}}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Claude").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "claude-dedup".to_string(),
        source_path: path.clone(),
        source_record_key: "claude-dedup".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
    };
    let meta = parse_claude_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    // Counted once despite three repeated lines of the same msg_1.
    assert_eq!(meta.input_tokens, 21); // 10 + 5 + 6, cache-inclusive
    assert_eq!(meta.output_tokens, 20);
    assert_eq!(meta.cache_read_tokens, 5);
    assert_eq!(meta.cache_write_tokens, 6);
    assert_eq!(meta.rounds.len(), 1);

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn prefers_claude_session_json_name_as_name() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-session-name-test-{}",
        std::process::id()
    ));
    let project_dir = temp_dir.join("projects").join("-Users-me-project");
    let sessions_dir = temp_dir.join("sessions");
    std::fs::create_dir_all(&project_dir).expect("create project dir");
    std::fs::create_dir_all(&sessions_dir).expect("create sessions dir");

    let path = project_dir.join("64c10ac1-0c64-4437-86df-8a5beac77f4b.jsonl");
    let content = r#"{"type":"user","sessionId":"64c10ac1-0c64-4437-86df-8a5beac77f4b","cwd":"/Users/me/project","gitBranch":"main","timestamp":"2026-07-08T07:06:46.543Z","message":{"role":"user","content":"first prompt fallback"}}
{"type":"assistant","sessionId":"64c10ac1-0c64-4437-86df-8a5beac77f4b","cwd":"/Users/me/project","gitBranch":"main","timestamp":"2026-07-08T07:06:49.000Z","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":12,"output_tokens":34}}}
"#;
    std::fs::write(&path, content).expect("write fixture");
    std::fs::write(
        sessions_dir.join("48664.json"),
        r#"{"pid":48664,"sessionId":"64c10ac1-0c64-4437-86df-8a5beac77f4b","cwd":"/Users/me/project","startedAt":1783522457884,"name":"orgii-05","nameSource":"derived"}"#,
    )
    .expect("write session metadata");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Claude").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "64c10ac1-0c64-4437-86df-8a5beac77f4b".to_string(),
        source_path: path.clone(),
        source_record_key: "64c10ac1-0c64-4437-86df-8a5beac77f4b".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
    };
    let meta = parse_claude_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    assert_eq!(meta.name, "orgii-05");

    std::fs::remove_dir_all(&temp_dir).expect("remove temp dir");
}

#[test]
fn prefers_claude_custom_title_over_ai_title_and_prompt() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-title-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-title.jsonl");
    // The app derives the displayed name from `custom-title` (user override)
    // first, then `ai-title`; the raw first prompt is only a last resort.
    let content = r#"{"type":"user","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:46.543Z","message":{"role":"user","content":"noisy first prompt that should not win"}}
{"type":"ai-title","aiTitle":"Auto generated title","sessionId":"abc"}
{"type":"custom-title","customTitle":"User chosen title","sessionId":"abc"}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Claude").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "claude-title".to_string(),
        source_path: path.clone(),
        source_record_key: "claude-title".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
    };
    let meta = parse_claude_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    assert_eq!(meta.name, "User chosen title");

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn counts_diff_stats_from_structured_patch() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-patch-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-patch.jsonl");
    // Two edited files: file_a nets +2/-1, file_b (a create) nets +1/-0.
    let content = r#"{"type":"user","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:46.543Z","message":{"role":"user","content":"do edits"}}
{"type":"user","sessionId":"abc","timestamp":"2026-04-01T07:06:47.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},"toolUseResult":{"filePath":"/tmp/project/a.rs","structuredPatch":[{"oldStart":1,"oldLines":2,"newStart":1,"newLines":3,"lines":[" ctx","-old line","+new line one","+new line two"]}]}}
{"type":"user","sessionId":"abc","timestamp":"2026-04-01T07:06:48.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"ok"}]},"toolUseResult":{"type":"create","filePath":"/tmp/project/b.rs","structuredPatch":[{"oldStart":0,"oldLines":0,"newStart":1,"newLines":1,"lines":["+brand new"]}]}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Claude").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "claude-patch".to_string(),
        source_path: path.clone(),
        source_record_key: "claude-patch".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
    };
    let meta = parse_claude_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    assert_eq!(meta.impact.lines_added, 3);
    assert_eq!(meta.impact.lines_removed, 1);
    assert_eq!(meta.impact.files_changed, 2);

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn prefers_claude_summary_as_session_name() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-summary-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-summary.jsonl");
    let content = r#"{"type":"summary","summary":"Ship auth dashboard","leafUuid":"abc"}
{"type":"user","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:46.543Z","message":{"role":"user","content":"build this"}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Claude").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "claude-summary".to_string(),
        source_path: path.clone(),
        source_record_key: "claude-summary".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
    };
    let meta = parse_claude_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    assert_eq!(meta.name, "Ship auth dashboard");

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn maps_claude_subagent_sidechain_to_parent_session_id() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-subagent-test-{}",
        std::process::id()
    ));
    let parent_uuid = "2a8996f3-3f82-4372-a315-3f116b2b79a7";
    let subagents_dir = temp_dir.join(parent_uuid).join("subagents");
    std::fs::create_dir_all(&subagents_dir).expect("create subagents dir");

    // Task-tool subagent transcript: every line is a sidechain and carries the
    // spawning session's UUID in `sessionId`, while the file itself is named
    // after the subagent's own `agent-*` id.
    let file_stem = "agent-affecc89fcde78ea8";
    let path = subagents_dir.join(format!("{file_stem}.jsonl"));
    let content = format!(
        r#"{{"type":"user","isSidechain":true,"sessionId":"{parent_uuid}","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-07-12T07:06:46.543Z","message":{{"role":"user","content":"explore the codebase"}}}}
{{"type":"assistant","isSidechain":true,"sessionId":"{parent_uuid}","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-07-12T07:06:49.000Z","message":{{"role":"assistant","model":"claude-sonnet-4","content":[{{"type":"text","text":"done"}}],"usage":{{"input_tokens":12,"output_tokens":34}}}}}}
"#
    );
    std::fs::write(&path, content).expect("write fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Claude").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: file_stem.to_string(),
        source_path: path.clone(),
        source_record_key: file_stem.to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
    };
    let meta = parse_claude_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    assert_eq!(meta.session_id, format!("claudecodeapp-{file_stem}"));
    assert_eq!(meta.name, "explore the codebase");
    assert_eq!(
        meta.parent_session_id.as_deref(),
        Some(format!("claudecodeapp-{parent_uuid}").as_str())
    );
    // The cache input must carry the parent through so the sidebar SQL
    // (`parent_session_id = ''`) and the frontend visibility filter subsume it.
    let cache_input = session_meta_to_cache_input(meta);
    assert_eq!(
        cache_input.parent_session_id.as_deref(),
        Some(format!("claudecodeapp-{parent_uuid}").as_str())
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir_all(&temp_dir).expect("remove temp dir");
}

#[test]
fn prefers_claude_subagent_metadata_description_over_prompt() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-subagent-title-test-{}",
        std::process::id()
    ));
    std::fs::remove_dir_all(&temp_dir).ok();
    let projects_dir = temp_dir.join("projects");
    let parent_uuid = "59fd4d4f-d556-412f-8b56-88cb8feebb39";
    let child_source_id = "agent-a45f5a98a73073100";
    let child_path = projects_dir
        .join("-Users-example-proj")
        .join(parent_uuid)
        .join("subagents")
        .join(format!("{child_source_id}.jsonl"));
    std::fs::create_dir_all(child_path.parent().expect("child parent"))
        .expect("create subagents dir");
    std::fs::write(
        &child_path,
        format!(
            r#"{{"type":"user","isSidechain":true,"sessionId":"{parent_uuid}","timestamp":"2026-08-06T18:00:02Z","message":{{"role":"user","content":"You are auditing part of the codebase. Your domain: work service transaction boundaries."}}}}
"#
        ),
    )
    .expect("write child fixture");
    std::fs::write(
        child_path.with_extension("meta.json"),
        r#"{"agentType":"general-purpose","description":"Audit work service transactions","spawnDepth":1}"#,
    )
    .expect("write child metadata fixture");

    let previous = HashMap::new();
    let mut walker =
        imported_history::scan_snapshot::SnapshotDirWalker::new(&previous, "jsonl", "Claude");
    let discovery =
        discover_claude_code_history_records(std::slice::from_ref(&projects_dir), &mut walker)
            .expect("discover");
    let record = discovery
        .records
        .iter()
        .find(|record| record.source_session_id == child_source_id)
        .expect("child record");
    let title = discovery
        .external_titles
        .get(child_source_id)
        .expect("metadata title");
    assert_eq!(title, "Audit work service transactions");
    assert_eq!(
        record.source_fingerprint,
        "subagent-meta:Audit work service transactions"
    );

    let meta = parse_claude_session_meta_with_title(record, None, title.clone())
        .expect("parse child")
        .meta
        .expect("child meta");
    assert_eq!(meta.name, "Audit work service transactions");
    assert_eq!(
        meta.parent_session_id.as_deref(),
        Some(format!("claudecodeapp-{parent_uuid}").as_str())
    );

    std::fs::remove_dir_all(&temp_dir).expect("remove temp dir");
}

#[test]
fn claude_subagent_metadata_change_invalidates_fingerprint() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-subagent-title-fingerprint-test-{}",
        std::process::id()
    ));
    std::fs::remove_dir_all(&temp_dir).ok();
    let projects_dir = temp_dir.join("projects");
    let child_path = projects_dir.join("-Users-example-proj/session/subagents/agent-a1.jsonl");
    std::fs::create_dir_all(child_path.parent().expect("child parent"))
        .expect("create subagents dir");
    std::fs::write(
        &child_path,
        r#"{"type":"user","isSidechain":true,"sessionId":"parent","timestamp":"2026-08-06T18:00:02Z","message":{"role":"user","content":"shared prompt"}}
"#,
    )
    .expect("write child fixture");
    let metadata_path = child_path.with_extension("meta.json");
    std::fs::write(
        &metadata_path,
        r#"{"description":"Audit work service transactions"}"#,
    )
    .expect("write first metadata");

    let discover = || {
        let previous = HashMap::new();
        let mut walker =
            imported_history::scan_snapshot::SnapshotDirWalker::new(&previous, "jsonl", "Claude");
        discover_claude_code_history_records(std::slice::from_ref(&projects_dir), &mut walker)
            .expect("discover")
    };
    let first = discover();
    let first_fingerprint = first.records[0].source_fingerprint.clone();

    std::fs::write(
        &metadata_path,
        r#"{"description":"Audit product mode implementation"}"#,
    )
    .expect("rewrite metadata");
    let second = discover();
    assert_ne!(first_fingerprint, second.records[0].source_fingerprint);
    assert_eq!(
        second.external_titles.get("agent-a1").map(String::as_str),
        Some("Audit product mode implementation")
    );

    std::fs::write(&metadata_path, "{malformed").expect("write malformed metadata");
    let malformed = discover();
    assert!(!malformed.external_titles.contains_key("agent-a1"));
    assert!(malformed.records[0].source_fingerprint.is_empty());

    std::fs::remove_dir_all(&temp_dir).expect("remove temp dir");
}

#[test]
fn top_level_claude_session_has_no_parent_session_id() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-no-parent-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    // A normal session's `sessionId` equals its own file stem and no line is a
    // sidechain, so it must stay a top-level (parentless) session.
    let path = temp_dir.join("claude-top-level.jsonl");
    let content = r#"{"type":"user","sessionId":"claude-top-level","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-07-12T07:06:46.543Z","message":{"role":"user","content":"build this"}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Claude").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "claude-top-level".to_string(),
        source_path: path.clone(),
        source_record_key: "claude-top-level".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
    };
    let meta = parse_claude_session_meta(&record)
        .expect("parse")
        .expect("session meta");

    assert_eq!(meta.parent_session_id, None);
    assert_eq!(session_meta_to_cache_input(meta).parent_session_id, None);

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn edit_replay_chunk_carries_structured_patch_as_diff() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-edit-diff-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-edit.jsonl");
    let content = r#"{"type":"assistant","sessionId":"abc","timestamp":"2026-04-01T07:06:47.000Z","message":{"role":"assistant","model":"m","content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"/tmp/p/a.rs","old_string":"old line","new_string":"new line one\nnew line two"}}]}}
{"type":"user","sessionId":"abc","timestamp":"2026-04-01T07:06:48.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"The file has been updated."}]},"toolUseResult":{"filePath":"/tmp/p/a.rs","oldString":"old line","newString":"new line one\nnew line two","structuredPatch":[{"oldStart":1,"oldLines":2,"newStart":1,"newLines":3,"lines":[" ctx","-old line","+new line one","+new line two"]}]}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_claude_code_history_from_path("claudecodeapp-abc", &path).expect("parse");
    assert_eq!(chunks.len(), 1);
    let edit = &chunks[0];
    assert_eq!(edit.function, imported_history::FUNCTION_EDIT_FILE);
    // Args no longer bury fields under `payload`; old/new stay off so the
    // context-rich diff (below) is what the frontend renders.
    assert_eq!(
        edit.args.get("action").and_then(Value::as_str),
        Some("edit")
    );
    assert_eq!(
        edit.args.get("file_path").and_then(Value::as_str),
        Some("/tmp/p/a.rs")
    );
    assert!(edit.args.get("payload").is_none());
    assert!(edit.args.get("old_string").is_none());

    let diff = edit
        .result
        .get("diff")
        .and_then(Value::as_str)
        .expect("diff");
    assert!(diff.contains("--- /tmp/p/a.rs"));
    assert!(diff.contains("@@ -1,2 +1,3 @@"));
    assert!(diff.contains("-old line"));
    assert!(diff.contains("+new line one"));
    assert!(diff.contains(" ctx"));
    assert_eq!(
        edit.result.get("linesAdded").and_then(Value::as_i64),
        Some(2)
    );
    assert_eq!(
        edit.result.get("linesRemoved").and_then(Value::as_i64),
        Some(1)
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn write_replay_chunk_is_tagged_create_and_diffs_from_patch() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-write-diff-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-write.jsonl");
    let content = r#"{"type":"assistant","sessionId":"abc","timestamp":"2026-04-01T07:06:47.000Z","message":{"role":"assistant","model":"m","content":[{"type":"tool_use","id":"w1","name":"Write","input":{"file_path":"/tmp/p/new.rs","content":"fn main() {}\n"}}]}}
{"type":"user","sessionId":"abc","timestamp":"2026-04-01T07:06:48.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"w1","content":"File created."}]},"toolUseResult":{"type":"create","filePath":"/tmp/p/new.rs","content":"fn main() {}\n","structuredPatch":[{"oldStart":0,"oldLines":0,"newStart":1,"newLines":1,"lines":["+fn main() {}"]}]}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_claude_code_history_from_path("claudecodeapp-abc", &path).expect("parse");
    assert_eq!(chunks.len(), 1);
    let write = &chunks[0];
    assert_eq!(write.function, imported_history::FUNCTION_EDIT_FILE);
    assert_eq!(
        write.args.get("action").and_then(Value::as_str),
        Some("create")
    );
    let diff = write
        .result
        .get("diff")
        .and_then(Value::as_str)
        .expect("diff");
    assert!(diff.contains("@@ -0,0 +1,1 @@"));
    assert!(diff.contains("+fn main() {}"));
    assert_eq!(
        write.result.get("linesAdded").and_then(Value::as_i64),
        Some(1)
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn edit_without_structured_patch_falls_back_to_old_new_on_args() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-edit-fallback-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-edit-fallback.jsonl");
    // Older/edge transcript: a tool result with authoritative old/new strings but
    // no structuredPatch. The strings are surfaced onto the args so a snippet
    // diff still renders.
    let content = r#"{"type":"assistant","sessionId":"abc","timestamp":"2026-04-01T07:06:47.000Z","message":{"role":"assistant","model":"m","content":[{"type":"tool_use","id":"t9","name":"Edit","input":{"file_path":"/tmp/p/a.rs","old_string":"foo","new_string":"bar"}}]}}
{"type":"user","sessionId":"abc","timestamp":"2026-04-01T07:06:48.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t9","content":"ok"}]},"toolUseResult":{"filePath":"/tmp/p/a.rs","oldString":"foo","newString":"bar"}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_claude_code_history_from_path("claudecodeapp-abc", &path).expect("parse");
    assert_eq!(chunks.len(), 1);
    let edit = &chunks[0];
    assert_eq!(
        edit.args.get("old_string").and_then(Value::as_str),
        Some("foo")
    );
    assert_eq!(
        edit.args.get("new_string").and_then(Value::as_str),
        Some("bar")
    );
    assert!(edit.result.get("diff").is_none());

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn captures_first_user_uuid_as_continuation_group_key() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-continuation-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("d0641111-1111-1111-1111-111111111111.jsonl");
    // Continuation rewrites preserve message uuids; the first `type:"user"`
    // line's uuid is the family key. Title/meta records before it must not
    // contribute a key.
    let content = r#"{"type":"custom-title","customTitle":"My convo","sessionId":"d0641111-1111-1111-1111-111111111111"}
{"type":"user","uuid":"b7b5ae5f-0000-0000-0000-000000000001","sessionId":"d0641111-1111-1111-1111-111111111111","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-07-17T10:00:00.000Z","message":{"role":"user","content":"first message"}}
{"type":"system","subtype":"compact_boundary","uuid":"eeb66522-0000-0000-0000-000000000001","sessionId":"d0641111-1111-1111-1111-111111111111","timestamp":"2026-07-17T10:00:30.000Z"}
{"type":"user","uuid":"b7b5ae5f-0000-0000-0000-000000000002","sessionId":"d0641111-1111-1111-1111-111111111111","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-07-17T10:01:00.000Z","message":{"role":"user","content":"second message"}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Claude").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "d0641111-1111-1111-1111-111111111111".to_string(),
        source_path: path.clone(),
        source_record_key: "d0641111-1111-1111-1111-111111111111".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
    };
    let meta = parse_claude_session_meta(&record)
        .expect("parse")
        .expect("session meta");
    assert_eq!(
        meta.first_user_uuid.as_deref(),
        Some("b7b5ae5f-0000-0000-0000-000000000001")
    );
    assert_eq!(
        meta.continuation_markers,
        vec!["eeb66522-0000-0000-0000-000000000001"]
    );

    let cache_input = session_meta_to_cache_input(meta);
    let metadata_json = cache_input.source_metadata_json.expect("metadata json");
    let parsed: serde_json::Value = serde_json::from_str(&metadata_json).expect("parse json");
    assert_eq!(
        parsed
            .get(imported_cache::CONTINUATION_GROUP_KEY_FIELD)
            .and_then(|value| value.as_str()),
        Some("b7b5ae5f-0000-0000-0000-000000000001")
    );
    assert_eq!(
        parsed
            .get(imported_cache::CONTINUATION_MARKERS_FIELD)
            .and_then(Value::as_array)
            .expect("continuation markers")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>(),
        vec![
            "b7b5ae5f-0000-0000-0000-000000000001",
            "eeb66522-0000-0000-0000-000000000001"
        ]
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn strips_ide_context_from_claude_replay() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-ide-context-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-ide-context.jsonl");
    // Line 1: ide_context-only user message (no user-authored text at all).
    // Line 2: bridge + ide_context prefixed user message with real text.
    let content = r#"{"type":"user","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:46.543Z","message":{"role":"user","content":"<ide_context>\nopen file: src/app.ts\n</ide_context>"}}
{"type":"user","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:47.000Z","message":{"role":"user","content":"<orgii_cli_exec_mode_bridge>\ninternal briefing\n</orgii_cli_exec_mode_bridge>\n\n<ide_context>\nopen file: src/app.ts\n</ide_context>\n\nfix the login bug"}}
{"type":"assistant","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:49.000Z","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":3,"output_tokens":5}}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    // Replay: the ide_context-only line emits no bubble; the prefixed
    // line's bubble carries only the user-authored text.
    let chunks = load_claude_code_history_from_path("claudecodeapp-abc", &path).expect("parse");
    let user_chunks: Vec<_> = chunks
        .iter()
        .filter(|chunk| chunk.function == imported_history::FUNCTION_USER_MESSAGE)
        .collect();
    assert_eq!(user_chunks.len(), 1);
    assert_eq!(
        user_chunks[0]
            .result
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str),
        Some("fix the login bug")
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn strips_orgii_exec_mode_bridge_from_claude_title_and_replay() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-bridge-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-bridge.jsonl");
    // Line 1: bridge-only user message (no user-authored text at all).
    // Line 2: bridge-prefixed user message with real text after it.
    let content = r#"{"type":"user","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:46.543Z","message":{"role":"user","content":"<orgii_cli_exec_mode_bridge>\ninternal briefing\n</orgii_cli_exec_mode_bridge>"}}
{"type":"user","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:47.000Z","message":{"role":"user","content":"<orgii_cli_exec_mode_bridge>\ninternal briefing\n</orgii_cli_exec_mode_bridge>\n\nfix the login bug"}}
{"type":"assistant","sessionId":"abc","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:49.000Z","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":3,"output_tokens":5}}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    // Title/first_prompt: the bridge-only line is skipped as a candidate;
    // the prefixed line contributes only the user-authored text.
    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&path, "Claude").expect("metadata");
    let record = ImportedHistoryDiscoveredRecord {
        source_session_id: "claude-bridge".to_string(),
        source_path: path.clone(),
        source_record_key: "claude-bridge".to_string(),
        source_mtime_ms,
        source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
    };
    let meta = parse_claude_session_meta(&record)
        .expect("parse")
        .expect("session meta");
    assert_eq!(meta.name, "fix the login bug");

    // Replay: the bridge-only line emits no bubble; the prefixed line's
    // bubble carries only the user-authored text.
    let chunks = load_claude_code_history_from_path("claudecodeapp-abc", &path).expect("parse");
    let user_chunks: Vec<_> = chunks
        .iter()
        .filter(|chunk| chunk.function == imported_history::FUNCTION_USER_MESSAGE)
        .collect();
    assert_eq!(user_chunks.len(), 1);
    assert_eq!(
        user_chunks[0]
            .result
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str),
        Some("fix the login bug")
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn resumes_claude_meta_parse_from_watermark() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-history-watermark-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("claude-watermark.jsonl");
    let prefix = r#"{"type":"user","sessionId":"w","cwd":"/tmp/project","gitBranch":"main","timestamp":"2026-04-01T07:06:46.543Z","message":{"role":"user","content":"build this"}}
{"type":"assistant","sessionId":"w","timestamp":"2026-04-01T07:06:49.000Z","message":{"id":"msg_1","role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"a"}],"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":5,"cache_creation_input_tokens":6}}}
"#;
    std::fs::write(&path, prefix).expect("write fixture");

    let record_for = |path: &std::path::Path| {
        let (source_mtime_ms, source_size_bytes) =
            imported_paths::file_metadata_signature(path, "Claude").expect("metadata");
        ImportedHistoryDiscoveredRecord {
            source_session_id: "claude-watermark".to_string(),
            source_path: path.to_path_buf(),
            source_record_key: "claude-watermark".to_string(),
            source_mtime_ms,
            source_size_bytes,
            source_fingerprint: String::new(),
            parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
        }
    };

    let first = parse_claude_session_meta_incremental(&record_for(&path), None).expect("parse");
    assert!(!first.resumed);
    assert_eq!(first.watermark.byte_offset, prefix.len() as i64);
    let first_meta = first.meta.expect("first meta");
    assert_eq!(first_meta.input_tokens, 21);
    assert_eq!(first_meta.rounds.len(), 1);

    let suffix = r#"{"type":"assistant","sessionId":"w","timestamp":"2026-04-01T07:07:10.000Z","message":{"id":"msg_2","role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"b"}],"usage":{"input_tokens":40,"output_tokens":50,"cache_read_input_tokens":7,"cache_creation_input_tokens":8}}}
"#;
    std::fs::write(&path, format!("{prefix}{suffix}")).expect("append fixture");

    let resumed = parse_claude_session_meta_incremental(&record_for(&path), Some(&first.watermark))
        .expect("parse resumed");
    assert!(resumed.resumed);
    let scratch = parse_claude_session_meta_incremental(&record_for(&path), None)
        .expect("parse from scratch");
    assert!(!scratch.resumed);

    let resumed_meta = resumed.meta.expect("resumed meta");
    let scratch_meta = scratch.meta.expect("scratch meta");
    assert_eq!(resumed_meta.input_tokens, 21 + 55);
    assert_eq!(resumed_meta.input_tokens, scratch_meta.input_tokens);
    assert_eq!(resumed_meta.output_tokens, scratch_meta.output_tokens);
    assert_eq!(
        resumed_meta.cache_read_tokens,
        scratch_meta.cache_read_tokens
    );
    assert_eq!(
        resumed_meta.cache_write_tokens,
        scratch_meta.cache_write_tokens
    );
    assert_eq!(resumed_meta.rounds.len(), 2);
    assert_eq!(resumed_meta.rounds.len(), scratch_meta.rounds.len());
    assert_eq!(resumed_meta.rounds[1].seq, 1);
    assert_eq!(resumed_meta.rounds[1].input_tokens, 40);
    assert_eq!(resumed_meta.name, scratch_meta.name);
    assert_eq!(resumed_meta.created_at_ms, scratch_meta.created_at_ms);
    assert_eq!(resumed_meta.updated_at_ms, scratch_meta.updated_at_ms);
    assert_eq!(resumed.watermark.byte_offset, scratch.watermark.byte_offset);
    assert_eq!(resumed.watermark.prefix_hash, scratch.watermark.prefix_hash);

    // Same-length prefix mutation invalidates the watermark: the message.id
    // rewrite would double-count msg_2 usage if the resume were trusted.
    let mutated = format!("{prefix}{suffix}").replace("build this", "BUILD THIS");
    std::fs::write(&path, mutated).expect("mutate fixture");
    let reparsed =
        parse_claude_session_meta_incremental(&record_for(&path), Some(&resumed.watermark))
            .expect("parse mutated");
    assert!(!reparsed.resumed);
    let reparsed_meta = reparsed.meta.expect("reparsed meta");
    assert_eq!(reparsed_meta.input_tokens, 21 + 55);
    assert_eq!(reparsed_meta.name, "BUILD THIS");

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

fn journal_filter_fixture(tag: &str) -> std::path::PathBuf {
    let temp_dir =
        std::env::temp_dir().join(format!("orgii-claude-journal-{tag}-{}", std::process::id()));
    std::fs::remove_dir_all(&temp_dir).ok();
    let projects_dir = temp_dir.join("projects");
    let project = projects_dir.join("-Users-example-proj");
    let session = "11111111-1111-1111-1111-111111111111";
    let workflow_dir = project.join(session).join("subagents/workflows/wf_abc");
    std::fs::create_dir_all(&workflow_dir).expect("create workflow dir");
    let line = r#"{"type":"user","sessionId":"s","timestamp":"2026-04-01T07:06:46.543Z","message":{"role":"user","content":"hello"}}
"#;
    std::fs::write(project.join(format!("{session}.jsonl")), line).expect("write session");
    std::fs::write(
        workflow_dir.join("journal.jsonl"),
        "{\"type\":\"started\"}\n",
    )
    .expect("write journal");
    std::fs::write(workflow_dir.join("agent-a1.jsonl"), line).expect("write workflow agent");
    std::fs::write(project.join(session).join("subagents/agent-a2.jsonl"), line)
        .expect("write subagent");
    temp_dir
}

#[test]
fn excludes_workflow_journal_files_from_discovery_and_collect() {
    let temp_dir = journal_filter_fixture("filter");
    let projects_dir = temp_dir.join("projects");

    let mut files = Vec::new();
    collect_claude_session_files(&projects_dir, &mut files).expect("collect");
    let stems = files
        .iter()
        .map(|file| file.file_stem.as_str())
        .collect::<Vec<_>>();
    assert!(!stems.contains(&"journal"));
    assert!(stems.contains(&"11111111-1111-1111-1111-111111111111"));
    assert!(stems.contains(&"agent-a1"));
    assert!(stems.contains(&"agent-a2"));

    let previous = HashMap::new();
    let mut walker =
        imported_history::scan_snapshot::SnapshotDirWalker::new(&previous, "jsonl", "Claude");
    let discovery =
        discover_claude_code_history_records(std::slice::from_ref(&projects_dir), &mut walker)
            .expect("discover");
    let ids = discovery
        .records
        .iter()
        .map(|record| record.source_session_id.as_str())
        .collect::<Vec<_>>();
    assert!(!ids.contains(&"journal"));
    assert_eq!(discovery.records.len(), 3);

    assert!(is_claude_workflow_journal_path(Path::new(
        "/home/u/.claude/projects/p/uuid/subagents/workflows/wf_1/journal.jsonl"
    )));
    assert!(!is_claude_workflow_journal_path(Path::new(
        "/home/u/.claude/projects/p/uuid/subagents/workflows/wf_1/agent-a1.jsonl"
    )));
    assert!(!is_claude_workflow_journal_path(Path::new(
        "/home/u/.claude/projects/p/uuid/subagents/agent-a2.jsonl"
    )));
    assert!(!is_claude_workflow_journal_path(Path::new(
        "/home/u/.claude/projects/p/journal.jsonl"
    )));

    std::fs::remove_dir_all(&temp_dir).ok();
}

#[test]
fn prunes_stale_journal_cache_row_after_discovery_filter() {
    let temp_dir = journal_filter_fixture("prune");
    let projects_dir = temp_dir.join("projects");
    let conn = Connection::open_in_memory().expect("open in-memory db");
    crate::store::sqlite::SqliteRecordStore::init_tables(&conn).expect("init core tables");
    crate::store::sqlite::SqliteRecordStore::init_source_cache_tables(&conn)
        .expect("init source cache tables");
    conn.execute(
        "INSERT INTO imported_history_session_cache (source, source_session_id, session_id)
         VALUES ('claude_code', 'journal', 'claudecodeapp-journal')",
        [],
    )
    .expect("seed journal cache row");
    imported_history::watermark::write_parse_watermark_from_conn(
        &conn,
        SOURCE_CLAUDE_CODE,
        "journal",
        &ImportedParseWatermark {
            byte_offset: 1,
            source_size_bytes: 1,
            source_mtime_ms: 1,
            prefix_hash: "00".to_string(),
            parser_version: 1,
            state_json: "{}".to_string(),
        },
    )
    .expect("seed journal watermark");

    let previous = HashMap::new();
    let mut walker =
        imported_history::scan_snapshot::SnapshotDirWalker::new(&previous, "jsonl", "Claude");
    let discovery =
        discover_claude_code_history_records(std::slice::from_ref(&projects_dir), &mut walker)
            .expect("discover");
    let signatures = discovery
        .records
        .iter()
        .map(ImportedHistoryDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let live_ids = imported_cache::live_ids_from_signatures(&signatures);
    assert!(!live_ids.is_empty());
    assert!(!live_ids.iter().any(|id| id == "journal"));

    imported_cache::prune_missing_records_from_conn(&conn, SOURCE_CLAUDE_CODE, &live_ids)
        .expect("prune");

    let journal_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM imported_history_session_cache
             WHERE source = 'claude_code' AND source_session_id = 'journal'",
            [],
            |row| row.get(0),
        )
        .expect("count journal rows");
    assert_eq!(journal_rows, 0);
    assert_eq!(
        imported_history::watermark::read_parse_watermark_from_conn(
            &conn,
            SOURCE_CLAUDE_CODE,
            "journal"
        )
        .expect("read journal watermark"),
        None
    );

    std::fs::remove_dir_all(&temp_dir).ok();
}

#[test]
fn snapshot_reuse_keeps_fresh_file_signatures() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-claude-snapshot-reuse-{}",
        std::process::id()
    ));
    std::fs::remove_dir_all(&temp_dir).ok();
    let projects_dir = temp_dir.join("projects");
    let project = projects_dir.join("-Users-example-proj");
    std::fs::create_dir_all(&project).expect("create project dir");
    let session_path = project.join("22222222-2222-2222-2222-222222222222.jsonl");
    std::fs::write(&session_path, "{\"type\":\"user\"}\n").expect("write session");
    std::thread::sleep(std::time::Duration::from_millis(5));

    let empty = HashMap::new();
    let mut cold_walker =
        imported_history::scan_snapshot::SnapshotDirWalker::new(&empty, "jsonl", "Claude");
    let cold =
        discover_claude_code_history_records(std::slice::from_ref(&projects_dir), &mut cold_walker)
            .expect("cold discover");
    assert_eq!(cold.records.len(), 1);
    let cold_size = cold.records[0].source_size_bytes;
    assert!(cold_walker.dirs_enumerated >= 2);
    let snapshots = cold_walker.into_snapshots();

    std::fs::OpenOptions::new()
        .append(true)
        .open(&session_path)
        .and_then(|mut file| std::io::Write::write_all(&mut file, b"{\"type\":\"assistant\"}\n"))
        .expect("append to session");

    let mut warm_walker =
        imported_history::scan_snapshot::SnapshotDirWalker::new(&snapshots, "jsonl", "Claude");
    let warm =
        discover_claude_code_history_records(std::slice::from_ref(&projects_dir), &mut warm_walker)
            .expect("warm discover");
    assert_eq!(warm_walker.dirs_enumerated, 0);
    assert_eq!(warm_walker.dirs_reused, 2);
    assert_eq!(warm.records.len(), 1);
    assert!(warm.records[0].source_size_bytes > cold_size);
    assert!(warm.records[0].source_mtime_ms >= cold.records[0].source_mtime_ms);

    std::fs::remove_dir_all(&temp_dir).ok();
}

#[test]
#[ignore]
fn bench_real_home_claude_discovery_cold_vs_warm() {
    let projects_dirs = claude_projects_dirs().expect("projects dirs");
    let empty = HashMap::new();

    let started = std::time::Instant::now();
    let mut cold_walker =
        imported_history::scan_snapshot::SnapshotDirWalker::new(&empty, "jsonl", "Claude");
    let cold =
        discover_claude_code_history_records(&projects_dirs, &mut cold_walker).expect("cold");
    let cold_elapsed = started.elapsed();
    let cold_enumerated = cold_walker.dirs_enumerated;
    let snapshots = cold_walker.into_snapshots();

    let started = std::time::Instant::now();
    let mut warm_walker =
        imported_history::scan_snapshot::SnapshotDirWalker::new(&snapshots, "jsonl", "Claude");
    let warm =
        discover_claude_code_history_records(&projects_dirs, &mut warm_walker).expect("warm");
    let warm_elapsed = started.elapsed();

    println!(
        "claude discovery cold={cold_elapsed:?} ({} records, {cold_enumerated} dirs enumerated) \
         warm={warm_elapsed:?} ({} records, {} dirs reused, {} dirs enumerated)",
        cold.records.len(),
        warm.records.len(),
        warm_walker.dirs_reused,
        warm_walker.dirs_enumerated,
    );
    assert_eq!(cold.records.len(), warm.records.len());
}
