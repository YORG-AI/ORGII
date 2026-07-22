//! Canonical resource-interaction persistence shared by native runtime events
//! and reconciled provider transcripts.

use core_types::activity::ActivityChunk;
use core_types::extracted::ExtractedData;
use core_types::session_event::{EventDisplayStatus, SessionEvent};
use orgtrack_core::canonical::{
    AttributionPrecision, FileResourceRecord, ResourceAction, ResourceInteractionCaptureMethod,
    ResourceInteractionOutcome, ResourceInteractionRecord, SessionRecord,
    RESOURCE_INTERACTION_SCHEMA_VERSION,
};
use orgtrack_core::projectors::turn_metadata::metadata_projection_requirements;
use orgtrack_core::repo_sync::paths::{path_hash, record_id};
use orgtrack_core::resource_interaction::{
    activity_chunk_source_event_id, file_interactions_from_activity_chunk,
    interaction_outcome_from_activity_chunk,
};
use orgtrack_core::sources::imported_history::FUNCTION_USER_MESSAGE;
use orgtrack_core::store::RecordStore;
use rusqlite::Connection;
use session_persistence::CachedEvent;

use super::path_resolution::resolve_file_resource;

pub(crate) fn persist_native_event_interactions(
    store: &dyn RecordStore,
    session: &SessionRecord,
    event: &SessionEvent,
    turn_id: Option<&str>,
) -> Result<(), String> {
    let mut path_actions = match event.extracted.as_ref() {
        Some(ExtractedData::File(file)) => {
            vec![(file.file_path.clone(), ResourceAction::Read)]
        }
        Some(ExtractedData::Edit(edit)) if !edit.apply_patch_segments.is_empty() => edit
            .apply_patch_segments
            .iter()
            .map(|segment| {
                (
                    segment.file_path.clone(),
                    if segment.is_deleted {
                        ResourceAction::Delete
                    } else {
                        ResourceAction::Write
                    },
                )
            })
            .collect(),
        Some(ExtractedData::Edit(edit)) => vec![(
            edit.file_path.clone(),
            if edit.is_deleted {
                ResourceAction::Delete
            } else {
                ResourceAction::Write
            },
        )],
        Some(ExtractedData::DeleteFile(file)) => {
            vec![(file.file_path.clone(), ResourceAction::Delete)]
        }
        Some(ExtractedData::Search(search)) => search
            .results
            .iter()
            .map(|result| (result.file.clone(), ResourceAction::Search))
            .collect(),
        _ => Vec::new(),
    };
    path_actions.retain(|(path, _)| !path.trim().is_empty());
    path_actions.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then(left.1.as_str().cmp(right.1.as_str()))
    });
    path_actions.dedup();

    let workspace_path = event
        .repo_path
        .as_deref()
        .or(session.workspace_path.as_deref())
        .unwrap_or(".");
    let actor_id = session.org_member_id.as_deref().or_else(|| {
        session
            .parent_session_id
            .as_ref()
            .map(|_| session.session_id.as_str())
    });
    let precision = if actor_id.is_some() {
        AttributionPrecision::Exact
    } else {
        AttributionPrecision::SessionOnly
    };
    let outcome = if event.display_status == EventDisplayStatus::Failed {
        ResourceInteractionOutcome::Failed
    } else {
        ResourceInteractionOutcome::Succeeded
    };

    for (file_path, action) in path_actions {
        let source_event_base = event
            .result
            .get("call_id")
            .or_else(|| event.result.get("callId"))
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(&event.id);
        let source_event_id = format!("{source_event_base}:{}:{file_path}", action.as_str());
        persist_file_interaction(
            store,
            &session.source,
            Some(&session.source_session_id),
            &session.session_id,
            Some(&source_event_id),
            turn_id,
            actor_id,
            workspace_path,
            &file_path,
            action,
            outcome,
            &event.created_at,
            ResourceInteractionCaptureMethod::Native,
            precision,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[cfg(test)]
pub(crate) fn persist_activity_chunks(
    store: &dyn RecordStore,
    source: &str,
    source_session_id: Option<&str>,
    session_id: &str,
    actor_id: Option<&str>,
    workspace_path: &str,
    precision: AttributionPrecision,
    chunks: &[ActivityChunk],
) -> Result<usize, String> {
    let mut current_turn_id = None;
    persist_activity_chunks_with_turn_state(
        store,
        source,
        source_session_id,
        session_id,
        actor_id,
        workspace_path,
        precision,
        chunks,
        &mut current_turn_id,
    )
}

/// Persist one bounded replay batch while carrying the user-turn boundary
/// across batches. This prevents backend metadata consumers from rebuilding a
/// session-sized `Vec<ActivityChunk>` merely to preserve turn attribution.
#[allow(clippy::too_many_arguments)]
pub(crate) fn persist_activity_chunks_with_turn_state(
    store: &dyn RecordStore,
    source: &str,
    source_session_id: Option<&str>,
    session_id: &str,
    actor_id: Option<&str>,
    workspace_path: &str,
    precision: AttributionPrecision,
    chunks: &[ActivityChunk],
    current_turn_id: &mut Option<String>,
) -> Result<usize, String> {
    let mut persisted = 0;
    for chunk in chunks {
        if chunk.function == FUNCTION_USER_MESSAGE {
            *current_turn_id = Some(chunk.chunk_id.clone());
            continue;
        }
        let outcome = interaction_outcome_from_activity_chunk(chunk);
        for interaction in file_interactions_from_activity_chunk(chunk) {
            let source_event_id = activity_chunk_source_event_id(chunk, &interaction);
            persist_file_interaction(
                store,
                source,
                source_session_id,
                session_id,
                Some(&source_event_id),
                current_turn_id.as_deref(),
                actor_id,
                workspace_path,
                &interaction.file_path,
                interaction.action,
                outcome,
                &chunk.created_at,
                ResourceInteractionCaptureMethod::Reconciled,
                precision,
            )?;
            persisted += 1;
        }
    }
    Ok(persisted)
}

/// Stream resource metadata out of the session event cache without ever
/// building a session-sized `Vec<CachedEvent>` or `Vec<ActivityChunk>`.
///
/// The projection classifier runs before either JSON column is copied from
/// SQLite. Known assistant/thinking/REPL rows therefore cost only their small
/// discriminator fields; Grep reads its compact args but never its potentially
/// huge result. Unknown tools deliberately keep the conservative old path.
#[allow(clippy::too_many_arguments)]
pub(crate) fn persist_cached_event_interactions_streaming(
    conn: &Connection,
    store: &dyn RecordStore,
    source: &str,
    source_session_id: Option<&str>,
    session_id: &str,
    actor_id: Option<&str>,
    workspace_path: &str,
    precision: AttributionPrecision,
    mut map_path: impl FnMut(&str) -> Option<String>,
) -> Result<usize, String> {
    let mut statement = conn
        .prepare_cached(
            "SELECT id, session_id, event_type, function_name, thread_id,
                    created_at, history_sequence, args_json, result_json
             FROM events
             WHERE session_id = ?1
             ORDER BY COALESCE(history_sequence, rowid) ASC, created_at ASC, id ASC",
        )
        .map_err(|err| format!("Prepare cached event projection stream failed: {err}"))?;
    let mut rows = statement
        .query([session_id])
        .map_err(|err| format!("Query cached event projection stream failed: {err}"))?;
    let mut persisted = 0;
    let mut current_turn_id: Option<String> = None;
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("Read cached event projection row failed: {err}"))?
    {
        let id = row
            .get::<_, String>(0)
            .map_err(|err| format!("Read cached event id failed: {err}"))?;
        let function_name = row
            .get::<_, Option<String>>(3)
            .map_err(|err| format!("Read cached event function failed: {err}"))?;
        if function_name.as_deref() == Some(FUNCTION_USER_MESSAGE) {
            current_turn_id = Some(id);
            continue;
        }
        let requirements = metadata_projection_requirements(function_name.as_deref());
        if !requirements.projects_resource_interactions() {
            continue;
        }

        let event = CachedEvent {
            id,
            session_id: row
                .get(1)
                .map_err(|err| format!("Read cached event session id failed: {err}"))?,
            event_type: row
                .get(2)
                .map_err(|err| format!("Read cached event type failed: {err}"))?,
            function_name,
            thread_id: row
                .get(4)
                .map_err(|err| format!("Read cached event thread id failed: {err}"))?,
            args_json: if requirements.needs_args_json() {
                row.get(7)
                    .map_err(|err| format!("Read cached event args failed: {err}"))?
            } else {
                "null".to_string()
            },
            result_json: if requirements.needs_result_json() {
                row.get(8)
                    .map_err(|err| format!("Read cached event result failed: {err}"))?
            } else {
                "null".to_string()
            },
            content: String::new(),
            created_at: row
                .get(5)
                .map_err(|err| format!("Read cached event timestamp failed: {err}"))?,
            meta_json: None,
            history_sequence: row
                .get(6)
                .map_err(|err| format!("Read cached event sequence failed: {err}"))?,
        };
        let chunk = cached_event_to_activity_chunk(&event);
        let outcome = interaction_outcome_from_activity_chunk(&chunk);
        for mut interaction in file_interactions_from_activity_chunk(&chunk) {
            let Some(mapped_path) = map_path(&interaction.file_path) else {
                continue;
            };
            interaction.file_path = mapped_path;
            let source_event_id = activity_chunk_source_event_id(&chunk, &interaction);
            persist_file_interaction(
                store,
                source,
                source_session_id,
                session_id,
                Some(&source_event_id),
                current_turn_id.as_deref(),
                actor_id,
                workspace_path,
                &interaction.file_path,
                interaction.action,
                outcome,
                &chunk.created_at,
                ResourceInteractionCaptureMethod::Reconciled,
                precision,
            )?;
            persisted += 1;
        }
    }
    Ok(persisted)
}

pub(crate) fn cached_event_to_activity_chunk(event: &CachedEvent) -> ActivityChunk {
    ActivityChunk {
        chunk_id: event.id.clone(),
        session_id: event.session_id.clone(),
        action_type: event.event_type.clone(),
        function: event.function_name.clone().unwrap_or_default(),
        args: serde_json::from_str(&event.args_json).unwrap_or(serde_json::Value::Null),
        result: serde_json::from_str(&event.result_json).unwrap_or(serde_json::Value::Null),
        created_at: event.created_at.clone(),
        // This remains the execution thread/subagent dimension. Turn identity
        // is inferred from user-message boundaries in `persist_activity_chunks`.
        thread_id: event.thread_id.clone(),
        process_id: None,
        broadcast_only: false,
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn persist_file_interaction(
    store: &dyn RecordStore,
    source: &str,
    source_session_id: Option<&str>,
    session_id: &str,
    source_event_id: Option<&str>,
    turn_id: Option<&str>,
    actor_id: Option<&str>,
    cwd: &str,
    file_path: &str,
    action: ResourceAction,
    outcome: ResourceInteractionOutcome,
    occurred_at: &str,
    capture_method: ResourceInteractionCaptureMethod,
    attribution_precision: AttributionPrecision,
) -> Result<(), String> {
    let resolved = resolve_file_resource(cwd, file_path);
    let repository_locator = resolved
        .repository_id
        .as_deref()
        .unwrap_or(&resolved.workspace_path);
    let resource_id = record_id(&[
        "resource",
        "file",
        repository_locator,
        &resolved.repo_relative_path,
    ]);
    store.upsert_file_resource(&FileResourceRecord {
        schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
        resource_id: resource_id.clone(),
        repository_id: resolved.repository_id,
        workspace_path: resolved.workspace_path,
        repo_relative_path: resolved.repo_relative_path.clone(),
        display_path: resolved.display_path,
        path_hash: path_hash(&resolved.repo_relative_path),
    })?;

    let interaction_id = resource_interaction_id(
        source,
        session_id,
        source_event_id,
        actor_id,
        &resource_id,
        action,
        occurred_at,
        capture_method,
    );
    store.append_resource_interaction(&ResourceInteractionRecord {
        schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
        interaction_id,
        source: source.to_string(),
        source_session_id: source_session_id.map(str::to_string),
        source_event_id: source_event_id.map(str::to_string),
        session_id: session_id.to_string(),
        turn_id: turn_id.map(str::to_string),
        actor_id: actor_id.map(str::to_string),
        resource_id,
        action,
        outcome,
        occurred_at: occurred_at.to_string(),
        capture_method,
        attribution_precision,
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn resource_interaction_id(
    source: &str,
    session_id: &str,
    source_event_id: Option<&str>,
    actor_id: Option<&str>,
    resource_id: &str,
    action: ResourceAction,
    occurred_at: &str,
    capture_method: ResourceInteractionCaptureMethod,
) -> String {
    record_id(&[
        "interaction",
        source,
        session_id,
        source_event_id.unwrap_or(""),
        actor_id.unwrap_or(""),
        resource_id,
        action.as_str(),
        occurred_at,
        capture_method.as_str(),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use orgtrack_core::store::sqlite::SqliteRecordStore;
    use rusqlite::{params, Connection};

    const INSERT_EVENT: &str = "INSERT INTO events (
            id, session_id, event_type, function_name, thread_id,
            args_json, result_json, content, created_at, meta_json, history_sequence
         ) VALUES (?1, 'snapshot', 'tool_call', ?2, NULL, ?3, ?4, '', ?5, NULL, ?6)";

    #[test]
    fn cached_projection_stream_skips_unneeded_blob_payloads() {
        let conn = Connection::open_in_memory().expect("open DB");
        session_persistence::init_session_tables(&conn).expect("session tables");
        SqliteRecordStore::init_tables(&conn).expect("orgtrack tables");

        conn.execute(
            INSERT_EVENT,
            params![
                "user-1",
                FUNCTION_USER_MESSAGE,
                "null",
                "null",
                "2026-07-22T00:00:00Z",
                0_i64
            ],
        )
        .expect("user row");
        conn.execute(
            INSERT_EVENT,
            params![
                "assistant-1",
                "assistant",
                vec![0xff_u8; 1024 * 1024],
                vec![0xfe_u8; 1024 * 1024],
                "2026-07-22T00:00:01Z",
                1_i64
            ],
        )
        .expect("assistant blob row");
        conn.execute(
            INSERT_EVENT,
            params![
                "grep-1",
                "Grep",
                r#"{"path":"src"}"#,
                vec![0xfd_u8; 1024 * 1024],
                "2026-07-22T00:00:02Z",
                2_i64
            ],
        )
        .expect("grep blob result row");
        conn.execute(
            INSERT_EVENT,
            params![
                "edit-1",
                "write_file",
                r#"{"file_path":"src/main.rs","content":"ok"}"#,
                r#"{"success":true}"#,
                "2026-07-22T00:00:03Z",
                3_i64
            ],
        )
        .expect("edit row");

        let store = SqliteRecordStore::new(&conn);
        let persisted = persist_cached_event_interactions_streaming(
            &conn,
            &store,
            "test-source",
            Some("source-session"),
            "snapshot",
            Some("actor"),
            "/repo",
            AttributionPrecision::Exact,
            |path| Some(path.to_string()),
        )
        .expect("stream projection");

        assert_eq!(persisted, 1);
    }
}
