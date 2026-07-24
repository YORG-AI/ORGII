use super::*;
use crate::agent_sessions::event_pipeline::store::EventStore;

use super::notify::build_streaming_snapshot_delta;

fn test_event(id: &str, created_at: &str) -> SessionEvent {
    serde_json::from_value(serde_json::json!({
        "id": id,
        "chunk_id": null,
        "sessionId": "streaming-delta-test",
        "createdAt": created_at,
        "functionName": "assistant_message",
        "uiCanonical": "message",
        "actionType": "assistant",
        "args": {},
        "result": { "content": id },
        "source": "assistant",
        "displayText": id,
        "displayStatus": "running",
        "displayVariant": "message",
        "activityStatus": "agent"
    }))
    .expect("valid test event")
}

#[test]
fn streaming_delta_compacts_only_changed_events_and_tracks_positions() {
    let mut store = EventStore::new();
    let baseline = (0..100)
        .map(|index| {
            test_event(
                &format!("event-{index:03}"),
                &format!("2026-07-22T00:00:{index:02}.000Z"),
            )
        })
        .collect();
    store.set(baseline);
    store.mark_full_snapshot_emitted();
    store.set_streaming(true);

    store.upsert(test_event("event-050", "2026-07-22T00:00:50.000Z"));
    store.append(vec![test_event("event-100", "2026-07-22T00:01:40.000Z")]);

    let delta = build_streaming_snapshot_delta(&mut store);
    assert!(delta.incremental_orders);
    assert!(delta.streaming);
    assert_eq!(delta.upserts.len(), 2);
    assert_eq!(delta.memberships.len(), 2);
    assert_eq!(delta.memberships[0].id, "event-050");
    assert_eq!(delta.memberships[0].event_index, 50);
    assert_eq!(delta.memberships[1].id, "event-100");
    assert_eq!(delta.memberships[1].event_index, 100);
    assert!(delta.event_ids.is_empty());
    assert!(delta.chat_event_ids.is_empty());
    assert!(delta.sorted_simulator_event_ids.is_empty());

    let no_op = build_streaming_snapshot_delta(&mut store);
    assert_eq!(no_op.base_version, delta.version);
    assert!(no_op.upserts.is_empty());
    assert!(no_op.memberships.is_empty());
}

#[test]
fn round_window_reorder_requires_a_new_full_baseline() {
    let mut store = EventStore::new();
    store.set(vec![test_event("event-newer", "2026-07-22T00:01:00.000Z")]);
    store.mark_full_snapshot_emitted();
    store.set_streaming(true);

    store.merge_round_window_events(vec![test_event("event-older", "2026-07-22T00:00:00.000Z")]);

    assert!(store.should_emit_full_snapshot());
}
