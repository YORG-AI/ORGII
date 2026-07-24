use super::super::request_guard::{
    is_current_replay_episode, prewarm_request_states, replay_request_states, ReplayApplyResult,
};
use super::*;

fn delta(events: Vec<SessionEvent>, removed: Vec<String>, reset: bool) -> ExternalReplayDelta {
    ExternalReplayDelta {
        cursor: ReplayCursor {
            source_id: "codex_app".to_string(),
            session_id: "codexapp-test".to_string(),
            generation: "g1".to_string(),
            revision: 1,
            through_sequence: 0,
        },
        events,
        removed_event_ids: removed,
        reset_required: reset,
        stats: ReplayStats::default(),
        watcher_available: false,
    }
}

fn handoff_chunk(
    sequence: i64,
    action_type: &str,
    function: &str,
    content: &str,
) -> ReplayIndexedChunk {
    let mut chunk = ActivityChunk::new("codexapp-handoff", action_type, function);
    chunk.chunk_id = format!("handoff-{sequence}");
    chunk.result = serde_json::json!({"content":content});
    ReplayIndexedChunk {
        sequence,
        turn_index: sequence,
        chunk,
        payloads: Vec::new(),
    }
}

fn handoff_page(
    generation: &str,
    chunks: Vec<ReplayIndexedChunk>,
    has_older: bool,
) -> ResolvedReplayWindow {
    let through_sequence = chunks.last().map_or(-1, |chunk| chunk.sequence);
    let ipc_bytes = compact_handoff_page_bytes(&chunks) as u64;
    ResolvedReplayWindow::Imported(ReplayChunkWindow {
        cursor: ReplayCursor {
            source_id: "codex_app".to_string(),
            session_id: "codexapp-handoff".to_string(),
            generation: generation.to_string(),
            revision: 1,
            through_sequence,
        },
        total_turn_count: chunks.len() as u64,
        total_event_count: chunks.len() as u64,
        chunks,
        turn_headers: Vec::new(),
        has_older,
        stats: ReplayStats {
            ipc_bytes,
            ..ReplayStats::default()
        },
    })
}

fn handoff_turn_page(
    generation: &str,
    turn_index: i64,
    total_turns: u64,
    mut chunks: Vec<ReplayIndexedChunk>,
    has_older: bool,
) -> ResolvedReplayWindow {
    for chunk in &mut chunks {
        chunk.turn_index = turn_index;
    }
    let start_sequence = chunks.first().map_or(0, |chunk| chunk.sequence);
    let end_sequence = chunks.last().map(|chunk| chunk.sequence);
    let mut page = handoff_page(generation, chunks, has_older);
    if let ResolvedReplayWindow::Imported(window) = &mut page {
        window.total_turn_count = total_turns;
        window.turn_headers = vec![ReplayTurnHeader {
            turn_id: format!("turn-{turn_index}"),
            turn_index,
            start_sequence,
            end_sequence,
            started_at: "2026-07-22T00:00:00Z".to_string(),
            ended_at: Some("2026-07-22T00:00:01Z".to_string()),
            event_count: window.chunks.len() as u64,
        }];
    }
    page
}

#[test]
fn stream_cursor_guard_rejects_same_generation_new_revision() {
    let current = ReplayCursor {
        source_id: "opencode".to_string(),
        session_id: "opencode-test".to_string(),
        generation: "g1".to_string(),
        revision: 8,
        through_sequence: 200,
    };
    let error = validate_stream_replay_cursor("g1", 7, &current, "testing")
        .expect_err("same-generation revision changes must reset the stream");
    assert!(error.contains("g1@7"));
    assert!(error.contains("g1@8"));

    let error = validate_managed_chunk_stream_cursor(
        "chunks-3",
        200,
        &("chunks-3".to_string(), 201),
        "testing managed replay",
    )
    .expect_err("same-generation managed appends must reset the stream");
    assert!(error.contains("chunks-3@200"));
    assert!(error.contains("chunks-3@201"));
}

#[test]
fn export_and_cloud_prepare_three_lazy_kv_turns_before_strict_streaming() {
    use orgtrack_core::store::sqlite::SqliteRecordStore;

    for source in [
        ImportedHistorySourceId::CursorIde,
        ImportedHistorySourceId::Windsurf,
    ] {
        let directory = tempfile::tempdir().expect("lazy stream fixture");
        let source_path = directory.path().join(format!("{}.db", source.as_str()));
        let source_conn = Connection::open(&source_path).expect("KV source DB");
        source_conn
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                     CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT);",
            )
            .expect("KV source schema");
        let headers = (0..6)
            .map(|index| {
                serde_json::json!({
                    "bubbleId":format!("b{index}"),
                    "type":if index % 2 == 0 { 1 } else { 2 },
                })
            })
            .collect::<Vec<_>>();
        source_conn
            .execute(
                "INSERT INTO cursorDiskKV(key,value) VALUES('composerData:c1',?1)",
                [serde_json::json!({
                    "composerId":"c1",
                    "createdAt":1,
                    "lastUpdatedAt":6,
                    "fullConversationHeadersOnly":headers,
                })
                .to_string()],
            )
            .expect("composer row");
        for index in 0..6 {
            source_conn
                .execute(
                    "INSERT INTO cursorDiskKV(key,value) VALUES(?1,?2)",
                    rusqlite::params![
                        format!("bubbleId:c1:b{index}"),
                        serde_json::json!({
                            "bubbleId":format!("b{index}"),
                            "type":if index % 2 == 0 { 1 } else { 2 },
                            "createdAt":format!("2026-07-22T00:00:{index:02}Z"),
                            "text":format!("message {index}"),
                        })
                        .to_string(),
                    ],
                )
                .expect("bubble row");
        }

        let mut cache = Connection::open_in_memory().expect("replay cache");
        SqliteRecordStore::init_tables(&cache).expect("replay tables");
        SqliteRecordStore::init_source_cache_tables(&cache).expect("source cache tables");
        let session_id = format!("{}c1", source.descriptor().session_prefix);
        cache
            .execute(
                "INSERT INTO imported_history_session_cache(
                         source,source_session_id,session_id,source_path
                     ) VALUES(?1,'c1',?2,?3)",
                rusqlite::params![source.as_str(), session_id, source_path.to_string_lossy()],
            )
            .expect("cache source path");
        let limits = ReplayLimits {
            max_turns: 1,
            max_events: 1,
            max_ipc_bytes: STREAM_BATCH_MAX_BYTES,
        };
        let prepared = prepare_stream_replay_snapshot(&mut cache, source, &session_id, limits)
            .expect("prepare export/cloud snapshot");
        let mut after_sequence = -1_i64;
        let mut sequences = Vec::new();
        loop {
            let scan = replay::scan_window_after_generation(
                &mut cache,
                source,
                &session_id,
                &prepared.generation,
                prepared.revision,
                after_sequence,
                limits,
            )
            .expect("strict export/cloud scan");
            sequences.extend(scan.chunks.iter().map(|chunk| chunk.sequence));
            after_sequence = scan.cursor.through_sequence;
            if !scan.has_more {
                break;
            }
        }
        assert_eq!(sequences, vec![0, 1, 2, 3, 4, 5], "{}", source.as_str());
    }
}

#[test]
fn failed_export_preserves_destination_and_removes_unique_partial() {
    let directory = std::env::temp_dir().join(format!(
        "orgii-replay-export-atomic-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&directory).expect("export test directory");
    let destination = directory.join("history.json");
    fs::write(&destination, b"previous-valid-export").expect("old destination");

    let error = stream_replay_export(
        "not-a-replay-source",
        "not-a-session",
        destination.to_str().expect("UTF-8 destination"),
        ReplayExportFormat::Json,
        None,
    )
    .expect_err("invalid source must fail after opening the temporary file");

    assert!(!error.is_empty());
    assert_eq!(
        fs::read(&destination).expect("preserved destination"),
        b"previous-valid-export"
    );
    let partials = fs::read_dir(&directory)
        .expect("export directory")
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with(".history.json.orgii-") && name.ends_with(".part")
        })
        .count();
    assert_eq!(partials, 0, "failed export left a partial file");

    fs::remove_file(destination).expect("remove destination");
    fs::remove_dir(directory).expect("remove export test directory");
}

#[test]
fn not_ready_is_typed_and_non_destructive() {
    let window = not_ready_window(MANAGED_CLI_REPLAY_TARGET_ID, "cliagent-test");
    assert!(window.stats.not_ready);
    assert!(window.events.is_empty());
    assert_eq!(window.cursor.generation, "pending");
}

#[test]
fn fork_handoff_keeps_existing_semantics_skips_reasoning_and_caps_utf16_text() {
    let user = handoff_chunk(0, "user_message", "unknown", "fix the sync");
    let thinking = handoff_chunk(1, "reasoning", "thinking", "private chain of thought");
    let mut tool = handoff_chunk(2, "tool_call", "read_file", "old file");
    tool.chunk.args = serde_json::json!({"content":"src/sync.ts"});
    tool.chunk.result = serde_json::json!({"output":"old file"});
    let assistant = handoff_chunk(3, "assistant", "assistant", "I found the issue");

    assert_eq!(
        handoff_item_from_chunk(&user.chunk, "Claude App").as_deref(),
        Some("User: fix the sync")
    );
    assert!(handoff_item_from_chunk(&thinking.chunk, "Claude App").is_none());
    assert_eq!(
            handoff_item_from_chunk(&tool.chunk, "Claude App").as_deref(),
            Some(
                "[Imported Claude App action]\nTool: read_file\nInput: src/sync.ts\nResult at that time: old file"
            )
        );
    assert_eq!(
        handoff_item_from_chunk(&assistant.chunk, "Claude App").as_deref(),
        Some("Assistant: I found the issue")
    );

    let huge = handoff_chunk(4, "raw", "user_message", &"🙂".repeat(2_000));
    let bounded = handoff_item_from_chunk(&huge.chunk, "Codex App").expect("bounded user item");
    assert!(bounded.encode_utf16().count() <= EXTERNAL_REPLAY_HANDOFF_MAX_TEXT_UTF16);
    assert!(bounded.ends_with('…'));
}

#[test]
fn fork_handoff_pages_backwards_with_one_generation_and_no_runtime_side_effects() {
    let session_id = "codexapp-fork-handoff-pure";
    release_session_runtime(session_id);
    let mut calls = 0_usize;
    let handoff = collect_external_replay_handoff("Codex App", |before, turn, limits| {
        calls += 1;
        assert!(limits.max_ipc_bytes <= EXTERNAL_REPLAY_HANDOFF_SCAN_BYTES);
        match calls {
            1 => {
                assert_eq!(before, None);
                assert_eq!(turn, None);
                // Cursor/Windsurf cold indexes can report `hasOlder=false`
                // because only the latest body is hydrated. The compact
                // turn header still proves that turn 0 must be requested.
                Ok(handoff_turn_page(
                    "generation-1",
                    1,
                    2,
                    vec![handoff_chunk(50, "reasoning", "thinking", "private")],
                    false,
                ))
            }
            2 => {
                assert_eq!(before, None);
                assert_eq!(turn, Some(0));
                Ok(handoff_turn_page(
                    "generation-1",
                    0,
                    2,
                    vec![
                        handoff_chunk(10, "raw", "user_message", "usable older ask"),
                        handoff_chunk(11, "assistant", "assistant", "older answer"),
                    ],
                    false,
                ))
            }
            _ => panic!("handoff requested an unnecessary page"),
        }
    })
    .expect("paged handoff");
    assert_eq!(
        handoff.items,
        vec![
            "User: usable older ask".to_string(),
            "Assistant: older answer".to_string()
        ]
    );
    assert_eq!(handoff.generation, "generation-1");
    assert_eq!(handoff.scanned_events, 3);
    assert!(handoff.scanned_bytes <= EXTERNAL_REPLAY_HANDOFF_SCAN_BYTES as u64);
    assert!(!replay_request_states()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains_key(session_id));
    assert!(!external_replay_watcher::is_available(session_id));
}

#[test]
fn fork_handoff_rejects_cross_page_generation_mixing() {
    let mut calls = 0_usize;
    let error = collect_external_replay_handoff("Codex App", |_before, _turn, _limits| {
        calls += 1;
        if calls == 1 {
            Ok(handoff_page(
                "generation-a",
                vec![handoff_chunk(50, "reasoning", "thinking", "private")],
                true,
            ))
        } else {
            Ok(handoff_page(
                "generation-b",
                vec![handoff_chunk(10, "raw", "user_message", "older")],
                false,
            ))
        }
    })
    .expect_err("mixed replay generations must fail closed");
    assert!(error.contains("changed generation"));
    assert!(error.contains("retry"));
}

#[test]
fn fork_handoff_rejects_cross_page_revision_mixing() {
    let mut calls = 0_usize;
    let error = collect_external_replay_handoff("Codex App", |_before, _turn, _limits| {
        calls += 1;
        if calls == 1 {
            Ok(handoff_page(
                "generation-a",
                vec![handoff_chunk(50, "reasoning", "thinking", "private")],
                true,
            ))
        } else {
            let mut page = handoff_page(
                "generation-a",
                vec![handoff_chunk(10, "raw", "user_message", "older")],
                false,
            );
            if let ResolvedReplayWindow::Imported(window) = &mut page {
                window.cursor.revision = 2;
            }
            Ok(page)
        }
    })
    .expect_err("mixed replay revisions must fail closed");
    assert!(error.contains("changed revision"));
    assert!(error.contains("retry"));
}

#[test]
fn fork_handoff_returns_only_the_last_eighty_usable_items() {
    let chunks = (0..100)
        .map(|sequence| handoff_chunk(sequence, "raw", "user_message", &format!("item-{sequence}")))
        .collect::<Vec<_>>();
    let handoff = collect_external_replay_handoff("Codex App", |_before, _turn, _limits| {
        Ok(handoff_page("generation-1", chunks.clone(), false))
    })
    .expect("bounded handoff");
    assert_eq!(handoff.items.len(), EXTERNAL_REPLAY_HANDOFF_MAX_ITEMS);
    assert_eq!(
        handoff.items.first().map(String::as_str),
        Some("User: item-20")
    );
    assert_eq!(
        handoff.items.last().map(String::as_str),
        Some("User: item-99")
    );
    assert_eq!(handoff.scanned_events, 100);
    assert!(handoff.scanned_bytes <= EXTERNAL_REPLAY_HANDOFF_SCAN_BYTES as u64);
}

#[test]
fn same_id_and_content_is_a_true_no_op() {
    let existing = event("same", "codexapp-test", "unchanged");
    let mut store = EventStore::new();
    store.set(vec![existing.clone()]);
    let applied =
        apply_external_replay_delta(&mut store, &delta(vec![existing], Vec::new(), false));
    assert_eq!(applied, ReplayApplyResult::default());
}

#[test]
fn removals_are_applied_to_the_display_session_store() {
    let mut store = EventStore::new();
    store.set(vec![event("remove-me", "cliagent-test", "old")]);
    let applied = apply_external_replay_delta(
        &mut store,
        &delta(Vec::new(), vec!["remove-me".to_string()], false),
    );
    assert_eq!(applied.removed, 1);
    assert!(store.get_by_id("remove-me").is_none());
}

#[test]
fn generation_reset_replaces_with_bounded_canonical_window() {
    let mut store = EventStore::new();
    store.set(vec![event("ephemeral", "cliagent-test", "old")]);
    let canonical = event("canonical", "cliagent-test", "new");
    let applied =
        apply_external_replay_delta(&mut store, &delta(vec![canonical], Vec::new(), true));
    assert!(applied.changed);
    assert!(store.get_by_id("ephemeral").is_none());
    assert_eq!(
        store
            .get_by_id("canonical")
            .expect("canonical event")
            .session_id,
        "cliagent-test"
    );
    assert_eq!(
        store.hydration_mode(),
        crate::agent_sessions::event_pipeline::store::HydrationMode::RoundWindow,
        "a generation reset is still a bounded replay window, not a fully hydrated transcript"
    );
}

#[test]
fn newer_request_token_invalidates_late_results_without_cross_session_leakage() {
    let session_a = "cliagent-request-token-a";
    let session_b = "cliagent-request-token-b";
    let first_a = begin_replay_request(session_a, 10, true).expect("open A");
    let first_b = begin_replay_request(session_b, 20, true).expect("open B");

    assert!(is_current_replay_request(session_a, 10, first_a));
    assert!(is_current_replay_request(session_b, 20, first_b));

    let second_a = begin_replay_request(session_a, 10, false).expect("poll A");
    assert!(!is_current_replay_request(session_a, 10, first_a));
    assert!(is_current_replay_request(session_a, 10, second_a));
    assert!(is_current_replay_episode(session_a, 10));
    assert!(is_current_replay_request(session_b, 20, first_b));
}

#[test]
fn release_then_reopen_cannot_resurrect_an_a_to_b_to_a_result() {
    let session_a = "codexapp-request-release-a";
    let stale_a = begin_replay_request(session_a, 100, true).expect("first A");
    release_session_runtime_if_episode(session_a, 100);
    assert!(!is_current_replay_request(session_a, 100, stale_a));
    assert!(!is_current_replay_episode(session_a, 100));

    let reopened_a = begin_replay_request(session_a, 101, true).expect("reopen A");
    assert_ne!(reopened_a, stale_a);
    assert!(is_current_replay_episode(session_a, 101));
    // A delayed cleanup from the first episode cannot release A2.
    release_session_runtime_if_episode(session_a, 100);
    assert!(!is_current_replay_request(session_a, 100, stale_a));
    assert!(is_current_replay_request(session_a, 101, reopened_a));
    release_session_runtime(session_a);
}

#[test]
fn prewarm_episode_is_independent_and_release_rejects_late_a_completion() {
    let session_a = "codexapp-prewarm-episode-a";
    let first = begin_prewarm_request(session_a, 40).expect("first prewarm");
    assert!(is_current_prewarm_request(session_a, 40, first));
    assert!(!replay_request_states()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains_key(session_a));

    let current = begin_prewarm_request(session_a, 41).expect("newer prewarm");
    assert!(!is_current_prewarm_request(session_a, 40, first));
    assert!(is_current_prewarm_request(session_a, 41, current));
    assert!(begin_prewarm_request(session_a, 40).is_err());

    release_session_runtime(session_a);
    assert!(!is_current_prewarm_request(session_a, 41, current));
    assert!(begin_prewarm_request(session_a, 41).is_err());
    let reopened = begin_prewarm_request(session_a, 42).expect("reopened prewarm");
    assert_ne!(reopened, first);
    assert!(is_current_prewarm_request(session_a, 42, reopened));
    release_session_runtime(session_a);
}

#[test]
fn foreground_release_cancels_current_prewarm_without_touching_native_state() {
    let external_session = "codexapp-prewarm-release";
    let foreground = begin_replay_request(external_session, 500, true).expect("foreground");
    let prewarm = begin_prewarm_request(external_session, 12).expect("prewarm");
    assert!(is_current_replay_request(external_session, 500, foreground));
    assert!(is_current_prewarm_request(external_session, 12, prewarm));
    release_session_runtime_if_episode(external_session, 500);
    assert!(!is_current_prewarm_request(external_session, 12, prewarm));

    let native_session = "sdeagent-native-prewarm-boundary";
    assert!(validate_prewarm_target_identity("codex_app", native_session).is_err());
    assert!(!prewarm_request_states()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains_key(native_session));
}

#[test]
fn cancelled_prewarm_cannot_commit_or_reopen_the_same_episode() {
    let session_id = "codexapp-prewarm-atomic-commit";
    let state = EventStoreState::new();
    let stale_request_token = begin_prewarm_request(session_id, 70).expect("first prewarm");
    cancel_prewarm_requests(session_id);

    assert!(!apply_prewarm_window_if_current(
        &state,
        session_id,
        70,
        stale_request_token,
        &[event("stale", session_id, "must not publish")],
    ));
    assert!(state
        .with_store_opt(session_id, |store| store.events().len())
        .is_none());
    assert!(begin_prewarm_request(session_id, 70).is_err());

    let current_request_token = begin_prewarm_request(session_id, 71).expect("next visit");
    assert!(apply_prewarm_window_if_current(
        &state,
        session_id,
        71,
        current_request_token,
        &[event("current", session_id, "publish")],
    ));
    assert_eq!(
        state.with_store_opt(session_id, |store| store.events().len()),
        Some(1)
    );
    release_session_runtime(session_id);
}

#[test]
fn stale_query_generation_or_revision_cannot_be_applied() {
    validate_query_apply_version("generation-b", 8, "generation-b", 8)
        .expect("current query is accepted");
    assert!(validate_query_apply_version("generation-a", 7, "generation-b", 8).is_err());
    assert!(validate_query_apply_version("generation-b", 7, "generation-b", 8).is_err());
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
fn two_hundred_max_preview_events_stay_under_the_hard_wire_cap() {
    let events = (0..200)
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
        .collect::<Vec<_>>();
    let mut window = ExternalReplayWindow {
        cursor: ReplayCursor {
            source_id: "codex_app".to_string(),
            session_id: "codexapp-test".to_string(),
            generation: "g1".to_string(),
            revision: 200,
            through_sequence: 199,
        },
        events,
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
fn native_session_release_does_not_create_replay_runtime_state() {
    let native_session = "osagent-native-replay-boundary";
    release_session_runtime(native_session);
    assert!(!replay_request_states()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains_key(native_session));
    assert!(!external_replay_watcher::is_available(native_session));
}

#[test]
fn stable_json_matches_the_frontend_sorted_key_contract() {
    let mut bytes = Vec::new();
    write_stable_json(
        &mut bytes,
        &serde_json::json!({"z": [3, {"b": true, "a": null}], "a": 1}),
    )
    .expect("stable json");
    assert_eq!(
        String::from_utf8(bytes).expect("utf8"),
        r#"{"a":1,"z":[3,{"a":null,"b":true}]}"#
    );
}

#[test]
fn hashing_writer_reports_exact_stream_hash_and_byte_count() {
    let mut writer = HashingWriter::new(Vec::new());
    writer.write_all(b"bounded ").expect("first write");
    writer.write_all(b"export").expect("second write");
    let (bytes, hash, output) = writer.finish();
    assert_eq!(bytes, 14);
    assert_eq!(output, b"bounded export");
    assert_eq!(hash, sha256_hex(b"bounded export"));
}

#[test]
fn hydrated_export_splices_large_json_strings_in_bounded_ranges() {
    let preview = "small preview";
    let mut replay_event = event("large", "codexapp-test", preview);
    replay_event.payload_refs = vec![PayloadRef {
        event_id: replay_event.id.clone(),
        field_path: "result.content".to_string(),
        preview: preview.to_string(),
        full_size_bytes: 0,
        truncated: true,
        replay_encoding: Some(PayloadRefEncoding::Utf8Text),
        replay_source_id: Some("codex_app".to_string()),
        replay_generation: Some("g1".to_string()),
        replay_source_event_id: Some("large".to_string()),
    }];
    let full = format!("{}END", "quote=\" slash=\\ newline=\n 中🙂 ".repeat(40_000));
    replay_event.payload_refs[0].full_size_bytes = full.len();
    let mut output = Vec::new();
    let mut calls = 0_usize;
    write_hydrated_event_json(&mut output, &replay_event, &mut |payload_ref, offset| {
        assert_eq!(payload_ref.field_path, "result.content");
        calls += 1;
        let start = offset as usize;
        let mut end = start.saturating_add(7 * 1024).min(full.len());
        while end > start && !full.is_char_boundary(end) {
            end -= 1;
        }
        Ok(ReplayPayloadRange {
            event_id: payload_ref.event_id.clone(),
            field_path: payload_ref.field_path.clone(),
            offset,
            next_offset: end as u64,
            eof: end == full.len(),
            total_bytes: full.len() as u64,
            text: full[start..end].to_string(),
        })
    })
    .expect("stream hydrated event");

    let decoded: serde_json::Value =
        serde_json::from_slice(&output).expect("valid streamed event JSON");
    assert_eq!(
        decoded.pointer("/result/content").and_then(|v| v.as_str()),
        Some(full.as_str())
    );
    assert_eq!(
        decoded.get("displayText").and_then(|v| v.as_str()),
        Some(full.as_str())
    );
    assert!(decoded.get("payloadRefs").is_none());
    assert!(
        calls > 2,
        "field and display copies must both use range reads"
    );
}

#[test]
fn hydrated_export_restores_large_payload_inside_an_array() {
    let preview = "array preview";
    let mut replay_event = event("array", "managed-session", preview);
    replay_event.args = serde_json::json!({"items":[preview, "kept"]});
    replay_event.display_text = preview.to_string();
    replay_event.payload_refs = vec![PayloadRef {
        event_id: replay_event.id.clone(),
        field_path: "args.items.0".to_string(),
        preview: preview.to_string(),
        full_size_bytes: 0,
        truncated: true,
        replay_encoding: Some(PayloadRefEncoding::Utf8Text),
        replay_source_id: Some(MANAGED_CLI_REPLAY_TARGET_ID.to_string()),
        replay_generation: Some("legacy-generation".to_string()),
        replay_source_event_id: Some("array".to_string()),
    }];
    let mut full = "array-payload-中🙂".repeat(600_000);
    while full.len() < 10 * 1024 * 1024 {
        full.push_str("tail-🙂");
    }
    replay_event.payload_refs[0].full_size_bytes = full.len();

    let mut output = Vec::new();
    let mut calls = 0_usize;
    write_hydrated_event_json(&mut output, &replay_event, &mut |payload_ref, offset| {
        calls += 1;
        let start = offset as usize;
        let mut end = start.saturating_add(256 * 1024).min(full.len());
        while end > start && !full.is_char_boundary(end) {
            end -= 1;
        }
        Ok(ReplayPayloadRange {
            event_id: payload_ref.event_id.clone(),
            field_path: payload_ref.field_path.clone(),
            offset,
            next_offset: end as u64,
            eof: end == full.len(),
            total_bytes: full.len() as u64,
            text: full[start..end].to_string(),
        })
    })
    .expect("stream array payload");

    let decoded: serde_json::Value =
        serde_json::from_slice(&output).expect("valid streamed array event");
    let restored = decoded
        .pointer("/args/items/0")
        .and_then(serde_json::Value::as_str)
        .expect("restored array payload");
    assert_eq!(sha256_hex(restored.as_bytes()), sha256_hex(full.as_bytes()));
    assert_eq!(
        decoded
            .get("displayText")
            .and_then(serde_json::Value::as_str),
        Some(full.as_str())
    );
    assert!(calls > 2, "large array payload must be range streamed");
}

#[test]
fn hydrated_export_replaces_root_json_payload_without_quoting_it() {
    let mut replay_event = event("args", "codexapp-test", "tool");
    replay_event.args = serde_json::json!({"payloadPreview":"truncated"});
    replay_event.payload_refs = vec![PayloadRef {
        event_id: replay_event.id.clone(),
        field_path: "args".to_string(),
        preview: replay_event.args.to_string(),
        full_size_bytes: 30,
        truncated: true,
        replay_encoding: Some(PayloadRefEncoding::JsonValue),
        replay_source_id: Some("claude_code".to_string()),
        replay_generation: Some("g1".to_string()),
        replay_source_event_id: Some("args".to_string()),
    }];
    let full = r#"{"command":"printf \"hello\"","path":"src/lib.rs"}"#;
    let mut output = Vec::new();
    write_hydrated_event_json(&mut output, &replay_event, &mut |payload_ref, offset| {
        assert_eq!(offset, 0);
        Ok(ReplayPayloadRange {
            event_id: payload_ref.event_id.clone(),
            field_path: payload_ref.field_path.clone(),
            offset: 0,
            next_offset: full.len() as u64,
            eof: true,
            total_bytes: full.len() as u64,
            text: full.to_string(),
        })
    })
    .expect("stream root args");
    let decoded: serde_json::Value = serde_json::from_slice(&output).expect("valid event JSON");
    assert_eq!(
        decoded.pointer("/args/path").and_then(|v| v.as_str()),
        Some("src/lib.rs")
    );

    replace_event_payload(&mut replay_event, "args", full.to_string());
    assert_eq!(
        replay_event.args.get("path").and_then(|v| v.as_str()),
        Some("src/lib.rs")
    );
}
