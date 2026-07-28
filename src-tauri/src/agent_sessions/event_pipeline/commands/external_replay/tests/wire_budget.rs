use super::*;

fn delta(events: Vec<SessionEvent>) -> ExternalReplayDelta {
    ExternalReplayDelta {
        cursor: ReplayCursor {
            source_id: "codex_app".to_string(),
            session_id: "codexapp-test".to_string(),
            generation: "g1".to_string(),
            revision: 1,
            through_sequence: 0,
        },
        events,
        removed_event_ids: Vec::new(),
        reset_required: false,
        stats: ReplayStats::default(),
        watcher_available: false,
    }
}

fn max_preview_replay_events(count: usize) -> Vec<SessionEvent> {
    (0..count)
        .map(|index| {
            let mut row = event(
                &format!("event-{index}"),
                "codexapp-test",
                &"x".repeat(replay::NORMAL_PAYLOAD_PREVIEW_BYTES),
            );
            row.payload_refs.push(PayloadRef {
                event_id: row.id.clone(),
                field_path: "result.content".to_string(),
                preview: String::new(),
                full_size_bytes: 10 * 1024 * 1024,
                truncated: true,
                replay_encoding: Some(PayloadRefEncoding::Utf8Text),
                replay_source_id: Some("codex_app".to_string()),
                replay_generation: Some("g1".to_string()),
                replay_source_event_id: Some(row.id.clone()),
            });
            row
        })
        .collect()
}

#[test]
fn final_wire_budget_counts_normalized_payload_refs_and_fails_closed() {
    let mut replay_event = event("payload", "codexapp-test", "preview");
    replay_event.payload_refs.push(PayloadRef {
        event_id: replay_event.id.clone(),
        field_path: "result.content".to_string(),
        preview: "x".repeat(70 * 1024),
        full_size_bytes: 10 * 1024 * 1024,
        truncated: true,
        replay_encoding: Some(PayloadRefEncoding::Utf8Text),
        replay_source_id: Some("codex_app".to_string()),
        replay_generation: Some("g1".to_string()),
        replay_source_event_id: Some("payload".to_string()),
    });
    let cursor = ReplayCursor {
        source_id: "codex_app".to_string(),
        session_id: "codexapp-test".to_string(),
        generation: "g1".to_string(),
        revision: 7,
        through_sequence: 7,
    };
    let mut window = ExternalReplayWindow {
        cursor: cursor.clone(),
        events: vec![replay_event],
        window_start_sequence: Some(7),
        turn_headers: Vec::new(),
        total_turn_count: 1,
        total_event_count: 1,
        has_older: false,
        stats: ReplayStats::default(),
        watcher_available: false,
    };
    let error = finalize_window_wire_budget(&mut window, 64 * 1024)
        .expect_err("payload ref must count toward wire bytes");
    assert!(error.contains("serialized bytes"));
    assert_eq!(
        window.cursor, cursor,
        "failed wire check never advances cursor"
    );
}

#[test]
fn compact_storage_reads_reserve_normalization_wire_headroom() {
    let requested = ReplayLimits {
        max_turns: replay::HARD_MAX_TURNS,
        max_events: replay::HARD_MAX_EVENTS,
        max_ipc_bytes: replay::HARD_MAX_IPC_BYTES,
    };
    let storage = replay_storage_limits_with_normalization_headroom(requested);

    assert_eq!(storage.max_turns, requested.max_turns);
    assert_eq!(storage.max_events, requested.max_events);
    assert_eq!(
        storage.max_ipc_bytes,
        replay::HARD_MAX_IPC_BYTES / 2,
        "raw compact rows must stop before renderer-only fields and payload refs can overflow IPC"
    );
}

#[test]
fn two_hundred_max_preview_events_stay_under_the_hard_wire_cap() {
    let mut window = ExternalReplayWindow {
        cursor: ReplayCursor {
            source_id: "codex_app".to_string(),
            session_id: "codexapp-test".to_string(),
            generation: "g1".to_string(),
            revision: 200,
            through_sequence: 199,
        },
        events: max_preview_replay_events(200),
        window_start_sequence: Some(0),
        turn_headers: Vec::new(),
        total_turn_count: 1,
        total_event_count: 200,
        has_older: false,
        stats: ReplayStats::default(),
        watcher_available: false,
    };
    finalize_window_wire_budget(&mut window, replay::HARD_MAX_IPC_BYTES)
        .expect("200 normal previews fit hard cap");
    assert!(window.stats.ipc_bytes <= replay::HARD_MAX_IPC_BYTES as u64);
}

#[test]
fn final_delta_wire_budget_counts_payload_refs_and_preserves_the_cursor_on_failure() {
    let mut replay_event = event("payload", "codexapp-test", "preview");
    replay_event.payload_refs.push(PayloadRef {
        event_id: replay_event.id.clone(),
        field_path: "result.content".to_string(),
        preview: "x".repeat(70 * 1024),
        full_size_bytes: 10 * 1024 * 1024,
        truncated: true,
        replay_encoding: Some(PayloadRefEncoding::Utf8Text),
        replay_source_id: Some("codex_app".to_string()),
        replay_generation: Some("g1".to_string()),
        replay_source_event_id: Some("payload".to_string()),
    });
    let mut response = delta(vec![replay_event]);
    let cursor = response.cursor.clone();
    let error = finalize_delta_wire_budget(&mut response, 64 * 1024)
        .expect_err("delta payload ref must count toward wire bytes");
    assert!(error.contains("serialized bytes"));
    assert_eq!(
        response.cursor, cursor,
        "failed delta wire check never advances the caller-visible cursor"
    );
}

#[test]
fn two_hundred_max_preview_delta_events_stay_under_the_hard_wire_cap() {
    let mut response = delta(max_preview_replay_events(200));
    response.cursor.revision = 200;
    response.cursor.through_sequence = 199;
    finalize_delta_wire_budget(&mut response, replay::HARD_MAX_IPC_BYTES)
        .expect("200 normal delta previews fit hard cap");
    assert!(response.stats.ipc_bytes <= replay::HARD_MAX_IPC_BYTES as u64);
}
