use super::*;

pub(super) fn cloud_spools() -> &'static Mutex<HashMap<String, CloudSpoolEntry>> {
    static SPOOLS: OnceLock<Mutex<HashMap<String, CloudSpoolEntry>>> = OnceLock::new();
    SPOOLS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Default)]
pub(super) struct BoundedCloudGzipBuffer {
    bytes: Vec<u8>,
}

impl Write for BoundedCloudGzipBuffer {
    fn write(&mut self, input: &[u8]) -> std::io::Result<usize> {
        if self.bytes.len().saturating_add(input.len()) > CLOUD_SEGMENT_GZIP_MAX_BYTES {
            return Err(std::io::Error::other(
                "compressed replay event exceeds the cloud segment wire budget; the current SessionEvent[] RPC has no attachment/continuation type",
            ));
        }
        self.bytes.extend_from_slice(input);
        Ok(input.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub(super) struct CloudSegmentEncoder {
    gzip: GzEncoder<BoundedCloudGzipBuffer>,
    digest: Sha256,
}

impl CloudSegmentEncoder {
    fn new() -> Self {
        Self {
            gzip: GzEncoder::new(BoundedCloudGzipBuffer::default(), Compression::default()),
            digest: Sha256::new(),
        }
    }

    fn finish(self, event_count: u64) -> Result<ExternalReplayCloudSegment, String> {
        let segment_hash = format!("{:x}", self.digest.finalize());
        let compressed = self.gzip.finish().map_err(cloud_segment_write_error)?.bytes;
        let payload_gz = BASE64_STANDARD.encode(compressed);
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct BudgetWire<'a> {
            seq: u64,
            payload_gz: &'a str,
            event_count: u64,
            segment_hash: &'a str,
        }
        let wire_bytes = serde_json::to_vec(&BudgetWire {
            // The spool is reused across orgs/cursors, so reserve the largest
            // possible sequence representation before publication.
            seq: u64::MAX,
            payload_gz: &payload_gz,
            event_count,
            segment_hash: &segment_hash,
        })
        .map_err(|err| format!("measure replay cloud wire segment: {err}"))?
        .len();
        if wire_bytes > CLOUD_SEGMENT_WIRE_MAX_BYTES {
            return Err(format!(
                "Cloud replay cannot represent this event without loss: encoded segment is {wire_bytes} bytes (limit {CLOUD_SEGMENT_WIRE_MAX_BYTES}). The current SessionEvent[] RPC has no attachment/continuation type; upload requires the versioned replay-attachment protocol."
            ));
        }
        Ok(ExternalReplayCloudSegment {
            payload_gz,
            event_count,
            segment_hash,
            wire_bytes: wire_bytes as u64,
        })
    }
}

impl Write for CloudSegmentEncoder {
    fn write(&mut self, input: &[u8]) -> std::io::Result<usize> {
        self.gzip.write_all(input)?;
        self.digest.update(input);
        Ok(input.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.gzip.flush()
    }
}

pub(super) struct DigestingWriter<'a, W: Write> {
    inner: &'a mut W,
    digest: &'a mut Sha256,
}

impl<W: Write> Write for DigestingWriter<'_, W> {
    fn write(&mut self, input: &[u8]) -> std::io::Result<usize> {
        self.inner.write_all(input)?;
        self.digest.update(input);
        Ok(input.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

pub(super) fn cloud_segment_write_error(error: std::io::Error) -> String {
    if error
        .to_string()
        .contains("exceeds the cloud segment wire budget")
    {
        return format!(
            "Cloud replay cannot represent this event without loss: compressed payload exceeds the {CLOUD_SEGMENT_WIRE_MAX_BYTES}-byte wire limit. The current SessionEvent[] RPC has no attachment/continuation type; upload requires the versioned replay-attachment protocol."
        );
    }
    format!("encode replay cloud segment: {error}")
}

pub(super) fn encode_cloud_frozen_event(
    event: &SessionEvent,
    read_payload: &mut dyn FnMut(&PayloadRef, u64) -> Result<ReplayPayloadRange, String>,
) -> Result<(ExternalReplayCloudSegment, String), String> {
    let mut encoder = CloudSegmentEncoder::new();
    encoder.write_all(b"[").map_err(cloud_segment_write_error)?;
    let mut event_digest = Sha256::new();
    {
        let mut event_writer = DigestingWriter {
            inner: &mut encoder,
            digest: &mut event_digest,
        };
        write_hydrated_event_json(&mut event_writer, event, read_payload)?;
    }
    encoder.write_all(b"]").map_err(cloud_segment_write_error)?;
    Ok((encoder.finish(1)?, format!("{:x}", event_digest.finalize())))
}

pub(super) fn encode_cloud_attachment_frame(
    header: &CloudAttachmentFrameHeader,
    chunk: &[u8],
    event_count: u64,
) -> Result<ExternalReplayCloudSegment, String> {
    let frame = encode_replay_attachment_v2_frame(header, chunk)?;
    let mut encoder = CloudSegmentEncoder::new();
    encoder
        .write_all(&frame)
        .map_err(cloud_segment_write_error)?;
    encoder.finish(event_count)
}

pub(super) struct StreamingCloudAttachmentEncoder<'a> {
    attachment_id: String,
    chunk: Vec<u8>,
    part_index: u64,
    total_bytes: u64,
    digest: Sha256,
    emit: &'a mut dyn FnMut(ExternalReplayCloudSegment) -> Result<(), String>,
}

impl<'a> StreamingCloudAttachmentEncoder<'a> {
    fn new(
        event_id: &str,
        emit: &'a mut dyn FnMut(ExternalReplayCloudSegment) -> Result<(), String>,
    ) -> Self {
        Self {
            attachment_id: sha256_hex(event_id.as_bytes()),
            chunk: Vec::with_capacity(CLOUD_ATTACHMENT_CHUNK_BYTES),
            part_index: 0,
            total_bytes: 0,
            digest: Sha256::new(),
            emit,
        }
    }

    fn emit_chunk(&mut self, final_part: bool) -> Result<(), String> {
        if self.chunk.is_empty() {
            return Err("Replay attachment V2 cannot emit an empty part".to_string());
        }
        let chunk_bytes = self.chunk.len() as u64;
        let chunk_offset = self.total_bytes.saturating_sub(chunk_bytes);
        let attachment_hash = final_part.then(|| format!("{:x}", self.digest.clone().finalize()));
        let header = CloudAttachmentFrameHeader {
            kind: "event".to_string(),
            attachment_id: self.attachment_id.clone(),
            part_index: self.part_index,
            chunk_offset,
            chunk_bytes,
            final_part,
            event_bytes: final_part.then_some(self.total_bytes),
            attachment_hash,
        };
        let segment =
            encode_cloud_attachment_frame(&header, &self.chunk, if final_part { 1 } else { 0 })?;
        (self.emit)(segment)?;
        self.part_index = self.part_index.saturating_add(1);
        self.chunk.clear();
        Ok(())
    }

    fn finish(mut self) -> Result<String, String> {
        self.emit_chunk(true)?;
        Ok(format!("{:x}", self.digest.finalize()))
    }
}

impl Write for StreamingCloudAttachmentEncoder<'_> {
    fn write(&mut self, mut input: &[u8]) -> std::io::Result<usize> {
        let input_len = input.len();
        while !input.is_empty() {
            if self.chunk.len() == CLOUD_ATTACHMENT_CHUNK_BYTES {
                self.emit_chunk(false).map_err(std::io::Error::other)?;
            }
            let available = CLOUD_ATTACHMENT_CHUNK_BYTES.saturating_sub(self.chunk.len());
            let take = available.min(input.len());
            let bytes = &input[..take];
            self.chunk.extend_from_slice(bytes);
            self.digest.update(bytes);
            self.total_bytes = self.total_bytes.saturating_add(take as u64);
            input = &input[take..];
        }
        Ok(input_len)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub(super) fn is_cloud_segment_budget_error(error: &str) -> bool {
    error.contains("cloud segment wire budget")
        || error.contains("cannot represent this event without loss")
        || error.contains("compressed payload exceeds")
}

pub(super) fn encode_cloud_event_segments(
    event: &SessionEvent,
    read_payload: &mut dyn FnMut(&PayloadRef, u64) -> Result<ReplayPayloadRange, String>,
    emit: &mut dyn FnMut(ExternalReplayCloudSegment) -> Result<(), String>,
) -> Result<String, String> {
    match encode_cloud_frozen_event(event, read_payload) {
        Ok((segment, event_hash)) => {
            emit(segment)?;
            Ok(event_hash)
        }
        Err(error) if is_cloud_segment_budget_error(&error) => {
            let mut encoder = StreamingCloudAttachmentEncoder::new(&event.id, emit);
            write_hydrated_event_json(&mut encoder, event, read_payload)?;
            encoder.finish()
        }
        Err(error) => Err(error),
    }
}

pub(super) fn prepare_cloud_spool(
    source_id: &str,
    session_id: &str,
) -> Result<ExternalReplayCloudManifest, String> {
    cleanup_cloud_spools();
    let token = uuid::Uuid::new_v4().to_string();
    let final_path = std::env::temp_dir().join(format!("orgii-replay-cloud-{token}.sqlite"));
    let partial_path = final_path.with_extension("sqlite-part");
    let prepared = (|| {
        let mut spool = rusqlite::Connection::open(&partial_path)
            .map_err(|err| format!("create replay cloud spool: {err}"))?;
        spool
            .execute_batch(
                "PRAGMA journal_mode=OFF;
                 PRAGMA synchronous=OFF;
                 CREATE TABLE events (
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
                 CREATE INDEX frozen_segments_event_idx
                    ON frozen_segments(event_index, segment_index);
                 CREATE TABLE tail_segment (
                    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                    payload_gz TEXT NOT NULL,
                    event_count INTEGER NOT NULL,
                    segment_hash TEXT NOT NULL,
                    wire_bytes INTEGER NOT NULL
                 );",
            )
            .map_err(|err| format!("initialize replay cloud spool: {err}"))?;
        let tx = spool
            .transaction()
            .map_err(|err| format!("start replay cloud spool transaction: {err}"))?;
        let mut total_count = 0_u64;
        let mut frozen_event_count = 0_u64;
        let mut frozen_segment_count = 0_u64;
        let mut frozen_chain = Sha256::new();
        let generation =
            stream_replay_cloud_events(source_id, session_id, |event, read_payload| {
                let event_index = total_count;
                let mut emit = |segment: ExternalReplayCloudSegment| {
                    tx.execute(
                        "INSERT INTO frozen_segments (
                            segment_index, event_index, payload_gz, event_count,
                            segment_hash, wire_bytes
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        rusqlite::params![
                            frozen_segment_count as i64,
                            event_index as i64,
                            segment.payload_gz,
                            segment.event_count as i64,
                            segment.segment_hash,
                            segment.wire_bytes as i64,
                        ],
                    )
                    .map_err(|err| format!("write replay cloud frozen segment: {err}"))?;
                    frozen_segment_count = frozen_segment_count.saturating_add(1);
                    Ok(())
                };
                let event_hash = encode_cloud_event_segments(event, read_payload, &mut emit)?;
                if frozen_event_count > 0 {
                    frozen_chain.update(b"\n");
                }
                frozen_chain.update(event_hash.as_bytes());
                let chain_hash = format!("{:x}", frozen_chain.clone().finalize());
                tx.execute(
                    "INSERT INTO events (event_index, event_hash, frozen_chain_hash)
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![event_index as i64, event_hash, chain_hash],
                )
                .map_err(|err| format!("write replay cloud event hash: {err}"))?;
                // External source events are immutable within one generation.
                // Publishing all of them as a frozen prefix lets oversized
                // V2 events use continuation rows; an in-place source change
                // changes the logical prefix hash and forces an epoch rewrite.
                frozen_event_count = frozen_event_count.saturating_add(1);
                total_count = total_count.saturating_add(1);
                Ok(())
            })?;
        tx.commit()
            .map_err(|err| format!("commit replay cloud spool: {err}"))?;
        drop(spool);
        fs::rename(&partial_path, &final_path)
            .map_err(|err| format!("publish replay cloud spool: {err}"))?;
        Ok::<_, String>(ExternalReplayCloudManifest {
            token: token.clone(),
            generation,
            total_count,
            frozen_event_count,
            tail_event_count: 0,
            frozen_chain_hash: format!("{:x}", frozen_chain.finalize()),
            tail_hash: None,
        })
    })();
    let manifest = match prepared {
        Ok(manifest) => manifest,
        Err(error) => {
            let _ = fs::remove_file(&partial_path);
            let _ = fs::remove_file(&final_path);
            return Err(error);
        }
    };
    cloud_spools()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(
            token,
            CloudSpoolEntry {
                path: final_path,
                manifest: manifest.clone(),
                last_used: Instant::now(),
                lease_count: 1,
                owner_released: false,
            },
        );
    Ok(manifest)
}

pub(super) fn read_cloud_spool_batch(
    token: &str,
    start_event_index: u64,
    end_event_index: u64,
    start_segment_index: Option<u64>,
    max_bytes: Option<usize>,
) -> Result<ExternalReplayCloudBatch, String> {
    let entry = acquire_cloud_spool_read(token)?;
    let end = end_event_index.min(entry.manifest.total_count);
    if start_event_index > end {
        return Err("Replay cloud batch range is reversed".to_string());
    }
    if start_event_index == end {
        return Ok(ExternalReplayCloudBatch {
            segments: Vec::new(),
            start_event_index,
            next_event_index: start_event_index,
            start_segment_index: start_segment_index.unwrap_or(0),
            next_segment_index: start_segment_index.unwrap_or(0),
            eof: true,
            serialized_bytes: 0,
        });
    }
    let byte_limit = max_bytes
        .unwrap_or(STREAM_BATCH_MAX_BYTES)
        .clamp(1, CLOUD_SEGMENT_WIRE_MAX_BYTES);
    let conn = rusqlite::Connection::open_with_flags(
        &entry.path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|err| format!("open replay cloud spool: {err}"))?;
    let reading_tail = start_event_index == entry.manifest.frozen_event_count
        && entry.manifest.tail_event_count > 0;
    let resolved_segment_index = if let Some(index) = start_segment_index {
        index
    } else if reading_tail {
        0
    } else {
        conn.query_row(
            "SELECT MIN(segment_index) FROM frozen_segments
             WHERE event_index >= ?1 AND event_index < ?2",
            rusqlite::params![
                start_event_index.min(i64::MAX as u64) as i64,
                end.min(i64::MAX as u64) as i64,
            ],
            |row| row.get::<_, Option<i64>>(0),
        )
        .map_err(|err| format!("locate replay cloud physical cursor: {err}"))?
        .ok_or_else(|| "Replay cloud spool has no segment for the requested event".to_string())?
        .max(0) as u64
    };
    let (query, start, limit) = if reading_tail {
        (
            "SELECT ?1, payload_gz, event_count, segment_hash, wire_bytes
             FROM tail_segment WHERE singleton = 1",
            resolved_segment_index.min(i64::MAX as u64) as i64,
            1_i64,
        )
    } else {
        (
            "SELECT segment_index, payload_gz, event_count, segment_hash, wire_bytes
             FROM frozen_segments
             WHERE segment_index >= ?1 AND event_index >= ?2 AND event_index < ?3
             ORDER BY segment_index ASC LIMIT ?4",
            resolved_segment_index.min(i64::MAX as u64) as i64,
            STREAM_BATCH_MAX_EVENTS as i64,
        )
    };
    let mut stmt = conn
        .prepare(query)
        .map_err(|err| format!("prepare replay cloud batch: {err}"))?;
    let mut rows = if reading_tail {
        stmt.query([start])
    } else {
        stmt.query(rusqlite::params![
            start,
            start_event_index.min(i64::MAX as u64) as i64,
            end.min(i64::MAX as u64) as i64,
            limit,
        ])
    }
    .map_err(|err| format!("query replay cloud batch: {err}"))?;
    let mut segments = Vec::new();
    let mut serialized_bytes = 0_usize;
    let mut consumed_events = 0_u64;
    let mut next_segment_index = resolved_segment_index;
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("read replay cloud batch row: {err}"))?
    {
        let row_bytes = row.get::<_, i64>(4).unwrap_or_default().max(0) as usize;
        if !segments.is_empty() && serialized_bytes.saturating_add(row_bytes) > byte_limit {
            break;
        }
        if row_bytes > CLOUD_SEGMENT_WIRE_MAX_BYTES {
            return Err("Replay cloud spool contains an over-budget wire segment".to_string());
        }
        let physical_index = row.get::<_, i64>(0).unwrap_or_default().max(0) as u64;
        let event_count = row.get::<_, i64>(2).unwrap_or_default().max(0) as u64;
        segments.push(ExternalReplayCloudSegment {
            payload_gz: row.get(1).map_err(|err| err.to_string())?,
            event_count,
            segment_hash: row.get(3).map_err(|err| err.to_string())?,
            wire_bytes: row_bytes as u64,
        });
        serialized_bytes = serialized_bytes.saturating_add(row_bytes);
        consumed_events = consumed_events.saturating_add(event_count);
        next_segment_index = physical_index.saturating_add(1);
    }
    if segments.is_empty() {
        return Err("Replay cloud physical batch cursor did not resolve a segment".to_string());
    }
    let next_event_index = start_event_index.saturating_add(consumed_events).min(end);
    Ok(ExternalReplayCloudBatch {
        segments,
        start_event_index,
        next_event_index,
        start_segment_index: resolved_segment_index,
        next_segment_index,
        eof: next_event_index >= end,
        serialized_bytes: serialized_bytes as u64,
    })
}

pub(super) fn cloud_spool_prefix_hash(
    token: &str,
    event_count: u64,
) -> Result<ExternalReplayCloudPrefixHash, String> {
    let entry = acquire_cloud_spool_read(token)?;
    if event_count > entry.manifest.frozen_event_count {
        return Err("Requested prefix crosses the replay mutable tail".to_string());
    }
    let frozen_chain_hash = if event_count == 0 {
        sha256_hex(b"")
    } else {
        let conn = rusqlite::Connection::open_with_flags(
            &entry.path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|err| format!("open replay cloud spool: {err}"))?;
        conn.query_row(
            "SELECT frozen_chain_hash FROM events WHERE event_index=?1",
            [event_count.saturating_sub(1).min(i64::MAX as u64) as i64],
            |row| row.get(0),
        )
        .map_err(|err| format!("read replay cloud prefix hash: {err}"))?
    };
    Ok(ExternalReplayCloudPrefixHash {
        event_count,
        frozen_chain_hash,
    })
}

pub(super) fn acquire_cloud_spool_read(token: &str) -> Result<CloudSpoolReadLease, String> {
    let mut spools = cloud_spools()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let entry = spools
        .get_mut(token)
        .ok_or_else(|| "Replay cloud spool expired; prepare it again".to_string())?;
    if entry.owner_released {
        return Err("Replay cloud spool was released; prepare it again".to_string());
    }
    entry.last_used = Instant::now();
    entry.lease_count = entry.lease_count.saturating_add(1);
    Ok(CloudSpoolReadLease {
        token: token.to_string(),
        path: entry.path.clone(),
        manifest: entry.manifest.clone(),
    })
}

pub(super) fn release_cloud_spool(token: &str) -> Result<(), String> {
    let path = {
        let mut spools = cloud_spools()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(entry) = spools.get_mut(token) else {
            return Ok(());
        };
        if entry.owner_released {
            return Ok(());
        }
        entry.owner_released = true;
        entry.lease_count = entry.lease_count.saturating_sub(1);
        if entry.lease_count == 0 {
            spools.remove(token).map(|entry| entry.path)
        } else {
            None
        }
    };
    if let Some(path) = path {
        remove_cloud_spool_file(&path)?;
    }
    Ok(())
}

pub(super) fn release_cloud_spool_read_lease(token: &str) {
    let path = {
        let mut spools = cloud_spools()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(entry) = spools.get_mut(token) else {
            return;
        };
        entry.lease_count = entry.lease_count.saturating_sub(1);
        if entry.owner_released && entry.lease_count == 0 {
            spools.remove(token).map(|entry| entry.path)
        } else {
            None
        }
    };
    if let Some(path) = path {
        if let Err(error) = remove_cloud_spool_file(&path) {
            log::warn!("[external-replay] {error}");
        }
    }
}

pub(super) fn remove_cloud_spool_file(path: &PathBuf) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("remove replay cloud spool: {err}")),
    }
}

pub(super) fn cleanup_cloud_spools() {
    let paths = {
        let mut spools = cloud_spools()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        let expired = spools
            .iter()
            .filter(|(_, entry)| {
                // `lease_count == 1` is the renderer's idle owner lease. An
                // in-flight reader raises it above one and must never be
                // evicted merely because another session prepared a spool.
                !entry.owner_released
                    && entry.lease_count == 1
                    && now.duration_since(entry.last_used) >= CLOUD_SPOOL_TTL
            })
            .map(|(token, _)| token.clone())
            .collect::<Vec<_>>();
        expired
            .into_iter()
            .filter_map(|token| spools.remove(&token).map(|entry| entry.path))
            .collect::<Vec<_>>()
    };
    for path in paths {
        if let Err(error) = remove_cloud_spool_file(&path) {
            log::warn!("[external-replay] {error}");
        }
    }
}

#[cfg(test)]
pub(super) fn write_stable_json(
    writer: &mut impl Write,
    value: &serde_json::Value,
) -> Result<(), String> {
    match value {
        serde_json::Value::Object(object) => {
            writer.write_all(b"{").map_err(|err| err.to_string())?;
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    writer.write_all(b",").map_err(|err| err.to_string())?;
                }
                serde_json::to_writer(&mut *writer, key).map_err(|err| err.to_string())?;
                writer.write_all(b":").map_err(|err| err.to_string())?;
                write_stable_json(writer, &object[key])?;
            }
            writer.write_all(b"}").map_err(|err| err.to_string())?;
        }
        serde_json::Value::Array(array) => {
            writer.write_all(b"[").map_err(|err| err.to_string())?;
            for (index, item) in array.iter().enumerate() {
                if index > 0 {
                    writer.write_all(b",").map_err(|err| err.to_string())?;
                }
                write_stable_json(writer, item)?;
            }
            writer.write_all(b"]").map_err(|err| err.to_string())?;
        }
        primitive => {
            serde_json::to_writer(writer, primitive).map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn stream_replay_cloud_events(
    source_id: &str,
    session_id: &str,
    mut consume: impl FnMut(
        &SessionEvent,
        &mut dyn FnMut(&PayloadRef, u64) -> Result<ReplayPayloadRange, String>,
    ) -> Result<(), String>,
) -> Result<String, String> {
    match resolve_secondary_consumer_target(source_id, session_id)? {
        ResolvedReplayTarget::Imported {
            source,
            imported_session_id,
        } => {
            let limits = ReplayLimits {
                max_turns: 10,
                max_events: STREAM_BATCH_MAX_EVENTS,
                max_ipc_bytes: STREAM_BATCH_MAX_BYTES,
            };
            let prepared =
                prepare_sessions_stream_replay_snapshot(source, &imported_session_id, limits)?;
            let expected_generation = prepared.generation;
            let expected_revision = prepared.revision;
            let mut payload_conn = database::db::get_connection()
                .map_err(|err| format!("open replay stream payload DB: {err}"))?;
            let mut after_sequence = -1_i64;
            loop {
                let scan = with_sessions_replay_writer("replay cloud scan", |conn| {
                    replay::scan_window_after_generation(
                        conn,
                        source,
                        &imported_session_id,
                        &expected_generation,
                        expected_revision,
                        after_sequence,
                        limits,
                    )
                })?;
                let next_sequence = scan.cursor.through_sequence;
                let has_more = scan.has_more;
                let (events, _) = normalize_indexed_chunks(
                    scan.chunks,
                    session_id,
                    source.as_str(),
                    &scan.cursor.generation,
                );
                for event in &events {
                    let mut read_payload = |payload_ref: &PayloadRef, offset: u64| {
                        replay::read_payload_range(
                            &mut payload_conn,
                            source,
                            &imported_session_id,
                            &scan.cursor.generation,
                            payload_ref
                                .replay_source_event_id
                                .as_deref()
                                .unwrap_or(&payload_ref.event_id),
                            &payload_ref.field_path,
                            offset,
                            Some(EXPORT_PAYLOAD_RANGE_BYTES),
                        )
                    };
                    consume(event, &mut read_payload)?;
                }
                if !has_more {
                    break;
                }
                if next_sequence <= after_sequence {
                    return Err("Replay stream cursor did not advance".to_string());
                }
                after_sequence = next_sequence;
            }
            let final_scan = with_sessions_replay_writer("replay cloud finalization", |conn| {
                replay::scan_window_after(
                    conn,
                    source,
                    &imported_session_id,
                    after_sequence,
                    ReplayLimits {
                        max_turns: 1,
                        max_events: 1,
                        max_ipc_bytes: STREAM_BATCH_MAX_BYTES,
                    },
                )
            })?;
            validate_stream_replay_cursor(
                &expected_generation,
                expected_revision,
                &final_scan.cursor,
                "finalizing cloud replay",
            )?;
            Ok(expected_generation)
        }
        ResolvedReplayTarget::CollaborationSnapshot => {
            let conn = database::db::get_connection()
                .map_err(|err| format!("open collaboration replay stream DB: {err}"))?;
            let state = collaboration_snapshot_state(&conn, session_id)?;
            let limits = ReplayLimits {
                max_turns: replay::HARD_MAX_TURNS,
                max_events: STREAM_BATCH_MAX_EVENTS,
                max_ipc_bytes: STREAM_BATCH_MAX_BYTES,
            };
            let mut after_sequence = -1_i64;
            loop {
                let indexed = query_collaboration_snapshot_events(
                    &conn,
                    session_id,
                    &state.generation,
                    after_sequence,
                    state.max_sequence.saturating_add(1),
                    limits,
                    false,
                )?;
                if indexed.is_empty() {
                    break;
                }
                let next_sequence = indexed
                    .last()
                    .map_or(after_sequence, |(sequence, _)| *sequence);
                for (_, event) in &indexed {
                    let mut read_payload = |payload_ref: &PayloadRef, offset: u64| {
                        collaboration_snapshot_payload_range_from_conn(
                            &conn,
                            session_id,
                            &state.generation,
                            payload_ref
                                .replay_source_event_id
                                .as_deref()
                                .unwrap_or(&payload_ref.event_id),
                            &payload_ref.field_path,
                            offset,
                            EXPORT_PAYLOAD_RANGE_BYTES,
                        )
                    };
                    consume(event, &mut read_payload)?;
                }
                if next_sequence >= state.max_sequence {
                    break;
                }
                if next_sequence <= after_sequence {
                    return Err("Collaboration replay stream cursor did not advance".to_string());
                }
                after_sequence = next_sequence;
            }
            let current = collaboration_snapshot_state(&conn, session_id)?;
            validate_query_apply_version(
                &state.generation,
                state.revision,
                &current.generation,
                current.revision,
            )?;
            Ok(state.generation)
        }
        ResolvedReplayTarget::ManagedChunkStore => {
            let conn = database::db::get_connection()
                .map_err(|err| format!("open managed replay stream DB: {err}"))?;
            stream_managed_chunk_replay_events_from_conn(
                &conn,
                session_id,
                "streaming managed cloud replay",
                |event, read_payload| consume(event, read_payload),
            )
        }
        ResolvedReplayTarget::NotReady => {
            Err("Managed native transcript is not bound yet".to_string())
        }
    }
}

#[tauri::command]
pub async fn external_replay_cloud_prepare(
    source_id: String,
    session_id: String,
) -> Result<ExternalReplayCloudManifest, String> {
    let manifest =
        tokio::task::spawn_blocking(move || prepare_cloud_spool(&source_id, &session_id))
            .await
            .map_err(|err| format!("join replay cloud prepare task: {err}"))??;
    schedule_replay_cache_prune();
    Ok(manifest)
}

#[tauri::command]
pub async fn external_replay_cloud_read_batch(
    token: String,
    start_event_index: u64,
    end_event_index: u64,
    start_segment_index: Option<u64>,
    max_bytes: Option<usize>,
) -> Result<ExternalReplayCloudBatch, String> {
    tokio::task::spawn_blocking(move || {
        read_cloud_spool_batch(
            &token,
            start_event_index,
            end_event_index,
            start_segment_index,
            max_bytes,
        )
    })
    .await
    .map_err(|err| format!("join replay cloud batch task: {err}"))?
}

#[tauri::command]
pub async fn external_replay_cloud_prefix_hash(
    token: String,
    event_count: u64,
) -> Result<ExternalReplayCloudPrefixHash, String> {
    tokio::task::spawn_blocking(move || cloud_spool_prefix_hash(&token, event_count))
        .await
        .map_err(|err| format!("join replay cloud prefix task: {err}"))?
}

#[tauri::command]
pub async fn external_replay_cloud_release(token: String) -> Result<(), String> {
    release_cloud_spool(&token)
}
