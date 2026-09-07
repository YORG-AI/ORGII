use std::path::{Path, PathBuf};

use super::cache::{
    CodexTranscriptSignature, CodexTurnOffset, CodexTurnOffsetCache,
    CODEX_TURN_OFFSET_CACHE_CAPACITY, CODEX_TURN_OFFSET_LIMIT_PER_SESSION,
};
use super::reader::load_codex_app_mobile_tail_window_from_path_with_scan_limit;
use super::{
    load_codex_app_cloud_turn_from_path, load_codex_app_from_path,
    load_codex_app_turn_ids_from_path,
};

#[test]
fn preserves_codex_user_image_data_url_for_native_transfer() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-user-image-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-user-image.jsonl");
    let content = r#"{"timestamp":"2026-08-30T01:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"inspect"},{"type":"input_image","image_url":"data:image/png;base64,QUJD"}]}}
{"timestamp":"2026-08-30T01:00:00Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","id":"user-1","content":[{"type":"text","text":"inspect","text_elements":[]},{"type":"local_image","path":"/source-machine/image.png"}]}}}"#;
    std::fs::write(&path, format!("{content}\n")).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-user-image", &path)
        .expect("parse user image transcript");
    let user = chunks
        .iter()
        .find(|chunk| chunk.function == "user_message")
        .expect("user message");
    assert_eq!(
        chunks
            .iter()
            .filter(|chunk| chunk.function == "user_message")
            .count(),
        1
    );
    assert_eq!(user.result["message"]["content"], "inspect");
    assert_eq!(user.result["images"][0], "data:image/png;base64,QUJD");

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn preserves_app_server_injected_user_rows_without_ui_mirrors() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-injected-user-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-injected-user.jsonl");
    // `thread/start` establishes the native turn-context boundary before its
    // supported `thread/inject_items` history. Provider bootstrap may precede
    // it, while these injected rows deliberately follow it.
    let content = r#"{"timestamp":"2026-08-30T00:59:59Z","type":"turn_context","payload":{"turn_id":"materialization"}}
{"timestamp":"2026-08-30T01:00:00Z","type":"response_item","payload":{"type":"message","id":"user-1","role":"user","content":[{"type":"input_text","text":"first"},{"type":"input_image","image_url":"data:image/png;base64,QUJD"}]}}
{"timestamp":"2026-08-30T01:00:01Z","type":"response_item","payload":{"type":"message","id":"assistant-1","role":"assistant","content":[{"type":"output_text","text":"answer"}]}}
{"timestamp":"2026-08-30T01:00:02Z","type":"response_item","payload":{"type":"message","id":"user-2","role":"user","content":[{"type":"input_text","text":"second"}]}}"#;
    std::fs::write(&path, format!("{content}\n")).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-injected-user", &path)
        .expect("parse app-server injected transcript");
    let users = chunks
        .iter()
        .filter(|chunk| chunk.function == "user_message")
        .collect::<Vec<_>>();
    assert_eq!(users.len(), 2);
    assert_eq!(users[0].result["message"]["content"], "first");
    assert_eq!(users[0].result["images"][0], "data:image/png;base64,QUJD");
    assert_eq!(users[0].args["__orgiiSourceEventId"], "user-1");
    assert_eq!(users[1].result["message"]["content"], "second");
    assert_eq!(users[1].args["__orgiiSourceEventId"], "user-2");
    let assistants = chunks
        .iter()
        .filter(|chunk| chunk.function == "assistant")
        .collect::<Vec<_>>();
    assert_eq!(assistants.len(), 1);
    assert_eq!(assistants[0].args["__orgiiSourceEventId"], "assistant-1");

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn drops_pre_turn_app_server_bootstrap_without_trimming_later_native_turns() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-app-server-bootstrap-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-app-server-bootstrap.jsonl");
    let content = r#"{"timestamp":"2026-08-30T01:00:00Z","type":"session_meta","payload":{"id":"native-1"}}
{"timestamp":"2026-08-30T01:00:01Z","type":"response_item","payload":{"type":"message","id":"msg-bootstrap","role":"user","content":[{"type":"input_text","text":"<recommended_plugins>provider bootstrap</recommended_plugins>"}]}}
{"timestamp":"2026-08-30T01:00:02Z","type":"response_item","payload":{"type":"message","id":"orgii_evt_fedcba9876543210fedcba9876543210","role":"user","content":[{"type":"input_text","text":"early canonical team message"}]}}
{"timestamp":"2026-08-30T01:00:03Z","type":"turn_context","payload":{"turn_id":"turn-native"}}
{"timestamp":"2026-08-30T01:00:04Z","type":"event_msg","payload":{"type":"user_message","message":"real native question","images":[],"local_images":[]}}
{"timestamp":"2026-08-30T01:00:05Z","type":"event_msg","payload":{"type":"agent_message","message":"real native answer"}}
{"timestamp":"2026-08-30T01:00:06Z","type":"response_item","payload":{"type":"message","id":"orgii_evt_0123456789abcdef0123456789abcdef","role":"user","content":[{"type":"input_text","text":"later canonical team message"}]}}"#;
    std::fs::write(&path, format!("{content}\n")).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-bootstrap-boundary", &path)
        .expect("parse app-server bootstrap transcript");
    let messages = chunks
        .iter()
        .filter(|chunk| chunk.function == "user_message" || chunk.function == "assistant")
        .collect::<Vec<_>>();

    assert_eq!(messages.len(), 4);
    assert_eq!(
        messages[0].result["message"]["content"],
        "early canonical team message"
    );
    assert_eq!(
        messages[0].args["__orgiiSourceEventId"],
        "orgii_evt_fedcba9876543210fedcba9876543210"
    );
    assert_eq!(
        messages[1].result["message"]["content"],
        "real native question"
    );
    assert_eq!(messages[2].result["content"], "real native answer");
    assert_eq!(
        messages[3].result["message"]["content"],
        "later canonical team message"
    );
    assert_eq!(
        messages[3].args["__orgiiSourceEventId"],
        "orgii_evt_0123456789abcdef0123456789abcdef"
    );
    assert!(chunks.iter().all(|chunk| {
        chunk.result["message"]["content"].as_str()
            != Some("<recommended_plugins>provider bootstrap</recommended_plugins>")
    }));

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn marks_an_unresolved_codex_tool_as_interrupted_not_completed() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-interrupted-tool-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-interrupted.jsonl");
    let content = r#"{"timestamp":"2026-08-30T01:00:00Z","type":"event_msg","payload":{"type":"user_message","message":"inspect","images":[],"local_images":[]}}
{"timestamp":"2026-08-30T01:00:01Z","type":"event_msg","payload":{"type":"agent_message","message":"I found one thing."}}
{"timestamp":"2026-08-30T01:00:02Z","type":"response_item","payload":{"type":"function_call","name":"read_file","arguments":"{\"path\":\"/repo/README.md\"}","call_id":"call_interrupted"}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-interrupted", &path)
        .expect("parse interrupted transcript");
    let tool = chunks
        .iter()
        .find(|chunk| chunk.action_type == "tool_call")
        .expect("interrupted tool is diagnostic history");
    assert_eq!(tool.result["status"], "pending");
    assert_eq!(tool.result["interrupted"], true);
    assert!(chunks.iter().any(|chunk| {
        chunk.function == "assistant"
            && chunk.result["content"].as_str() == Some("I found one thing.")
    }));

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn native_compaction_is_one_system_marker_not_replacement_user_history() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-native-compact-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-compact.jsonl");
    let content = r#"{"timestamp":"2026-08-29T07:00:00Z","type":"event_msg","payload":{"type":"user_message","message":"inspect the repo","images":[],"local_images":[]}}
{"timestamp":"2026-08-29T07:00:01Z","type":"response_item","payload":{"type":"function_call","name":"read_file","arguments":"{\"path\":\"/repo/README.md\"}","call_id":"call_before_compact"}}
{"timestamp":"2026-08-29T07:00:02Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_before_compact","output":"contents"}}
{"timestamp":"2026-08-29T07:00:03Z","type":"event_msg","payload":{"type":"agent_message","message":"done"}}
{"timestamp":"2026-08-29T07:00:04Z","type":"compacted","payload":{"message":"Native Codex summary","replacement_history":[{"item":{"type":"message","role":"user","content":[{"type":"input_text","text":"replacement history copy"}]}},{"item":{"type":"compaction","encrypted_content":"opaque-provider-state"}}],"window_number":2,"first_window_id":"window-1","previous_window_id":"window-1","window_id":"window-2"}}
{"timestamp":"2026-08-29T07:00:04Z","type":"event_msg","payload":{"type":"token_count","info":null}}
{"timestamp":"2026-08-29T07:00:04Z","type":"event_msg","payload":{"type":"context_compacted"}}
{"timestamp":"2026-08-29T07:00:05Z","type":"event_msg","payload":{"type":"user_message","message":"continue after compact","images":[],"local_images":[]}}
{"timestamp":"2026-08-29T07:00:06Z","type":"event_msg","payload":{"type":"agent_message","message":"continued"}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-native-compact", &path)
        .expect("parse native compact transcript");
    let human_messages = chunks
        .iter()
        .filter(|chunk| chunk.function == "user_message")
        .map(|chunk| {
            chunk.result["message"]["content"]
                .as_str()
                .unwrap_or_default()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        human_messages,
        vec!["inspect the repo", "continue after compact"]
    );
    assert!(!serde_json::to_string(&chunks)
        .expect("serialize chunks")
        .contains("replacement history copy"));
    let compact_markers = chunks
        .iter()
        .filter(|chunk| chunk.function == "context_compacted")
        .collect::<Vec<_>>();
    assert_eq!(compact_markers.len(), 1);
    assert_eq!(
        compact_markers[0].result["observation"].as_str(),
        Some("Native Codex summary")
    );
    let tool = chunks
        .iter()
        .find(|chunk| chunk.action_type == "tool_call")
        .expect("paired tool call");
    assert_eq!(tool.args["path"], "/repo/README.md");
    assert_eq!(tool.result["output"], "contents");

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn adjacent_native_compaction_windows_form_one_logical_boundary() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-native-compact-windows-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-compact-windows.jsonl");
    let content = r#"{"timestamp":"2026-08-29T07:00:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"inspect","images":[],"local_images":[]}}
{"timestamp":"2026-08-29T07:00:04.000Z","type":"compacted","payload":{"message":"","window_number":152,"window_id":"window-152","replacement_history":[]}}
{"timestamp":"2026-08-29T07:00:04.020Z","type":"compacted","payload":{"message":"","window_number":153,"previous_window_id":"window-152","window_id":"window-153","replacement_history":[]}}
{"timestamp":"2026-08-29T07:00:04.040Z","type":"compacted","payload":{"message":"final summary","window_number":154,"previous_window_id":"window-153","window_id":"window-154","replacement_history":[]}}
{"timestamp":"2026-08-29T07:00:04.050Z","type":"event_msg","payload":{"type":"context_compacted"}}
{"timestamp":"2026-08-29T07:00:05.000Z","type":"event_msg","payload":{"type":"user_message","message":"continue","images":[],"local_images":[]}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-native-compact-windows", &path)
        .expect("parse native compact windows");
    let compact_markers = chunks
        .iter()
        .filter(|chunk| chunk.function == "context_compacted")
        .collect::<Vec<_>>();
    assert_eq!(compact_markers.len(), 1);
    assert_eq!(
        compact_markers[0].result["observation"].as_str(),
        Some("final summary")
    );
    assert!(compact_markers[0].chunk_id.contains("window-154"));

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn nearby_distinct_native_compactions_are_not_merged() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-distinct-native-compacts-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout-distinct-compacts.jsonl");
    let content = r#"{"timestamp":"2026-08-29T07:00:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"inspect","images":[],"local_images":[]}}
{"timestamp":"2026-08-29T07:00:01.000Z","type":"compacted","payload":{"message":"first summary","window_number":2,"previous_window_id":"window-1","window_id":"window-2","replacement_history":[]}}
{"timestamp":"2026-08-29T07:00:01.010Z","type":"event_msg","payload":{"type":"context_compacted"}}
{"timestamp":"2026-08-29T07:00:02.000Z","type":"compacted","payload":{"message":"second summary","window_number":3,"previous_window_id":"window-2","window_id":"window-3","replacement_history":[]}}
{"timestamp":"2026-08-29T07:00:02.010Z","type":"event_msg","payload":{"type":"context_compacted"}}"#;
    std::fs::write(&path, format!("{content}\n")).expect("write fixture");

    let chunks = load_codex_app_from_path("codexapp-distinct-native-compacts", &path)
        .expect("parse distinct nearby native compactions");
    let compact_markers = chunks
        .iter()
        .filter(|chunk| chunk.function == "context_compacted")
        .collect::<Vec<_>>();
    assert_eq!(compact_markers.len(), 2);
    assert_eq!(
        compact_markers[0].result["observation"].as_str(),
        Some("first summary")
    );
    assert_eq!(
        compact_markers[1].result["observation"].as_str(),
        Some("second summary")
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn cloud_turn_ids_are_source_offsets_in_transcript_order() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-cloud-turn-ids-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout.jsonl");
    let first = r#"{"timestamp":"2026-08-05T10:00:00Z","payload":{"type":"user_message","message":"first"}}"#;
    let assistant = r#"{"timestamp":"2026-08-05T10:00:01Z","payload":{"type":"assistant_message","message":"reply"}}"#;
    let second = r#"{"timestamp":"2026-08-05T10:01:00Z","payload":{"type":"user_message","message":"second"}}"#;
    std::fs::write(&path, format!("{first}\n{assistant}\n{second}\n")).expect("write fixture");

    let ids = load_codex_app_turn_ids_from_path(&path).expect("load turn ids");
    let second_offset = first.len() + 1 + assistant.len() + 1;
    assert_eq!(
        ids,
        vec![
            "codex-user-0".to_string(),
            format!("codex-user-{second_offset}")
        ]
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn cloud_turn_windows_preserve_full_sequence_ids() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-cloud-turn-window-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout.jsonl");
    let content = r#"{"timestamp":"2026-08-05T10:00:00Z","payload":{"type":"task_started","turn_id":"provider-turn-1"}}
{"timestamp":"2026-08-05T10:00:01Z","payload":{"type":"user_message","message":"first"}}
{"timestamp":"2026-08-05T10:01:00Z","payload":{"type":"task_started","turn_id":"provider-turn-2"}}
{"timestamp":"2026-08-05T10:01:01Z","payload":{"type":"user_message","message":"second"}}
"#;
    std::fs::write(&path, content).expect("write fixture");

    let full =
        load_codex_app_from_path("codexapp-cloud-window", &path).expect("load full transcript");
    let ids = load_codex_app_turn_ids_from_path(&path).expect("load turn ids");
    let mut cloud = Vec::new();
    let mut next_sequence = 0usize;
    for turn_id in ids {
        let chunks = load_codex_app_cloud_turn_from_path(
            "codexapp-cloud-window",
            &path,
            &turn_id,
            next_sequence,
        )
        .expect("load cloud turn");
        next_sequence += chunks.len();
        cloud.extend(chunks);
    }
    assert_eq!(
        serde_json::to_value(cloud).expect("serialize cloud chunks"),
        serde_json::to_value(full).expect("serialize full chunks")
    );

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn cloud_turn_rejects_an_unparseable_turn_id() {
    let error = load_codex_app_cloud_turn_from_path(
        "codexapp-cloud-window",
        Path::new("unused.jsonl"),
        "not-a-codex-turn-id",
        0,
    )
    .expect_err("invalid id must error, not read as empty");
    assert!(error.contains("Invalid Codex cloud turn id"));
}

#[test]
fn codex_turn_offset_cache_bounds_sessions_and_turns() {
    let signature = CodexTranscriptSignature {
        modified_ns: 1,
        size_bytes: 2,
    };
    let mut cache = CodexTurnOffsetCache::default();
    for session in 0..=CODEX_TURN_OFFSET_CACHE_CAPACITY {
        let offsets = (0..=CODEX_TURN_OFFSET_LIMIT_PER_SESSION)
            .map(|turn| CodexTurnOffset {
                turn_id: format!("turn-{turn}"),
                byte_offset: turn as u64,
                sequence: turn,
            })
            .collect();
        cache.insert(
            PathBuf::from(format!("session-{session}.jsonl")),
            signature,
            offsets,
        );
    }

    assert_eq!(cache.entries.len(), CODEX_TURN_OFFSET_CACHE_CAPACITY);
    assert!(cache
        .get(Path::new("session-0.jsonl"), signature, "turn-4096")
        .is_none());
    assert!(cache
        .get(Path::new("session-8.jsonl"), signature, "turn-0")
        .is_none());
    assert_eq!(
        cache.get(Path::new("session-8.jsonl"), signature, "turn-4096"),
        Some((4096, 4096))
    );
}

#[test]
fn mobile_tail_window_reads_only_the_latest_bounded_turn() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-mobile-tail-window-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout.jsonl");
    let first = r#"{"timestamp":"2026-08-29T10:00:00Z","payload":{"type":"user_message","message":"outside bound"}}"#;
    let padding = format!(
        "{{\"timestamp\":\"2026-08-29T10:00:01Z\",\"payload\":{{\"type\":\"reasoning\",\"summary\":[{{\"text\":\"{}\"}}]}}}}",
        "x".repeat(2_048)
    );
    let latest = r#"{"timestamp":"2026-08-29T10:01:00Z","payload":{"type":"user_message","message":"latest"}}"#;
    let reply = r#"{"timestamp":"2026-08-29T10:01:01Z","payload":{"type":"agent_message","message":"latest reply"}}"#;
    std::fs::write(&path, format!("{first}\n{padding}\n{latest}\n{reply}\n"))
        .expect("write fixture");

    let window = load_codex_app_mobile_tail_window_from_path_with_scan_limit(
        "codexapp-mobile-tail",
        &path,
        (latest.len() + reply.len() + 2) as u64,
    )
    .expect("load bounded mobile tail");
    assert!(window.chunks.iter().any(|chunk| {
        chunk
            .result
            .pointer("/message/content")
            .and_then(serde_json::Value::as_str)
            == Some("latest")
    }));
    assert!(window.chunks.iter().any(|chunk| {
        chunk
            .result
            .get("observation")
            .and_then(serde_json::Value::as_str)
            == Some("latest reply")
    }));
    assert!(!window.chunks.iter().any(|chunk| {
        chunk
            .result
            .pointer("/message/content")
            .and_then(serde_json::Value::as_str)
            == Some("outside bound")
    }));

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}

#[test]
fn mobile_tail_window_fails_when_no_user_turn_is_inside_the_bound() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orgii-codex-mobile-tail-error-test-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).expect("create temp dir");
    let path = temp_dir.join("rollout.jsonl");
    std::fs::write(
        &path,
        concat!(
            "{\"timestamp\":\"2026-08-29T10:00:00Z\",\"payload\":{\"type\":\"user_message\",\"message\":\"old\"}}\n",
            "{\"timestamp\":\"2026-08-29T10:01:00Z\",\"payload\":{\"type\":\"agent_message\",\"message\":\"reply\"}}\n"
        ),
    )
    .expect("write fixture");

    let error = load_codex_app_mobile_tail_window_from_path_with_scan_limit(
        "codexapp-mobile-tail",
        &path,
        16,
    )
    .expect_err("missing bounded user turn must be explicit");
    assert!(error.contains("No recent Codex user turn"));

    std::fs::remove_file(&path).expect("remove fixture");
    std::fs::remove_dir(&temp_dir).expect("remove temp dir");
}
