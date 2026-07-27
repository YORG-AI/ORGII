use super::*;

pub(super) async fn persist_shell_replays_for_delivery(
    source_id: &str,
    session_id: &str,
    generation: &str,
    revision: u64,
    events: &mut Vec<SessionEvent>,
) -> Result<(), String> {
    if !events
        .iter()
        .any(|event| event.ui_canonical == core_types::tool_names::RUN_SHELL)
    {
        return Ok(());
    }
    let source_id = source_id.to_string();
    let session_id = session_id.to_string();
    let generation = generation.to_string();
    let owned = std::mem::take(events);
    *events = tokio::task::spawn_blocking(move || {
        persist_shell_replays_bounded(&source_id, &session_id, &generation, revision, owned)
    })
    .await
    .map_err(|error| format!("join external shell replay persistence: {error}"))??;
    Ok(())
}

pub(super) fn persist_shell_replays_bounded(
    source_id: &str,
    session_id: &str,
    generation: &str,
    revision: u64,
    mut events: Vec<SessionEvent>,
) -> Result<Vec<SessionEvent>, String> {
    match resolve_target(source_id, session_id)? {
        ResolvedReplayTarget::Imported {
            source,
            imported_session_id,
        } => {
            with_foreground_replay_connection("external Shell replay", |conn| {
                let tx = database::db::begin_immediate(conn).map_err(|error| {
                    format!("begin external Shell manifest transaction: {error}")
                })?;
                for event in events.iter_mut().filter(|event| {
                    event.ui_canonical == core_types::tool_names::RUN_SHELL
                        && event.shell_replay.is_none()
                }) {
                    persist_imported_shell_manifest(
                        &tx,
                        event,
                        source,
                        &imported_session_id,
                        generation,
                    )?;
                }
                tx.commit()
                    .map_err(|error| format!("publish external Shell manifests: {error}"))
            })?;
            validate_imported_shell_snapshot(source, &imported_session_id, generation, revision)?;
        }
        ResolvedReplayTarget::CollaborationSnapshot => {
            // Collaboration generation identifies the snapshot lineage, while
            // same-lineage rewrites advance revision. Artifact scopes must
            // include both or a same-length UPDATE can reuse stale content.
            let artifact_generation = collaboration_shell_artifact_generation(generation, revision);
            with_foreground_replay_connection("collaboration Shell replay", |conn| {
                let tx = database::db::begin_immediate(conn).map_err(|error| {
                    format!("begin collaboration Shell manifest transaction: {error}")
                })?;
                for event in events.iter_mut().filter(|event| {
                    event.ui_canonical == core_types::tool_names::RUN_SHELL
                        && event.shell_replay.is_none()
                }) {
                    persist_scoped_shell_manifest(
                        &tx,
                        event,
                        source_id,
                        session_id,
                        &artifact_generation,
                        |payload_ref, offset, max| {
                            collaboration_snapshot_payload_range_from_conn(
                                &tx,
                                session_id,
                                generation,
                                payload_ref
                                    .replay_source_event_id
                                    .as_deref()
                                    .unwrap_or(&payload_ref.event_id),
                                &payload_ref.field_path,
                                offset,
                                max,
                            )
                            .map(|range| range.text.into_bytes())
                        },
                    )?;
                }
                tx.commit()
                    .map_err(|error| format!("publish collaboration Shell manifests: {error}"))
            })?;
            validate_collaboration_shell_snapshot(session_id, generation, revision)?;
        }
        ResolvedReplayTarget::ManagedChunkStore => {
            with_foreground_replay_connection("managed Shell replay", |conn| {
                let tx = database::db::begin_immediate(conn).map_err(|error| {
                    format!("begin managed Shell manifest transaction: {error}")
                })?;
                for event in events.iter_mut().filter(|event| {
                    event.ui_canonical == core_types::tool_names::RUN_SHELL
                        && event.shell_replay.is_none()
                }) {
                    persist_scoped_shell_manifest(
                        &tx,
                        event,
                        source_id,
                        session_id,
                        generation,
                        |payload_ref, offset, max| {
                            managed_chunk_payload_range_from_conn(
                                &tx,
                                session_id,
                                payload_ref
                                    .replay_source_event_id
                                    .as_deref()
                                    .unwrap_or(&payload_ref.event_id),
                                &payload_ref.field_path,
                                offset,
                                max,
                            )
                            .map(|range| range.text.into_bytes())
                        },
                    )?;
                }
                tx.commit()
                    .map_err(|error| format!("publish managed Shell manifests: {error}"))
            })?;
            validate_managed_chunk_shell_snapshot(session_id, generation, revision)?;
        }
        ResolvedReplayTarget::NotReady => {}
    }
    Ok(events)
}

pub(super) fn collaboration_shell_artifact_generation(generation: &str, revision: u64) -> String {
    format!("{generation}-r{revision}")
}

pub(super) fn validate_imported_shell_snapshot(
    source: ImportedHistorySourceId,
    session_id: &str,
    generation: &str,
    revision: u64,
) -> Result<(), String> {
    with_foreground_replay_connection("imported Shell validation", |conn| {
        validate_imported_shell_snapshot_from_conn(conn, source, session_id, generation, revision)
    })
}

pub(super) fn validate_imported_shell_snapshot_from_conn(
    conn: &mut Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
    generation: &str,
    revision: u64,
) -> Result<(), String> {
    // Re-observe the provider, not merely ORGII's last compact state. A file
    // or WAL can change (including same-size replacement) while the per-event
    // artifact transactions run; a local state lookup would miss that race.
    let observed = replay::scan_window_after(
        conn,
        source,
        session_id,
        i64::MAX,
        ReplayLimits {
            max_turns: 1,
            max_events: 1,
            max_ipc_bytes: 1,
        },
    )?;
    if observed.cursor.generation == generation && observed.cursor.revision == revision {
        return Ok(());
    }
    Err(format!(
        "Imported Shell replay changed while publishing manifests: expected {generation}@{revision}, found {}@{}; retry the bounded replay request",
        observed.cursor.generation, observed.cursor.revision
    ))
}

pub(super) fn validate_collaboration_shell_snapshot(
    session_id: &str,
    generation: &str,
    revision: u64,
) -> Result<(), String> {
    let conn = database::db::get_connection()
        .map_err(|error| format!("open collaboration Shell validation DB: {error}"))?;
    let current = collaboration_snapshot_state(&conn, session_id)?;
    if current.generation == generation && current.revision == revision {
        return Ok(());
    }
    Err(format!(
        "Collaboration Shell replay changed while publishing manifests: expected {generation}@{revision}, found {}@{}; retry the bounded replay request",
        current.generation, current.revision
    ))
}

pub(super) fn validate_managed_chunk_shell_snapshot(
    session_id: &str,
    generation: &str,
    revision: u64,
) -> Result<(), String> {
    let conn = database::db::get_connection()
        .map_err(|error| format!("open managed Shell validation DB: {error}"))?;
    let current = managed_chunk_stream_cursor(&conn, session_id)?;
    if current.0 == generation && current.1.max(0) as u64 == revision {
        return Ok(());
    }
    Err(format!(
        "Managed Shell replay changed while publishing manifests: expected {generation}@{revision}, found {}@{}; retry the bounded replay request",
        current.0, current.1
    ))
}

#[derive(Debug, Clone)]
pub(super) struct CanonicalExternalShellSegment {
    pub(super) stream: ShellReplayStream,
    pub(super) artifact: replay::ReplayPayloadArtifactLocator,
    pub(super) preview: String,
}

pub(super) fn persist_imported_shell_manifest(
    tx: &Transaction<'_>,
    event: &mut SessionEvent,
    source: ImportedHistorySourceId,
    imported_session_id: &str,
    generation: &str,
) -> Result<(), String> {
    if event.ui_canonical != core_types::tool_names::RUN_SHELL || event.shell_replay.is_some() {
        return Ok(());
    }
    let selected = select_shell_payload_refs(event);
    if selected.is_empty() {
        let source_session_id = source.source_session_id(imported_session_id)?;
        return persist_inline_shell_manifest(
            tx,
            event,
            source.as_str(),
            source_session_id,
            generation,
        );
    }
    let mut segments = Vec::with_capacity(selected.len());
    for payload_ref in selected {
        let source_event_id = payload_ref
            .replay_source_event_id
            .as_deref()
            .unwrap_or(&payload_ref.event_id);
        let artifact = replay::materialize_payload_artifact(
            tx,
            source,
            imported_session_id,
            generation,
            source_event_id,
            &payload_ref.field_path,
        )?;
        if artifact.total_bytes != payload_ref.full_size_bytes as u64 {
            return Err(format!(
                "External Shell payload changed while publishing manifest: expected {} bytes, found {}",
                payload_ref.full_size_bytes, artifact.total_bytes
            ));
        }
        segments.push(CanonicalExternalShellSegment {
            stream: shell_stream_for_payload_ref(payload_ref),
            artifact,
            preview: payload_ref.preview.clone(),
        });
    }
    publish_external_shell_manifest(tx, event, &segments)
}

pub(super) fn persist_scoped_shell_manifest(
    tx: &Transaction<'_>,
    event: &mut SessionEvent,
    source_id: &str,
    source_session_id: &str,
    generation: &str,
    mut read_range: impl FnMut(&PayloadRef, u64, usize) -> Result<Vec<u8>, String>,
) -> Result<(), String> {
    if event.ui_canonical != core_types::tool_names::RUN_SHELL || event.shell_replay.is_some() {
        return Ok(());
    }
    let selected = select_shell_payload_refs(event);
    if selected.is_empty() {
        return persist_inline_shell_manifest(tx, event, source_id, source_session_id, generation);
    }
    let mut segments = Vec::with_capacity(selected.len());
    for payload_ref in selected {
        let source_event_id = payload_ref
            .replay_source_event_id
            .as_deref()
            .unwrap_or(&payload_ref.event_id);
        let expected_bytes = payload_ref.full_size_bytes as u64;
        let artifact = if let Some(existing) = replay::find_scoped_payload_artifact(
            tx,
            source_id,
            source_session_id,
            generation,
            source_event_id,
            &payload_ref.field_path,
            expected_bytes,
        )? {
            existing
        } else {
            replay::store_scoped_payload_artifact_streamed(
                tx,
                source_id,
                source_session_id,
                generation,
                source_event_id,
                &payload_ref.field_path,
                expected_bytes,
                |writer| {
                    let mut offset = 0_u64;
                    while offset < expected_bytes {
                        let requested = (expected_bytes - offset)
                            .min(SHELL_REPLAY_RANGE_MAX_BYTES as u64)
                            as usize;
                        let bytes = read_range(payload_ref, offset, requested)?;
                        if bytes.is_empty() || bytes.len() > requested {
                            return Err(format!(
                                "External Shell payload made invalid progress at byte {offset}"
                            ));
                        }
                        writer
                            .write_all(&bytes)
                            .map_err(|error| format!("write external Shell payload: {error}"))?;
                        offset = offset.saturating_add(bytes.len() as u64);
                    }
                    Ok(())
                },
            )?
        };
        segments.push(CanonicalExternalShellSegment {
            stream: shell_stream_for_payload_ref(payload_ref),
            artifact,
            preview: payload_ref.preview.clone(),
        });
    }
    publish_external_shell_manifest(tx, event, &segments)
}

pub(super) fn persist_inline_shell_manifest(
    tx: &Transaction<'_>,
    event: &mut SessionEvent,
    source_id: &str,
    source_session_id: &str,
    generation: &str,
) -> Result<(), String> {
    if event
        .payload_refs
        .iter()
        .any(|payload_ref| payload_ref.field_path == "result")
    {
        return Ok(());
    }
    let parts = external_shell_inline_segments(event);
    if parts.is_empty() {
        return Ok(());
    }
    let mut segments = Vec::with_capacity(parts.len());
    for (ordinal, part) in parts.into_iter().enumerate() {
        let field_path = format!("__shell_inline.{ordinal}");
        let expected_bytes = part.text.len() as u64;
        let artifact = if let Some(existing) = replay::find_scoped_payload_artifact(
            tx,
            source_id,
            source_session_id,
            generation,
            &event.id,
            &field_path,
            expected_bytes,
        )? {
            existing
        } else {
            replay::store_scoped_payload_artifact_streamed(
                tx,
                source_id,
                source_session_id,
                generation,
                &event.id,
                &field_path,
                expected_bytes,
                |writer| {
                    writer
                        .write_all(part.text.as_bytes())
                        .map_err(|error| format!("write inline external Shell payload: {error}"))
                },
            )?
        };
        segments.push(CanonicalExternalShellSegment {
            stream: part.stream,
            artifact,
            preview: utf8_tail_preview(part.text, SHELL_REPLAY_PREVIEW_BYTES),
        });
    }
    publish_external_shell_manifest(tx, event, &segments)
}

pub(super) fn shell_stream_for_payload_ref(payload_ref: &PayloadRef) -> ShellReplayStream {
    if payload_ref
        .field_path
        .rsplit('.')
        .next()
        .is_some_and(|field| field.eq_ignore_ascii_case("stderr"))
    {
        ShellReplayStream::Stderr
    } else {
        ShellReplayStream::Stdout
    }
}

pub(super) fn publish_external_shell_manifest(
    tx: &Transaction<'_>,
    event: &mut SessionEvent,
    segments: &[CanonicalExternalShellSegment],
) -> Result<(), String> {
    if segments.is_empty() {
        return Ok(());
    }
    let logical_call_id = event.call_id.as_deref().unwrap_or(&event.id);
    let mut identity = Sha256::new();
    identity.update(b"orgii-external-shell-manifest-v1\0");
    let mut total_bytes = 0_u64;
    let mut last_sequence = 0_u64;
    let mut manifest_rows = Vec::with_capacity(segments.len());
    let mut preview = String::new();
    for (ordinal, segment) in segments.iter().enumerate() {
        let stream_tag = match segment.stream {
            ShellReplayStream::Stdout => 1_u8,
            ShellReplayStream::Stderr => 2_u8,
        };
        identity.update((ordinal as u64).to_le_bytes());
        identity.update([stream_tag]);
        identity.update(segment.artifact.total_bytes.to_le_bytes());
        identity.update(segment.artifact.content_hash.as_bytes());

        let output_byte_start = total_bytes;
        total_bytes = total_bytes
            .checked_add(segment.artifact.total_bytes)
            .ok_or_else(|| "External Shell manifest byte count overflow".to_string())?;
        let frame_count = segment
            .artifact
            .total_bytes
            .saturating_add(SHELL_REPLAY_FRAME_MAX_BYTES as u64 - 1)
            / SHELL_REPLAY_FRAME_MAX_BYTES as u64;
        let first_sequence = last_sequence.saturating_add(1);
        last_sequence = last_sequence
            .checked_add(frame_count)
            .ok_or_else(|| "External Shell manifest sequence overflow".to_string())?;
        manifest_rows.push((
            ordinal as u64,
            segment,
            output_byte_start,
            first_sequence,
            frame_count,
        ));

        if segment.stream == ShellReplayStream::Stderr {
            preview.push_str("[stderr] ");
        }
        preview.push_str(&segment.preview);
        if preview.len() > SHELL_REPLAY_PREVIEW_BYTES * 2 {
            preview = utf8_tail_preview(&preview, SHELL_REPLAY_PREVIEW_BYTES);
        }
    }
    preview = utf8_tail_preview(&preview, SHELL_REPLAY_PREVIEW_BYTES);
    let identity_hash = identity
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let call_id = format!("{logical_call_id}-external-{identity_hash}");

    let existing_identity = tx
        .query_row(
            "SELECT call_id,identity_hash
             FROM imported_replay_shell_manifests
             WHERE session_id=?1 AND logical_call_id=?2",
            params![event.session_id, logical_call_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| format!("read existing external Shell identity: {error}"))?;
    if let Some((existing_call_id, existing_hash)) = existing_identity.as_ref() {
        if existing_hash == &identity_hash {
            if existing_call_id != &call_id {
                return Err("external Shell manifest identity/call id mismatch".to_string());
            }
            tx.execute(
                "UPDATE imported_replay_shell_manifests
                 SET accessed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
                 WHERE session_id=?1 AND call_id=?2
                   AND accessed_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds')",
                params![event.session_id, call_id],
            )
            .map_err(|error| format!("touch unchanged external Shell manifest: {error}"))?;
            set_external_shell_state(event, call_id, total_bytes, last_sequence, preview);
            return Ok(());
        }
    }

    let old_scopes = {
        let mut statement = tx
            .prepare(
                "SELECT DISTINCT segment.source,segment.source_session_id,segment.generation
                 FROM imported_replay_shell_segments AS segment
                 JOIN imported_replay_shell_manifests AS manifest
                   ON manifest.session_id=segment.session_id AND manifest.call_id=segment.call_id
                 WHERE manifest.session_id=?1 AND manifest.logical_call_id=?2",
            )
            .map_err(|error| format!("prepare old Shell manifest scopes: {error}"))?;
        let rows = statement
            .query_map(params![event.session_id, logical_call_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| format!("query old Shell manifest scopes: {error}"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("read old Shell manifest scopes: {error}"))?
    };
    // sessions.db and orgtrack-cli connections do not globally enable
    // foreign_keys, so ON DELETE CASCADE is documentation rather than a
    // cleanup guarantee. Delete the old references explicitly before their
    // manifest; otherwise they retain obsolete content-addressed BLOBs.
    if let Some((old_call_id, _)) = existing_identity.as_ref() {
        tx.execute(
            "DELETE FROM imported_replay_shell_segments
             WHERE session_id=?1 AND call_id=?2",
            params![event.session_id, old_call_id],
        )
        .map_err(|error| format!("delete replaced external Shell segments: {error}"))?;
    }
    tx.execute(
        "DELETE FROM imported_replay_shell_manifests
         WHERE session_id=?1 AND logical_call_id=?2",
        params![event.session_id, logical_call_id],
    )
    .map_err(|error| format!("replace external Shell manifest: {error}"))?;
    tx.execute(
        "INSERT INTO imported_replay_shell_manifests(
             session_id,logical_call_id,call_id,identity_hash,total_bytes,last_sequence,
             terminal_preview,completed_at,accessed_at
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,
                  strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        params![
            event.session_id,
            logical_call_id,
            call_id,
            identity_hash,
            i64::try_from(total_bytes)
                .map_err(|_| "External Shell manifest exceeds SQLite INTEGER".to_string())?,
            i64::try_from(last_sequence)
                .map_err(|_| "External Shell sequence exceeds SQLite INTEGER".to_string())?,
            preview,
            event.created_at,
        ],
    )
    .map_err(|error| format!("insert external Shell manifest: {error}"))?;
    for (ordinal, segment, output_byte_start, first_sequence, frame_count) in manifest_rows {
        tx.execute(
            "INSERT INTO imported_replay_shell_segments(
                 session_id,call_id,ordinal,stream,source,source_session_id,generation,
                 content_hash,output_byte_start,total_bytes,first_sequence,frame_count
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![
                event.session_id,
                call_id,
                i64::try_from(ordinal)
                    .map_err(|_| "External Shell segment ordinal overflow".to_string())?,
                segment.stream.as_wire_str(),
                segment.artifact.source_id,
                segment.artifact.source_session_id,
                segment.artifact.generation,
                segment.artifact.content_hash,
                i64::try_from(output_byte_start)
                    .map_err(|_| "External Shell output offset overflow".to_string())?,
                i64::try_from(segment.artifact.total_bytes)
                    .map_err(|_| "External Shell segment size overflow".to_string())?,
                i64::try_from(first_sequence)
                    .map_err(|_| "External Shell first sequence overflow".to_string())?,
                i64::try_from(frame_count)
                    .map_err(|_| "External Shell frame count overflow".to_string())?,
            ],
        )
        .map_err(|error| format!("insert external Shell segment: {error}"))?;
    }

    let mut cleanup_scopes = old_scopes.into_iter().collect::<HashSet<_>>();
    cleanup_scopes.extend(segments.iter().map(|segment| {
        (
            segment.artifact.source_id.clone(),
            segment.artifact.source_session_id.clone(),
            segment.artifact.generation.clone(),
        )
    }));
    for (source, source_session_id, generation) in cleanup_scopes {
        delete_unreferenced_payload_artifacts(tx, &source, &source_session_id, &generation)?;
    }

    set_external_shell_state(event, call_id, total_bytes, last_sequence, preview);
    Ok(())
}

pub(super) fn set_external_shell_state(
    event: &mut SessionEvent,
    call_id: String,
    total_bytes: u64,
    last_sequence: u64,
    terminal_preview: String,
) {
    event.shell_replay = Some(ShellReplayState {
        replay_ref: ShellReplayRef {
            session_id: event.session_id.clone(),
            call_id,
            format_version: SHELL_REPLAY_FORMAT_VERSION,
        },
        bookmark: ShellReplayBookmark {
            visible_through_sequence: last_sequence,
            visible_bytes: total_bytes,
        },
        terminal_preview,
        status: ShellReplayStatus::Complete,
        error: None,
        completed_at: Some(event.created_at.clone()),
    });
}

pub(super) const DELETE_UNREFERENCED_PAYLOAD_ARTIFACTS_SQL: &str =
    "DELETE FROM imported_replay_payload_artifacts AS artifact
     WHERE artifact.source=?1 AND artifact.source_session_id=?2 AND artifact.generation=?3
       AND artifact.content_hash NOT IN(
         SELECT ref.content_hash FROM imported_replay_payload_artifact_refs AS ref
         WHERE ref.source=?1
           AND ref.source_session_id=?2
           AND ref.generation=?3
       )
       AND artifact.content_hash NOT IN(
         SELECT shell.content_hash FROM imported_replay_shell_segments AS shell
         WHERE shell.source=?1
           AND shell.source_session_id=?2
           AND shell.generation=?3
       )";

pub(super) fn delete_unreferenced_payload_artifacts(
    tx: &Transaction<'_>,
    source: &str,
    source_session_id: &str,
    generation: &str,
) -> Result<(), String> {
    tx.execute(
        DELETE_UNREFERENCED_PAYLOAD_ARTIFACTS_SQL,
        params![source, source_session_id, generation],
    )
    .map(|_| ())
    .map_err(|error| format!("delete unreferenced external Shell payload: {error}"))
}

#[derive(Debug)]
pub(super) struct ExternalShellManifestSegment {
    stream: ShellReplayStream,
    artifact_row_id: i64,
    output_byte_start: u64,
    total_bytes: u64,
    first_sequence: u64,
    frame_count: u64,
}

/// Read an external-CLI Shell manifest when one exists, otherwise preserve
/// the native SDE Agent's #425 `.slog` command unchanged. An invalid external
/// manifest is an error: silently falling through could surface a stale native
/// replay with the same logical call id.
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri wire and replay storage boundaries keep stable fields explicit"
)]
#[tauri::command(rename_all = "camelCase")]
pub async fn shell_replay_read_range(
    session_id: String,
    call_id: String,
    visible_through_sequence: u64,
    visible_bytes: u64,
    offset_bytes: u64,
    limit_bytes: u64,
) -> Result<ShellReplayRange, String> {
    // Native #425 replay is a high-frequency range path. Its call ids never
    // carry the content-addressed external suffix, so bypass both the extra
    // task and the replay-cache connection entirely.
    if !is_external_shell_manifest_call_id(&call_id) {
        return agent_core::tools::impls::coding::exec::shell_replay::shell_replay_read_range(
            session_id,
            call_id,
            visible_through_sequence,
            visible_bytes,
            offset_bytes,
            limit_bytes,
        )
        .await;
    }
    let external_session_id = session_id.clone();
    let external_call_id = call_id.clone();
    #[cfg(test)]
    EXTERNAL_SHELL_MANIFEST_DB_PROBES.fetch_add(1, Ordering::SeqCst);
    let external = tokio::task::spawn_blocking(move || {
        let conn = database::db::get_connection()
            .map_err(|error| format!("open external Shell replay DB: {error}"))?;
        read_external_shell_manifest_range(
            &conn,
            &external_session_id,
            &external_call_id,
            visible_through_sequence,
            visible_bytes,
            offset_bytes,
            limit_bytes,
        )
    })
    .await
    .map_err(|error| format!("join external Shell range read: {error}"))??;
    if let Some(range) = external {
        return Ok(range);
    }
    agent_core::tools::impls::coding::exec::shell_replay::shell_replay_read_range(
        session_id,
        call_id,
        visible_through_sequence,
        visible_bytes,
        offset_bytes,
        limit_bytes,
    )
    .await
}

pub(super) fn is_external_shell_manifest_call_id(call_id: &str) -> bool {
    let Some((_, digest)) = call_id.rsplit_once("-external-") else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[allow(
    clippy::too_many_arguments,
    reason = "Tauri wire and replay storage boundaries keep stable fields explicit"
)]
pub(super) fn read_external_shell_manifest_range(
    conn: &Connection,
    session_id: &str,
    call_id: &str,
    visible_through_sequence: u64,
    visible_bytes: u64,
    offset_bytes: u64,
    limit_bytes: u64,
) -> Result<Option<ShellReplayRange>, String> {
    let manifest_table_exists = conn
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM sqlite_master
                 WHERE type='table' AND name='imported_replay_shell_manifests'
             )",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("inspect external Shell replay schema: {error}"))?;
    if !manifest_table_exists {
        return Ok(None);
    }
    let manifest = conn
        .query_row(
            "SELECT total_bytes,last_sequence
             FROM imported_replay_shell_manifests
             WHERE session_id=?1 AND call_id=?2",
            params![session_id, call_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|error| format!("read external Shell manifest: {error}"))?;
    let Some((manifest_total, manifest_last_sequence)) = manifest else {
        return Ok(None);
    };
    let manifest_total = nonnegative_sqlite_u64(manifest_total, "manifest total_bytes")?;
    let manifest_last_sequence =
        nonnegative_sqlite_u64(manifest_last_sequence, "manifest last_sequence")?;

    // Acquire cache liveness before opening any artifact BLOB. Cache pruning
    // performs selection and deletion under one IMMEDIATE transaction, so
    // this conditional write and prune have a clear lock order: either this
    // read protects the manifest first, or it observes that prune removed it.
    // Failed/corrupt read attempts may retain a small entry for one TTL; that
    // is preferable to deleting a payload while a reader is opening it.
    conn.execute(
        "UPDATE imported_replay_shell_manifests
         SET accessed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE session_id=?1 AND call_id=?2
           AND accessed_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds')",
        params![session_id, call_id],
    )
    .map_err(|error| format!("touch external Shell manifest: {error}"))?;

    let mut statement = conn
        .prepare(
            "SELECT segment.ordinal,segment.stream,segment.output_byte_start,
                    segment.total_bytes,segment.first_sequence,segment.frame_count,
                    artifact.rowid,LENGTH(artifact.payload)
             FROM imported_replay_shell_segments AS segment
             LEFT JOIN imported_replay_payload_artifacts AS artifact
               ON artifact.source=segment.source
              AND artifact.source_session_id=segment.source_session_id
              AND artifact.generation=segment.generation
              AND artifact.content_hash=segment.content_hash
             WHERE segment.session_id=?1 AND segment.call_id=?2
             ORDER BY segment.ordinal ASC",
        )
        .map_err(|error| format!("prepare external Shell segments: {error}"))?;
    let rows = statement
        .query_map(params![session_id, call_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<i64>>(7)?,
            ))
        })
        .map_err(|error| format!("query external Shell segments: {error}"))?;
    let raw_segments = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("read external Shell segments: {error}"))?;
    drop(statement);

    let mut segments = Vec::with_capacity(raw_segments.len());
    let mut expected_output_start = 0_u64;
    let mut expected_first_sequence = 1_u64;
    for (expected_ordinal, row) in raw_segments.into_iter().enumerate() {
        let (
            ordinal,
            stream,
            output_byte_start,
            total_bytes,
            first_sequence,
            frame_count,
            artifact_row_id,
            artifact_bytes,
        ) = row;
        let ordinal = nonnegative_sqlite_u64(ordinal, "segment ordinal")?;
        if ordinal != expected_ordinal as u64 {
            return Err(format!(
                "invalid external Shell segment ordinal {ordinal}; expected {expected_ordinal}"
            ));
        }
        let stream = match stream.as_str() {
            "stdout" => ShellReplayStream::Stdout,
            "stderr" => ShellReplayStream::Stderr,
            other => return Err(format!("invalid external Shell stream {other:?}")),
        };
        let output_byte_start =
            nonnegative_sqlite_u64(output_byte_start, "segment output_byte_start")?;
        let total_bytes = nonnegative_sqlite_u64(total_bytes, "segment total_bytes")?;
        let first_sequence = nonnegative_sqlite_u64(first_sequence, "segment first_sequence")?;
        let frame_count = nonnegative_sqlite_u64(frame_count, "segment frame_count")?;
        let expected_frame_count = total_bytes
            .saturating_add(SHELL_REPLAY_FRAME_MAX_BYTES as u64 - 1)
            / SHELL_REPLAY_FRAME_MAX_BYTES as u64;
        if output_byte_start != expected_output_start
            || first_sequence != expected_first_sequence
            || frame_count != expected_frame_count
        {
            return Err(format!(
                "invalid external Shell segment layout at ordinal {ordinal}"
            ));
        }
        let artifact_row_id = artifact_row_id.ok_or_else(|| {
            format!("external Shell payload artifact missing at ordinal {ordinal}")
        })?;
        let artifact_bytes = nonnegative_sqlite_u64(
            artifact_bytes.ok_or_else(|| {
                format!("external Shell payload length missing at ordinal {ordinal}")
            })?,
            "artifact payload length",
        )?;
        if artifact_bytes != total_bytes {
            return Err(format!(
                "external Shell payload length mismatch at ordinal {ordinal}: expected {total_bytes}, found {artifact_bytes}"
            ));
        }
        segments.push(ExternalShellManifestSegment {
            stream,
            artifact_row_id,
            output_byte_start,
            total_bytes,
            first_sequence,
            frame_count,
        });
        expected_output_start = expected_output_start
            .checked_add(total_bytes)
            .ok_or_else(|| "external Shell output byte count overflow".to_string())?;
        expected_first_sequence = expected_first_sequence
            .checked_add(frame_count)
            .ok_or_else(|| "external Shell sequence overflow".to_string())?;
    }
    if expected_output_start != manifest_total
        || expected_first_sequence.saturating_sub(1) != manifest_last_sequence
    {
        return Err("external Shell manifest summary does not match its segments".to_string());
    }

    let visible_sequence = visible_through_sequence.min(manifest_last_sequence);
    let visible_end = visible_bytes.min(manifest_total);
    let start = offset_bytes.min(visible_end);
    let limit = limit_bytes.min(SHELL_REPLAY_RANGE_MAX_BYTES as u64).max(1);
    let range = if start >= visible_end || visible_sequence == 0 {
        ShellReplayRange {
            frames: Vec::new(),
            next_offset_bytes: start,
            eof: true,
        }
    } else {
        read_external_shell_frames(conn, &segments, visible_sequence, visible_end, start, limit)?
    };

    Ok(Some(range))
}

pub(super) fn read_external_shell_frames(
    conn: &Connection,
    segments: &[ExternalShellManifestSegment],
    visible_sequence: u64,
    visible_end: u64,
    start: u64,
    limit: u64,
) -> Result<ShellReplayRange, String> {
    let tail_request = start.saturating_add(limit) >= visible_end;
    let mut frames = Vec::new();
    let mut next_offset = start;
    let mut response_bytes = 0_u64;
    let mut rendered_response_bytes = 0_usize;
    'segments: for segment in segments {
        let segment_end = segment
            .output_byte_start
            .checked_add(segment.total_bytes)
            .ok_or_else(|| "external Shell segment end overflow".to_string())?;
        if segment_end <= start || segment.output_byte_start >= visible_end {
            continue;
        }
        let blob = conn
            .blob_open(
                DatabaseName::Main,
                "imported_replay_payload_artifacts",
                "payload",
                segment.artifact_row_id,
                true,
            )
            .map_err(|error| format!("open external Shell payload BLOB: {error}"))?;
        if blob.len() as u64 != segment.total_bytes {
            return Err("external Shell payload changed after manifest validation".to_string());
        }
        let local_start = start.saturating_sub(segment.output_byte_start);
        let mut frame_index = (local_start / SHELL_REPLAY_FRAME_MAX_BYTES as u64)
            .saturating_sub(1)
            .min(segment.frame_count.saturating_sub(1));
        while frame_index < segment.frame_count {
            let sequence = segment
                .first_sequence
                .checked_add(frame_index)
                .ok_or_else(|| "external Shell frame sequence overflow".to_string())?;
            if sequence > visible_sequence {
                break 'segments;
            }
            let candidate_start = frame_index
                .checked_mul(SHELL_REPLAY_FRAME_MAX_BYTES as u64)
                .ok_or_else(|| "external Shell frame offset overflow".to_string())?;
            let candidate_end = frame_index
                .saturating_add(1)
                .saturating_mul(SHELL_REPLAY_FRAME_MAX_BYTES as u64)
                .min(segment.total_bytes);
            let local_frame_start =
                external_shell_utf8_boundary(&blob, candidate_start, segment.total_bytes)?;
            let local_frame_end =
                external_shell_utf8_boundary(&blob, candidate_end, segment.total_bytes)?;
            if local_frame_end <= local_frame_start {
                return Err("external Shell UTF-8 frame made no progress".to_string());
            }
            let frame_start = segment
                .output_byte_start
                .checked_add(local_frame_start)
                .ok_or_else(|| "external Shell frame start overflow".to_string())?;
            let frame_end = segment
                .output_byte_start
                .checked_add(local_frame_end)
                .ok_or_else(|| "external Shell frame end overflow".to_string())?;
            frame_index = frame_index.saturating_add(1);
            if frame_end <= start {
                continue;
            }
            if frame_start >= visible_end || frame_end > visible_end {
                break 'segments;
            }
            if tail_request
                && frame_start < start
                && frame_end < visible_end
                && visible_end.saturating_sub(frame_start) > limit
            {
                continue;
            }
            let frame_bytes = frame_end.saturating_sub(frame_start);
            if !frames.is_empty() && response_bytes.saturating_add(frame_bytes) > limit {
                break 'segments;
            }
            let frame_len = usize::try_from(local_frame_end - local_frame_start)
                .map_err(|_| "external Shell frame exceeds address space".to_string())?;
            if frame_len > SHELL_REPLAY_FRAME_MAX_BYTES + 3 {
                return Err("external Shell UTF-8 frame exceeds its hard bound".to_string());
            }
            let mut payload = vec![0_u8; frame_len];
            blob.read_at_exact(
                &mut payload,
                usize::try_from(local_frame_start).map_err(|_| {
                    "external Shell payload offset exceeds address space".to_string()
                })?,
            )
            .map_err(|error| format!("read external Shell payload BLOB: {error}"))?;
            let text = String::from_utf8(payload)
                .map_err(|_| "external Shell payload is not valid UTF-8".to_string())?;
            if !frames.is_empty()
                && rendered_response_bytes.saturating_add(text.len()) > SHELL_REPLAY_RANGE_MAX_BYTES
            {
                break 'segments;
            }
            rendered_response_bytes = rendered_response_bytes.saturating_add(text.len());
            response_bytes = response_bytes.saturating_add(frame_bytes);
            next_offset = frame_end;
            frames.push(ShellReplayFrame {
                sequence,
                stream: segment.stream.as_wire_str().to_string(),
                byte_start: frame_start,
                byte_end: frame_end,
                text,
            });
            if next_offset >= visible_end || response_bytes >= limit {
                break;
            }
        }
        if next_offset >= visible_end || response_bytes >= limit {
            break;
        }
    }
    Ok(ShellReplayRange {
        frames,
        next_offset_bytes: next_offset,
        eof: next_offset >= visible_end,
    })
}

pub(super) fn external_shell_utf8_boundary(
    blob: &rusqlite::blob::Blob<'_>,
    candidate: u64,
    total_bytes: u64,
) -> Result<u64, String> {
    if candidate == 0 || candidate >= total_bytes {
        return Ok(candidate.min(total_bytes));
    }
    let mut boundary = candidate;
    let mut byte = [0_u8; 1];
    blob.read_at_exact(
        &mut byte,
        usize::try_from(boundary)
            .map_err(|_| "external Shell UTF-8 boundary exceeds address space".to_string())?,
    )
    .map_err(|error| format!("read external Shell UTF-8 boundary: {error}"))?;
    if byte[0] & 0b1100_0000 != 0b1000_0000 {
        return Ok(boundary);
    }
    for _ in 0..3 {
        boundary = boundary
            .checked_sub(1)
            .ok_or_else(|| "invalid external Shell UTF-8 prefix".to_string())?;
        blob.read_at_exact(
            &mut byte,
            usize::try_from(boundary)
                .map_err(|_| "external Shell UTF-8 boundary exceeds address space".to_string())?,
        )
        .map_err(|error| format!("read external Shell UTF-8 boundary: {error}"))?;
        if byte[0] & 0b1100_0000 != 0b1000_0000 {
            return Ok(boundary);
        }
    }
    Err("external Shell payload has an invalid UTF-8 boundary".to_string())
}

pub(super) fn nonnegative_sqlite_u64(value: i64, label: &str) -> Result<u64, String> {
    u64::try_from(value).map_err(|_| format!("invalid negative external Shell {label}: {value}"))
}

pub(super) fn select_shell_payload_refs(event: &SessionEvent) -> Vec<&PayloadRef> {
    let result_refs = event
        .payload_refs
        .iter()
        .filter(|payload_ref| payload_ref.field_path.starts_with("result."))
        .collect::<Vec<_>>();
    let suffix = |payload_ref: &PayloadRef, names: &[&str]| {
        payload_ref
            .field_path
            .rsplit('.')
            .next()
            .is_some_and(|field| names.iter().any(|name| field.eq_ignore_ascii_case(name)))
    };
    if let Some(interleaved) = result_refs
        .iter()
        .find(|payload_ref| suffix(payload_ref, &["interleavedOutput", "aggregated_output"]))
    {
        return vec![*interleaved];
    }
    let mut split_streams = result_refs
        .iter()
        .filter(|payload_ref| suffix(payload_ref, &["stdout", "stderr"]))
        .copied()
        .collect::<Vec<_>>();
    if !split_streams.is_empty() {
        split_streams.sort_by_key(|payload_ref| {
            usize::from(
                payload_ref
                    .field_path
                    .rsplit('.')
                    .next()
                    .is_some_and(|field| field.eq_ignore_ascii_case("stderr")),
            )
        });
        return split_streams;
    }
    for name in ["output", "observation", "content"] {
        if let Some(payload_ref) = result_refs
            .iter()
            .find(|payload_ref| suffix(payload_ref, &[name]))
        {
            return vec![*payload_ref];
        }
    }
    Vec::new()
}
