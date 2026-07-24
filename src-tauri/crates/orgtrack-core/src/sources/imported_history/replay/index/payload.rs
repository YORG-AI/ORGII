use super::source_identity::*;
use super::*;

#[allow(
    clippy::too_many_arguments,
    reason = "Payload range API mirrors the stable source, generation, event, field, and byte-range contract"
)]
pub(in crate::sources::imported_history::replay) fn read_payload_range(
    conn: &Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
    offset: u64,
    max_bytes: usize,
) -> Result<ReplayPayloadRange, String> {
    let resolved = resolve_source(conn, source, session_id)?;
    let payloads_json = conn
        .query_row(
            "SELECT payloads_json FROM imported_replay_events
             WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND event_id=?4",
            params![
                source.as_str(),
                resolved.source_session_id,
                generation,
                event_id
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("query replay payload locator: {err}"))?
        .ok_or_else(|| "Replay event/generation is no longer available".to_string())?;
    if let Some(range) = read_payload_artifact_range(
        conn,
        source,
        &resolved.source_session_id,
        generation,
        event_id,
        field_path,
        offset,
        max_bytes,
    )? {
        return Ok(range);
    }
    read_provider_payload_range(
        source,
        &resolved.path,
        &payloads_json,
        event_id,
        field_path,
        offset,
        max_bytes,
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
pub(super) fn read_provider_payload_range(
    source: ImportedHistorySourceId,
    source_path: &Path,
    payloads_json: &str,
    event_id: &str,
    field_path: &str,
    offset: u64,
    max_bytes: usize,
) -> Result<ReplayPayloadRange, String> {
    match replay_driver_kind(source) {
        ReplayDriverKind::CodexJsonl => codex_jsonl::read_payload(
            source_path,
            payloads_json,
            event_id,
            field_path,
            offset,
            max_bytes,
        ),
        ReplayDriverKind::SharedJsonl => jsonl_driver::read_payload(
            source,
            source_path,
            payloads_json,
            event_id,
            field_path,
            offset,
            max_bytes,
        ),
        ReplayDriverKind::Sqlite => sqlite_driver::read_payload(
            source,
            source_path,
            payloads_json,
            event_id,
            field_path,
            offset,
            max_bytes,
        ),
        ReplayDriverKind::StructuredSqlite => structured_driver::read_payload(
            source,
            source_path,
            payloads_json,
            event_id,
            field_path,
            offset,
            max_bytes,
        ),
        ReplayDriverKind::WholeJson => whole_json_driver::read_payload(
            source_path,
            payloads_json,
            event_id,
            field_path,
            offset,
            max_bytes,
        ),
    }
}

/// Materialize one direct provider locator into the same immutable replay
/// artifact table used by adapters that decode payloads while indexing.
#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
pub(in crate::sources::imported_history::replay) fn materialize_payload_artifact(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
) -> Result<ReplayPayloadArtifactLocator, String> {
    let resolved = resolve_source(tx, source, session_id)?;
    let payloads_json = tx
        .query_row(
            "SELECT payloads_json FROM imported_replay_events
             WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND event_id=?4",
            params![
                source.as_str(),
                resolved.source_session_id,
                generation,
                event_id
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("query replay payload for materialization: {error}"))?
        .ok_or_else(|| "Replay event/generation is no longer available".to_string())?;
    let descriptor = serde_json::from_str::<Vec<ReplayPayloadDescriptor>>(&payloads_json)
        .map_err(|error| format!("decode replay payload locator: {error}"))?
        .into_iter()
        .find(|descriptor| descriptor.field_path == field_path)
        .ok_or_else(|| format!("No deferred replay payload for {field_path}"))?;

    if let Some((content_hash, total_bytes)) = tx
        .query_row(
            "SELECT ref.content_hash, LENGTH(artifact.payload)
             FROM imported_replay_payload_artifact_refs AS ref
             JOIN imported_replay_payload_artifacts AS artifact
               ON artifact.source=ref.source
              AND artifact.source_session_id=ref.source_session_id
              AND artifact.generation=ref.generation
              AND artifact.content_hash=ref.content_hash
             WHERE ref.source=?1 AND ref.source_session_id=?2 AND ref.generation=?3
               AND ref.event_id=?4 AND ref.field_path=?5",
            params![
                source.as_str(),
                resolved.source_session_id,
                generation,
                event_id,
                field_path
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|error| format!("locate replay payload artifact: {error}"))?
    {
        return Ok(ReplayPayloadArtifactLocator {
            source_id: source.as_str().to_string(),
            source_session_id: resolved.source_session_id,
            generation: generation.to_string(),
            content_hash,
            total_bytes: total_bytes.max(0) as u64,
        });
    }
    if descriptor.source_key.is_none() && descriptor.spans.is_empty() {
        return Err(format!(
            "Replay payload artifact for {event_id}/{field_path} is missing and has no direct provider locator"
        ));
    }

    let total_bytes = descriptor.total_bytes;
    let content_hash = payload_artifact::store_streamed(
        tx,
        source,
        &resolved.source_session_id,
        generation,
        event_id,
        field_path,
        total_bytes,
        |writer| {
            let mut offset = 0_u64;
            while offset < total_bytes {
                let range = read_provider_payload_range(
                    source,
                    &resolved.path,
                    &payloads_json,
                    event_id,
                    field_path,
                    offset,
                    HARD_MAX_PAYLOAD_RANGE_BYTES,
                )?;
                if range.offset != offset || range.next_offset <= offset {
                    return Err(format!(
                        "Replay payload materialization made no exact progress at byte {offset}: returned {}..{}",
                        range.offset, range.next_offset
                    ));
                }
                if range.total_bytes != total_bytes {
                    return Err(format!(
                        "Replay payload changed during materialization: expected {total_bytes} bytes, found {}",
                        range.total_bytes
                    ));
                }
                writer
                    .write_all(range.text.as_bytes())
                    .map_err(|error| format!("write replay payload artifact page: {error}"))?;
                offset = range.next_offset;
            }
            Ok(())
        },
    )?;
    Ok(ReplayPayloadArtifactLocator {
        source_id: source.as_str().to_string(),
        source_session_id: resolved.source_session_id,
        generation: generation.to_string(),
        content_hash,
        total_bytes,
    })
}

#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
pub(super) fn read_payload_artifact_range(
    conn: &Connection,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    event_id: &str,
    field_path: &str,
    offset: u64,
    max_bytes: usize,
) -> Result<Option<ReplayPayloadRange>, String> {
    let offset_i64 = offset.min(i64::MAX as u64) as i64;
    let read_bytes = max_bytes.saturating_add(4).min(i64::MAX as usize) as i64;
    let row = conn
        .query_row(
            "SELECT LENGTH(artifact.payload), SUBSTR(artifact.payload, ?6 + 1, ?7)
             FROM imported_replay_payload_artifact_refs AS ref
             JOIN imported_replay_payload_artifacts AS artifact
               ON artifact.source=ref.source
              AND artifact.source_session_id=ref.source_session_id
              AND artifact.generation=ref.generation
              AND artifact.content_hash=ref.content_hash
             WHERE ref.source=?1 AND ref.source_session_id=?2 AND ref.generation=?3
               AND ref.event_id=?4 AND ref.field_path=?5",
            params![
                source.as_str(),
                source_session_id,
                generation,
                event_id,
                field_path,
                offset_i64,
                read_bytes
            ],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?.max(0) as u64,
                    row.get::<_, Vec<u8>>(1)?,
                ))
            },
        )
        .optional()
        .map_err(|err| format!("read replay payload artifact: {err}"))?;
    let Some((total_bytes, bytes)) = row else {
        return Ok(None);
    };
    if offset >= total_bytes {
        return Ok(Some(ReplayPayloadRange {
            event_id: event_id.to_string(),
            field_path: field_path.to_string(),
            offset: total_bytes,
            next_offset: total_bytes,
            eof: true,
            total_bytes,
            text: String::new(),
        }));
    }
    let mut start = 0_usize;
    while start < bytes.len() && bytes[start] & 0b1100_0000 == 0b1000_0000 {
        start += 1;
    }
    let mut end = start.saturating_add(max_bytes).min(bytes.len());
    while end > start && std::str::from_utf8(&bytes[start..end]).is_err() {
        end -= 1;
    }
    // Avoid an empty, non-EOF page when the caller's byte budget is smaller
    // than the next UTF-8 scalar. The public hard cap still bounds this to at
    // most three extra bytes.
    if end == start && start < bytes.len() && max_bytes > 0 {
        end = (start + 1..=bytes.len())
            .find(|candidate| std::str::from_utf8(&bytes[start..*candidate]).is_ok())
            .unwrap_or(bytes.len());
    }
    let text = std::str::from_utf8(&bytes[start..end])
        .map_err(|err| format!("decode replay payload artifact UTF-8: {err}"))?
        .to_string();
    let actual_offset = offset.saturating_add(start as u64);
    let next_offset = actual_offset.saturating_add((end - start) as u64);
    Ok(Some(ReplayPayloadRange {
        event_id: event_id.to_string(),
        field_path: field_path.to_string(),
        offset: actual_offset,
        next_offset,
        eof: next_offset >= total_bytes,
        total_bytes,
        text,
    }))
}
