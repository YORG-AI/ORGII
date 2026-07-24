use super::*;

fn collaboration_snapshot_test_schema(conn: &rusqlite::Connection) {
    conn.execute_batch(
        "CREATE TABLE events (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                function_name TEXT,
                thread_id TEXT,
                args_json TEXT NOT NULL DEFAULT '{}',
                result_json TEXT NOT NULL DEFAULT '{}',
                content TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                meta_json TEXT,
                history_sequence INTEGER
             );
             CREATE INDEX idx_test_events_session_sequence
             ON events(session_id,history_sequence);",
    )
    .expect("collaboration snapshot schema");
}

fn collaboration_snapshot_meta(source: &str, display_text: &str) -> String {
    serde_json::to_string(&serde_json::json!({
        "source": source,
        "displayText": display_text,
        "displayStatus": "completed",
        "displayVariant": "message",
        "activityStatus": "processed",
        "uiCanonical": if source == "user" { "user_message" } else { "assistant_message" },
    }))
    .expect("snapshot event metadata")
}

#[test]
fn collaboration_snapshot_is_special_and_never_matches_native_agent_ids() {
    assert!(matches!(
        resolve_target(
            COLLABORATION_SNAPSHOT_REPLAY_TARGET_ID,
            "imported-session-test"
        ),
        Ok(ResolvedReplayTarget::CollaborationSnapshot)
    ));
    assert!(resolve_target(COLLABORATION_SNAPSHOT_REPLAY_TARGET_ID, "sdeagent-native").is_err());
    assert!(resolve_target("codex_app", "imported-session-test").is_err());
    assert_eq!(ImportedHistorySourceId::ALL.len(), 15);
}

#[test]
fn collaboration_snapshot_window_is_bounded_ranges_ten_mib_and_polls_true_deltas() {
    let mut conn = rusqlite::Connection::open_in_memory().expect("snapshot replay DB");
    collaboration_snapshot_test_schema(&conn);
    let session_id = "imported-session-bounded";
    let large_content = format!("{}END", "snapshot-output\n".repeat(700_000));
    let large_result = serde_json::to_string(&serde_json::json!({
        "content": large_content,
        "status": "done",
    }))
    .expect("large snapshot result");
    {
        let tx = conn.transaction().expect("snapshot insert transaction");
        let mut insert = tx
            .prepare(
                "INSERT INTO events(
                       id,session_id,event_type,function_name,thread_id,args_json,
                       result_json,content,created_at,meta_json,history_sequence
                     ) VALUES(?1,?2,?3,?4,NULL,'{}',?5,'',?6,?7,?8)",
            )
            .expect("snapshot insert statement");
        for sequence in 0..205_i64 {
            let user = sequence == 0;
            let event_id = format!("snapshot-{sequence}");
            let result = if sequence == 204 {
                large_result.as_str()
            } else {
                "{\"content\":\"small\"}"
            };
            insert
                .execute(rusqlite::params![
                    event_id,
                    session_id,
                    if user { "user_message" } else { "assistant" },
                    if user {
                        "user_message"
                    } else {
                        "assistant_message"
                    },
                    result,
                    format!("2026-07-22T00:{:02}:{:02}Z", sequence / 60, sequence % 60),
                    collaboration_snapshot_meta(
                        if user { "user" } else { "assistant" },
                        if user { "start" } else { "answer" },
                    ),
                    sequence,
                ])
                .expect("insert snapshot row");
        }
        drop(insert);
        tx.commit().expect("commit snapshot rows");
    }

    let limits = ReplayLimits {
        max_turns: 1,
        max_events: 200,
        max_ipc_bytes: 4 * 1024 * 1024,
    };
    let window =
        collaboration_snapshot_read_window_from_conn(&conn, session_id, None, None, None, limits)
            .expect("bounded collaboration window");
    assert_eq!(window.events.len(), 200);
    assert_eq!(window.total_event_count, 205);
    assert!(window.has_older);
    assert!(window.stats.ipc_bytes < 4 * 1024 * 1024);
    let large = window
        .events
        .iter()
        .find(|event| event.id == "snapshot-204")
        .expect("large event remains in latest window");
    let payload = large
        .payload_refs
        .iter()
        .find(|reference| reference.field_path == "result")
        .expect("large result is deferred at the canonical root");
    assert!(payload.full_size_bytes > 10 * 1024 * 1024);

    let mut rebuilt = String::new();
    let mut offset = 0_u64;
    loop {
        let range = collaboration_snapshot_payload_range_from_conn(
            &conn,
            session_id,
            &window.cursor.generation,
            "snapshot-204",
            "result",
            offset,
            replay::HARD_MAX_PAYLOAD_RANGE_BYTES,
        )
        .expect("bounded collaboration payload range");
        assert!(range.text.len() <= replay::HARD_MAX_PAYLOAD_RANGE_BYTES);
        rebuilt.push_str(&range.text);
        if range.eof {
            break;
        }
        assert!(range.next_offset > offset);
        offset = range.next_offset;
    }
    assert_eq!(rebuilt, large_result);

    let unchanged =
        collaboration_snapshot_poll_delta_from_conn(&conn, session_id, &window.cursor, limits)
            .expect("unchanged collaboration poll");
    assert!(unchanged.events.is_empty());
    assert_eq!(unchanged.stats.parsed_rows, 0);
    assert!(!unchanged.reset_required);

    conn.execute(
        "INSERT INTO events(
               id,session_id,event_type,function_name,args_json,result_json,
               content,created_at,meta_json,history_sequence
             ) VALUES(
               'snapshot-205',?1,'assistant','assistant_message','{}',
               '{\"content\":\"appended\"}','','2026-07-22T00:03:25Z',?2,205
             )",
        rusqlite::params![
            session_id,
            collaboration_snapshot_meta("assistant", "appended")
        ],
    )
    .expect("append collaboration event");
    let delta =
        collaboration_snapshot_poll_delta_from_conn(&conn, session_id, &window.cursor, limits)
            .expect("collaboration append delta");
    assert_eq!(delta.events.len(), 1);
    assert_eq!(delta.events[0].id, "snapshot-205");
    assert_eq!(delta.cursor.generation, window.cursor.generation);
    assert!(!delta.reset_required);

    conn.execute(
        "UPDATE events SET result_json='{\"content\":\"rewritten\"}'
             WHERE id='snapshot-205'",
        [],
    )
    .expect("rewrite collaboration event");
    let reset =
        collaboration_snapshot_poll_delta_from_conn(&conn, session_id, &delta.cursor, limits)
            .expect("collaboration rewrite reset");
    assert!(reset.reset_required);
    assert_ne!(reset.cursor.generation, delta.cursor.generation);

    conn.execute("DELETE FROM events WHERE session_id=?1", [session_id])
        .expect("bulk-delete collaboration snapshot");
    let deleted = collaboration_snapshot_state(&conn, session_id)
        .expect("refresh state once after bulk delete");
    assert_eq!(deleted.event_count, 0);
    assert_eq!(deleted.max_sequence, -1);
}

#[test]
fn snapshot_backed_native_fork_secondary_replay_keeps_native_execution_isolated() {
    let mut conn = rusqlite::Connection::open_in_memory().expect("native fork replay DB");
    session_persistence::init_session_tables(&conn).expect("native session schema");
    crate::agent_sessions::event_pipeline::commands::collaboration_snapshot_ingest::install_snapshot_schema_for_test(&mut conn)
            .expect("collaboration snapshot schema");
    let session_id = "agentsession-snapshot-secondary";
    let inherited_count = 1_000_i64;
    {
        let tx = conn
            .transaction()
            .expect("seed inherited snapshot transaction");
        let mut insert_event = tx
            .prepare(
                "INSERT INTO events(
                       id,session_id,event_type,function_name,thread_id,args_json,
                       result_json,content,created_at,meta_json,history_sequence
                     ) VALUES(?1,?2,?3,?4,NULL,?5,?6,'',?7,?8,?9)",
            )
            .expect("prepare inherited event insert");
        let mut insert_map = tx
            .prepare(
                "INSERT INTO collaboration_snapshot_event_map(
                       session_id,event_id,original_id,physical_seq,event_index,
                       logical_index,is_tail
                     ) VALUES(?1,?2,?3,?4,0,?5,0)",
            )
            .expect("prepare inherited map insert");
        for sequence in 0..inherited_count {
            let event_id = format!("{session_id}~inherited-{sequence}");
            let user = sequence == 0;
            insert_event
                .execute(rusqlite::params![
                    event_id,
                    session_id,
                    if user { "user_message" } else { "assistant" },
                    if user {
                        "user_message"
                    } else {
                        "assistant_message"
                    },
                    if user {
                        "{\"content\":\"inherited question\"}"
                    } else {
                        "{}"
                    },
                    if user {
                        "{}"
                    } else {
                        "{\"content\":\"inherited answer\"}"
                    },
                    format!("2026-07-22T00:{:02}:{:02}Z", sequence / 60, sequence % 60),
                    collaboration_snapshot_meta(
                        if user { "user" } else { "assistant" },
                        if user {
                            "inherited question"
                        } else {
                            "inherited answer"
                        },
                    ),
                    sequence,
                ])
                .expect("insert inherited event");
            insert_map
                .execute(rusqlite::params![
                    session_id,
                    event_id,
                    format!("inherited-{sequence}"),
                    sequence + 1,
                    sequence,
                ])
                .expect("insert inherited map row");
        }
        drop(insert_map);
        drop(insert_event);
        tx.execute(
            "INSERT INTO sessions(session_id,event_count,cached_at)
                 VALUES(?1,?2,0)",
            rusqlite::params![session_id, inherited_count],
        )
        .expect("insert native fork session row");
        tx.execute(
            "INSERT INTO collaboration_snapshot_ingest_state(
                   session_id,epoch,frozen_seq,event_count,frozen_event_count,
                   tail_hash,updated_at
                 ) VALUES(?1,7,?2,?2,?2,NULL,0)",
            rusqlite::params![session_id, inherited_count],
        )
        .expect("insert native fork snapshot cursor");
        tx.commit().expect("commit inherited snapshot");
    }

    assert!(resolve_target(COLLABORATION_SNAPSHOT_REPLAY_TARGET_ID, session_id).is_err());
    assert!(matches!(
        resolve_secondary_consumer_target(COLLABORATION_SNAPSHOT_REPLAY_TARGET_ID, session_id),
        Ok(ResolvedReplayTarget::CollaborationSnapshot)
    ));
    let replay_state_table: i64 = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master
                 WHERE type='table' AND name='collaboration_replay_state')",
            [],
            |row| row.get(0),
        )
        .expect("inspect imported replay accounting table");
    assert_eq!(replay_state_table, 0);
    let frontier_plan = conn
        .prepare(
            "EXPLAIN QUERY PLAN SELECT history_sequence FROM events
                 WHERE session_id=?1 AND history_sequence IS NOT NULL
                 ORDER BY history_sequence DESC LIMIT 1",
        )
        .expect("prepare native fork frontier plan")
        .query_map([session_id], |row| row.get::<_, String>(3))
        .expect("query native fork frontier plan")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("collect native fork frontier plan");
    assert!(frontier_plan
        .iter()
        .any(|detail| detail.contains("idx_events_session_sequence")));

    let limits = ReplayLimits {
        max_turns: 1,
        max_events: 200,
        max_ipc_bytes: 4 * 1024 * 1024,
    };
    let inherited_window =
        collaboration_snapshot_read_window_from_conn(&conn, session_id, None, None, None, limits)
            .expect("read bounded inherited window");
    assert_eq!(inherited_window.events.len(), 200);
    assert_eq!(inherited_window.total_event_count, inherited_count as u64);
    assert_eq!(
        inherited_window.cursor.through_sequence,
        inherited_count - 1
    );

    let suffix_user_id = format!("{session_id}~native-user");
    let suffix_assistant_id = format!("{session_id}~native-assistant");
    let large_result = serde_json::to_string(&serde_json::json!({
        "content": format!("{}END", "native-suffix-output\n".repeat(550_000)),
        "status": "done",
    }))
    .expect("large native suffix result");
    {
        let tx = conn
            .transaction()
            .expect("append native suffix transaction");
        tx.execute(
            "INSERT INTO events(
                   id,session_id,event_type,function_name,args_json,result_json,
                   content,created_at,meta_json,history_sequence
                 ) VALUES(?1,?2,'user_message','user_message',?3,'{}','',?4,?5,?6)",
            rusqlite::params![
                suffix_user_id,
                session_id,
                "{\"content\":\"native suffix question\"}",
                "2026-07-22T01:00:00Z",
                collaboration_snapshot_meta("user", "native suffix question"),
                inherited_count,
            ],
        )
        .expect("insert native suffix user");
        tx.execute(
            "INSERT INTO events(
                   id,session_id,event_type,function_name,args_json,result_json,
                   content,created_at,meta_json,history_sequence
                 ) VALUES(?1,?2,'assistant','assistant_message','{}',?3,'',?4,?5,?6)",
            rusqlite::params![
                suffix_assistant_id,
                session_id,
                large_result,
                "2026-07-22T01:00:01Z",
                collaboration_snapshot_meta("assistant", "native suffix answer"),
                inherited_count + 1,
            ],
        )
        .expect("insert native suffix assistant");
        tx.execute(
            "UPDATE sessions SET event_count=?2 WHERE session_id=?1",
            rusqlite::params![session_id, inherited_count + 2],
        )
        .expect("publish native suffix count");
        tx.commit().expect("commit native suffix");
    }

    let appended = collaboration_snapshot_poll_delta_from_conn(
        &conn,
        session_id,
        &inherited_window.cursor,
        limits,
    )
    .expect("poll native suffix delta");
    assert!(!appended.reset_required);
    assert_eq!(
        appended.cursor.generation,
        inherited_window.cursor.generation
    );
    assert!(appended.cursor.revision > inherited_window.cursor.revision);
    assert_eq!(
        appended
            .events
            .iter()
            .map(|event| event.id.as_str())
            .collect::<Vec<_>>(),
        vec![suffix_user_id.as_str(), suffix_assistant_id.as_str()]
    );

    let suffix_turn = collaboration_snapshot_read_window_from_conn(
        &conn,
        session_id,
        None,
        Some(&suffix_user_id),
        None,
        limits,
    )
    .expect("address native suffix turn");
    assert_eq!(suffix_turn.events.len(), 2);
    assert_eq!(suffix_turn.events[1].id, suffix_assistant_id);
    let payload = suffix_turn.events[1]
        .payload_refs
        .iter()
        .find(|reference| reference.field_path == "result")
        .expect("native suffix large result is deferred");
    assert!(payload.full_size_bytes > 10 * 1024 * 1024);

    let mut expected_hash = Sha256::new();
    expected_hash.update(large_result.as_bytes());
    let expected_hash = format!("{:x}", expected_hash.finalize());
    let mut actual_hash = Sha256::new();
    let mut offset = 0_u64;
    loop {
        let range = collaboration_snapshot_payload_range_from_conn(
            &conn,
            session_id,
            &appended.cursor.generation,
            &suffix_assistant_id,
            "result",
            offset,
            replay::HARD_MAX_PAYLOAD_RANGE_BYTES,
        )
        .expect("read native suffix payload range");
        assert!(range.text.len() <= replay::HARD_MAX_PAYLOAD_RANGE_BYTES);
        actual_hash.update(range.text.as_bytes());
        if range.eof {
            break;
        }
        assert!(range.next_offset > offset);
        offset = range.next_offset;
    }
    assert_eq!(format!("{:x}", actual_hash.finalize()), expected_hash);

    let batch_limits = ReplayLimits {
        max_turns: 10,
        max_events: 17,
        max_ipc_bytes: 4 * 1024 * 1024,
    };
    let mut lower = -1_i64;
    let mut ordered_ids = Vec::new();
    loop {
        let batch = query_collaboration_snapshot_events(
            &conn,
            session_id,
            &appended.cursor.generation,
            lower,
            i64::MAX,
            batch_limits,
            false,
        )
        .expect("stream native fork event batch");
        assert!(batch.len() <= 17);
        if batch.is_empty() {
            break;
        }
        lower = batch.last().expect("non-empty batch").0;
        ordered_ids.extend(batch.into_iter().map(|(_, event)| event.id));
    }
    assert_eq!(ordered_ids.len(), (inherited_count + 2) as usize);
    assert_eq!(
        ordered_ids.first(),
        Some(&format!("{session_id}~inherited-0"))
    );
    assert_eq!(
        &ordered_ids[ordered_ids.len() - 2..],
        &[suffix_user_id.clone(), suffix_assistant_id.clone()]
    );

    conn.execute(
        "UPDATE events SET result_json='{\"content\":\"rewritten\"}' WHERE id=?1",
        [&suffix_assistant_id],
    )
    .expect("rewrite native suffix event");
    let rewritten =
        collaboration_snapshot_poll_delta_from_conn(&conn, session_id, &appended.cursor, limits)
            .expect("poll rewritten native suffix");
    assert!(rewritten.reset_required);
    assert_eq!(rewritten.cursor.generation, appended.cursor.generation);
    assert!(rewritten.cursor.revision > appended.cursor.revision);

    conn.execute("DELETE FROM events WHERE id=?1", [&suffix_assistant_id])
        .expect("delete native suffix event");
    conn.execute(
        "UPDATE sessions SET event_count=?2 WHERE session_id=?1",
        rusqlite::params![session_id, inherited_count + 1],
    )
    .expect("publish native suffix delete count");
    let delete_delta =
        collaboration_snapshot_poll_delta_from_conn(&conn, session_id, &rewritten.cursor, limits)
            .expect("poll deleted native suffix");
    assert!(delete_delta.reset_required);
    assert_eq!(delete_delta.cursor.generation, rewritten.cursor.generation);
    let deleted = crate::agent_sessions::event_pipeline::commands::collaboration_snapshot_ingest::collaboration_snapshot_secondary_state(
                &conn, session_id,
            )
            .expect("read deleted native suffix state")
            .expect("native fork remains snapshot-backed after suffix delete");
    assert_eq!(deleted.event_count, (inherited_count + 1) as u64);
    assert_eq!(deleted.max_sequence, inherited_count);
}
