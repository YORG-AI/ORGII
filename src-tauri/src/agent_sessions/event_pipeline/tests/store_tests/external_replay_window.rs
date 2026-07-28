use crate::agent_sessions::event_pipeline::store::EventStore;
use crate::agent_sessions::event_pipeline::types::*;

use super::support::*;

#[test]
fn test_round_window_hydration_mode() {
    let mut store = EventStore::new();
    assert_eq!(
        store.hydration_mode(),
        crate::agent_sessions::event_pipeline::store::HydrationMode::Full
    );

    store.set_round_window(vec![make_user_turn_header(
        "turn-1",
        "2026-01-01T00:00:00Z",
    )]);
    assert_eq!(
        store.hydration_mode(),
        crate::agent_sessions::event_pipeline::store::HydrationMode::RoundWindow
    );

    store.merge_events(vec![make_event("live-1", "message")]);
    assert_eq!(
        store.hydration_mode(),
        crate::agent_sessions::event_pipeline::store::HydrationMode::LivePartial
    );
}

#[test]
fn test_empty_round_window_does_not_clobber_existing_events() {
    let mut store = EventStore::new();
    store.set_round_window(vec![
        make_user_turn_header("turn-1", "2026-01-01T00:00:00Z"),
        make_event("turn-1-body-1", "message"),
    ]);
    assert_eq!(store.events().len(), 2);

    // An empty round window (turn index mid-rebuild) must not wipe the store.
    store.set_round_window(Vec::new());

    assert_eq!(store.events().len(), 2);
    assert!(store.get_by_id("turn-1").is_some());
    assert!(store.get_by_id("turn-1-body-1").is_some());
}

#[test]
fn test_empty_round_window_on_empty_store_is_noop_set() {
    let mut store = EventStore::new();
    // Empty window on an already-empty store stays empty (no panic, no events).
    store.set_round_window(Vec::new());
    assert_eq!(store.events().len(), 0);
}

#[test]
fn external_replay_empty_window_authoritatively_clears_stale_history() {
    let mut store = EventStore::new();
    store.set_external_replay_window(vec![
        make_user_turn_header("turn-1", "2026-01-01T00:00:00Z"),
        make_event("turn-1-body-1", "message"),
    ]);
    assert_eq!(store.events().len(), 2);

    store.set_external_replay_window(Vec::new());

    assert!(store.events().is_empty());
}

#[test]
fn external_replay_byte_cap_keeps_a_newest_whole_turn_suffix() {
    let mut events = Vec::new();
    for turn in 0..4 {
        events.push(make_user_turn_header(
            &format!("turn-{turn}"),
            &format!("2026-01-01T00:0{turn}:00Z"),
        ));
        let mut body = make_event(&format!("turn-{turn}-body"), "assistant");
        body.display_text = format!("turn {turn} {}", "x".repeat(2 * 1024));
        events.push(body);
    }
    let latest_two_turn_bytes = serde_json::to_vec(&events[4..])
        .expect("serialize expected suffix")
        .len();
    let mut store = EventStore::new();
    store.set_round_window(events);

    let actual = store
        .cap_external_replay_bytes(latest_two_turn_bytes)
        .expect("cap external replay");

    assert!(actual <= latest_two_turn_bytes);
    assert!(store.get_by_id("turn-0").is_none());
    assert!(store.get_by_id("turn-1-body").is_none());
    assert!(store.get_by_id("turn-2").is_some());
    assert!(store.get_by_id("turn-3-body").is_some());
    assert_eq!(
        store.events().first().map(|event| event.source.clone()),
        Some(EventSource::User),
        "the byte cut must not leave a detached partial turn"
    );
}

#[test]
fn repeated_external_older_turn_merges_remain_byte_bounded() {
    const STORE_BUDGET: usize = 32 * 1024;
    let mut store = EventStore::new();
    for turn in 0..100 {
        let mut body = make_event(&format!("turn-{turn}-body"), "assistant");
        body.display_text = format!("turn {turn} {}", "y".repeat(2 * 1024));
        let created_at = format!("2026-01-01T{:02}:{:02}:00Z", turn / 60, turn % 60);
        body.created_at = created_at.clone();
        store.merge_round_window_events(vec![
            make_user_turn_header(&format!("turn-{turn}"), &created_at),
            body,
        ]);
        let bytes = store
            .cap_external_replay_bytes(STORE_BUDGET)
            .expect("cap merged replay turns");
        assert!(bytes <= STORE_BUDGET);
    }
    assert!(store.get_by_id("turn-99").is_some());
    assert!(store.get_by_id("turn-99-body").is_some());
    assert!(store.events().len() < 100);
}

#[test]
fn external_replay_merge_preserves_delta_baseline_while_native_round_merge_resets_it() {
    let mut external_store = EventStore::new();
    external_store.set_external_replay_window(vec![make_event("latest", "assistant")]);
    external_store.mark_full_snapshot_emitted();
    assert!(!external_store.should_emit_full_snapshot());

    let mut older = make_event("older", "assistant");
    older.created_at = "2025-12-31T23:59:00Z".to_string();
    external_store.merge_external_replay_window_events(vec![older]);

    assert!(
        !external_store.should_emit_full_snapshot(),
        "external prepend must use the existing order-replacement delta"
    );
    let (base_version, changed_ids, _) = external_store.take_delta_tracking();
    assert!(base_version > 0);
    assert_eq!(changed_ids, vec!["older".to_string()]);
    assert_eq!(
        external_store
            .events()
            .iter()
            .map(|event| event.id.as_str())
            .collect::<Vec<_>>(),
        vec!["older", "latest"]
    );

    let mut native_store = EventStore::new();
    native_store.set_round_window(vec![make_event("latest", "assistant")]);
    native_store.mark_full_snapshot_emitted();
    native_store.merge_round_window_events(vec![make_event("older", "assistant")]);
    assert!(
        native_store.should_emit_full_snapshot(),
        "native SDE round hydration must keep its established baseline reset"
    );
}

#[test]
fn external_replay_resident_budget_keeps_selected_older_turn_and_prefetch_neighbours() {
    const STORE_BUDGET: usize = 16 * 1024 * 1024;
    const LARGE_BODY_BYTES: usize = 3 * 1024 * 1024 + 512 * 1024;

    fn large_turn(turn: u32, minute: u32, body_bytes: usize) -> Vec<SessionEvent> {
        let created_at = format!("2026-01-01T00:{minute:02}:00Z");
        let mut body = make_event(&format!("turn-{turn}-body"), "assistant");
        body.created_at = created_at.clone();
        body.display_text = format!("turn {turn} {}", "z".repeat(body_bytes));
        vec![
            make_user_turn_header(&format!("turn-{turn}"), &created_at),
            body,
        ]
    }

    let mut store = EventStore::new();
    store.set_external_replay_window(large_turn(99, 59, LARGE_BODY_BYTES));
    store
        .cap_external_replay_bytes(STORE_BUDGET)
        .expect("cap latest external turn");

    // The selected historical page and its two prefetch neighbours are each
    // valid <4 MiB replay windows. They must remain visible alongside the
    // latest page instead of being discarded by the former 4 MiB suffix cap.
    for (turn, minute) in [(10, 10), (9, 9), (11, 11)] {
        store.merge_round_window_events(large_turn(turn, minute, LARGE_BODY_BYTES));
        let bytes = store
            .cap_external_replay_bytes(STORE_BUDGET)
            .expect("cap selected external turn window");
        assert!(bytes <= STORE_BUDGET);
    }

    // A normal small live delta must not immediately evict the selected body
    // while the user is reading it.
    let mut poll_event = make_event("turn-99-poll", "assistant");
    poll_event.created_at = "2026-01-01T00:59:30Z".to_string();
    poll_event.display_text = "p".repeat(256 * 1024);
    store.merge_round_window_events(vec![poll_event]);
    let bytes = store
        .cap_external_replay_bytes(STORE_BUDGET)
        .expect("cap live external delta");

    assert!(bytes <= STORE_BUDGET);
    for id in [
        "turn-9",
        "turn-9-body",
        "turn-10",
        "turn-10-body",
        "turn-11",
        "turn-11-body",
        "turn-99",
        "turn-99-body",
        "turn-99-poll",
    ] {
        assert!(store.get_by_id(id).is_some(), "{id} must remain resident");
    }
}

#[test]
fn external_replay_preserving_cap_keeps_each_newly_prepended_page_visible() {
    const STORE_BUDGET: usize = 16 * 1024 * 1024;
    const PAGE_BODY_BYTES: usize = 3 * 1024 * 1024 + 256 * 1024;

    fn large_turn(turn: u32, minute: u32) -> Vec<SessionEvent> {
        let created_at = format!("2026-01-01T00:{minute:02}:00Z");
        let mut body = make_event(&format!("turn-{turn}-body"), "assistant");
        body.created_at = created_at.clone();
        body.display_text = format!("turn {turn} {}", "w".repeat(PAGE_BODY_BYTES));
        vec![
            make_user_turn_header(&format!("turn-{turn}"), &created_at),
            body,
        ]
    }

    let mut store = EventStore::new();
    store.set_external_replay_window(large_turn(99, 59));
    store
        .cap_external_replay_bytes(STORE_BUDGET)
        .expect("cap latest external turn");

    let mut previous_turn = None;
    for turn in (4..=10_u32).rev() {
        let page = large_turn(turn, turn);
        let preserved_ids = page
            .iter()
            .map(|event| event.id.clone())
            .collect::<std::collections::HashSet<_>>();
        store.merge_round_window_events(page);
        let bytes = store
            .cap_external_replay_bytes_preserving(STORE_BUDGET, &preserved_ids)
            .expect("cap prepended external replay page");

        assert!(bytes <= STORE_BUDGET);
        assert!(store.get_by_id(&format!("turn-{turn}")).is_some());
        assert!(store.get_by_id(&format!("turn-{turn}-body")).is_some());
        assert!(store.get_by_id("turn-99").is_some());
        if let Some(previous_turn) = previous_turn {
            assert!(
                store
                    .get_by_id(&format!("turn-{previous_turn}-body"))
                    .is_some(),
                "the immediately newer page must remain as the prepend anchor"
            );
        }
        previous_turn = Some(turn);
    }

    let retained_old_pages = (4..=10_u32)
        .filter(|turn| store.get_by_id(&format!("turn-{turn}-body")).is_some())
        .count();
    assert!(
        retained_old_pages < 7,
        "non-adjacent historical pages must still be evicted under the resident cap"
    );
}

#[test]
fn test_unload_turn_body_restores_placeholder_and_preserves_headers() {
    let mut store = EventStore::new();
    store.set_round_window(vec![
        make_user_turn_header("turn-1", "2026-01-01T00:00:00Z"),
        make_event("turn-1-body-1", "message"),
        make_event("turn-1-body-2", "tool_call"),
        make_user_turn_header("turn-2", "2026-01-01T00:01:00Z"),
        make_event("turn-2-body-1", "message"),
    ]);

    let removed = store.unload_turn_body("turn-1", make_turn_placeholder("turn-1", Some("turn-2")));

    assert_eq!(removed, 2);
    assert!(store.get_by_id("turn-1").is_some());
    assert!(store.get_by_id("turn-placeholder-turn-1").is_some());
    assert!(store.get_by_id("turn-1-body-1").is_none());
    assert!(store.get_by_id("turn-1-body-2").is_none());
    assert!(store.get_by_id("turn-2").is_some());
    assert!(store.get_by_id("turn-2-body-1").is_some());
    assert_eq!(
        store.hydration_mode(),
        crate::agent_sessions::event_pipeline::store::HydrationMode::RoundWindow
    );
}

#[test]
fn test_unload_turn_body_preserves_final_reply_as_preview() {
    let mut final_reply = make_event("turn-1-final-reply", "assistant");
    final_reply.function_name = "assistant".to_string();
    final_reply.ui_canonical = "agent_message".to_string();
    final_reply.display_variant = EventDisplayVariant::Message;
    final_reply.display_text = "Finished the work".to_string();

    let mut store = EventStore::new();
    store.set_round_window(vec![
        make_user_turn_header("turn-1", "2026-01-01T00:00:00Z"),
        make_event("turn-1-tool", "tool_call"),
        final_reply,
        make_user_turn_header("turn-2", "2026-01-01T00:01:00Z"),
    ]);

    let removed = store.unload_turn_body("turn-1", make_turn_placeholder("turn-1", Some("turn-2")));

    assert_eq!(removed, 1);
    let preview = store.get_by_id("turn-1-final-reply").unwrap();
    assert_eq!(
        preview.args.get("turnPreviewOnly"),
        Some(&serde_json::Value::Bool(true))
    );
    assert!(store.get_by_id("turn-1-tool").is_none());
    assert!(store.get_by_id("turn-placeholder-turn-1").is_some());
}

#[test]
fn test_merge_round_window_events_removes_loaded_turn_placeholder() {
    let mut store = EventStore::new();
    store.set_round_window(vec![
        make_user_turn_header("turn-1", "2026-01-01T00:00:00Z"),
        make_turn_placeholder("turn-1", Some("turn-2")),
        make_user_turn_header("turn-2", "2026-01-01T00:01:00Z"),
    ]);

    let mut body_1 = make_event("turn-1-body-1", "message");
    body_1.created_at = "2026-01-01T00:00:20Z".to_string();
    let mut body_2 = make_event("turn-1-body-2", "tool_call");
    body_2.created_at = "2026-01-01T00:00:40Z".to_string();

    store.merge_round_window_events(vec![
        make_user_turn_header("turn-1", "2026-01-01T00:00:00Z"),
        body_1,
        body_2,
    ]);

    assert!(store.get_by_id("turn-placeholder-turn-1").is_none());
    assert!(store.get_by_id("turn-1").is_some());
    assert!(store.get_by_id("turn-1-body-1").is_some());
    assert!(store.get_by_id("turn-1-body-2").is_some());
    assert!(store.get_by_id("turn-2").is_some());
    let event_ids = store
        .events()
        .iter()
        .map(|event| event.id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        event_ids,
        vec!["turn-1", "turn-1-body-1", "turn-1-body-2", "turn-2"]
    );
    assert_eq!(
        store.hydration_mode(),
        crate::agent_sessions::event_pipeline::store::HydrationMode::RoundWindow
    );
}
