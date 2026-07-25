use super::staging::*;
use super::*;

pub(super) struct DecodedWireFile {
    path: PathBuf,
    bytes: u64,
    hash: String,
    is_v2: bool,
}

pub(super) struct TempFileGuard {
    path: PathBuf,
    armed: bool,
}

impl TempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(mut self) -> PathBuf {
        self.armed = false;
        self.path.clone()
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

impl Drop for DecodedWireFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn decode_wire_to_file(
    root: &Path,
    token: &str,
    wire: &CollaborationSnapshotWire,
) -> Result<DecodedWireFile, String> {
    validate_hash("segmentHash", &wire.segment_hash)?;
    let compressed = BASE64_STANDARD
        .decode(&wire.payload_gz)
        .map_err(|error| format!("segment {} has invalid base64: {error}", wire.seq))?;
    let temp_path = root.join(format!("{token}-wire-{}-{}.tmp", wire.seq, Uuid::new_v4()));
    let temp_guard = TempFileGuard::new(temp_path.clone());
    let file = File::create(&temp_path)
        .map_err(|error| format!("create decoded wire staging file: {error}"))?;
    let mut output = BufWriter::with_capacity(64 * 1024, file);
    let mut decoder = GzDecoder::new(compressed.as_slice());
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut prefix = Vec::with_capacity(FRAME_MAGIC.len());
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = decoder
            .read(&mut buffer)
            .map_err(|error| format!("gunzip segment {}: {error}", wire.seq))?;
        if read == 0 {
            break;
        }
        if prefix.len() < FRAME_MAGIC.len() {
            let remaining = FRAME_MAGIC.len() - prefix.len();
            prefix.extend_from_slice(&buffer[..read.min(remaining)]);
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| "decoded segment byte count overflow".to_string())?;
        // Before the magic is known, use the V1 ceiling. Once the prefix is
        // complete, V2's much smaller physical-frame ceiling applies.
        let is_v2 = prefix.len() == FRAME_MAGIC.len() && prefix == FRAME_MAGIC;
        let limit = if is_v2 {
            MAX_DECOMPRESSED_V2_BYTES
        } else {
            MAX_DECOMPRESSED_V1_BYTES
        };
        if total > limit {
            return Err(format!(
                "decoded segment {} exceeds the {} byte limit",
                wire.seq, limit
            ));
        }
        hasher.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(|error| format!("stage decoded segment {}: {error}", wire.seq))?;
    }
    output
        .flush()
        .map_err(|error| format!("flush decoded segment {}: {error}", wire.seq))?;
    let hash = format!("{:x}", hasher.finalize());
    if hash != wire.segment_hash.to_ascii_lowercase() {
        return Err(format!("segment {} content hash mismatch", wire.seq));
    }
    Ok(DecodedWireFile {
        path: temp_guard.disarm(),
        bytes: total,
        hash,
        is_v2: prefix == FRAME_MAGIC,
    })
}

pub(super) fn stage_cached_event(
    tx: &Transaction<'_>,
    event: SessionEvent,
    local_session_id: &str,
    physical_seq: u64,
    event_index: u64,
    is_tail: bool,
) -> Result<(), String> {
    let original_id = event.id.clone();
    let normalized = normalize_event(event, local_session_id)?;
    let cached = session_event_to_cached_event(&normalized);
    tx.execute(
        "INSERT INTO staged_events(
           normalized_id,original_id,physical_seq,event_index,is_tail,event_type,
           function_name,thread_id,args_json,result_json,content,created_at,meta_json
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            cached.id,
            original_id,
            i64::try_from(physical_seq).map_err(|_| "physical sequence is too large")?,
            i64::try_from(event_index).map_err(|_| "event index is too large")?,
            is_tail,
            cached.event_type,
            cached.function_name,
            cached.thread_id,
            cached.args_json,
            cached.result_json,
            cached.content,
            cached.created_at,
            cached.meta_json,
        ],
    )
    .map_err(|error| format!("stage event {original_id}: {error}"))?;
    Ok(())
}

pub(super) struct StreamingEventArrayVisitor<'a> {
    tx: &'a Transaction<'a>,
    local_session_id: &'a str,
    physical_seq: u64,
    is_tail: bool,
}

impl<'de> Visitor<'de> for StreamingEventArrayVisitor<'_> {
    type Value = u64;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a legacy replay SessionEvent array")
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut count = 0_u64;
        while let Some(event) = sequence.next_element::<SessionEvent>()? {
            stage_cached_event(
                self.tx,
                event,
                self.local_session_id,
                self.physical_seq,
                count,
                self.is_tail,
            )
            .map_err(serde::de::Error::custom)?;
            count += 1;
        }
        Ok(count)
    }
}

pub(super) fn stage_v1_wire(
    tx: &Transaction<'_>,
    decoded: &DecodedWireFile,
    wire: &CollaborationSnapshotWire,
    local_session_id: &str,
) -> Result<(), String> {
    let file = File::open(&decoded.path)
        .map_err(|error| format!("open decoded segment {}: {error}", wire.seq))?;
    let mut deserializer = serde_json::Deserializer::from_reader(BufReader::new(file));
    let count = serde::Deserializer::deserialize_seq(
        &mut deserializer,
        StreamingEventArrayVisitor {
            tx,
            local_session_id,
            physical_seq: wire.seq,
            is_tail: wire.seq == 0,
        },
    )
    .map_err(|error| format!("decode legacy segment {}: {error}", wire.seq))?;
    deserializer
        .end()
        .map_err(|error| format!("legacy segment {} has trailing data: {error}", wire.seq))?;
    if count != wire.event_count {
        return Err(format!(
            "segment {} declared {} events but decoded {count}",
            wire.seq, wire.event_count
        ));
    }
    Ok(())
}

pub(super) fn stage_v2_wire(
    tx: &Transaction<'_>,
    decoded: &DecodedWireFile,
    wire: &CollaborationSnapshotWire,
) -> Result<(), String> {
    if wire.seq == 0 {
        return Err("Replay Attachment V2 cannot be used for the mutable tail".to_string());
    }
    let bytes = fs::read(&decoded.path)
        .map_err(|error| format!("read attachment frame {}: {error}", wire.seq))?;
    let decoded_frame = decode_replay_attachment_v2_frame(&bytes)
        .map_err(|error| format!("attachment frame {} {error}", wire.seq))?;
    let ReplayAttachmentV2FrameHeader {
        attachment_id,
        part_index,
        chunk_offset,
        final_part,
        event_bytes,
        attachment_hash,
        ..
    } = decoded_frame.header;
    let chunk = decoded_frame.chunk;
    if wire.event_count != u64::from(final_part) {
        return Err(format!(
            "attachment frame {} eventCount is inconsistent",
            wire.seq
        ));
    }
    tx.execute(
        "INSERT INTO attachment_parts(
           attachment_id,part_index,physical_seq,chunk_offset,chunk,final_part,
           event_bytes,attachment_hash
        ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            attachment_id,
            i64::try_from(part_index).map_err(|_| "attachment part index too large")?,
            i64::try_from(wire.seq).map_err(|_| "physical sequence too large")?,
            i64::try_from(chunk_offset).map_err(|_| "attachment offset too large")?,
            chunk,
            final_part,
            event_bytes
                .map(i64::try_from)
                .transpose()
                .map_err(|_| "attachment event size too large")?,
            attachment_hash,
        ],
    )
    .map_err(|error| format!("stage attachment frame {}: {error}", wire.seq))?;
    Ok(())
}

pub(super) fn cursor_json(cursor: &CollaborationSnapshotWireCursor) -> Result<String, String> {
    serde_json::to_string(cursor).map_err(|error| format!("serialize wire cursor: {error}"))
}

pub(super) fn validate_page_contract(
    manifest: &StagingManifest,
    request: &CollaborationSnapshotIngestPageRequest,
) -> Result<(), String> {
    if request.epoch != manifest.epoch
        || request.frozen_seq != manifest.expected_frozen_seq
        || request.count != manifest.expected_count
        || request.tail_hash != manifest.expected_tail_hash
    {
        return Err("wire page snapshot summary changed during ingestion".to_string());
    }
    if request.has_more != request.next_cursor.is_some() {
        return Err("wire page hasMore and nextCursor disagree".to_string());
    }
    if request.segments.len() > MAX_PAGE_SEGMENTS {
        return Err(format!(
            "wire page has {} rows (limit {MAX_PAGE_SEGMENTS})",
            request.segments.len()
        ));
    }
    let mut seen_sequences = std::collections::HashSet::new();
    let actual_wire_bytes = request.segments.iter().try_fold(0_usize, |total, wire| {
        if !seen_sequences.insert(wire.seq) {
            return Err(format!("wire page repeats physical seq {}", wire.seq));
        }
        let bytes = serde_json::to_vec(wire)
            .map_err(|error| format!("measure physical wire {}: {error}", wire.seq))?
            .len();
        if bytes > MAX_WIRE_BYTES {
            return Err(format!(
                "physical wire {} is {bytes} bytes (limit {MAX_WIRE_BYTES})",
                wire.seq
            ));
        }
        total
            .checked_add(bytes)
            .ok_or_else(|| "wire page byte count overflow".to_string())
    })?;
    if actual_wire_bytes > MAX_PAGE_BYTES || request.returned_wire_bytes != actual_wire_bytes as u64
    {
        return Err(format!(
            "wire page byte count is {actual_wire_bytes}, reported {} (limit {MAX_PAGE_BYTES})",
            request.returned_wire_bytes
        ));
    }
    if manifest.page_count > 0 {
        let expected = manifest
            .next_cursor_json
            .as_deref()
            .ok_or_else(|| "wire page chain was already complete".to_string())?;
        if cursor_json(&request.cursor)? != expected {
            return Err("wire page cursor does not continue the prior page".to_string());
        }
    }
    match &request.cursor {
        CollaborationSnapshotWireCursor::Forward {
            after_seq,
            through_seq,
        } => {
            if through_seq.is_some_and(|through| through != manifest.expected_frozen_seq) {
                return Err("forward wire cursor changed the frozen high-water mark".to_string());
            }
            for wire in request.segments.iter().filter(|wire| wire.seq > 0) {
                if wire.seq <= *after_seq || through_seq.is_some_and(|through| wire.seq > through) {
                    return Err(format!(
                        "forward page row {} is outside its cursor",
                        wire.seq
                    ));
                }
            }
        }
        CollaborationSnapshotWireCursor::Backward { before_seq } => {
            for wire in request.segments.iter().filter(|wire| wire.seq > 0) {
                if before_seq.is_some_and(|before| wire.seq >= before) {
                    return Err(format!(
                        "backward page row {} is outside its cursor",
                        wire.seq
                    ));
                }
            }
        }
    }
    if request.tail_included != request.segments.iter().any(|wire| wire.seq == 0) {
        return Err("wire page tailIncluded does not match seq 0 presence".to_string());
    }
    if request.tail_included && manifest.expected_tail_hash.is_none() {
        return Err("wire page returned an unpinned mutable tail".to_string());
    }
    if let Some(tail) = request.segments.iter().find(|wire| wire.seq == 0) {
        if Some(tail.segment_hash.as_str()) != manifest.expected_tail_hash.as_deref() {
            return Err("wire page mutable tail hash mismatch".to_string());
        }
    }
    if let Some(next) = request.next_cursor.as_ref() {
        if std::mem::discriminant(next) != std::mem::discriminant(&request.cursor) {
            return Err("wire page continuation changes direction".to_string());
        }
    }
    let mut frozen_sequences = request
        .segments
        .iter()
        .filter_map(|wire| (wire.seq > 0).then_some(wire.seq))
        .collect::<Vec<_>>();
    frozen_sequences.sort_unstable();
    match (&request.cursor, request.next_cursor.as_ref()) {
        (
            CollaborationSnapshotWireCursor::Forward { .. },
            Some(CollaborationSnapshotWireCursor::Forward {
                after_seq,
                through_seq,
            }),
        ) => {
            if frozen_sequences.last().copied() != Some(*after_seq)
                || *through_seq != Some(manifest.expected_frozen_seq)
            {
                return Err(
                    "forward page continuation does not advance to its last row".to_string()
                );
            }
        }
        (
            CollaborationSnapshotWireCursor::Backward { .. },
            Some(CollaborationSnapshotWireCursor::Backward { before_seq }),
        ) => {
            if frozen_sequences.first().copied() != *before_seq {
                return Err(
                    "backward page continuation does not continue before its first row".to_string(),
                );
            }
        }
        (_, None) => {}
        _ => return Err("wire page continuation changes direction".to_string()),
    }
    Ok(())
}

pub(super) fn page_progress(
    conn: &Connection,
    complete: bool,
) -> Result<CollaborationSnapshotIngestProgress, String> {
    let (rows, events): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*),COALESCE(SUM(event_count),0) FROM staged_wires",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("read snapshot ingest progress: {error}"))?;
    Ok(CollaborationSnapshotIngestProgress {
        accepted_physical_rows: rows.max(0) as u64,
        accepted_logical_events: events.max(0) as u64,
        complete,
    })
}

pub(super) fn apply_page_at_root(
    root: &Path,
    request: CollaborationSnapshotIngestPageRequest,
) -> Result<CollaborationSnapshotIngestProgress, String> {
    let path = staging_path(root, &request.token)?;
    let mut conn = open_staging(&path)?;
    let manifest = load_manifest(&conn)?;
    if manifest.token != request.token {
        return Err("snapshot ingest token does not match its manifest".to_string());
    }
    validate_page_contract(&manifest, &request)?;

    let page_cursor_json = cursor_json(&request.cursor)?;
    let next_cursor_json = request.next_cursor.as_ref().map(cursor_json).transpose()?;
    let page_hash = sha256_hex(
        &serde_json::to_vec(&request.segments)
            .map_err(|error| format!("hash wire page: {error}"))?,
    );
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS staged_pages(
           cursor_json TEXT PRIMARY KEY,
           page_hash TEXT NOT NULL,
           next_cursor_json TEXT,
           complete INTEGER NOT NULL
         );",
    )
    .map_err(|error| format!("initialize snapshot page receipts: {error}"))?;
    let prior_page: Option<(String, Option<String>, bool)> = conn
        .query_row(
            "SELECT page_hash,next_cursor_json,complete FROM staged_pages WHERE cursor_json=?1",
            [&page_cursor_json],
            |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)? != 0)),
        )
        .optional()
        .map_err(|error| format!("read snapshot page receipt: {error}"))?;
    if let Some((prior_hash, prior_next, prior_complete)) = prior_page {
        if prior_hash != page_hash
            || prior_next != next_cursor_json
            || prior_complete == request.has_more
        {
            return Err("wire page retry differs from the accepted page".to_string());
        }
        return page_progress(&conn, !request.has_more);
    }

    let tx = conn
        .transaction()
        .map_err(|error| format!("begin snapshot page transaction: {error}"))?;
    for wire in &request.segments {
        let prior: Option<(String, i64)> = tx
            .query_row(
                "SELECT segment_hash,event_count FROM staged_wires WHERE seq=?1",
                [i64::try_from(wire.seq).map_err(|_| "physical sequence is too large")?],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("read staged physical row {}: {error}", wire.seq))?;
        if let Some((hash, count)) = prior {
            if hash == wire.segment_hash && count == wire.event_count as i64 {
                continue;
            }
            return Err(format!(
                "physical row {} changed during ingestion",
                wire.seq
            ));
        }
        let decoded = decode_wire_to_file(root, &request.token, wire)?;
        if decoded.hash != wire.segment_hash.to_ascii_lowercase() || decoded.bytes == 0 {
            return Err(format!(
                "physical row {} decoded to invalid content",
                wire.seq
            ));
        }
        if decoded.is_v2 {
            stage_v2_wire(&tx, &decoded, wire)?;
        } else {
            stage_v1_wire(&tx, &decoded, wire, &manifest.local_session_id)?;
        }
        tx.execute(
            "INSERT INTO staged_wires(seq,segment_hash,event_count,is_tail)
             VALUES(?1,?2,?3,?4)",
            params![
                i64::try_from(wire.seq).map_err(|_| "physical sequence is too large")?,
                wire.segment_hash.to_ascii_lowercase(),
                i64::try_from(wire.event_count).map_err(|_| "event count is too large")?,
                wire.seq == 0,
            ],
        )
        .map_err(|error| format!("record physical row {}: {error}", wire.seq))?;
    }
    tx.execute(
        "INSERT INTO staged_pages(cursor_json,page_hash,next_cursor_json,complete)
         VALUES(?1,?2,?3,?4)",
        params![
            page_cursor_json,
            page_hash,
            next_cursor_json,
            !request.has_more,
        ],
    )
    .map_err(|error| format!("record accepted wire page: {error}"))?;
    tx.execute(
        "UPDATE manifest SET page_count=page_count+1,next_cursor_json=?1,
                             page_chain_complete=?2 WHERE singleton=1",
        params![next_cursor_json, !request.has_more],
    )
    .map_err(|error| format!("advance snapshot wire cursor: {error}"))?;
    tx.commit()
        .map_err(|error| format!("commit snapshot wire page: {error}"))?;
    page_progress(&conn, !request.has_more)
}

pub(super) async fn collaboration_snapshot_ingest_apply_wire_page_impl(
    request: CollaborationSnapshotIngestPageRequest,
) -> Result<CollaborationSnapshotIngestProgress, String> {
    let root = staging_root()?;
    tokio::task::spawn_blocking(move || apply_page_at_root(&root, request))
        .await
        .map_err(|error| error.to_string())?
}

pub(super) fn finalize_one_attachment(
    tx: &Transaction<'_>,
    root: &Path,
    token: &str,
    local_session_id: &str,
    attachment_id: &str,
) -> Result<(), String> {
    let event_path = root.join(format!("{token}-event-{}.tmp", Uuid::new_v4()));
    let _event_guard = TempFileGuard::new(event_path.clone());
    let event_file = File::create(&event_path)
        .map_err(|error| format!("create attachment event staging file: {error}"))?;
    let mut output = BufWriter::with_capacity(64 * 1024, event_file);
    let mut hasher = Sha256::new();
    let mut expected_part = 0_i64;
    let mut expected_offset = 0_i64;
    let mut final_metadata: Option<(i64, String, i64)> = None;
    {
        let mut statement = tx
            .prepare(
                "SELECT part_index,physical_seq,chunk_offset,chunk,final_part,
                        event_bytes,attachment_hash
                 FROM attachment_parts WHERE attachment_id=?1 ORDER BY part_index ASC",
            )
            .map_err(|error| format!("prepare attachment {attachment_id}: {error}"))?;
        let mut rows = statement
            .query([attachment_id])
            .map_err(|error| format!("query attachment {attachment_id}: {error}"))?;
        while let Some(row) = rows
            .next()
            .map_err(|error| format!("read attachment {attachment_id}: {error}"))?
        {
            let part_index: i64 = row.get(0).map_err(|error| error.to_string())?;
            let physical_seq: i64 = row.get(1).map_err(|error| error.to_string())?;
            let offset: i64 = row.get(2).map_err(|error| error.to_string())?;
            let chunk: Vec<u8> = row.get(3).map_err(|error| error.to_string())?;
            let final_part = row.get::<_, i64>(4).map_err(|error| error.to_string())? != 0;
            let event_bytes: Option<i64> = row.get(5).map_err(|error| error.to_string())?;
            let attachment_hash: Option<String> = row.get(6).map_err(|error| error.to_string())?;
            if part_index != expected_part || offset != expected_offset {
                return Err(format!(
                    "attachment {attachment_id} has missing or reordered parts"
                ));
            }
            if final_metadata.is_some() {
                return Err(format!(
                    "attachment {attachment_id} has data after its final part"
                ));
            }
            output
                .write_all(&chunk)
                .map_err(|error| format!("write attachment {attachment_id}: {error}"))?;
            hasher.update(&chunk);
            expected_part += 1;
            expected_offset = expected_offset
                .checked_add(chunk.len() as i64)
                .ok_or_else(|| "attachment byte count overflow".to_string())?;
            if final_part {
                let size = event_bytes
                    .ok_or_else(|| format!("attachment {attachment_id} final size is missing"))?;
                let hash = attachment_hash
                    .ok_or_else(|| format!("attachment {attachment_id} final hash is missing"))?;
                final_metadata = Some((size, hash, physical_seq));
            } else if event_bytes.is_some() || attachment_hash.is_some() {
                return Err(format!(
                    "attachment {attachment_id} has premature final metadata"
                ));
            }
        }
    }
    output
        .flush()
        .map_err(|error| format!("flush attachment {attachment_id}: {error}"))?;
    drop(output);
    let result = (|| {
        let (event_bytes, expected_hash, physical_seq) = final_metadata
            .ok_or_else(|| format!("attachment {attachment_id} is missing its final part"))?;
        if event_bytes != expected_offset {
            return Err(format!("attachment {attachment_id} total size mismatch"));
        }
        let actual_hash = format!("{:x}", hasher.finalize());
        if actual_hash != expected_hash.to_ascii_lowercase() {
            return Err(format!(
                "attachment {attachment_id} complete event hash mismatch"
            ));
        }
        let file = File::open(&event_path)
            .map_err(|error| format!("open assembled attachment {attachment_id}: {error}"))?;
        let mut deserializer = serde_json::Deserializer::from_reader(BufReader::new(file));
        let event = SessionEvent::deserialize(&mut deserializer)
            .map_err(|error| format!("parse attachment {attachment_id} event: {error}"))?;
        deserializer.end().map_err(|error| {
            format!("attachment {attachment_id} event has trailing data: {error}")
        })?;
        stage_cached_event(tx, event, local_session_id, physical_seq as u64, 0, false)?;
        tx.execute(
            "DELETE FROM attachment_parts WHERE attachment_id=?1",
            [attachment_id],
        )
        .map_err(|error| format!("clear attachment {attachment_id} parts: {error}"))?;
        Ok(())
    })();
    result
}

pub(super) fn finalize_attachments(
    conn: &mut Connection,
    root: &Path,
    manifest: &StagingManifest,
) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|error| format!("begin attachment finalization: {error}"))?;
    loop {
        let attachment_id: Option<String> = tx
            .query_row(
                "SELECT attachment_id FROM attachment_parts ORDER BY physical_seq ASC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("find pending attachment: {error}"))?;
        let Some(attachment_id) = attachment_id else {
            break;
        };
        finalize_one_attachment(
            &tx,
            root,
            &manifest.token,
            &manifest.local_session_id,
            &attachment_id,
        )?;
    }
    tx.commit()
        .map_err(|error| format!("commit attachment finalization: {error}"))
}

pub(super) fn validate_complete_staging(
    conn: &Connection,
    manifest: &StagingManifest,
) -> Result<(u64, u64), String> {
    if manifest.page_count == 0 || !manifest.page_chain_complete {
        return Err("snapshot wire page chain is incomplete".to_string());
    }
    let base_frozen_seq = if manifest.replace {
        0
    } else {
        manifest
            .previous
            .as_ref()
            .map_or(0, |cursor| cursor.frozen_seq)
    };
    let expected_physical = manifest
        .expected_frozen_seq
        .checked_sub(base_frozen_seq)
        .ok_or_else(|| "snapshot frozen sequence moved backwards".to_string())?;
    let (physical_count, min_seq, max_seq): (i64, Option<i64>, Option<i64>) = conn
        .query_row(
            "SELECT COUNT(*),MIN(seq),MAX(seq) FROM staged_wires WHERE seq>0",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| format!("validate frozen physical rows: {error}"))?;
    if physical_count.max(0) as u64 != expected_physical
        || (expected_physical > 0
            && (min_seq != Some((base_frozen_seq + 1) as i64)
                || max_seq != Some(manifest.expected_frozen_seq as i64)))
    {
        return Err(format!(
            "snapshot frozen rows are incomplete: expected {}..={}, got count={} min={min_seq:?} max={max_seq:?}",
            base_frozen_seq + 1,
            manifest.expected_frozen_seq,
            physical_count
        ));
    }
    let has_tail: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM staged_wires WHERE seq=0)",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("validate snapshot tail: {error}"))?
        != 0;
    if has_tail != manifest.expected_tail_hash.is_some() {
        return Err("snapshot mutable tail is incomplete".to_string());
    }
    let staged_logical: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(event_count),0) FROM staged_wires",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("count staged logical events: {error}"))?;
    let staged_events: i64 = conn
        .query_row("SELECT COUNT(*) FROM staged_events", [], |row| row.get(0))
        .map_err(|error| format!("count staged event rows: {error}"))?;
    if staged_events != staged_logical {
        return Err(format!(
            "snapshot decoded event count {staged_events} does not match physical rows {staged_logical}"
        ));
    }
    let base_frozen_count = if manifest.replace {
        0
    } else {
        manifest
            .previous
            .as_ref()
            .map_or(0, |cursor| cursor.frozen_count)
    };
    let final_count = base_frozen_count
        .checked_add(staged_logical.max(0) as u64)
        .ok_or_else(|| "snapshot logical event count overflow".to_string())?;
    if final_count != manifest.expected_count {
        return Err(format!(
            "snapshot logical count is {final_count}, expected {}",
            manifest.expected_count
        ));
    }
    let staged_frozen: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM staged_events WHERE is_tail=0",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("count staged frozen events: {error}"))?;
    let final_frozen_count = base_frozen_count
        .checked_add(staged_frozen.max(0) as u64)
        .ok_or_else(|| "snapshot frozen event count overflow".to_string())?;
    Ok((final_count, final_frozen_count))
}
