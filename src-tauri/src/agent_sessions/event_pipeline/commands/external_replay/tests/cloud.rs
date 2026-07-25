use super::*;

#[test]
fn cloud_spool_batch_is_byte_bounded_and_prefix_addressable() {
    let token = format!("test-{}", uuid::Uuid::new_v4());
    let path = std::env::temp_dir().join(format!("orgii-cloud-spool-{token}.sqlite"));
    let conn = rusqlite::Connection::open(&path).expect("spool db");
    conn.execute_batch(
        "CREATE TABLE events (
                event_index INTEGER PRIMARY KEY,
                event_hash TEXT NOT NULL,
                frozen_chain_hash TEXT NOT NULL
             );
             CREATE TABLE frozen_segments (
                segment_index INTEGER PRIMARY KEY,
                event_index INTEGER NOT NULL,
                payload_gz TEXT NOT NULL,
                event_count INTEGER NOT NULL,
                segment_hash TEXT NOT NULL,
                wire_bytes INTEGER NOT NULL
             );
             CREATE TABLE tail_segment (
                singleton INTEGER PRIMARY KEY,
                payload_gz TEXT NOT NULL,
                event_count INTEGER NOT NULL,
                segment_hash TEXT NOT NULL,
                wire_bytes INTEGER NOT NULL
             );",
    )
    .expect("spool schema");
    let events = [
        event("a", "cliagent-test", "one"),
        event("b", "cliagent-test", "two"),
        event("c", "cliagent-test", "three"),
    ];
    let mut first_size = 0_usize;
    for (index, event) in events.iter().enumerate() {
        let (segment, _) = encode_cloud_frozen_event(event, &mut |_, _| {
            panic!("compact event has no deferred payload")
        })
        .expect("encode event segment");
        if index == 0 {
            first_size = segment.wire_bytes as usize;
        }
        conn.execute(
            "INSERT INTO events VALUES (?1, ?2, ?3)",
            rusqlite::params![
                index as i64,
                format!("event-{index}"),
                format!("chain-{index}"),
            ],
        )
        .expect("insert event");
        conn.execute(
            "INSERT INTO frozen_segments VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                index as i64,
                index as i64,
                segment.payload_gz,
                segment.event_count as i64,
                segment.segment_hash,
                segment.wire_bytes as i64,
            ],
        )
        .expect("insert frozen segment");
    }
    conn.execute(
        "INSERT INTO tail_segment VALUES (1, 'tail-payload', 1, 'tail-hash', 12)",
        [],
    )
    .expect("insert tail segment");
    drop(conn);
    let manifest = ExternalReplayCloudManifest {
        token: token.clone(),
        generation: "g1".to_string(),
        total_count: 3,
        frozen_event_count: 3,
        tail_event_count: 0,
        frozen_chain_hash: "chain-2".to_string(),
        tail_hash: None,
    };
    cloud_spools()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(
            token.clone(),
            CloudSpoolEntry {
                path: path.clone(),
                manifest,
                last_used: Instant::now(),
                lease_count: 1,
                owner_released: false,
            },
        );

    let batch =
        read_cloud_spool_batch(&token, 0, 3, None, Some(first_size + 1)).expect("bounded batch");
    assert_eq!(batch.segments.len(), 1);
    assert_eq!(batch.next_event_index, 1);
    assert!(!batch.eof);
    assert!(batch.serialized_bytes <= (first_size + 1) as u64);
    let prefix = cloud_spool_prefix_hash(&token, 2).expect("prefix");
    assert_eq!(prefix.frozen_chain_hash, "chain-1");
    let empty = read_cloud_spool_batch(&token, 3, 3, None, None).expect("empty frozen range");
    assert!(empty.segments.is_empty());
    assert_eq!(empty.next_event_index, 3);
    assert!(empty.eof);

    release_cloud_spool(&token).expect("release spool");
    assert!(!path.exists());
}

#[test]
fn cloud_spool_release_waits_for_in_flight_read_lease() {
    let token = format!("test-lease-{}", uuid::Uuid::new_v4());
    let path = std::env::temp_dir().join(format!("orgii-cloud-spool-{token}.sqlite"));
    fs::write(&path, b"leased").expect("leased spool file");
    cloud_spools()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(
            token.clone(),
            CloudSpoolEntry {
                path: path.clone(),
                manifest: ExternalReplayCloudManifest {
                    token: token.clone(),
                    generation: "g-lease".to_string(),
                    total_count: 0,
                    frozen_event_count: 0,
                    tail_event_count: 0,
                    frozen_chain_hash: sha256_hex(b""),
                    tail_hash: None,
                },
                last_used: Instant::now(),
                lease_count: 1,
                owner_released: false,
            },
        );

    let read_lease = acquire_cloud_spool_read(&token).expect("acquire read lease");
    release_cloud_spool(&token).expect("release owner lease");
    assert!(path.exists(), "active read must keep the spool file alive");
    assert!(acquire_cloud_spool_read(&token).is_err());

    drop(read_lease);
    assert!(!path.exists(), "last reader removes the released spool");
}

#[test]
fn nine_live_cloud_spools_are_not_lru_evicted() {
    let mut entries = Vec::new();
    for index in 0..9 {
        let token = format!("test-nine-{index}-{}", uuid::Uuid::new_v4());
        let path = std::env::temp_dir().join(format!("orgii-cloud-spool-{token}.sqlite"));
        fs::write(&path, b"live").expect("live spool file");
        cloud_spools()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                token.clone(),
                CloudSpoolEntry {
                    path: path.clone(),
                    manifest: ExternalReplayCloudManifest {
                        token: token.clone(),
                        generation: format!("g-{index}"),
                        total_count: 0,
                        frozen_event_count: 0,
                        tail_event_count: 0,
                        frozen_chain_hash: sha256_hex(b""),
                        tail_hash: None,
                    },
                    last_used: Instant::now(),
                    lease_count: 1,
                    owner_released: false,
                },
            );
        entries.push((token, path));
    }

    cleanup_cloud_spools();

    for (token, path) in &entries {
        assert!(path.exists(), "live spool {token} was evicted");
        drop(acquire_cloud_spool_read(token).expect("live token remains readable"));
    }
    for (token, path) in entries {
        release_cloud_spool(&token).expect("release live spool");
        assert!(!path.exists());
    }
}

#[test]
fn cloud_spool_physical_cursor_advances_across_zero_event_v2_parts() {
    let token = format!("test-v2-{}", uuid::Uuid::new_v4());
    let path = std::env::temp_dir().join(format!("orgii-cloud-spool-{token}.sqlite"));
    let conn = rusqlite::Connection::open(&path).expect("V2 spool db");
    conn.execute_batch(
        "CREATE TABLE events (
                event_index INTEGER PRIMARY KEY,
                event_hash TEXT NOT NULL,
                frozen_chain_hash TEXT NOT NULL
             );
             CREATE TABLE frozen_segments (
                segment_index INTEGER PRIMARY KEY,
                event_index INTEGER NOT NULL,
                payload_gz TEXT NOT NULL,
                event_count INTEGER NOT NULL,
                segment_hash TEXT NOT NULL,
                wire_bytes INTEGER NOT NULL
             );
             CREATE TABLE tail_segment (
                singleton INTEGER PRIMARY KEY,
                payload_gz TEXT NOT NULL,
                event_count INTEGER NOT NULL,
                segment_hash TEXT NOT NULL,
                wire_bytes INTEGER NOT NULL
             );",
    )
    .expect("V2 spool schema");
    let attachment_id = sha256_hex(b"event-v2");
    let attachment_hash = sha256_hex(b"abcdef");
    let first = encode_cloud_attachment_frame(
        &CloudAttachmentFrameHeader {
            kind: "event".to_string(),
            attachment_id: attachment_id.clone(),
            part_index: 0,
            chunk_offset: 0,
            chunk_bytes: 3,
            final_part: false,
            event_bytes: None,
            attachment_hash: None,
        },
        b"abc",
        0,
    )
    .expect("first V2 row");
    let final_segment = encode_cloud_attachment_frame(
        &CloudAttachmentFrameHeader {
            kind: "event".to_string(),
            attachment_id: attachment_id.clone(),
            part_index: 1,
            chunk_offset: 3,
            chunk_bytes: 3,
            final_part: true,
            event_bytes: Some(6),
            attachment_hash: Some(attachment_hash.clone()),
        },
        b"def",
        1,
    )
    .expect("final V2 row");
    for (segment_index, segment) in [first.clone(), final_segment].into_iter().enumerate() {
        conn.execute(
            "INSERT INTO frozen_segments VALUES (?1, 0, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                segment_index as i64,
                segment.payload_gz,
                segment.event_count as i64,
                segment.segment_hash,
                segment.wire_bytes as i64,
            ],
        )
        .expect("insert V2 physical row");
    }
    conn.execute("INSERT INTO events VALUES (0, ?1, ?1)", [&attachment_hash])
        .expect("insert V2 logical event");
    drop(conn);
    cloud_spools()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(
            token.clone(),
            CloudSpoolEntry {
                path: path.clone(),
                manifest: ExternalReplayCloudManifest {
                    token: token.clone(),
                    generation: "g-v2".to_string(),
                    total_count: 1,
                    frozen_event_count: 1,
                    tail_event_count: 0,
                    frozen_chain_hash: attachment_hash,
                    tail_hash: None,
                },
                last_used: Instant::now(),
                lease_count: 1,
                owner_released: false,
            },
        );

    let first_batch = read_cloud_spool_batch(&token, 0, 1, None, Some(first.wire_bytes as usize))
        .expect("first V2 physical batch");
    assert_eq!(first_batch.segments.len(), 1);
    assert_eq!(first_batch.next_event_index, 0);
    assert_eq!(first_batch.next_segment_index, 1);
    assert!(!first_batch.eof);
    let final_batch =
        read_cloud_spool_batch(&token, 0, 1, Some(1), None).expect("final V2 physical batch");
    assert_eq!(final_batch.next_event_index, 1);
    assert_eq!(final_batch.next_segment_index, 2);
    assert!(final_batch.eof);

    release_cloud_spool(&token).expect("release V2 spool");
}

#[test]
fn ten_mib_single_event_is_streamed_into_one_bounded_lossless_cloud_wire() {
    let total = 10 * 1024 * 1024;
    let mut replay_event = event("large", "cliagent-test", "preview");
    replay_event.result = serde_json::json!({"content":"preview"});
    replay_event.display_text = "preview".to_string();
    replay_event.payload_refs = vec![PayloadRef {
        event_id: replay_event.id.clone(),
        field_path: "result.content".to_string(),
        preview: "preview".to_string(),
        full_size_bytes: total,
        truncated: true,
        replay_encoding: Some(PayloadRefEncoding::Utf8Text),
        replay_source_id: Some("codex_app".to_string()),
        replay_generation: Some("g1".to_string()),
        replay_source_event_id: Some("source-large".to_string()),
    }];
    let mut largest_range = 0_usize;
    let (segment, _) = encode_cloud_frozen_event(&replay_event, &mut |_, offset| {
        let start = offset as usize;
        let bytes = total.saturating_sub(start).min(EXPORT_PAYLOAD_RANGE_BYTES);
        largest_range = largest_range.max(bytes);
        Ok(ReplayPayloadRange {
            event_id: "source-large".to_string(),
            field_path: "result.content".to_string(),
            offset,
            text: "x".repeat(bytes),
            next_offset: offset.saturating_add(bytes as u64),
            eof: start.saturating_add(bytes) >= total,
            total_bytes: total as u64,
        })
    })
    .expect("compressible large event wire");
    assert!(largest_range <= EXPORT_PAYLOAD_RANGE_BYTES);
    assert!(segment.wire_bytes <= CLOUD_SEGMENT_WIRE_MAX_BYTES as u64);

    let compressed = BASE64_STANDARD
        .decode(segment.payload_gz)
        .expect("base64 segment");
    let mut decoded = String::new();
    GzDecoder::new(compressed.as_slice())
        .read_to_string(&mut decoded)
        .expect("gzip segment");
    let value: serde_json::Value = serde_json::from_str(&decoded).expect("segment JSON");
    assert_eq!(
        value[0]["result"]["content"]
            .as_str()
            .expect("full result")
            .len(),
        total
    );
}

#[test]
fn replay_attachment_v2_frame_matches_the_published_golden_hash() {
    let attachment_id = sha256_hex(b"golden");
    let attachment_hash = sha256_hex(b"abc");
    let header = CloudAttachmentFrameHeader {
        kind: "event".to_string(),
        attachment_id,
        part_index: 0,
        chunk_offset: 0,
        chunk_bytes: 3,
        final_part: true,
        event_bytes: Some(3),
        attachment_hash: Some(attachment_hash),
    };
    let segment = encode_cloud_attachment_frame(&header, b"abc", 1).expect("golden frame");
    assert_eq!(
        segment.segment_hash,
        "1cf7b415e8558ddb0d72bcf9212ff381c9a57bfd719628824a61e4a67bcf3126"
    );
}

#[test]
fn ten_mib_high_entropy_event_round_trips_through_bounded_v2_rows() {
    let total = 10 * 1024 * 1024;
    let mut replay_event = event("random", "cliagent-test", "preview");
    replay_event.result = serde_json::json!({"content":"preview"});
    replay_event.payload_refs = vec![PayloadRef {
        event_id: replay_event.id.clone(),
        field_path: "result.content".to_string(),
        preview: "preview".to_string(),
        full_size_bytes: total,
        truncated: true,
        replay_encoding: Some(PayloadRefEncoding::Utf8Text),
        replay_source_id: Some("codex_app".to_string()),
        replay_generation: Some("g1".to_string()),
        replay_source_event_id: Some("source-random".to_string()),
    }];
    let mut largest_range = 0_usize;
    let mut segments = Vec::new();
    let event_hash = encode_cloud_event_segments(
        &replay_event,
        &mut |_, offset| {
            let start = offset as usize;
            let bytes = total.saturating_sub(start).min(EXPORT_PAYLOAD_RANGE_BYTES);
            largest_range = largest_range.max(bytes);
            let text = (start..start + bytes)
                .map(|index| {
                    let mut value = index as u64 + 0x9e37_79b9_7f4a_7c15;
                    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
                    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
                    let alphabet =
                        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
                    alphabet[(value ^ (value >> 31)) as usize % alphabet.len()] as char
                })
                .collect::<String>();
            Ok(ReplayPayloadRange {
                event_id: "source-random".to_string(),
                field_path: "result.content".to_string(),
                offset,
                text,
                next_offset: offset.saturating_add(bytes as u64),
                eof: start.saturating_add(bytes) >= total,
                total_bytes: total as u64,
            })
        },
        &mut |segment| {
            segments.push(segment);
            Ok(())
        },
    )
    .expect("V2 attachment rows");

    assert!(largest_range <= EXPORT_PAYLOAD_RANGE_BYTES);
    assert!(segments.len() > 2);
    assert_eq!(
        segments
            .iter()
            .map(|segment| segment.event_count)
            .sum::<u64>(),
        1
    );
    let mut hydrated_event = Vec::new();
    for (part_index, segment) in segments.iter().enumerate() {
        assert!(segment.wire_bytes <= CLOUD_SEGMENT_WIRE_MAX_BYTES as u64);
        let compressed = BASE64_STANDARD
            .decode(&segment.payload_gz)
            .expect("base64 V2 frame");
        let mut frame = Vec::new();
        GzDecoder::new(compressed.as_slice())
            .read_to_end(&mut frame)
            .expect("gzip V2 frame");
        assert_eq!(sha256_hex(&frame), segment.segment_hash);
        assert!(frame.starts_with(CLOUD_ATTACHMENT_V2_MAGIC));
        let header_offset = CLOUD_ATTACHMENT_V2_MAGIC.len();
        let header_len = u32::from_be_bytes(
            frame[header_offset..header_offset + 4]
                .try_into()
                .expect("V2 header length"),
        ) as usize;
        let payload_offset = header_offset + 4 + header_len;
        let header: serde_json::Value =
            serde_json::from_slice(&frame[header_offset + 4..payload_offset])
                .expect("V2 header JSON");
        assert_eq!(header["partIndex"].as_u64(), Some(part_index as u64));
        assert_eq!(
            header["chunkOffset"].as_u64(),
            Some(hydrated_event.len() as u64)
        );
        let final_part = part_index + 1 == segments.len();
        assert_eq!(header["finalPart"].as_bool(), Some(final_part));
        assert_eq!(segment.event_count, u64::from(final_part));
        hydrated_event.extend_from_slice(&frame[payload_offset..]);
        if final_part {
            assert_eq!(
                header["eventBytes"].as_u64(),
                Some(hydrated_event.len() as u64)
            );
            assert_eq!(header["attachmentHash"].as_str(), Some(event_hash.as_str()));
        }
    }
    assert_eq!(sha256_hex(&hydrated_event), event_hash);
    let value: serde_json::Value =
        serde_json::from_slice(&hydrated_event).expect("hydrated event JSON");
    assert_eq!(
        value["result"]["content"]
            .as_str()
            .expect("full V2 result")
            .len(),
        total
    );
}
