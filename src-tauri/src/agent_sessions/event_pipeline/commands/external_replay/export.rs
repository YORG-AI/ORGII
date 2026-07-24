use super::*;

pub(super) fn stream_replay_export(
    source_id: &str,
    session_id: &str,
    destination_path: &str,
    format: ReplayExportFormat,
    orgii_envelope: Option<&OrgiiSessionExportEnvelope>,
) -> Result<ReplayExportResult, String> {
    let destination = std::path::Path::new(destination_path);
    let parent = destination
        .parent()
        .ok_or_else(|| "Replay export destination has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("create replay export directory {}: {err}", parent.display()))?;
    let destination_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("replay-export");
    let temporary = parent.join(format!(
        ".{destination_name}.orgii-{}.part",
        uuid::Uuid::new_v4()
    ));
    let result = (|| -> Result<ReplayExportResult, String> {
        let file = fs::File::create(&temporary)
            .map_err(|err| format!("create replay export {}: {err}", temporary.display()))?;
        let mut writer =
            HashingWriter::new(BufWriter::with_capacity(EXPORT_WRITER_BUFFER_BYTES, file));
        match format {
            ReplayExportFormat::Json => writer.write_all(b"[\n").map_err(|err| err.to_string())?,
            ReplayExportFormat::OrgiiSessionJson => {
                let envelope = orgii_envelope.ok_or_else(|| {
                    "orgii_session_json export requires the small session envelope".to_string()
                })?;
                writer
                    .write_all(
                        b"{\"format\":\"orgii.session.export\",\"version\":1,\"exportedAt\":",
                    )
                    .map_err(|err| err.to_string())?;
                serde_json::to_writer(&mut writer, &envelope.exported_at)
                    .map_err(|err| format!("serialize replay export timestamp: {err}"))?;
                writer
                    .write_all(b",\"session\":")
                    .map_err(|err| err.to_string())?;
                serde_json::to_writer(&mut writer, &envelope.session)
                    .map_err(|err| format!("serialize replay export session: {err}"))?;
                writer
                    .write_all(b",\"payload\":{\"events\":[\n")
                    .map_err(|err| err.to_string())?;
            }
            ReplayExportFormat::Markdown => {}
        }
        let summary = stream_replay_export_events(source_id, session_id, &mut writer, format)?;
        let count = summary.event_count;
        let first_created_at = summary.first_created_at;
        let last_created_at = summary.last_created_at;
        match format {
            ReplayExportFormat::Json => {
                writer.write_all(b"\n]\n").map_err(|err| err.to_string())?
            }
            ReplayExportFormat::OrgiiSessionJson => {
                let envelope = orgii_envelope.expect("validated above");
                writer
                    .write_all(b"\n],\"specs\":")
                    .map_err(|err| err.to_string())?;
                serde_json::to_writer(&mut writer, &envelope.specs)
                    .map_err(|err| format!("serialize replay export specs: {err}"))?;
                let fallback_start = envelope
                    .session
                    .get("created_at")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                let fallback_end = envelope
                    .session
                    .get("updated_at")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(fallback_start);
                writer
                    .write_all(b",\"timeRange\":{\"start\":")
                    .map_err(|err| err.to_string())?;
                serde_json::to_writer(
                    &mut writer,
                    first_created_at.as_deref().unwrap_or(fallback_start),
                )
                .map_err(|err| format!("serialize replay export time range: {err}"))?;
                writer
                    .write_all(b",\"end\":")
                    .map_err(|err| err.to_string())?;
                serde_json::to_writer(
                    &mut writer,
                    last_created_at.as_deref().unwrap_or(fallback_end),
                )
                .map_err(|err| format!("serialize replay export time range: {err}"))?;
                writer
                    .write_all(b"}},\"metadata\":{\"originalCategory\":")
                    .map_err(|err| err.to_string())?;
                serde_json::to_writer(&mut writer, &envelope.original_category)
                    .map_err(|err| format!("serialize replay export category: {err}"))?;
                writer
                    .write_all(format!(",\"eventCount\":{count}}}}}\n").as_bytes())
                    .map_err(|err| err.to_string())?;
            }
            ReplayExportFormat::Markdown => {}
        }
        writer
            .flush()
            .map_err(|err| format!("flush replay export: {err}"))?;
        let (bytes_written, sha256, mut inner) = writer.finish();
        inner
            .flush()
            .map_err(|err| format!("flush replay export file: {err}"))?;
        inner
            .get_ref()
            .sync_all()
            .map_err(|err| format!("sync replay export file: {err}"))?;
        drop(inner);
        fs::rename(&temporary, destination).map_err(|err| {
            format!(
                "publish replay export {} -> {}: {err}",
                temporary.display(),
                destination.display()
            )
        })?;
        Ok(ReplayExportResult {
            destination_path: destination_path.to_string(),
            bytes_written,
            event_count: count,
            sha256,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[derive(Default)]
pub(super) struct ReplayExportSummary {
    event_count: u64,
    first_created_at: Option<String>,
    last_created_at: Option<String>,
}

impl ReplayExportSummary {
    fn observe(&mut self, event: &SessionEvent) {
        if self
            .first_created_at
            .as_ref()
            .is_none_or(|first| event.created_at < *first)
        {
            self.first_created_at = Some(event.created_at.clone());
        }
        if self
            .last_created_at
            .as_ref()
            .is_none_or(|last| event.created_at > *last)
        {
            self.last_created_at = Some(event.created_at.clone());
        }
        self.event_count = self.event_count.saturating_add(1);
    }
}

pub(super) fn prepare_stream_replay_snapshot(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    imported_session_id: &str,
    limits: ReplayLimits,
) -> Result<ReplayCursor, String> {
    replay::prepare_pinned_scan(conn, source, imported_session_id, limits)
}

pub(super) fn prepare_sessions_stream_replay_snapshot(
    source: ImportedHistorySourceId,
    imported_session_id: &str,
    limits: ReplayLimits,
) -> Result<ReplayCursor, String> {
    with_sessions_replay_writer("replay stream preparation", |conn| {
        prepare_stream_replay_snapshot(conn, source, imported_session_id, limits)
    })
}

/// Export-only source scan. Unlike the cloud spool iterator, this deliberately
/// keeps events compact and gives the writer a range reader for each deferred
/// payload. A single 10 MiB output therefore never becomes a 10 MiB `String`.
pub(super) fn stream_replay_export_events(
    source_id: &str,
    session_id: &str,
    writer: &mut impl Write,
    format: ReplayExportFormat,
) -> Result<ReplayExportSummary, String> {
    let mut summary = ReplayExportSummary::default();
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
                .map_err(|err| format!("open replay export payload DB: {err}"))?;
            let mut after_sequence = -1_i64;
            loop {
                let scan = with_sessions_replay_writer("replay export scan", |conn| {
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
                for event in events {
                    write_replay_export_event(
                        writer,
                        &event,
                        format,
                        summary.event_count,
                        |payload_ref, offset| {
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
                        },
                    )?;
                    summary.observe(&event);
                }
                if !has_more {
                    break;
                }
                if next_sequence <= after_sequence {
                    return Err("Replay export cursor did not advance".to_string());
                }
                after_sequence = next_sequence;
            }
            let final_scan = with_sessions_replay_writer("replay export finalization", |conn| {
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
                "finalizing replay export",
            )?;
        }
        ResolvedReplayTarget::CollaborationSnapshot => {
            let conn = database::db::get_connection()
                .map_err(|err| format!("open collaboration replay export DB: {err}"))?;
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
                for (_, event) in indexed {
                    write_replay_export_event(
                        writer,
                        &event,
                        format,
                        summary.event_count,
                        |payload_ref, offset| {
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
                        },
                    )?;
                    summary.observe(&event);
                }
                if next_sequence >= state.max_sequence {
                    break;
                }
                if next_sequence <= after_sequence {
                    return Err("Collaboration replay export cursor did not advance".to_string());
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
        }
        ResolvedReplayTarget::ManagedChunkStore => {
            let conn = database::db::get_connection()
                .map_err(|err| format!("open managed replay export DB: {err}"))?;
            stream_managed_chunk_replay_events_from_conn(
                &conn,
                session_id,
                "exporting managed replay",
                |event, read_payload| {
                    write_replay_export_event(
                        writer,
                        event,
                        format,
                        summary.event_count,
                        |payload_ref, offset| read_payload(payload_ref, offset),
                    )?;
                    summary.observe(event);
                    Ok(())
                },
            )?;
        }
        ResolvedReplayTarget::NotReady => {
            return Err("Managed native transcript is not bound yet".to_string())
        }
    }
    Ok(summary)
}

pub(super) fn write_replay_export_event(
    writer: &mut impl Write,
    event: &SessionEvent,
    format: ReplayExportFormat,
    event_index: u64,
    mut read_payload: impl FnMut(&PayloadRef, u64) -> Result<ReplayPayloadRange, String>,
) -> Result<(), String> {
    match format {
        ReplayExportFormat::Json | ReplayExportFormat::OrgiiSessionJson => {
            if event_index > 0 {
                writer.write_all(b",\n").map_err(|err| err.to_string())?;
            }
            write_hydrated_event_json(writer, event, &mut read_payload)
        }
        ReplayExportFormat::Markdown => {
            write_markdown_event_streaming(writer, event, &mut read_payload)
        }
    }
}

#[derive(Clone, Copy)]
pub(super) enum PayloadMarkerEncoding {
    JsonString,
    RawJson,
}

pub(super) struct PayloadMarker {
    encoded_marker: Vec<u8>,
    payload_ref: PayloadRef,
    encoding: PayloadMarkerEncoding,
}

pub(super) fn write_hydrated_event_json(
    writer: &mut impl Write,
    event: &SessionEvent,
    read_payload: &mut dyn FnMut(&PayloadRef, u64) -> Result<ReplayPayloadRange, String>,
) -> Result<(), String> {
    if event.payload_refs.is_empty() {
        return serde_json::to_writer(writer, event)
            .map_err(|err| format!("serialize replay export event: {err}"));
    }

    let mut compact = event.clone();
    let payload_refs = std::mem::take(&mut compact.payload_refs);
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let mut markers = Vec::with_capacity(payload_refs.len().saturating_mul(2));
    for (index, payload_ref) in payload_refs.into_iter().enumerate() {
        let field_marker = format!("__ORGII_REPLAY_{nonce}_FIELD_{index}__");
        if set_event_payload_marker(&mut compact, &payload_ref.field_path, &field_marker) {
            markers.push(PayloadMarker {
                encoded_marker: serde_json::to_vec(&field_marker)
                    .map_err(|err| format!("encode replay export marker: {err}"))?,
                encoding: match payload_ref.replay_encoding {
                    Some(PayloadRefEncoding::JsonValue) => PayloadMarkerEncoding::RawJson,
                    Some(PayloadRefEncoding::Utf8Text) => PayloadMarkerEncoding::JsonString,
                    None if matches!(payload_ref.field_path.as_str(), "args" | "result") => {
                        PayloadMarkerEncoding::RawJson
                    }
                    None => PayloadMarkerEncoding::JsonString,
                },
                payload_ref: payload_ref.clone(),
            });
        }
        if compact.display_text == payload_ref.preview {
            let display_marker = format!("__ORGII_REPLAY_{nonce}_DISPLAY_{index}__");
            compact.display_text = display_marker.clone();
            markers.push(PayloadMarker {
                encoded_marker: serde_json::to_vec(&display_marker)
                    .map_err(|err| format!("encode replay display marker: {err}"))?,
                payload_ref,
                encoding: PayloadMarkerEncoding::JsonString,
            });
        }
    }

    let encoded = serde_json::to_vec(&compact)
        .map_err(|err| format!("serialize compact replay export event: {err}"))?;
    let mut position = 0_usize;
    while position < encoded.len() {
        let next = markers
            .iter()
            .enumerate()
            .filter_map(|(index, marker)| {
                find_bytes(&encoded[position..], &marker.encoded_marker)
                    .map(|offset| (position + offset, index))
            })
            .min_by_key(|(offset, _)| *offset);
        let Some((offset, marker_index)) = next else {
            writer
                .write_all(&encoded[position..])
                .map_err(|err| format!("write compact replay export event: {err}"))?;
            break;
        };
        writer
            .write_all(&encoded[position..offset])
            .map_err(|err| format!("write replay export marker prefix: {err}"))?;
        let marker = &markers[marker_index];
        stream_payload_to_writer(writer, &marker.payload_ref, marker.encoding, read_payload)?;
        position = offset.saturating_add(marker.encoded_marker.len());
    }
    Ok(())
}

pub(super) fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|candidate| candidate == needle)
}

pub(super) fn set_event_payload_marker(
    event: &mut SessionEvent,
    field_path: &str,
    marker: &str,
) -> bool {
    match field_path {
        "args" => {
            event.args = serde_json::Value::String(marker.to_string());
            true
        }
        "result" => {
            event.result = serde_json::Value::String(marker.to_string());
            true
        }
        _ => {
            let Some((root, path)) = field_path.split_once('.') else {
                return false;
            };
            let value = match root {
                "args" => &mut event.args,
                "result" => &mut event.result,
                _ => return false,
            };
            set_json_string_path(value, path, marker.to_string());
            json_value_at_path(value, path).is_some_and(|value| value.as_str() == Some(marker))
        }
    }
}

pub(super) fn json_value_at_path<'a>(
    mut value: &'a serde_json::Value,
    path: &str,
) -> Option<&'a serde_json::Value> {
    for segment in path.split('.') {
        value = match value {
            serde_json::Value::Object(object) => object.get(segment)?,
            serde_json::Value::Array(array) => array.get(segment.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(value)
}

pub(super) fn stream_payload_to_writer(
    writer: &mut impl Write,
    payload_ref: &PayloadRef,
    encoding: PayloadMarkerEncoding,
    read_payload: &mut dyn FnMut(&PayloadRef, u64) -> Result<ReplayPayloadRange, String>,
) -> Result<(), String> {
    if matches!(encoding, PayloadMarkerEncoding::JsonString) {
        writer.write_all(b"\"").map_err(|err| err.to_string())?;
    }
    let mut offset = 0_u64;
    loop {
        let range = read_payload(payload_ref, offset)?;
        match encoding {
            PayloadMarkerEncoding::RawJson => writer
                .write_all(range.text.as_bytes())
                .map_err(|err| format!("write raw replay export payload: {err}"))?,
            PayloadMarkerEncoding::JsonString => {
                let escaped = serde_json::to_vec(&range.text)
                    .map_err(|err| format!("escape replay export payload range: {err}"))?;
                if escaped.len() < 2 {
                    return Err("Encoded replay payload range was not a JSON string".to_string());
                }
                writer
                    .write_all(&escaped[1..escaped.len() - 1])
                    .map_err(|err| format!("write escaped replay export payload: {err}"))?;
            }
        }
        if range.eof {
            break;
        }
        if range.next_offset <= offset {
            return Err("Replay export payload cursor did not advance".to_string());
        }
        offset = range.next_offset;
    }
    if matches!(encoding, PayloadMarkerEncoding::JsonString) {
        writer.write_all(b"\"").map_err(|err| err.to_string())?;
    }
    Ok(())
}

pub(super) fn write_markdown_event_streaming(
    writer: &mut impl Write,
    event: &SessionEvent,
    read_payload: &mut dyn FnMut(&PayloadRef, u64) -> Result<ReplayPayloadRange, String>,
) -> Result<(), String> {
    let heading = match event.source {
        EventSource::User => "**User**\n\n",
        EventSource::Assistant if event.ui_canonical == "agent_message" => "**Assistant**\n\n",
        EventSource::Assistant | EventSource::System => return Ok(()),
    };
    let display_payload = event
        .payload_refs
        .iter()
        .find(|payload_ref| event.display_text == payload_ref.preview);
    if display_payload.is_none() && event.display_text.trim().is_empty() {
        return Ok(());
    }
    writer
        .write_all(heading.as_bytes())
        .map_err(|err| format!("write replay Markdown heading: {err}"))?;
    if let Some(payload_ref) = display_payload {
        stream_payload_to_writer(
            writer,
            payload_ref,
            PayloadMarkerEncoding::RawJson,
            read_payload,
        )?;
    } else {
        writer
            .write_all(event.display_text.trim().as_bytes())
            .map_err(|err| format!("write replay Markdown event: {err}"))?;
    }
    writer
        .write_all(b"\n\n---\n\n")
        .map_err(|err| format!("finish replay Markdown event: {err}"))
}

pub(super) struct HashingWriter<W> {
    inner: W,
    digest: Sha256,
    bytes: u64,
}

impl<W> HashingWriter<W> {
    pub(super) fn new(inner: W) -> Self {
        Self {
            inner,
            digest: Sha256::new(),
            bytes: 0,
        }
    }

    pub(super) fn finish(self) -> (u64, String, W) {
        let hash = self.digest.finalize();
        (self.bytes, format!("{hash:x}"), self.inner)
    }
}

impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(bytes)?;
        self.digest.update(&bytes[..written]);
        self.bytes = self.bytes.saturating_add(written as u64);
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// Stream the current generation directly to a destination file. Deferred
/// payloads are spliced in by bounded range reads; neither Rust nor JS builds
/// a complete transcript (or a complete large event) in memory.
#[tauri::command]
pub async fn external_replay_stream_export(
    source_id: String,
    session_id: String,
    destination_path: String,
    format: ReplayExportFormat,
    orgii_envelope: Option<OrgiiSessionExportEnvelope>,
) -> Result<ReplayExportResult, String> {
    let result = tokio::task::spawn_blocking(move || {
        stream_replay_export(
            &source_id,
            &session_id,
            &destination_path,
            format,
            orgii_envelope.as_ref(),
        )
    })
    .await
    .map_err(|err| format!("join replay export task: {err}"))??;
    schedule_replay_cache_prune();
    Ok(result)
}
