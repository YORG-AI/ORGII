use std::path::{Path, PathBuf};

use super::cache::{
    CodexTranscriptSignature, CodexTurnOffset, CodexTurnOffsetCache,
    CODEX_TURN_OFFSET_CACHE_CAPACITY, CODEX_TURN_OFFSET_LIMIT_PER_SESSION,
};
use super::{
    load_codex_app_cloud_turn_from_path, load_codex_app_from_path,
    load_codex_app_turn_ids_from_path,
};

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
