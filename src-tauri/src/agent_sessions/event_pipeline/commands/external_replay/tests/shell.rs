use super::*;

fn external_shell_payload_event(
    id: &str,
    session_id: &str,
    call_id: &str,
    source_event_id: &str,
    full_size_bytes: usize,
) -> SessionEvent {
    let mut event = ingestion::normalize_single(
        &RawActivityChunk {
            chunk_id: Some(id.to_string()),
            session_id: Some(session_id.to_string()),
            action_type: Some("tool_call".to_string()),
            function: Some("run_command_line".to_string()),
            result: Some(serde_json::json!({"output":"bounded preview"})),
            created_at: Some("2026-07-22T00:00:00Z".to_string()),
            ..RawActivityChunk::default()
        },
        session_id,
    );
    event.ui_canonical = core_types::tool_names::RUN_SHELL.to_string();
    event.call_id = Some(call_id.to_string());
    event.payload_refs = vec![PayloadRef {
        event_id: event.id.clone(),
        field_path: "result.output".to_string(),
        preview: "bounded preview".to_string(),
        full_size_bytes,
        truncated: true,
        replay_encoding: Some(PayloadRefEncoding::Utf8Text),
        replay_source_id: Some(MANAGED_CLI_REPLAY_TARGET_ID.to_string()),
        replay_generation: Some("test-generation".to_string()),
        replay_source_event_id: Some(source_event_id.to_string()),
    }];
    event
}

fn ten_mib_utf8_shell_payload() -> String {
    const TARGET: usize = 10 * 1024 * 1024;
    let pattern = "你🙂 shell stdout/stderr boundary\n";
    let mut payload = pattern.repeat(TARGET / pattern.len() + 1);
    let mut boundary = TARGET;
    while !payload.is_char_boundary(boundary) {
        boundary -= 1;
    }
    payload.truncate(boundary);
    payload.extend(std::iter::repeat_n('x', TARGET - boundary));
    assert_eq!(payload.len(), TARGET);
    payload
}

fn bounded_utf8_payload_bytes(text: &str, offset: u64, max_bytes: usize) -> Vec<u8> {
    let start = offset as usize;
    assert!(text.is_char_boundary(start));
    let mut end = start.saturating_add(max_bytes).min(text.len());
    while end > start && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.as_bytes()[start..end].to_vec()
}

#[test]
fn foreground_replay_connection_does_not_wait_for_catalog_writer_mutex() {
    use std::sync::mpsc;
    use std::time::Duration;

    let (release_tx, release_rx) = mpsc::sync_channel::<()>(1);
    let (locked_tx, locked_rx) = mpsc::sync_channel(1);
    let catalog_writer = std::thread::spawn(move || {
        let _writer = database::db::sessions_writer_guard();
        locked_tx.send(()).expect("report catalog writer lock");
        release_rx.recv().expect("release catalog writer lock");
    });
    locked_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("catalog writer must acquire the mutex");

    let (probe_tx, probe_rx) = mpsc::sync_channel(1);
    let foreground = std::thread::spawn(move || {
        let result = with_foreground_replay_connection("lock probe", |conn| {
            let tx = database::db::begin_immediate(conn)
                .map_err(|error| format!("begin foreground lock probe: {error}"))?;
            tx.rollback()
                .map_err(|error| format!("rollback foreground lock probe: {error}"))?;
            Ok(1_i64)
        });
        probe_tx.send(result).expect("report foreground probe");
    });
    let probe = probe_rx.recv_timeout(Duration::from_secs(2));
    release_tx
        .send(())
        .expect("release simulated catalog writer");
    catalog_writer.join().expect("catalog writer thread");
    foreground.join().expect("foreground probe thread");

    assert_eq!(
        probe.expect("foreground Shell path must bypass the catalog mutex"),
        Ok(1)
    );
}

fn read_complete_external_shell(
    conn: &Connection,
    session_id: &str,
    call_id: &str,
    total_bytes: u64,
    last_sequence: u64,
) -> String {
    let mut output = String::new();
    let mut offset = 0_u64;
    loop {
        let range = read_external_shell_manifest_range(
            conn,
            session_id,
            call_id,
            last_sequence,
            total_bytes,
            offset,
            SHELL_REPLAY_RANGE_MAX_BYTES as u64,
        )
        .expect("read external Shell range")
        .expect("external Shell manifest");
        assert!(range
            .frames
            .iter()
            .all(|frame| frame.text.len() <= SHELL_REPLAY_FRAME_MAX_BYTES + 3));
        for frame in range.frames {
            output.push_str(&frame.text);
        }
        if range.eof {
            break;
        }
        assert!(range.next_offset_bytes > offset);
        offset = range.next_offset_bytes;
    }
    output
}

#[test]
fn native_shell_call_id_performs_zero_external_database_probes() {
    assert!(!is_external_shell_manifest_call_id("native-shell-call"));
    assert!(!is_external_shell_manifest_call_id(
        "looks-external-but-short-external-deadbeef"
    ));
    assert!(is_external_shell_manifest_call_id(&format!(
        "managed-call-external-{}",
        "a".repeat(64)
    )));

    let before = EXTERNAL_SHELL_MANIFEST_DB_PROBES.load(Ordering::SeqCst);
    let result = tokio::runtime::Runtime::new()
        .expect("native Shell range runtime")
        .block_on(shell_replay_read_range(
            "native-shell-probe-session".to_string(),
            "native-shell-probe-call".to_string(),
            1,
            1,
            0,
            1,
        ));
    assert!(
        result.is_err(),
        "the synthetic native replay does not exist"
    );
    assert_eq!(
        EXTERNAL_SHELL_MANIFEST_DB_PROBES.load(Ordering::SeqCst),
        before,
        "native #425 range reads must bypass the external DB/task path"
    );
}

#[test]
fn absent_external_schema_is_an_explicit_native_fallback() {
    let conn = Connection::open_in_memory().expect("native-only replay DB");
    conn.execute_batch(
        "CREATE TABLE shell_replays(
                 session_id TEXT NOT NULL,
                 call_id TEXT NOT NULL,
                 PRIMARY KEY(session_id,call_id)
             );",
    )
    .expect("native-only Shell schema marker");
    let call_id = format!("legacy-live-external-{}", "b".repeat(64));
    let external =
        read_external_shell_manifest_range(&conn, "native-only-session", &call_id, 1, 1, 0, 1)
            .expect("missing external table is not corruption");
    assert!(external.is_none());
}

#[test]
fn imported_shell_final_guard_reobserves_same_size_provider_rewrite() {
    use orgtrack_core::store::sqlite::SqliteRecordStore;

    let directory = tempfile::tempdir().expect("imported Shell provider fixture");
    let source_path = directory.path().join("codex-session.jsonl");
    let initial = concat!(
        "{\"timestamp\":\"2026-07-22T00:00:00Z\",\"type\":\"event_msg\",",
        "\"payload\":{\"type\":\"user_message\",\"message\":\"question\"}}\n",
        "{\"timestamp\":\"2026-07-22T00:00:01Z\",\"type\":\"event_msg\",",
        "\"payload\":{\"type\":\"agent_message\",\"message\":\"answer-AAAA\"}}\n",
    );
    let replacement = initial.replace("answer-AAAA", "answer-BBBB");
    assert_eq!(initial.len(), replacement.len());
    fs::write(&source_path, initial).expect("write initial Codex transcript");

    let source = ImportedHistorySourceId::CodexApp;
    let session_id = "codexapp-shell-provider-race";
    let source_session_id = source
        .source_session_id(session_id)
        .expect("Codex source session id");
    let mut cache = Connection::open_in_memory().expect("imported Shell replay cache");
    SqliteRecordStore::init_tables(&cache).expect("replay tables");
    SqliteRecordStore::init_source_cache_tables(&cache).expect("source cache tables");
    cache
        .execute(
            "INSERT INTO imported_history_session_cache(
                     source,source_session_id,session_id,source_path
                 ) VALUES(?1,?2,?3,?4)",
            params![
                source.as_str(),
                source_session_id,
                session_id,
                source_path.to_string_lossy()
            ],
        )
        .expect("bind Codex provider transcript");
    let opened = replay::open_window(&mut cache, source, session_id, ReplayLimits::default())
        .expect("open initial Codex replay");
    validate_imported_shell_snapshot_from_conn(
        &mut cache,
        source,
        session_id,
        &opened.cursor.generation,
        opened.cursor.revision,
    )
    .expect("unchanged provider remains valid");

    // Keep the physical size identical so this specifically proves the
    // final guard observes provider identity/content rather than trusting
    // the previously published compact state or payload length.
    std::thread::sleep(Duration::from_millis(2));
    fs::write(&source_path, replacement).expect("rewrite Codex transcript in place");
    let error = validate_imported_shell_snapshot_from_conn(
        &mut cache,
        source,
        session_id,
        &opened.cursor.generation,
        opened.cursor.revision,
    )
    .expect_err("same-size provider rewrite must invalidate Shell delivery");
    assert!(error.contains("changed while publishing manifests"));
    assert!(error.contains(&opened.cursor.generation));
}

#[test]
fn collaboration_revision_is_part_of_the_shell_artifact_epoch() {
    use orgtrack_core::store::sqlite::SqliteRecordStore;

    let mut conn = Connection::open_in_memory().expect("collaboration Shell cache");
    SqliteRecordStore::init_tables(&conn).expect("replay schema");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("cache schema");
    let session_id = "agentsession-collaboration-shell";
    let generation = "collaboration-secondary-v1";
    let first_payload = format!("BEGIN{}END", "A".repeat(96 * 1024));
    let second_payload = format!("BEGIN{}END", "B".repeat(96 * 1024));
    assert_eq!(first_payload.len(), second_payload.len());

    let mut first = external_shell_payload_event(
        "collaboration-shell-event",
        session_id,
        "collaboration-shell-call",
        "collaboration-shell-event",
        first_payload.len(),
    );
    let first_epoch = collaboration_shell_artifact_generation(generation, 41);
    {
        let tx = conn.transaction().expect("first collaboration revision");
        persist_scoped_shell_manifest(
            &tx,
            &mut first,
            COLLABORATION_SNAPSHOT_REPLAY_TARGET_ID,
            session_id,
            &first_epoch,
            |_, offset, max_bytes| {
                Ok(bounded_utf8_payload_bytes(
                    &first_payload,
                    offset,
                    max_bytes,
                ))
            },
        )
        .expect("first collaboration Shell manifest");
        tx.commit().expect("commit first collaboration revision");
    }
    let first_state = first.shell_replay.expect("first collaboration state");
    let first_hash = conn
        .query_row(
            "SELECT content_hash FROM imported_replay_shell_segments
                 WHERE session_id=?1",
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .expect("first collaboration Shell hash");

    // The collaboration generation is intentionally unchanged; only the
    // cursor revision advances after an in-line snapshot rewrite.
    let second_epoch = collaboration_shell_artifact_generation(generation, 42);
    assert_ne!(first_epoch, second_epoch);
    let mut second = external_shell_payload_event(
        "collaboration-shell-event",
        session_id,
        "collaboration-shell-call",
        "collaboration-shell-event",
        second_payload.len(),
    );
    let mut second_reads = 0_usize;
    {
        let tx = conn
            .transaction()
            .expect("rewritten collaboration revision");
        persist_scoped_shell_manifest(
            &tx,
            &mut second,
            COLLABORATION_SNAPSHOT_REPLAY_TARGET_ID,
            session_id,
            &second_epoch,
            |_, offset, max_bytes| {
                second_reads += 1;
                Ok(bounded_utf8_payload_bytes(
                    &second_payload,
                    offset,
                    max_bytes,
                ))
            },
        )
        .expect("rewritten collaboration Shell manifest");
        tx.commit()
            .expect("commit rewritten collaboration revision");
    }
    assert!(
        second_reads > 0,
        "new revision must not hit the old artifact"
    );
    let second_state = second.shell_replay.expect("second collaboration state");
    let (second_hash, stored_epoch): (String, String) = conn
        .query_row(
            "SELECT content_hash,generation FROM imported_replay_shell_segments
                 WHERE session_id=?1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("rewritten collaboration Shell locator");
    assert_ne!(first_hash, second_hash);
    assert_ne!(
        first_state.replay_ref.call_id,
        second_state.replay_ref.call_id
    );
    assert_eq!(stored_epoch, second_epoch);
    let restored = read_complete_external_shell(
        &conn,
        session_id,
        &second_state.replay_ref.call_id,
        second_state.bookmark.visible_bytes,
        second_state.bookmark.visible_through_sequence,
    );
    assert_eq!(restored, second_payload);
}

#[test]
fn shell_events_commit_independently_and_retry_after_later_failure() {
    use orgtrack_core::store::sqlite::SqliteRecordStore;

    let mut conn = Connection::open_in_memory().expect("per-event Shell cache");
    SqliteRecordStore::init_tables(&conn).expect("replay schema");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("cache schema");
    let session_id = "cliagent-per-event-shell";
    let payload = "bounded-event-payload".repeat(4_096);
    let mut first =
        external_shell_payload_event("event-a", session_id, "call-a", "payload-a", payload.len());
    {
        let tx = conn.transaction().expect("first event transaction");
        persist_scoped_shell_manifest(
            &tx,
            &mut first,
            MANAGED_CLI_REPLAY_TARGET_ID,
            session_id,
            "chunks-1",
            |_, offset, max_bytes| Ok(bounded_utf8_payload_bytes(&payload, offset, max_bytes)),
        )
        .expect("first event manifest");
        tx.commit().expect("commit first event manifest");
    }

    let mut second =
        external_shell_payload_event("event-b", session_id, "call-b", "payload-b", payload.len());
    {
        let tx = conn.transaction().expect("second event transaction");
        let error = persist_scoped_shell_manifest(
            &tx,
            &mut second,
            MANAGED_CLI_REPLAY_TARGET_ID,
            session_id,
            "chunks-1",
            |_, _, _| Ok(Vec::new()),
        )
        .expect_err("second event source fails before commit");
        assert!(error.contains("invalid progress"));
        tx.rollback().expect("rollback failed second event");
    }
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM imported_replay_shell_manifests",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("first manifest survives later failure"),
        1
    );
    assert!(read_external_shell_manifest_range(
        &conn,
        session_id,
        &first
            .shell_replay
            .as_ref()
            .expect("first replay state")
            .replay_ref
            .call_id,
        u64::MAX,
        u64::MAX,
        0,
        SHELL_REPLAY_RANGE_MAX_BYTES as u64,
    )
    .expect("first manifest remains readable")
    .is_some());

    let tx = conn.transaction().expect("second event retry transaction");
    persist_scoped_shell_manifest(
        &tx,
        &mut second,
        MANAGED_CLI_REPLAY_TARGET_ID,
        session_id,
        "chunks-1",
        |_, offset, max_bytes| Ok(bounded_utf8_payload_bytes(&payload, offset, max_bytes)),
    )
    .expect("retry second event manifest");
    tx.commit().expect("commit retried second event");
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM imported_replay_shell_manifests",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("both per-event manifests"),
        2
    );
}

#[test]
fn external_shell_payload_is_one_canonical_body_and_updates_atomically() {
    use orgtrack_core::store::sqlite::SqliteRecordStore;

    let directory = tempfile::tempdir().expect("external Shell cache directory");
    let database_path = directory.path().join("replay-cache.sqlite");
    let mut conn = Connection::open(&database_path).expect("external Shell cache DB");
    SqliteRecordStore::init_tables(&conn).expect("external Shell replay schema");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("source cache schema");

    let session_id = "cliagent-shared-shell";
    let source_event_id = "shared-ten-mib-payload";
    let payload = ten_mib_utf8_shell_payload();
    let mut range_reads = 0_usize;
    let mut replay_states = Vec::new();
    {
        let tx = conn.transaction().expect("publish shared Shell manifests");
        for index in 0..50 {
            let mut event = external_shell_payload_event(
                &format!("shell-event-{index}"),
                session_id,
                &format!("shell-call-{index}"),
                source_event_id,
                payload.len(),
            );
            persist_scoped_shell_manifest(
                &tx,
                &mut event,
                MANAGED_CLI_REPLAY_TARGET_ID,
                session_id,
                "generation-a",
                |_, offset, max_bytes| {
                    range_reads += 1;
                    Ok(bounded_utf8_payload_bytes(&payload, offset, max_bytes))
                },
            )
            .expect("publish shared Shell manifest");
            replay_states.push(event.shell_replay.expect("external Shell replay state"));
        }
        tx.commit().expect("commit shared Shell manifests");
    }
    assert!(range_reads > 1, "the first 10 MiB body is range streamed");
    assert!(range_reads < 50, "later calls reuse the immutable artifact");

    let (artifact_count, artifact_bytes): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*),COALESCE(SUM(LENGTH(payload)),0)
                 FROM imported_replay_payload_artifacts",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("physical artifact accounting");
    assert_eq!(artifact_count, 1);
    assert_eq!(artifact_bytes as usize, payload.len());
    let original_content_hash = conn
        .query_row(
            "SELECT content_hash FROM imported_replay_payload_artifacts
                 WHERE generation='generation-a'",
            [],
            |row| row.get::<_, String>(0),
        )
        .expect("original canonical content hash");
    let segment_count = conn
        .query_row(
            "SELECT COUNT(*) FROM imported_replay_shell_segments",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("Shell manifest references");
    assert_eq!(segment_count, 50, "50 calls reference one physical body");
    let artifact_reference_count = conn
        .query_row(
            "SELECT COUNT(*) FROM imported_replay_payload_artifact_refs",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("canonical source references");
    assert_eq!(artifact_reference_count, 1);
    let native_slog_table_count = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='table' AND name='shell_replays'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("native .slog table lookup");
    assert_eq!(
        native_slog_table_count, 0,
        "external path creates no native `.slog`"
    );
    let database_bytes = std::fs::metadata(&database_path)
        .expect("external Shell cache file")
        .len();
    assert!(
        // SQLite may retain the temporary content-key pages on its
        // freelist until a later vacuum, so allow that one transient body
        // in addition to the one live BLOB. Fifty live copies would be
        // roughly 500 MiB and fail this bound by a wide margin.
        database_bytes < (payload.len() as u64) * 3,
        "50 manifests must not make 50 physical 10 MiB bodies: {database_bytes} bytes"
    );

    let first_state = &replay_states[0];
    let restored = read_complete_external_shell(
        &conn,
        session_id,
        &first_state.replay_ref.call_id,
        first_state.bookmark.visible_bytes,
        first_state.bookmark.visible_through_sequence,
    );
    assert_eq!(
        sha256_hex(restored.as_bytes()),
        sha256_hex(payload.as_bytes())
    );

    // Delivering the same immutable epoch again must neither read provider
    // ranges nor rewrite the unchanged manifest/segments.
    let mut unchanged = external_shell_payload_event(
        "shell-event-0",
        session_id,
        "shell-call-0",
        source_event_id,
        payload.len(),
    );
    let unchanged_call_id = {
        let tx = conn.transaction().expect("unchanged Shell delivery");
        let mut repeated_reads = 0_usize;
        persist_scoped_shell_manifest(
            &tx,
            &mut unchanged,
            MANAGED_CLI_REPLAY_TARGET_ID,
            session_id,
            "generation-a",
            |_, _, _| {
                repeated_reads += 1;
                Ok(Vec::new())
            },
        )
        .expect("reuse unchanged Shell manifest");
        assert_eq!(repeated_reads, 0);
        tx.commit().expect("commit unchanged delivery");
        unchanged
            .shell_replay
            .as_ref()
            .expect("unchanged replay state")
            .replay_ref
            .call_id
            .clone()
    };
    assert_eq!(unchanged_call_id, first_state.replay_ref.call_id);
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM imported_replay_shell_segments",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("unchanged segment count"),
        50
    );

    // A new immutable generation with the same byte length must be read
    // and hashed again; length alone can never select the old body.
    let mut changed_payload = payload.clone();
    changed_payload.replace_range(0.."你".len(), "界");
    assert_eq!(changed_payload.len(), payload.len());
    let mut changed = external_shell_payload_event(
        "shell-event-0",
        session_id,
        "shell-call-0",
        source_event_id,
        changed_payload.len(),
    );
    let mut changed_reads = 0_usize;
    {
        let tx = conn.transaction().expect("changed Shell generation");
        persist_scoped_shell_manifest(
            &tx,
            &mut changed,
            MANAGED_CLI_REPLAY_TARGET_ID,
            session_id,
            "generation-b",
            |_, offset, max_bytes| {
                changed_reads += 1;
                Ok(bounded_utf8_payload_bytes(
                    &changed_payload,
                    offset,
                    max_bytes,
                ))
            },
        )
        .expect("publish same-length changed Shell body");
        tx.commit().expect("commit changed Shell generation");
    }
    assert!(changed_reads > 1);
    let changed_state = changed.shell_replay.expect("changed replay state");
    assert_ne!(changed_state.replay_ref.call_id, unchanged_call_id);
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM imported_replay_shell_segments
                 WHERE session_id=?1 AND call_id=?2",
            params![session_id, unchanged_call_id],
            |row| row.get::<_, i64>(0),
        )
        .expect("obsolete call segment count"),
        0,
        "replacement must explicitly remove old segments with foreign_keys OFF"
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM imported_replay_shell_segments
                 WHERE content_hash=?1",
            [&original_content_hash],
            |row| row.get::<_, i64>(0),
        )
        .expect("remaining shared-body references"),
        49,
        "the other 49 calls still share and retain the original body"
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM imported_replay_shell_segments",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("replacement segment count"),
        50
    );
    let changed_restored = read_complete_external_shell(
        &conn,
        session_id,
        &changed_state.replay_ref.call_id,
        changed_state.bookmark.visible_bytes,
        changed_state.bookmark.visible_through_sequence,
    );
    assert_eq!(
        sha256_hex(changed_restored.as_bytes()),
        sha256_hex(changed_payload.as_bytes())
    );
    assert_ne!(
        sha256_hex(payload.as_bytes()),
        sha256_hex(changed_payload.as_bytes())
    );

    // Simulate a failed/crashed replacement: artifact, refs, manifest and
    // segment publication share one transaction, so rollback must leave
    // the last committed canonical body readable.
    let mut rolled_back_payload = changed_payload.clone();
    rolled_back_payload.replace_range(0.."界".len(), "中");
    let mut rolled_back = external_shell_payload_event(
        "shell-event-0",
        session_id,
        "shell-call-0",
        source_event_id,
        rolled_back_payload.len(),
    );
    {
        let tx = conn.transaction().expect("failed Shell replacement");
        persist_scoped_shell_manifest(
            &tx,
            &mut rolled_back,
            MANAGED_CLI_REPLAY_TARGET_ID,
            session_id,
            "generation-c",
            |_, offset, max_bytes| {
                Ok(bounded_utf8_payload_bytes(
                    &rolled_back_payload,
                    offset,
                    max_bytes,
                ))
            },
        )
        .expect("stage failed Shell replacement");
        tx.rollback().expect("rollback failed Shell replacement");
    }
    let committed_call_id = conn
        .query_row(
            "SELECT call_id FROM imported_replay_shell_manifests
                 WHERE session_id=?1 AND logical_call_id='shell-call-0'",
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .expect("committed manifest after rollback");
    assert_eq!(committed_call_id, changed_state.replay_ref.call_id);
    let after_rollback = read_complete_external_shell(
        &conn,
        session_id,
        &committed_call_id,
        changed_state.bookmark.visible_bytes,
        changed_state.bookmark.visible_through_sequence,
    );
    assert_eq!(
        sha256_hex(after_rollback.as_bytes()),
        sha256_hex(changed_payload.as_bytes())
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM imported_replay_payload_artifacts
                 WHERE generation='generation-c'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("rolled-back artifact count"),
        0
    );

    // Repeated identity replacements stay at one segment for this
    // logical call even though this connection deliberately leaves
    // SQLite foreign_keys at its default OFF.
    let changed_artifact = conn
        .query_row(
            "SELECT source,source_session_id,generation,content_hash,LENGTH(payload)
                 FROM imported_replay_payload_artifacts
                 WHERE generation='generation-b'",
            [],
            |row| {
                Ok(replay::ReplayPayloadArtifactLocator {
                    source_id: row.get(0)?,
                    source_session_id: row.get(1)?,
                    generation: row.get(2)?,
                    content_hash: row.get(3)?,
                    total_bytes: row.get::<_, i64>(4)?.max(0) as u64,
                })
            },
        )
        .expect("changed canonical artifact");
    for iteration in 0..6 {
        let mut replacement = external_shell_payload_event(
            "shell-event-0",
            session_id,
            "shell-call-0",
            source_event_id,
            changed_payload.len(),
        );
        let tx = conn.transaction().expect("repeat manifest replacement");
        publish_external_shell_manifest(
            &tx,
            &mut replacement,
            &[CanonicalExternalShellSegment {
                stream: if iteration % 2 == 0 {
                    ShellReplayStream::Stderr
                } else {
                    ShellReplayStream::Stdout
                },
                artifact: changed_artifact.clone(),
                preview: "changed preview".to_string(),
            }],
        )
        .expect("repeat external Shell replacement");
        tx.commit().expect("commit repeat manifest replacement");
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM imported_replay_shell_segments",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("non-staircase segment count"),
            50
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*)
                     FROM imported_replay_shell_segments AS segment
                     JOIN imported_replay_shell_manifests AS manifest
                       ON manifest.session_id=segment.session_id
                      AND manifest.call_id=segment.call_id
                     WHERE manifest.session_id=?1
                       AND manifest.logical_call_id='shell-call-0'",
                [session_id],
                |row| row.get::<_, i64>(0),
            )
            .expect("single live logical-call segment"),
            1
        );
    }
}

#[test]
fn external_shell_artifact_cleanup_does_not_use_correlated_reference_scans() {
    use orgtrack_core::store::sqlite::SqliteRecordStore;

    let conn = Connection::open_in_memory().expect("open cleanup query-plan DB");
    SqliteRecordStore::init_tables(&conn).expect("initialize replay schema");
    SqliteRecordStore::init_source_cache_tables(&conn).expect("initialize source cache schema");

    let mut statement = conn
        .prepare(&format!(
            "EXPLAIN QUERY PLAN {DELETE_UNREFERENCED_PAYLOAD_ARTIFACTS_SQL}"
        ))
        .expect("prepare cleanup query plan");
    let details = statement
        .query_map(params!["codex_app", "session", "generation"], |row| {
            row.get::<_, String>(3)
        })
        .expect("query cleanup plan")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("read cleanup query plan");

    assert!(
        details.iter().all(|detail| !detail.contains("CORRELATED")),
        "cleanup must build each referenced-hash set once instead of rescanning it per artifact: {details:?}"
    );
}
