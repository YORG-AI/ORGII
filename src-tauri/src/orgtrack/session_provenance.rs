//! Session-to-resource provenance ingestion.
//!
//! External hooks are intentionally split into two processes:
//! 1. the lightweight hook invocation normalizes vendor JSON and atomically
//!    writes privacy-filtered envelopes to an inbox;
//! 2. the desktop process drains that inbox and performs canonical DB writes.
//!
//! This keeps hooks fast, avoids SQLite contention, and ensures raw prompts,
//! tool responses, commands, and file contents never enter the spool.

mod approval_gate;
mod collaboration_replay;
mod historical_backfill;
mod hook_capture;
mod interaction_store;
mod path_resolution;
mod status_post;

pub(crate) use collaboration_replay::{delete_collaboration_replay, index_collaboration_replay};
pub(super) use historical_backfill::request_historical_backfill;
pub(crate) use historical_backfill::spawn_codex_write_reconciliation_loop;
pub use hook_capture::capture_hook_stdin;
pub(super) use hook_capture::drain_hook_inbox;
pub(crate) use hook_capture::notify_hook_inbox_ready;
#[cfg(test)]
use hook_capture::quarantine_invalid_envelope;
pub(crate) use hook_capture::spawn_hook_inbox_drain_loop;
use interaction_store::persist_file_interaction;
pub(crate) use interaction_store::persist_native_event_interactions;
#[cfg(test)]
use interaction_store::resource_interaction_id;
pub(super) use interaction_store::{cached_event_to_activity_chunk, persist_activity_chunks};
pub(super) use path_resolution::{canonicalize_existing_prefix, resolve_file_resource};

use std::path::Path;

use orgtrack_core::canonical::{
    AgentMetadata, AttributionPrecision, ResourceInteractionCaptureMethod,
    ResourceInteractionEnvelopeV1, SessionActorLifecycleEnvelopeV1, SessionActorLifecyclePhase,
    SessionActorRecord, SessionRecord, SESSION_ACTOR_SCHEMA_VERSION,
    SESSION_PROVENANCE_HOOK_ORIGIN,
};
use orgtrack_core::privacy::ORGTRACK_SCHEMA_VERSION;
use orgtrack_core::repo_sync::paths::record_id;
use orgtrack_core::sources::codex::app::{
    load_codex_app_from_path, resolve_codex_transcript_for_thread_id_near_path,
};
use orgtrack_core::sources::imported_history::metadata::SOURCE_CODEX_APP;
use orgtrack_core::store::{sqlite::SqliteRecordStore, RecentHookSignal, RecordStore};

pub(crate) const RESOURCE_INTERACTIONS_CHANGED_EVENT: &str =
    "orgtrack:resource-interactions-changed";

#[tauri::command]
pub async fn session_provenance_recent_signals(
    limit: Option<usize>,
) -> Result<Vec<RecentHookSignal>, String> {
    hook_capture::recent_signals(limit).await
}

fn persist_actor_lifecycle(
    store: &SqliteRecordStore<'_>,
    envelope: &SessionActorLifecycleEnvelopeV1,
) -> Result<(), String> {
    let existing = store.get_session_actor_by_source_identity(
        &envelope.source,
        &envelope.source_session_id,
        &envelope.actor_id,
    )?;
    let root_transcript = resolve_lifecycle_root_transcript(envelope)?;
    let root_session_id = root_transcript
        .as_ref()
        .map(|locator| locator.session_id.clone())
        .or_else(|| {
            existing
                .as_ref()
                .map(|record| record.session_id.clone())
                .filter(|session_id| codex_rollout_source_session_id(session_id).is_some())
        })
        .or_else(|| {
            codex_rollout_source_session_id(&envelope.session_id)
                .map(|_| envelope.session_id.clone())
        })
        .or_else(|| existing.as_ref().map(|record| record.session_id.clone()))
        .unwrap_or_else(|| envelope.session_id.clone());
    let root_source_session_id = root_transcript
        .as_ref()
        .map(|locator| locator.source_session_id.clone())
        .or_else(|| codex_rollout_source_session_id(&root_session_id).map(ToString::to_string))
        .unwrap_or_else(|| envelope.source_session_id.clone());

    let mut root_session = match store.get_session(&root_session_id)? {
        Some(mut session) => {
            session.created_at =
                merge_earliest_timestamp(session.created_at, Some(envelope.occurred_at.as_str()));
            session.updated_at =
                merge_latest_timestamp(session.updated_at, Some(envelope.occurred_at.as_str()));
            session
        }
        None => SessionRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            source: envelope.source.clone(),
            source_session_id: root_source_session_id.clone(),
            session_id: root_session_id.clone(),
            title: root_source_session_id,
            status: None,
            created_at: Some(envelope.occurred_at.clone()),
            updated_at: Some(envelope.occurred_at.clone()),
            completed_at: None,
            workspace_path: Some(envelope.cwd.clone()),
            branch: None,
            parent_session_id: None,
            org_member_id: None,
            collaboration_origin: None,
            metadata: AgentMetadata {
                origin: Some(SESSION_PROVENANCE_HOOK_ORIGIN.to_string()),
                ..AgentMetadata::default()
            },
        },
    };
    if root_transcript.is_some() {
        // The resolver found a concrete rollout file. Promote a prior hook
        // placeholder to a replayable session without waiting for backfill.
        root_session.metadata.origin = Some(envelope.source.clone());
    }
    store.upsert_session(&root_session)?;

    let transcript = actor_transcript_target(envelope)
        .or_else(|| existing.as_ref().and_then(stored_actor_transcript_target));
    if let Some((source_session_id, transcript_session_id, _)) = transcript.as_ref() {
        let child = match store.get_session(transcript_session_id)? {
            Some(mut child) => {
                child.parent_session_id = Some(root_session_id.clone());
                child.created_at =
                    merge_earliest_timestamp(child.created_at, Some(envelope.occurred_at.as_str()));
                child.updated_at =
                    merge_latest_timestamp(child.updated_at, Some(envelope.occurred_at.as_str()));
                if envelope.phase == SessionActorLifecyclePhase::Stopped {
                    child.completed_at = merge_latest_timestamp(
                        child.completed_at,
                        Some(envelope.occurred_at.as_str()),
                    );
                }
                child.metadata.origin = Some(envelope.source.clone());
                child
            }
            None => SessionRecord {
                schema_version: ORGTRACK_SCHEMA_VERSION,
                source: envelope.source.clone(),
                source_session_id: source_session_id.clone(),
                session_id: transcript_session_id.clone(),
                title: envelope
                    .actor_type
                    .clone()
                    .unwrap_or_else(|| envelope.actor_id.clone()),
                status: None,
                created_at: Some(envelope.occurred_at.clone()),
                updated_at: Some(envelope.occurred_at.clone()),
                completed_at: (envelope.phase == SessionActorLifecyclePhase::Stopped)
                    .then(|| envelope.occurred_at.clone()),
                workspace_path: Some(envelope.cwd.clone()),
                branch: None,
                parent_session_id: Some(root_session_id.clone()),
                org_member_id: None,
                collaboration_origin: None,
                metadata: AgentMetadata {
                    origin: Some(envelope.source.clone()),
                    display_name: envelope.actor_type.clone(),
                    ..AgentMetadata::default()
                },
            },
        };
        store.upsert_session(&child)?;
    }

    let (transcript_source_session_id, transcript_session_id, transcript_path) = transcript
        .map(|(source_session_id, session_id, path)| {
            (Some(source_session_id), Some(session_id), Some(path))
        })
        .unwrap_or((None, None, None));
    let started_at = merge_earliest_timestamp(
        existing
            .as_ref()
            .and_then(|record| record.started_at.clone()),
        (envelope.phase == SessionActorLifecyclePhase::Started)
            .then_some(envelope.occurred_at.as_str()),
    );
    let stopped_at = merge_latest_timestamp(
        existing
            .as_ref()
            .and_then(|record| record.stopped_at.clone()),
        (envelope.phase == SessionActorLifecyclePhase::Stopped)
            .then_some(envelope.occurred_at.as_str()),
    );
    let actor_record = SessionActorRecord {
        schema_version: SESSION_ACTOR_SCHEMA_VERSION,
        actor_record_id: record_id(&[
            "session-actor",
            &envelope.source,
            &envelope.source_session_id,
            &envelope.actor_id,
        ]),
        source: envelope.source.clone(),
        source_session_id: envelope.source_session_id.clone(),
        session_id: root_session_id,
        turn_id: envelope
            .turn_id
            .clone()
            .or_else(|| existing.as_ref().and_then(|record| record.turn_id.clone())),
        actor_id: envelope.actor_id.clone(),
        actor_type: envelope.actor_type.clone().or_else(|| {
            existing
                .as_ref()
                .and_then(|record| record.actor_type.clone())
        }),
        started_at,
        stopped_at,
        transcript_session_id: transcript_session_id.or_else(|| {
            existing
                .as_ref()
                .and_then(|record| record.transcript_session_id.clone())
        }),
        transcript_path: transcript_path.or_else(|| {
            existing
                .as_ref()
                .and_then(|record| record.transcript_path.clone())
        }),
    };
    store.upsert_session_actor(&actor_record)?;

    if envelope.phase == SessionActorLifecyclePhase::Stopped {
        if let (Some(source_session_id), Some(transcript_session_id), Some(transcript_path)) = (
            transcript_source_session_id.as_deref(),
            actor_record.transcript_session_id.as_deref(),
            actor_record.transcript_path.as_deref(),
        ) {
            let path = Path::new(transcript_path);
            if path.is_file() {
                match load_codex_app_from_path(transcript_session_id, path) {
                    Ok(chunks) => {
                        store.delete_reconciled_resource_interactions(
                            &envelope.source,
                            transcript_session_id,
                        )?;
                        persist_activity_chunks(
                            store,
                            &envelope.source,
                            Some(source_session_id),
                            transcript_session_id,
                            Some(&envelope.actor_id),
                            &envelope.cwd,
                            AttributionPrecision::Exact,
                            &chunks,
                        )?;
                    }
                    Err(err) => tracing::warn!(
                        actor_id = %envelope.actor_id,
                        transcript_path,
                        error = %err,
                        "[SessionProvenance] Codex subagent transcript reconciliation failed"
                    ),
                }
            }
        }
    }
    Ok(())
}

fn merge_earliest_timestamp(current: Option<String>, incoming: Option<&str>) -> Option<String> {
    match (current, incoming) {
        (Some(current), Some(incoming)) if incoming < current.as_str() => {
            Some(incoming.to_string())
        }
        (Some(current), _) => Some(current),
        (None, Some(incoming)) => Some(incoming.to_string()),
        (None, None) => None,
    }
}

fn merge_latest_timestamp(current: Option<String>, incoming: Option<&str>) -> Option<String> {
    match (current, incoming) {
        (Some(current), Some(incoming)) if incoming > current.as_str() => {
            Some(incoming.to_string())
        }
        (Some(current), _) => Some(current),
        (None, Some(incoming)) => Some(incoming.to_string()),
        (None, None) => None,
    }
}

fn codex_rollout_source_session_id(session_id: &str) -> Option<&str> {
    if !session_id.starts_with(orgtrack_core::sources::codex::SESSION_PREFIX) {
        return None;
    }
    session_id
        .strip_prefix(orgtrack_core::sources::codex::SESSION_PREFIX)
        .filter(|source_session_id| source_session_id.starts_with("rollout-"))
}

fn resolve_lifecycle_root_transcript(
    envelope: &SessionActorLifecycleEnvelopeV1,
) -> Result<Option<orgtrack_core::sources::codex::app::CodexTranscriptLocator>, String> {
    if envelope.source != SOURCE_CODEX_APP {
        return Ok(None);
    }
    let Some(reference_path) = envelope
        .transcript_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    else {
        return Ok(None);
    };
    resolve_codex_transcript_for_thread_id_near_path(
        Path::new(reference_path),
        &envelope.source_session_id,
    )
}

fn actor_transcript_target(
    envelope: &SessionActorLifecycleEnvelopeV1,
) -> Option<(String, String, String)> {
    if envelope.source != SOURCE_CODEX_APP {
        return None;
    }
    let path = envelope.transcript_path.as_deref()?.trim();
    if !Path::new(path).is_file() {
        return None;
    }
    let source_session_id = Path::new(path)
        .file_stem()
        .and_then(|value| value.to_str())?
        .trim();
    if source_session_id.is_empty() {
        return None;
    }
    Some((
        source_session_id.to_string(),
        orgtrack_core::sources::codex::canonical_session_id(source_session_id),
        path.to_string(),
    ))
}

fn stored_actor_transcript_target(record: &SessionActorRecord) -> Option<(String, String, String)> {
    if record.source != SOURCE_CODEX_APP {
        return None;
    }
    let path = record.transcript_path.as_deref()?.trim();
    if !Path::new(path).is_file() {
        return None;
    }
    let source_session_id = Path::new(path)
        .file_stem()
        .and_then(|value| value.to_str())?
        .trim();
    let transcript_session_id = record.transcript_session_id.as_deref()?.trim();
    if source_session_id.is_empty() || transcript_session_id.is_empty() {
        return None;
    }
    Some((
        source_session_id.to_string(),
        transcript_session_id.to_string(),
        path.to_string(),
    ))
}

fn persist_envelope(
    store: &dyn RecordStore,
    envelope: &ResourceInteractionEnvelopeV1,
) -> Result<(), String> {
    if store.get_session(&envelope.session_id)?.is_none() {
        store.upsert_session(&SessionRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            source: envelope.source.clone(),
            source_session_id: envelope.source_session_id.clone(),
            session_id: envelope.session_id.clone(),
            title: envelope.source_session_id.clone(),
            status: None,
            created_at: Some(envelope.occurred_at.clone()),
            updated_at: Some(envelope.occurred_at.clone()),
            completed_at: None,
            workspace_path: Some(envelope.cwd.clone()),
            branch: None,
            parent_session_id: None,
            // Actor/subagent identity belongs to the interaction. It must not
            // be promoted to session-level org membership.
            org_member_id: None,
            collaboration_origin: None,
            metadata: AgentMetadata {
                origin: Some(SESSION_PROVENANCE_HOOK_ORIGIN.to_string()),
                ..AgentMetadata::default()
            },
        })?;
    }

    persist_file_interaction(
        store,
        &envelope.source,
        Some(&envelope.source_session_id),
        &envelope.session_id,
        envelope.source_event_id.as_deref(),
        envelope.turn_id.as_deref(),
        envelope.actor_id.as_deref(),
        &envelope.cwd,
        &envelope.file_path,
        envelope.action,
        envelope.outcome,
        &envelope.occurred_at,
        ResourceInteractionCaptureMethod::Hook,
        envelope.attribution_precision,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use orgtrack_core::canonical::ResourceAction;
    use orgtrack_core::sources::codex::app::load_codex_app_for_session;
    use orgtrack_core::sources::imported_history::metadata::SOURCE_CLAUDE_CODE;
    use rusqlite::Connection;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn interaction_identity_preserves_independent_capture_observations() {
        let hook_id = resource_interaction_id(
            SOURCE_CLAUDE_CODE,
            "root-session",
            Some("tool-1"),
            None,
            "file-1",
            ResourceAction::Read,
            "2026-07-14T01:00:00Z",
            ResourceInteractionCaptureMethod::Hook,
        );
        let reconciled_id = resource_interaction_id(
            SOURCE_CLAUDE_CODE,
            "child-session",
            Some("tool-1"),
            Some("agent-1"),
            "file-1",
            ResourceAction::Read,
            "2026-07-14T01:00:00Z",
            ResourceInteractionCaptureMethod::Reconciled,
        );

        assert_ne!(hook_id, reconciled_id);
        assert_eq!(
            hook_id,
            resource_interaction_id(
                SOURCE_CLAUDE_CODE,
                "root-session",
                Some("tool-1"),
                None,
                "file-1",
                ResourceAction::Read,
                "2026-07-14T01:00:00Z",
                ResourceInteractionCaptureMethod::Hook,
            )
        );
    }

    #[test]
    fn resolves_relative_paths_without_leaking_content() {
        let temp = tempfile::tempdir().expect("temp workspace");
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(workspace.join("src")).expect("workspace tree");
        let resolved =
            resolve_file_resource(workspace.to_string_lossy().as_ref(), "src/../src/lib.rs");
        assert_eq!(
            PathBuf::from(&resolved.workspace_path),
            fs::canonicalize(&workspace).expect("canonical workspace")
        );
        assert_eq!(resolved.repo_relative_path, "src/lib.rs");
        assert_eq!(resolved.display_path, "src/lib.rs");
    }

    #[test]
    fn malformed_envelopes_are_quarantined_for_upgrade_diagnostics() {
        let temp = tempfile::tempdir().expect("temporary provenance root");
        let inbox = temp.path().join("inbox");
        fs::create_dir_all(&inbox).expect("inbox");
        let path = inbox.join("invalid.json");
        fs::write(&path, b"not-json").expect("invalid envelope");

        quarantine_invalid_envelope(&inbox, &path).expect("quarantine invalid envelope");

        assert!(!path.exists());
        assert!(temp.path().join("rejected").join("invalid.json").is_file());
    }

    #[test]
    fn codex_lifecycle_maps_actor_to_independently_loadable_transcript() {
        let conn = Connection::open_in_memory().expect("in-memory SQLite");
        SqliteRecordStore::init_tables(&conn).expect("initialize orgtrack schema");
        SqliteRecordStore::init_source_cache_tables(&conn)
            .expect("initialize imported history schema");
        let store = SqliteRecordStore::new(&conn);
        let temp = tempfile::tempdir().expect("Codex session root");
        let sessions_dir = temp
            .path()
            .join("sessions")
            .join("2026")
            .join("07")
            .join("14");
        fs::create_dir_all(&sessions_dir).expect("Codex sessions tree");
        let parent_thread_id = "019f6177-f314-7433-a3ed-1c498aa42967";
        let child_thread_id = "019f6177-f314-7433-a3ed-1c498aa42968";
        let parent_stem = format!("rollout-2026-07-14T01-00-00-{parent_thread_id}");
        let child_stem = format!("rollout-2026-07-14T01-01-00-{child_thread_id}");
        let parent_path = sessions_dir.join(format!("{parent_stem}.jsonl"));
        let child_path = sessions_dir.join(format!("{child_stem}.jsonl"));
        fs::write(
            &parent_path,
            r#"{"timestamp":"2026-07-14T01:00:00Z","type":"event_msg","payload":{"type":"user_message","message":"parent transcript marker"}}
"#,
        )
        .expect("write parent transcript");
        fs::write(
            &child_path,
            r#"{"timestamp":"2026-07-14T01:01:00Z","type":"event_msg","payload":{"type":"user_message","message":"child transcript marker"}}
"#,
        )
        .expect("write child transcript");
        let transcript_path = child_path.to_string_lossy().into_owned();
        let parent_session_id = orgtrack_core::sources::codex::canonical_session_id(&parent_stem);
        let child_session_id = orgtrack_core::sources::codex::canonical_session_id(&child_stem);

        persist_actor_lifecycle(
            &store,
            &SessionActorLifecycleEnvelopeV1 {
                schema_version: SESSION_ACTOR_SCHEMA_VERSION,
                source: SOURCE_CODEX_APP.to_string(),
                source_session_id: parent_thread_id.to_string(),
                // Real Codex payloads can remain provisional at stop time;
                // the child path plus parent UUID must resolve the rollout.
                session_id: format!("codexapp-{parent_thread_id}"),
                turn_id: Some("turn-1".to_string()),
                actor_id: "agent-1".to_string(),
                actor_type: Some("explorer".to_string()),
                phase: SessionActorLifecyclePhase::Stopped,
                occurred_at: "2026-07-14T01:02:00Z".to_string(),
                cwd: "/repo".to_string(),
                transcript_path: Some(transcript_path.clone()),
            },
        )
        .expect("persist stop first");
        persist_actor_lifecycle(
            &store,
            &SessionActorLifecycleEnvelopeV1 {
                schema_version: SESSION_ACTOR_SCHEMA_VERSION,
                source: SOURCE_CODEX_APP.to_string(),
                source_session_id: parent_thread_id.to_string(),
                // Inbox delivery is not ordered: a late SubagentStart must
                // not downgrade the concrete parent found by SubagentStop.
                session_id: format!("codexapp-{parent_thread_id}"),
                turn_id: Some("turn-1".to_string()),
                actor_id: "agent-1".to_string(),
                actor_type: Some("explorer".to_string()),
                phase: SessionActorLifecyclePhase::Started,
                occurred_at: "2026-07-14T01:00:00Z".to_string(),
                cwd: "/repo".to_string(),
                transcript_path: None,
            },
        )
        .expect("persist late start");

        let actor = store
            .get_session_actor(SOURCE_CODEX_APP, &parent_session_id, "agent-1")
            .expect("query actor")
            .expect("actor mapping");
        assert_eq!(actor.started_at.as_deref(), Some("2026-07-14T01:00:00Z"));
        assert_eq!(actor.stopped_at.as_deref(), Some("2026-07-14T01:02:00Z"));
        assert_eq!(
            actor.transcript_session_id.as_deref(),
            Some(child_session_id.as_str())
        );
        assert_eq!(
            actor.transcript_path.as_deref(),
            Some(transcript_path.as_str())
        );

        let child = store
            .get_session(&child_session_id)
            .expect("query child")
            .expect("child session");
        assert_eq!(child.created_at.as_deref(), Some("2026-07-14T01:00:00Z"));
        assert_eq!(child.updated_at.as_deref(), Some("2026-07-14T01:02:00Z"));
        assert_eq!(child.completed_at.as_deref(), Some("2026-07-14T01:02:00Z"));
        assert_eq!(
            child.parent_session_id.as_deref(),
            Some(parent_session_id.as_str())
        );
        let parent = store
            .get_session(&parent_session_id)
            .expect("query parent")
            .expect("parent session");
        assert_eq!(parent.created_at.as_deref(), Some("2026-07-14T01:00:00Z"));
        assert_eq!(parent.updated_at.as_deref(), Some("2026-07-14T01:02:00Z"));
        assert_eq!(parent.metadata.origin.as_deref(), Some(SOURCE_CODEX_APP));
        assert_eq!(child.metadata.origin.as_deref(), Some(SOURCE_CODEX_APP));
        let parent_chunks = load_codex_app_for_session(&conn, &parent_session_id)
            .expect("load parent through lifecycle locator");
        assert!(parent_chunks.iter().any(|chunk| {
            chunk.args.to_string().contains("parent transcript marker")
                || chunk
                    .result
                    .to_string()
                    .contains("parent transcript marker")
        }));
        let child_chunks = load_codex_app_for_session(&conn, &child_session_id)
            .expect("load child through actor transcript locator");
        assert!(child_chunks.iter().any(|chunk| {
            chunk.args.to_string().contains("child transcript marker")
                || chunk.result.to_string().contains("child transcript marker")
        }));
    }

    #[cfg(unix)]
    #[test]
    fn resolves_symlink_aliases_for_not_yet_created_files() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temp workspace");
        let real_workspace = temp.path().join("real-workspace");
        let alias_workspace = temp.path().join("alias-workspace");
        fs::create_dir_all(real_workspace.join("src")).expect("workspace tree");
        symlink(&real_workspace, &alias_workspace).expect("workspace alias");

        let aliased_file = alias_workspace.join("src/new.rs");
        let resolved = resolve_file_resource(
            alias_workspace.to_string_lossy().as_ref(),
            aliased_file.to_string_lossy().as_ref(),
        );

        assert_eq!(
            PathBuf::from(&resolved.workspace_path),
            fs::canonicalize(&real_workspace).expect("canonical workspace")
        );
        assert_eq!(resolved.repo_relative_path, "src/new.rs");
        assert_eq!(resolved.display_path, "src/new.rs");
    }
}
