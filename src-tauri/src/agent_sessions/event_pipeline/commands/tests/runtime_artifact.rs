use super::*;
use std::collections::HashSet;

use core_types::extracted::ExtractedEditData;
use core_types::session_event::SessionEventPatch;
use orgtrack_core::canonical::{AgentMetadata, SOURCE_ORGII_RUST_AGENTS};
use orgtrack_core::edit_extraction::{artifacts_from_extracted_edit, EditArtifactContext};
use orgtrack_core::repo_sync::paths::record_id;

use super::push_events::collect_post_merge_persistable_events;
use super::state_bounded_replay::BOUNDED_REPLAY_GENERIC_INPUT_MAX_BYTES;

fn test_event(id: &str, call_id: Option<&str>) -> SessionEvent {
    serde_json::from_value(serde_json::json!({
        "id": id,
        "chunk_id": null,
        "sessionId": "test-session",
        "createdAt": "2026-07-19T00:00:00Z",
        "functionName": "run_shell",
        "uiCanonical": "run_shell",
        "actionType": "tool_call",
        "args": {},
        "result": {},
        "source": "assistant",
        "displayText": id,
        "displayStatus": "running",
        "displayVariant": "tool_call",
        "activityStatus": "agent",
        "callId": call_id
    }))
    .unwrap()
}

fn replay_policy_event(session_id: &str, id: &str, body_bytes: usize) -> SessionEvent {
    let mut event = test_event(id, None);
    event.session_id = session_id.to_string();
    event.function_name = "assistant_message".to_string();
    event.ui_canonical = "assistant_message".to_string();
    event.action_type = "raw".to_string();
    event.display_text = "x".repeat(body_bytes);
    event
}

#[test]
fn post_merge_persistence_preserves_timeline_order() {
    let events = vec![
        test_event("event-c", Some("call-c")),
        test_event("event-a", Some("call-a")),
        test_event("event-b", Some("call-b")),
    ];
    let incoming_ids = HashSet::from(["event-b".to_string(), "event-c".to_string()]);
    let result_call_ids = HashSet::from(["call-a".to_string()]);

    let selected = collect_post_merge_persistable_events(&events, &incoming_ids, &result_call_ids);

    assert_eq!(
        selected
            .into_iter()
            .map(|event| event.id)
            .collect::<Vec<_>>(),
        vec!["event-c", "event-a", "event-b"]
    );
}

#[test]
fn managed_cli_generic_live_writes_remain_under_resident_budget() {
    const EVENT_BODY_BYTES: usize = 256 * 1024;
    let session_id = "cliagent-live-budget";
    let state = EventStoreState::new();
    assert!(state
        .session_manager
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .set_active(session_id)
        .is_empty());

    for index in 0..80 {
        let event = replay_policy_event(
            session_id,
            &format!("managed-live-{index}"),
            EVENT_BODY_BYTES,
        );
        let incoming_bytes = state
            .validate_bounded_replay_input(session_id, std::slice::from_ref(&event))
            .expect("individual live event fits bounded store");
        state.with_store_mut(session_id, |store| store.append(vec![event]));
        state
            .account_bounded_replay_write(session_id, incoming_bytes)
            .expect("live write policy succeeds");
    }

    let (bytes, count) = state
        .with_store_opt(session_id, |store| {
            (
                serde_json::to_vec(store.events())
                    .expect("serialize managed CLI store")
                    .len(),
                store.event_count(),
            )
        })
        .expect("managed CLI store exists");
    assert!(bytes <= BOUNDED_REPLAY_STORE_MAX_BYTES);
    assert!(count < 80, "old live events must be evicted by bytes");
    assert!(state.bounded_replay_exact_cap_count() > 0);
}

#[test]
fn hundreds_of_same_id_stream_updates_do_not_rescan_store_per_token() {
    const EVENT_BODY_BYTES: usize = 64 * 1024;
    const UPDATE_COUNT: usize = 400;
    let session_id = "cliagent-same-id-stream";
    let state = EventStoreState::new();

    for _ in 0..UPDATE_COUNT {
        let event = replay_policy_event(session_id, "streaming-message", EVENT_BODY_BYTES);
        let incoming_bytes = state
            .validate_bounded_replay_input(session_id, std::slice::from_ref(&event))
            .expect("stream update fits input budget");
        state.with_store_mut(session_id, |store| store.upsert(event));
        state
            .account_bounded_replay_write(session_id, incoming_bytes)
            .expect("amortized stream accounting succeeds");
    }

    let bytes = state
        .with_store_opt(session_id, |store| {
            assert_eq!(store.event_count(), 1);
            serde_json::to_vec(store.events())
                .expect("serialize same-ID stream store")
                .len()
        })
        .expect("same-ID store exists");
    let exact_scans = state.bounded_replay_exact_cap_count();
    assert!(bytes <= BOUNDED_REPLAY_STORE_MAX_BYTES);
    assert!(
        exact_scans > 0,
        "conservative debt eventually forces a scan"
    );
    assert!(
        exact_scans < UPDATE_COUNT / 20,
        "streaming must not rescan the resident store for every token: {exact_scans} scans"
    );
}

#[test]
fn native_sde_generic_writes_do_not_enter_external_store_policy() {
    const EVENT_BODY_BYTES: usize = 1024 * 1024;
    let session_id = "sdeagent-native-budget-control";
    let state = EventStoreState::new();

    for index in 0..17 {
        let event = replay_policy_event(
            session_id,
            &format!("native-live-{index}"),
            EVENT_BODY_BYTES,
        );
        let incoming_bytes = state
            .validate_bounded_replay_input(session_id, std::slice::from_ref(&event))
            .expect("native preflight is a no-op");
        state.with_store_mut(session_id, |store| store.append(vec![event]));
        state
            .account_bounded_replay_write(session_id, incoming_bytes)
            .expect("native policy is a no-op");
    }

    let (bytes, count) = state
        .with_store_opt(session_id, |store| {
            (
                serde_json::to_vec(store.events())
                    .expect("serialize native store")
                    .len(),
                store.event_count(),
            )
        })
        .expect("native store exists");
    assert!(bytes > BOUNDED_REPLAY_STORE_MAX_BYTES);
    assert_eq!(count, 17, "native EventStore semantics stay unchanged");
    assert_eq!(state.bounded_replay_exact_cap_count(), 0);
}

#[test]
fn oversized_managed_cli_write_fails_before_mutating_store() {
    let session_id = "cliagent-oversized-live";
    let state = EventStoreState::new();
    let event = replay_policy_event(
        session_id,
        "oversized-event",
        BOUNDED_REPLAY_GENERIC_INPUT_MAX_BYTES,
    );

    let error = state
        .validate_bounded_replay_input(session_id, std::slice::from_ref(&event))
        .expect_err("serialization overhead must push the event over budget");
    assert!(error.contains("exceeds"));
    assert!(state.with_store_opt(session_id, |_| ()).is_none());
}

#[test]
fn repeated_large_managed_cli_patch_fails_before_payload_amplification() {
    let session_id = "cliagent-large-patch";
    let state = EventStoreState::new();
    let events = (0..17)
        .map(|index| replay_policy_event(session_id, &format!("patch-{index}"), 32))
        .collect::<Vec<_>>();
    let ids = events
        .iter()
        .map(|event| event.id.clone())
        .collect::<Vec<_>>();
    state.with_store_mut(session_id, |store| store.append(events));
    let patch = SessionEventPatch {
        display_text: Some("p".repeat(1024 * 1024)),
        ..SessionEventPatch::default()
    };

    let error = state
        .validate_bounded_replay_patch(session_id, &ids, &patch)
        .expect_err("repeated patch must be rejected before it is cloned");
    assert!(error.contains("amplification"));
    assert!(
        state.with_store_opt(session_id, |store| {
            store
                .events()
                .iter()
                .all(|event| event.display_text.len() == 32)
        }) == Some(true)
    );

    assert!(state
        .validate_bounded_replay_patch("sdeagent-native", &ids, &patch)
        .is_ok());
}

#[test]
fn runtime_projection_uses_backfill_record_id_shape() {
    let edit = ExtractedEditData {
        file_path: "src/main.rs".to_string(),
        file_name: "main.rs".to_string(),
        language: "rust".to_string(),
        content: None,
        line_count: None,
        old_content: Some("fn main() {}\n".to_string()),
        new_content: Some("fn main() { println!(\"hi\"); }\n".to_string()),
        diff: None,
        old_start_line: Some(1),
        new_start_line: Some(1),
        lines_added: Some(1),
        lines_removed: Some(1),
        is_deleted: false,
        apply_patch_segments: Vec::new(),
    };
    let context = EditArtifactContext {
        source: SOURCE_ORGII_RUST_AGENTS.to_string(),
        source_session_id: Some("sdeagent-1".to_string()),
        session_id: "sdeagent-1".to_string(),
        source_event_id: Some("tool-call-1".to_string()),
        turn_id: Some("turn-1".to_string()),
        sequence_index: 7,
        timestamp: Some("2026-06-17T00:00:00Z".to_string()),
        workspace_path: Some("/tmp/repo".to_string()),
        metadata: AgentMetadata::default(),
    };

    let artifacts = artifacts_from_extracted_edit(&context, &edit);

    assert_eq!(artifacts.edits.len(), 1);
    assert_eq!(artifacts.chunks.len(), 1);
    assert_eq!(
        artifacts.edits[0].record_id,
        record_id(&[
            "edit",
            SOURCE_ORGII_RUST_AGENTS,
            "sdeagent-1",
            "tool-call-1",
            "7",
            "0",
            "src/main.rs",
        ])
    );
    assert_eq!(
        artifacts.chunks[0].record_id,
        record_id(&[
            "diff_chunk",
            SOURCE_ORGII_RUST_AGENTS,
            "sdeagent-1",
            "tool-call-1",
            "7",
            "0",
            "src/main.rs",
        ])
    );
}
