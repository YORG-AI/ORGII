//! Runtime orgtrack artifact persistence.
//!
//! Projects live `SessionEvent`s (native Rust agent execution, not an
//! imported provider transcript) into the orgtrack schema: the owning
//! `SessionRecord`, native interaction rows, and edit/diff-chunk artifacts
//! extracted from `ExtractedData::Edit` payloads. Runs off the hot path via
//! `spawn_blocking`, invoked from [`super::push_events_to_session`].

use std::collections::HashMap;

use core_types::extracted::ExtractedData;
use database::db::get_connection;
use orgtrack_core::canonical::{
    AgentMetadata, SessionDiffChunkRecord, SessionRecord, SOURCE_ORGII_RUST_AGENTS,
};
use orgtrack_core::edit_extraction::{
    artifacts_from_extracted_edit, final_diff_from_chunks, EditArtifactContext,
};
use orgtrack_core::privacy::ORGTRACK_SCHEMA_VERSION;
use orgtrack_core::store::{sqlite::SqliteRecordStore, RecordStore};
use tauri::Emitter;

use crate::agent_sessions::event_pipeline::types::SessionEvent;

pub(super) fn persist_runtime_orgtrack_records_async(
    app: tauri::AppHandle,
    session_id: String,
    events: Vec<(usize, Option<String>, SessionEvent)>,
) {
    tokio::task::spawn_blocking(move || {
        match persist_runtime_orgtrack_records(&session_id, events) {
            Ok(()) => {
                let _ = app.emit(
                    crate::orgtrack::session_provenance::RESOURCE_INTERACTIONS_CHANGED_EVENT,
                    (),
                );
            }
            Err(err) => {
                tracing::warn!(
                    session_id = %session_id,
                    error = %err,
                    "[orgtrack_runtime_artifacts] failed to persist runtime provenance records"
                );
            }
        }
    });
}

fn persist_runtime_orgtrack_records(
    session_id: &str,
    events: Vec<(usize, Option<String>, SessionEvent)>,
) -> Result<(), String> {
    if events.is_empty() {
        return Ok(());
    }

    let conn = get_connection().map_err(|err| err.to_string())?;
    let store = SqliteRecordStore::new(&conn);
    let session = runtime_artifact_session_record(session_id)?;
    store.upsert_session(&session)?;

    let mut chunks_by_file: HashMap<String, Vec<SessionDiffChunkRecord>> = HashMap::new();
    for (sequence_index, turn_id, event) in events {
        if let Err(err) = crate::orgtrack::session_provenance::persist_native_event_interactions(
            &store,
            &session,
            &event,
            turn_id.as_deref(),
        ) {
            tracing::warn!(
                session_id = %session.session_id,
                event_id = %event.id,
                error = %err,
                "[SessionProvenance] Native interaction persistence failed"
            );
        }
        let Some(ExtractedData::Edit(edit)) = event.extracted.as_ref() else {
            continue;
        };
        let context = EditArtifactContext {
            source: SOURCE_ORGII_RUST_AGENTS.to_string(),
            source_session_id: Some(session.source_session_id.clone()),
            session_id: session.session_id.clone(),
            source_event_id: Some(event.id.clone()),
            turn_id,
            sequence_index: sequence_index as i64,
            timestamp: Some(event.created_at.clone()),
            workspace_path: event
                .repo_path
                .clone()
                .or_else(|| session.workspace_path.clone()),
            metadata: session.metadata.clone(),
        };
        let artifacts = artifacts_from_extracted_edit(&context, edit);
        for artifact in &artifacts.edits {
            store.upsert_edit_artifact(artifact)?;
        }
        for chunk in artifacts.chunks {
            chunks_by_file
                .entry(chunk.file_path.clone())
                .or_default()
                .push(chunk.clone());
            store.upsert_diff_chunk(&chunk)?;
        }
    }

    for (file_path, chunks) in chunks_by_file {
        if let Some(final_diff) = final_diff_from_chunks(
            SOURCE_ORGII_RUST_AGENTS,
            &session.session_id,
            &file_path,
            &chunks,
        ) {
            store.upsert_final_diff(&final_diff)?;
        }
    }

    Ok(())
}

pub(crate) fn runtime_artifact_session_record(session_id: &str) -> Result<SessionRecord, String> {
    let Some(record) =
        agent_core::session::persistence::get_session(session_id).map_err(|err| err.to_string())?
    else {
        return Ok(SessionRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            source: SOURCE_ORGII_RUST_AGENTS.to_string(),
            source_session_id: session_id.to_string(),
            session_id: session_id.to_string(),
            title: session_id.to_string(),
            status: None,
            created_at: None,
            updated_at: None,
            completed_at: None,
            workspace_path: None,
            branch: None,
            parent_session_id: None,
            org_member_id: None,
            collaboration_origin: None,
            metadata: AgentMetadata {
                dispatch_category: Some("rust_agent".to_string()),
                origin: Some(SOURCE_ORGII_RUST_AGENTS.to_string()),
                ..AgentMetadata::default()
            },
        });
    };

    let rust_agent_type = match record.session_type.as_str() {
        agent_core::session::persistence::session_type::HUMAN => None,
        agent_core::session::persistence::session_type::DESKTOP => Some("os".to_string()),
        agent_core::session::persistence::session_type::CODING
        | agent_core::session::persistence::session_type::ORG_MEMBER => Some("sde".to_string()),
        agent_core::session::persistence::session_type::GATEWAY => Some("gateway".to_string()),
        _ => Some("custom".to_string()),
    };
    let dispatch_category =
        if record.session_type == agent_core::session::persistence::session_type::HUMAN {
            "human_session"
        } else {
            "rust_agent"
        };
    Ok(SessionRecord {
        schema_version: ORGTRACK_SCHEMA_VERSION,
        source: SOURCE_ORGII_RUST_AGENTS.to_string(),
        source_session_id: record.session_id.clone(),
        session_id: record.session_id,
        title: record.name.clone(),
        status: Some(record.status),
        created_at: Some(record.created_at),
        updated_at: Some(record.updated_at),
        completed_at: None,
        workspace_path: record
            .workspace_path
            .clone()
            .or_else(|| record.worktree_path.clone()),
        branch: record.worktree_branch.or(record.base_branch),
        parent_session_id: record.parent_session_id,
        org_member_id: record.org_member_id,
        collaboration_origin: None,
        metadata: AgentMetadata {
            dispatch_category: Some(dispatch_category.to_string()),
            rust_agent_type,
            agent_exec_mode: record.agent_exec_mode,
            model: record.model,
            key_source: Some(record.key_source.to_string()),
            origin: Some(SOURCE_ORGII_RUST_AGENTS.to_string()),
            display_name: Some(record.name),
            ..AgentMetadata::default()
        },
    })
}
