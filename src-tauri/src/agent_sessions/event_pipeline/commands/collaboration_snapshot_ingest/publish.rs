use super::schema::*;
use super::staging::*;
use super::wire::*;
use super::*;

pub(super) fn drop_replay_accounting_triggers(tx: &Transaction<'_>) -> Result<(), String> {
    // A full replacement must not emit one generation/accounting mutation per
    // row. The ingest transaction publishes the exact aggregate state once
    // below; the next replay access reinstalls these
    // CREATE-IF-NOT-EXISTS triggers.
    tx.execute_batch(
        "DROP TRIGGER IF EXISTS collaboration_replay_events_insert;
         DROP TRIGGER IF EXISTS collaboration_replay_events_delete;
         DROP TRIGGER IF EXISTS collaboration_replay_events_update_old;
         DROP TRIGGER IF EXISTS collaboration_replay_events_update_new;",
    )
    .map_err(|error| format!("suspend per-row collaboration replay accounting: {error}"))
}

pub(super) fn publish_replay_accounting_state(
    tx: &Transaction<'_>,
    session_id: &str,
    event_count: i64,
    max_sequence: i64,
) -> Result<(), String> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS collaboration_replay_state (
           session_id TEXT PRIMARY KEY,
           generation INTEGER NOT NULL DEFAULT 0,
           revision INTEGER NOT NULL DEFAULT 0,
           max_sequence INTEGER NOT NULL DEFAULT -1,
           event_count INTEGER NOT NULL DEFAULT 0
         );",
    )
    .map_err(|error| format!("initialize collaboration replay accounting state: {error}"))?;
    tx.execute(
        PUBLISH_REPLAY_ACCOUNTING_SQL,
        params![session_id, event_count, max_sequence],
    )
    .map_err(|error| format!("publish collaboration replay accounting state: {error}"))?;
    Ok(())
}

pub(super) fn handoff_text_value(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        serde_json::Value::Array(values) => {
            let mut joined = String::new();
            for text in values.iter().filter_map(handoff_text_value) {
                if !joined.is_empty() {
                    joined.push('\n');
                }
                joined.push_str(&text);
                if joined.encode_utf16().count() >= HANDOFF_MAX_ITEM_UTF16 {
                    break;
                }
            }
            (!joined.is_empty()).then_some(joined)
        }
        serde_json::Value::Object(object) => ["text", "content", "message", "output", "summary"]
            .into_iter()
            .find_map(|key| object.get(key).and_then(handoff_text_value)),
        _ => None,
    }
}

pub(super) fn truncate_handoff_item(text: &str) -> String {
    if text.encode_utf16().count() <= HANDOFF_MAX_ITEM_UTF16 {
        return text.to_string();
    }
    let budget = HANDOFF_MAX_ITEM_UTF16.saturating_sub(1);
    let mut output = String::new();
    let mut units = 0_usize;
    for character in text.chars() {
        let next = units.saturating_add(character.len_utf16());
        if next > budget {
            break;
        }
        output.push(character);
        units = next;
    }
    output.push('…');
    output
}

pub(super) fn handoff_item_from_event(event: &SessionEvent) -> Option<String> {
    let action_type = event.action_type.as_str();
    let function = event.function_name.as_str();
    if action_type.contains("thinking")
        || action_type.contains("reasoning")
        || matches!(function, "thinking" | "thinking_delta" | "reasoning")
    {
        return None;
    }
    let result = handoff_text_value(&event.result);
    let args = handoff_text_value(&event.args);
    let content = result.as_deref().or(args.as_deref()).or_else(|| {
        let text = event.display_text.trim();
        (!text.is_empty()).then_some(text)
    });
    let item = if matches!(action_type, "user" | "user_message")
        || matches!(function, "user" | "user_message")
    {
        content.map(|text| format!("User: {text}"))
    } else if matches!(
        action_type,
        "assistant" | "assistant_message" | "llm_response"
    ) || matches!(
        function,
        "agent_message" | "assistant" | "assistant_message"
    ) {
        content.map(|text| format!("Assistant: {text}"))
    } else if action_type.contains("tool") {
        let mut lines = vec![
            "[Imported Collaboration Snapshot action]".to_string(),
            format!(
                "Tool: {}",
                if function.is_empty() {
                    "unknown_tool"
                } else {
                    function
                }
            ),
        ];
        if let Some(args) = args {
            lines.push(format!("Input: {args}"));
        }
        if let Some(result) = result {
            lines.push(format!("Result at that time: {result}"));
        }
        Some(lines.join("\n"))
    } else {
        content.map(|text| format!("Assistant context: {text}"))
    }?;
    Some(truncate_handoff_item(&item))
}

pub(super) fn collect_published_handoff(
    tx: &Transaction<'_>,
    session_id: &str,
) -> Result<(Vec<String>, u64, u64), String> {
    let mut statement = tx
        .prepare(
            "SELECT id,session_id,event_type,function_name,thread_id,
                    CASE WHEN length(CAST(args_json AS BLOB))<=?2
                         THEN args_json
                         WHEN json_valid(args_json) THEN json_object(
                           'content',substr(COALESCE(
                             json_extract(args_json,'$.content'),
                             json_extract(args_json,'$.text'),
                             json_extract(args_json,'$.message'),
                             json_extract(args_json,'$.command'),
                             json_extract(args_json,'$.path'),
                             json_extract(args_json,'$.description'),''
                           ),1,?3)
                         ) ELSE '{}' END,
                    CASE WHEN length(CAST(result_json AS BLOB))<=?2
                         THEN result_json
                         WHEN json_valid(result_json) THEN json_object(
                           'content',substr(COALESCE(
                             json_extract(result_json,'$.content'),
                             json_extract(result_json,'$.text'),
                             json_extract(result_json,'$.message'),
                             json_extract(result_json,'$.output'),
                             json_extract(result_json,'$.summary'),''
                           ),1,?3)
                         ) ELSE '{}' END,
                    '',created_at,
                    CASE WHEN length(CAST(meta_json AS BLOB))<=?2
                         THEN meta_json ELSE json_object(
                           'source',CASE WHEN json_valid(meta_json)
                             THEN json_extract(meta_json,'$.source') END,
                           'displayText',CASE WHEN json_valid(meta_json)
                             THEN substr(json_extract(meta_json,'$.displayText'),1,1200) END,
                           'displayStatus',CASE WHEN json_valid(meta_json)
                             THEN json_extract(meta_json,'$.displayStatus') END,
                           'displayVariant',CASE WHEN json_valid(meta_json)
                             THEN json_extract(meta_json,'$.displayVariant') END,
                           'activityStatus',CASE WHEN json_valid(meta_json)
                             THEN json_extract(meta_json,'$.activityStatus') END,
                           'uiCanonical',CASE WHEN json_valid(meta_json)
                             THEN json_extract(meta_json,'$.uiCanonical') END,
                           'chunk_id',CASE WHEN json_valid(meta_json)
                             THEN json_extract(meta_json,'$.chunk_id') END
                         ) END,
                    history_sequence,
                    MIN(COALESCE(length(CAST(args_json AS BLOB)),0),?2) +
                    MIN(COALESCE(length(CAST(result_json AS BLOB)),0),?2) +
                    MIN(COALESCE(length(CAST(meta_json AS BLOB)),0),?2) +
                    COALESCE(length(CAST(id AS BLOB)),0) +
                    COALESCE(length(CAST(event_type AS BLOB)),0) +
                    COALESCE(length(CAST(function_name AS BLOB)),0) +
                    COALESCE(length(CAST(created_at AS BLOB)),0)
             FROM events
             WHERE session_id=?1 AND history_sequence IS NOT NULL
             ORDER BY history_sequence DESC
             LIMIT 400",
        )
        .map_err(|error| format!("prepare collaboration handoff fold: {error}"))?;
    let mut rows = statement
        .query(params![
            session_id,
            HANDOFF_FIELD_PREVIEW_BYTES,
            HANDOFF_FIELD_PREVIEW_CHARS,
        ])
        .map_err(|error| format!("query collaboration handoff fold: {error}"))?;
    let mut remaining = HANDOFF_SCAN_BYTES;
    let mut scanned_bytes = 0_u64;
    let mut scanned_events = 0_u64;
    let mut newest_first = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("read collaboration handoff row: {error}"))?
    {
        let row_bytes = row
            .get::<_, Option<i64>>(11)
            .map_err(|error| error.to_string())?
            .unwrap_or(0)
            .max(0) as usize;
        if row_bytes > remaining {
            break;
        }
        remaining -= row_bytes;
        scanned_bytes = scanned_bytes.saturating_add(row_bytes as u64);
        scanned_events = scanned_events.saturating_add(1);
        let cached = session_persistence::CachedEvent {
            id: row.get(0).map_err(|error| error.to_string())?,
            session_id: row.get(1).map_err(|error| error.to_string())?,
            event_type: row.get(2).map_err(|error| error.to_string())?,
            function_name: row.get(3).map_err(|error| error.to_string())?,
            thread_id: row.get(4).map_err(|error| error.to_string())?,
            args_json: row.get(5).map_err(|error| error.to_string())?,
            result_json: row.get(6).map_err(|error| error.to_string())?,
            content: row.get(7).map_err(|error| error.to_string())?,
            created_at: row.get(8).map_err(|error| error.to_string())?,
            meta_json: row.get(9).map_err(|error| error.to_string())?,
            history_sequence: row.get(10).map_err(|error| error.to_string())?,
        };
        let event = cached_event_to_session_event(&cached);
        if let Some(item) = handoff_item_from_event(&event) {
            newest_first.push(item);
            if newest_first.len() >= HANDOFF_MAX_ITEMS {
                break;
            }
        }
        if remaining == 0 {
            break;
        }
    }
    newest_first.reverse();
    Ok((newest_first, scanned_bytes, scanned_events))
}

pub(super) fn extend_time_range(
    time_range_start: &mut Option<String>,
    time_range_end: &mut Option<String>,
    created_at: &str,
) {
    if time_range_start
        .as_deref()
        .is_none_or(|current| created_at < current)
    {
        *time_range_start = Some(created_at.to_string());
    }
    if time_range_end
        .as_deref()
        .is_none_or(|current| created_at > current)
    {
        *time_range_end = Some(created_at.to_string());
    }
}

pub(super) fn publish_staged_snapshot(
    destination: &Connection,
    staging: &Connection,
    manifest: &StagingManifest,
    final_count: u64,
    final_frozen_count: u64,
) -> Result<CollaborationSnapshotIngestCommitResult, String> {
    // Incremental publication may read destination state only through primary
    // keys or bounded/indexed sentinels. History-sized aggregation belongs on
    // the token-scoped staging DB, whose size is exactly the incoming delta.
    let tx = database::db::begin_immediate(destination)
        .map_err(|error| format!("begin collaboration snapshot publish: {error}"))?;
    ensure_destination_schema(&tx)?;
    let current = match read_destination_cursor(&tx, &manifest.local_session_id) {
        Ok(cursor) => cursor,
        Err(_) if manifest.replace && manifest.previous.is_none() => None,
        Err(error) => return Err(error),
    };
    if let Some(previous) = manifest.previous.as_ref() {
        if current.as_ref() != Some(previous) {
            return Err("local collaboration snapshot changed before commit".to_string());
        }
    } else if !manifest.replace {
        return Err("incremental collaboration snapshot has no prior cursor".to_string());
    }
    let previous_session_metadata = if !manifest.replace {
        if !destination_indexes_are_installed(&tx)? {
            return Err(
                "local collaboration snapshot indexes are missing; rebuild required".to_string(),
            );
        }
        let current_cursor = current.as_ref().ok_or_else(|| {
            "incremental collaboration snapshot has no published base".to_string()
        })?;
        Some(
            destination_snapshot_constant_time_metadata(
                &tx,
                &manifest.local_session_id,
                current_cursor,
            )?
            .ok_or_else(|| {
                "local collaboration snapshot base is incomplete; rebuild required".to_string()
            })?,
        )
    } else {
        None
    };

    let target_cursor = CollaborationSnapshotCursor {
        epoch: manifest.epoch,
        frozen_seq: manifest.expected_frozen_seq,
        count: final_count,
        frozen_count: final_frozen_count,
        tail_hash: manifest.expected_tail_hash.clone(),
    };
    if !manifest.replace && current.as_ref() == Some(&target_cursor) {
        let (handoff_items, handoff_scanned_bytes, handoff_scanned_events) =
            collect_published_handoff(&tx, &manifest.local_session_id)?;
        tx.commit()
            .map_err(|error| format!("finish unchanged collaboration snapshot: {error}"))?;
        return Ok(CollaborationSnapshotIngestCommitResult {
            local_session_id: manifest.local_session_id.clone(),
            epoch: target_cursor.epoch,
            frozen_seq: target_cursor.frozen_seq,
            event_count: target_cursor.count,
            frozen_event_count: target_cursor.frozen_count,
            tail_hash: target_cursor.tail_hash,
            handoff_items,
            handoff_scanned_bytes,
            handoff_scanned_events,
        });
    }

    let imported_snapshot = is_imported_snapshot_session(&manifest.local_session_id);
    let native_snapshot = manifest.local_session_id.starts_with(AGENT_SESSION_PREFIX);
    if imported_snapshot {
        drop_replay_accounting_triggers(&tx)?;
    }
    if native_snapshot {
        // Replacing a large fork must not issue one state UPDATE per inherited
        // event. Rollback restores the previous triggers on failure; success
        // reinstalls them after publishing the new aggregate state below.
        drop_secondary_mutation_triggers(&tx)?;
    }
    if manifest.replace {
        tx.execute(
            "DELETE FROM events WHERE session_id=?1",
            [&manifest.local_session_id],
        )
        .map_err(|error| format!("clear prior collaboration snapshot events: {error}"))?;
        tx.execute(
            "DELETE FROM collaboration_snapshot_event_map WHERE session_id=?1",
            [&manifest.local_session_id],
        )
        .map_err(|error| format!("clear prior collaboration snapshot event map: {error}"))?;
        create_destination_indexes(&tx)?;
    } else {
        tx.execute(DELETE_TAIL_EVENTS_SQL, [&manifest.local_session_id])
            .map_err(|error| format!("replace prior collaboration snapshot tail: {error}"))?;
        tx.execute(DELETE_TAIL_MAP_SQL, [&manifest.local_session_id])
            .map_err(|error| format!("clear prior collaboration snapshot tail map: {error}"))?;
    }

    let base_logical_index = if manifest.replace {
        0_i64
    } else {
        i64::try_from(
            manifest
                .previous
                .as_ref()
                .map_or(0, |value| value.frozen_count),
        )
        .map_err(|_| "previous frozen event count is too large")?
    };
    let (mut time_start, mut time_end) = previous_session_metadata
        .map(|metadata| (metadata.time_range_start, metadata.time_range_end))
        .unwrap_or_default();
    let mut statement = staging
        .prepare(
            "SELECT normalized_id,original_id,physical_seq,event_index,is_tail,event_type,
                    function_name,thread_id,args_json,result_json,content,created_at,meta_json
             FROM staged_events ORDER BY is_tail ASC,physical_seq ASC,event_index ASC",
        )
        .map_err(|error| format!("prepare staged collaboration events: {error}"))?;
    let mut rows = statement
        .query([])
        .map_err(|error| format!("query staged collaboration events: {error}"))?;
    let mut offset = 0_i64;
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("read staged collaboration event: {error}"))?
    {
        let event_id: String = row.get(0).map_err(|error| error.to_string())?;
        let original_id: String = row.get(1).map_err(|error| error.to_string())?;
        let physical_seq: i64 = row.get(2).map_err(|error| error.to_string())?;
        let event_index: i64 = row.get(3).map_err(|error| error.to_string())?;
        let is_tail: bool = row.get::<_, i64>(4).map_err(|error| error.to_string())? != 0;
        let logical_index = base_logical_index
            .checked_add(offset)
            .ok_or_else(|| "published logical event index overflow".to_string())?;
        let created_at: String = row.get(11).map_err(|error| error.to_string())?;
        extend_time_range(&mut time_start, &mut time_end, &created_at);
        tx.execute(
            "INSERT INTO events(
               id,session_id,event_type,function_name,thread_id,args_json,result_json,
               content,created_at,meta_json,history_sequence
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                event_id,
                manifest.local_session_id,
                row.get::<_, String>(5).map_err(|error| error.to_string())?,
                row.get::<_, Option<String>>(6)
                    .map_err(|error| error.to_string())?,
                row.get::<_, Option<String>>(7)
                    .map_err(|error| error.to_string())?,
                row.get::<_, String>(8).map_err(|error| error.to_string())?,
                row.get::<_, String>(9).map_err(|error| error.to_string())?,
                row.get::<_, String>(10)
                    .map_err(|error| error.to_string())?,
                created_at,
                row.get::<_, Option<String>>(12)
                    .map_err(|error| error.to_string())?,
                logical_index,
            ],
        )
        .map_err(|error| format!("publish collaboration event {event_id}: {error}"))?;
        tx.execute(
            "INSERT INTO collaboration_snapshot_event_map(
               session_id,event_id,original_id,physical_seq,event_index,logical_index,is_tail
             ) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                manifest.local_session_id,
                event_id,
                original_id,
                physical_seq,
                event_index,
                logical_index,
                is_tail,
            ],
        )
        .map_err(|error| format!("publish collaboration event map: {error}"))?;
        offset += 1;
    }

    let published_logical_count = base_logical_index
        .checked_add(offset)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| "published logical event count overflow".to_string())?;
    if published_logical_count != final_count {
        return Err(format!(
            "published logical event count mismatch: expected {final_count}, got {published_logical_count}"
        ));
    }

    let now = Utc::now().timestamp();
    let final_event_count =
        i64::try_from(final_count).map_err(|_| "final event count is too large")?;
    let final_frozen_event_count =
        i64::try_from(final_frozen_count).map_err(|_| "final frozen event count is too large")?;
    let final_max_sequence = if final_event_count == 0 {
        -1
    } else {
        final_event_count - 1
    };
    tx.execute(
        "INSERT INTO sessions(
           session_id,event_count,cached_at,time_range_start,time_range_end,specs_json
         ) VALUES(?1,?2,?3,?4,?5,NULL)
         ON CONFLICT(session_id) DO UPDATE SET
           event_count=excluded.event_count,
           cached_at=excluded.cached_at,
           time_range_start=excluded.time_range_start,
           time_range_end=excluded.time_range_end",
        params![
            manifest.local_session_id,
            final_event_count,
            now,
            time_start,
            time_end,
        ],
    )
    .map_err(|error| format!("publish collaboration session metadata: {error}"))?;
    tx.execute(
        "INSERT INTO collaboration_snapshot_ingest_state(
           session_id,epoch,frozen_seq,event_count,frozen_event_count,tail_hash,updated_at
         ) VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(session_id) DO UPDATE SET
           epoch=excluded.epoch,
           frozen_seq=excluded.frozen_seq,
           event_count=excluded.event_count,
           frozen_event_count=excluded.frozen_event_count,
           tail_hash=excluded.tail_hash,
           updated_at=excluded.updated_at",
        params![
            manifest.local_session_id,
            manifest.epoch,
            i64::try_from(manifest.expected_frozen_seq)
                .map_err(|_| "final frozen sequence is too large")?,
            final_event_count,
            final_frozen_event_count,
            manifest.expected_tail_hash,
            now,
        ],
    )
    .map_err(|error| format!("publish collaboration snapshot cursor: {error}"))?;
    if native_snapshot {
        tx.execute(
            "INSERT INTO collaboration_snapshot_secondary_state(
               session_id,generation,revision,reset_revision,max_sequence,event_count
             ) VALUES(?1,0,0,0,?2,?3)
             ON CONFLICT(session_id) DO UPDATE SET
               generation=collaboration_snapshot_secondary_state.generation+1,
               revision=collaboration_snapshot_secondary_state.revision+1,
               reset_revision=collaboration_snapshot_secondary_state.revision+1,
               max_sequence=excluded.max_sequence,
               event_count=excluded.event_count",
            params![
                manifest.local_session_id,
                final_max_sequence,
                final_event_count,
            ],
        )
        .map_err(|error| format!("publish native fork secondary replay state: {error}"))?;
        ensure_secondary_mutation_triggers(&tx)?;
    }
    tx.execute(
        "DELETE FROM session_turns WHERE session_id=?1",
        [&manifest.local_session_id],
    )
    .map_err(|error| format!("invalidate collaboration turn summaries: {error}"))?;
    tx.execute(
        "DELETE FROM session_turn_index_state WHERE session_id=?1",
        [&manifest.local_session_id],
    )
    .map_err(|error| format!("invalidate collaboration turn index state: {error}"))?;
    if imported_snapshot {
        publish_replay_accounting_state(
            &tx,
            &manifest.local_session_id,
            final_event_count,
            final_max_sequence,
        )?;
    }
    let (handoff_items, handoff_scanned_bytes, handoff_scanned_events) =
        collect_published_handoff(&tx, &manifest.local_session_id)?;
    tx.commit()
        .map_err(|error| format!("commit collaboration snapshot publish: {error}"))?;

    Ok(CollaborationSnapshotIngestCommitResult {
        local_session_id: manifest.local_session_id.clone(),
        epoch: manifest.epoch,
        frozen_seq: manifest.expected_frozen_seq,
        event_count: final_count,
        frozen_event_count: final_frozen_count,
        tail_hash: manifest.expected_tail_hash.clone(),
        handoff_items,
        handoff_scanned_bytes,
        handoff_scanned_events,
    })
}

pub(super) fn commit_at_root_with_connection(
    root: &Path,
    token: &str,
    destination: &Connection,
) -> Result<CollaborationSnapshotIngestCommitResult, String> {
    let path = staging_path(root, token)?;
    let result = (|| {
        let mut staging = open_staging(&path)?;
        let manifest = load_manifest(&staging)?;
        if manifest.token != token {
            return Err("snapshot ingest token does not match its manifest".to_string());
        }
        finalize_attachments(&mut staging, root, &manifest)?;
        let (final_count, final_frozen_count) = validate_complete_staging(&staging, &manifest)?;
        publish_staged_snapshot(
            destination,
            &staging,
            &manifest,
            final_count,
            final_frozen_count,
        )
    })();
    // A commit token is single-use. Validation and SQLite failures are
    // fail-closed and cannot be repaired by replaying an ambiguous suffix.
    remove_staging_files(&path);
    remove_token_temp_files(root, token);
    result
}

pub(super) async fn collaboration_snapshot_ingest_commit_impl(
    request: CollaborationSnapshotIngestTokenRequest,
) -> Result<CollaborationSnapshotIngestCommitResult, String> {
    let root = staging_root()?;
    tokio::task::spawn_blocking(move || {
        database::db::with_sessions_writer(|| {
            let destination = database::db::get_connection()
                .map_err(|error| format!("open sessions.db for snapshot publish: {error}"))?;
            commit_at_root_with_connection(&root, &request.token, &destination)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}
