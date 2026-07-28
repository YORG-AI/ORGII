pub mod agent_live_status;
pub mod builder_profile_commands;
pub mod exporter;
pub mod external_cli_detection;
pub mod extraction_scheduler;
pub mod history_commands;
pub mod impact_indexer;
pub mod importer;
pub mod paths;
pub mod session_provenance;
pub mod types;
pub mod usage_dashboard_commands;

mod command_stats;
mod diff_commands;
mod file_session_history;

use command_stats::record_orgtrack_command_call;
#[cfg(test)]
use diff_commands::is_temporary_diff_path;
// Glob re-exports so each `#[tauri::command]`'s generated `__cmd__<name>` macro is
// re-exported alongside the fn, keeping `orgtrack::<name>` resolvable for
// `generate_handler!`.
pub use diff_commands::*;
#[cfg(test)]
use file_session_history::project_file_session_history;
pub use file_session_history::*;

use std::path::PathBuf;

use database::db::get_connection;
use orgtrack_core::canonical::SOURCE_ORGII_RUST_AGENTS;
use orgtrack_core::policy::{source_tier_policy, SourceTierPolicy};
use orgtrack_core::projectors::stats::{session_summaries, CoreSessionSummary};
use orgtrack_core::store::{sqlite::SqliteRecordStore, RecordStore};
use types::OrgtrackTier;

#[tauri::command]
pub async fn orgtrack_initialize(
    repo_path: String,
    tier: Option<String>,
    allow_raw_trajectory: Option<bool>,
) -> Result<types::OrgtrackExportResult, String> {
    record_orgtrack_command_call("orgtrack_initialize");
    let tier = validate_tier(tier.as_deref(), allow_raw_trajectory)?;
    tokio::task::spawn_blocking(move || {
        exporter::initialize_orgtrack(&PathBuf::from(repo_path), tier)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_export(
    repo_path: String,
    tier: Option<String>,
    allow_raw_trajectory: Option<bool>,
) -> Result<types::OrgtrackExportResult, String> {
    record_orgtrack_command_call("orgtrack_export");
    let tier = validate_tier(tier.as_deref(), allow_raw_trajectory)?;
    tokio::task::spawn_blocking(move || exporter::export_orgtrack(&PathBuf::from(repo_path), tier))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_sync_core_repo(repo_path: String) -> Result<types::OrgtrackIndex, String> {
    record_orgtrack_command_call("orgtrack_sync_core_repo");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        orgtrack_core::repo_sync::sync_repo_from_store(&store, &PathBuf::from(repo_path))
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_get_file_timeline(
    repo_path: String,
    file_path: String,
) -> Result<Option<types::OrgtrackFileTimeline>, String> {
    record_orgtrack_command_call("orgtrack_get_file_timeline");
    tokio::task::spawn_blocking(move || {
        importer::read_file_timeline(&PathBuf::from(repo_path), &file_path)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_get_session_summaries(
    workspace_path: Option<String>,
) -> Result<Vec<CoreSessionSummary>, String> {
    record_orgtrack_command_call("orgtrack_get_session_summaries");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        let sessions = store.list_sessions(workspace_path.as_deref())?;
        let final_diffs = store.list_final_diffs(None, None)?;
        let commit_links = store.list_commit_links()?;
        let mut summaries = session_summaries(sessions, final_diffs, commit_links);
        apply_runtime_impact_overrides(&mut summaries)?;
        Ok(summaries)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_get_session_summary(
    session_id: String,
) -> Result<Option<CoreSessionSummary>, String> {
    record_orgtrack_command_call("orgtrack_get_session_summary");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        let sessions: Vec<_> = store
            .list_sessions(None)?
            .into_iter()
            .filter(|session| session.session_id == session_id)
            .collect();
        if sessions.is_empty() {
            return Ok(None);
        }
        let final_diffs = store.list_final_diffs(None, Some(&session_id))?;
        let commit_links = store.list_commit_links_for_session(&session_id)?;
        let mut summaries = session_summaries(sessions, final_diffs, commit_links);
        apply_runtime_impact_overrides(&mut summaries)?;
        Ok(summaries.pop())
    })
    .await
    .map_err(|err| err.to_string())?
}

fn apply_runtime_impact_overrides(summaries: &mut [CoreSessionSummary]) -> Result<(), String> {
    for summary in summaries {
        if summary.source != SOURCE_ORGII_RUST_AGENTS {
            continue;
        }
        if let Some(impact) = impact_indexer::get_session_impact(&summary.session_id)? {
            summary.files_changed = impact.files_changed.max(0) as usize;
            summary.lines_added = impact.lines_added.max(0) as i32;
            summary.lines_removed = impact.lines_removed.max(0) as i32;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn orgtrack_get_source_tier_policy(source: String) -> Result<SourceTierPolicy, String> {
    record_orgtrack_command_call("orgtrack_get_source_tier_policy");
    Ok(source_tier_policy(&source))
}

#[tauri::command]
pub async fn orgtrack_get_extraction_memory_gate(
) -> Result<extraction_scheduler::ExtractionMemoryGateState, String> {
    record_orgtrack_command_call("orgtrack_get_extraction_memory_gate");
    Ok(extraction_scheduler::evaluate_memory_gate(
        &extraction_scheduler::ExtractionMemoryGateConfig::default(),
    ))
}

#[cfg(test)]
mod tests {
    use super::{is_temporary_diff_path, project_file_session_history};
    use orgtrack_core::canonical::{
        AgentMetadata, AttributionPrecision, CollaborationSessionOrigin, ResourceAction,
        ResourceInteractionCaptureMethod, ResourceInteractionOutcome, ResourceInteractionRecord,
        SessionActorRecord, SessionRecord, RESOURCE_INTERACTION_SCHEMA_VERSION,
        SESSION_ACTOR_SCHEMA_VERSION, SESSION_PROVENANCE_HOOK_ORIGIN,
    };
    use orgtrack_core::privacy::ORGTRACK_SCHEMA_VERSION;
    use orgtrack_core::store::{sqlite::SqliteRecordStore, RecordStore};
    use rusqlite::Connection;

    #[test]
    fn hides_tmp_and_scratchpad_diff_paths() {
        assert!(is_temporary_diff_path("/tmp/stale_probe.txt"));
        assert!(is_temporary_diff_path(
            "/private/var/folders/sj/orgii-501/project/sdeagent-id/scratchpad/stale_probe.txt"
        ));
        assert!(!is_temporary_diff_path(
            "/Users/vinceorz/Projects/ORG2/src/main.ts"
        ));
        assert!(!is_temporary_diff_path(
            "/Users/vinceorz/Downloads/notes.txt"
        ));
    }

    #[test]
    fn file_session_history_groups_actions_and_preserves_strongest_attribution() {
        let conn = Connection::open_in_memory().expect("in-memory SQLite");
        SqliteRecordStore::init_tables(&conn).expect("initialize orgtrack schema");
        let store = SqliteRecordStore::new(&conn);
        store
            .upsert_session(&SessionRecord {
                schema_version: ORGTRACK_SCHEMA_VERSION,
                source: "codex_app".to_string(),
                source_session_id: "source-1".to_string(),
                session_id: "session-1".to_string(),
                title: "Implement provenance".to_string(),
                status: None,
                created_at: None,
                updated_at: None,
                completed_at: None,
                workspace_path: Some("/repo".to_string()),
                branch: None,
                parent_session_id: None,
                org_member_id: None,
                collaboration_origin: Some(CollaborationSessionOrigin {
                    org_id: "org-1".to_string(),
                    session_row_id: "org-1:user-1:source-1".to_string(),
                    source_session_id: "source-1".to_string(),
                    owner_member_id: "user-1".to_string(),
                    owner_display_name: "Teammate".to_string(),
                }),
                metadata: AgentMetadata {
                    origin: Some(SESSION_PROVENANCE_HOOK_ORIGIN.to_string()),
                    ..AgentMetadata::default()
                },
            })
            .expect("upsert session");

        let interaction = |id: &str,
                           action: ResourceAction,
                           at: &str,
                           actor: Option<&str>,
                           precision: AttributionPrecision| {
            ResourceInteractionRecord {
                schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
                interaction_id: id.to_string(),
                source: "codex_app".to_string(),
                source_session_id: Some("source-1".to_string()),
                source_event_id: Some(id.to_string()),
                session_id: "session-1".to_string(),
                turn_id: None,
                actor_id: actor.map(str::to_string),
                resource_id: "resource-1".to_string(),
                action,
                outcome: ResourceInteractionOutcome::Succeeded,
                occurred_at: at.to_string(),
                capture_method: ResourceInteractionCaptureMethod::Hook,
                attribution_precision: precision,
            }
        };
        let history = project_file_session_history(
            &store,
            vec![
                interaction(
                    "read",
                    ResourceAction::Read,
                    "2026-07-14T01:00:00Z",
                    Some("agent-1"),
                    AttributionPrecision::SessionOnly,
                ),
                interaction(
                    "write",
                    ResourceAction::Write,
                    "2026-07-14T02:00:00Z",
                    Some("agent-1"),
                    AttributionPrecision::Exact,
                ),
            ],
        )
        .expect("project history");

        assert_eq!(history.len(), 1);
        assert_eq!(history[0].session_label, "Implement provenance");
        assert_eq!(history[0].transcript_session_id, None);
        assert_eq!(history[0].interaction_count, 2);
        assert_eq!(history[0].action_counts.get("read"), Some(&1));
        assert_eq!(history[0].action_counts.get("write"), Some(&1));
        assert_eq!(history[0].attribution_precision, "exact");
        assert_eq!(
            history[0]
                .collaboration_origin
                .as_ref()
                .map(|origin| origin.session_row_id.as_str()),
            Some("org-1:user-1:source-1")
        );
        assert!(history[0].participants.is_empty());
    }

    #[test]
    fn file_session_history_hides_subagent_that_replays_the_root_transcript() {
        let conn = Connection::open_in_memory().expect("in-memory SQLite");
        SqliteRecordStore::init_tables(&conn).expect("initialize orgtrack schema");
        let store = SqliteRecordStore::new(&conn);
        store
            .upsert_session(&SessionRecord {
                schema_version: ORGTRACK_SCHEMA_VERSION,
                source: "codex_app".to_string(),
                source_session_id: "parent".to_string(),
                session_id: "codexapp-parent".to_string(),
                title: "Parent".to_string(),
                status: None,
                created_at: None,
                updated_at: None,
                completed_at: None,
                workspace_path: Some("/repo".to_string()),
                branch: None,
                parent_session_id: None,
                org_member_id: None,
                collaboration_origin: None,
                metadata: AgentMetadata::default(),
            })
            .expect("upsert root session");
        store
            .upsert_session_actor(&SessionActorRecord {
                schema_version: SESSION_ACTOR_SCHEMA_VERSION,
                actor_record_id: "actor-record-root".to_string(),
                source: "codex_app".to_string(),
                source_session_id: "parent".to_string(),
                session_id: "codexapp-parent".to_string(),
                turn_id: Some("turn-1".to_string()),
                actor_id: "agent-1".to_string(),
                actor_type: Some("default".to_string()),
                started_at: Some("2026-07-14T01:00:00Z".to_string()),
                stopped_at: Some("2026-07-14T01:10:00Z".to_string()),
                transcript_session_id: Some("codexapp-parent".to_string()),
                transcript_path: Some("/local/root.jsonl".to_string()),
            })
            .expect("upsert root-pointing actor");

        let history = project_file_session_history(
            &store,
            vec![ResourceInteractionRecord {
                schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
                interaction_id: "interaction-root-actor".to_string(),
                source: "codex_app".to_string(),
                source_session_id: Some("parent".to_string()),
                source_event_id: Some("tool-1".to_string()),
                session_id: "codexapp-parent".to_string(),
                turn_id: Some("turn-1".to_string()),
                actor_id: Some("agent-1".to_string()),
                resource_id: "resource-1".to_string(),
                action: ResourceAction::Read,
                outcome: ResourceInteractionOutcome::Succeeded,
                occurred_at: "2026-07-14T01:05:00Z".to_string(),
                capture_method: ResourceInteractionCaptureMethod::Hook,
                attribution_precision: AttributionPrecision::Exact,
            }],
        )
        .expect("project root-pointing actor history");

        assert_eq!(history.len(), 1);
        assert_eq!(
            history[0].transcript_session_id.as_deref(),
            Some("codexapp-parent")
        );
        assert_eq!(history[0].interaction_count, 1);
        assert!(history[0].participants.is_empty());
    }

    #[test]
    fn file_session_history_resolves_subagent_to_loadable_child_transcript() {
        let conn = Connection::open_in_memory().expect("in-memory SQLite");
        SqliteRecordStore::init_tables(&conn).expect("initialize orgtrack schema");
        let store = SqliteRecordStore::new(&conn);
        for (session_id, source_session_id, title, parent_session_id) in [
            ("claudecodeapp-parent", "parent", "Parent", None),
            (
                "claudecodeapp-agent-1",
                "agent-1",
                "Research subagent",
                Some("claudecodeapp-parent"),
            ),
        ] {
            store
                .upsert_session(&SessionRecord {
                    schema_version: ORGTRACK_SCHEMA_VERSION,
                    source: "claude_code".to_string(),
                    source_session_id: source_session_id.to_string(),
                    session_id: session_id.to_string(),
                    title: title.to_string(),
                    status: None,
                    created_at: None,
                    updated_at: None,
                    completed_at: None,
                    workspace_path: Some("/repo".to_string()),
                    branch: None,
                    parent_session_id: parent_session_id.map(str::to_string),
                    org_member_id: None,
                    collaboration_origin: None,
                    metadata: AgentMetadata::default(),
                })
                .expect("upsert session");
        }

        let history = project_file_session_history(
            &store,
            vec![
                ResourceInteractionRecord {
                    schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
                    interaction_id: "interaction-hook".to_string(),
                    source: "claude_code".to_string(),
                    source_session_id: Some("parent".to_string()),
                    source_event_id: Some("tool-1".to_string()),
                    session_id: "claudecodeapp-parent".to_string(),
                    turn_id: None,
                    actor_id: None,
                    resource_id: "resource-1".to_string(),
                    action: ResourceAction::Read,
                    outcome: ResourceInteractionOutcome::Succeeded,
                    occurred_at: "2026-07-14T01:00:00Z".to_string(),
                    capture_method: ResourceInteractionCaptureMethod::Hook,
                    attribution_precision: AttributionPrecision::SessionOnly,
                },
                ResourceInteractionRecord {
                    schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
                    interaction_id: "interaction-reconciled".to_string(),
                    source: "claude_code".to_string(),
                    source_session_id: Some("agent-1".to_string()),
                    source_event_id: Some("tool-1".to_string()),
                    session_id: "claudecodeapp-agent-1".to_string(),
                    turn_id: None,
                    actor_id: Some("1".to_string()),
                    resource_id: "resource-1".to_string(),
                    action: ResourceAction::Read,
                    outcome: ResourceInteractionOutcome::Succeeded,
                    occurred_at: "2026-07-14T01:00:01Z".to_string(),
                    capture_method: ResourceInteractionCaptureMethod::Reconciled,
                    attribution_precision: AttributionPrecision::Exact,
                },
            ],
        )
        .expect("project history");

        assert_eq!(history.len(), 1);
        assert_eq!(history[0].session_id, "claudecodeapp-parent");
        assert_eq!(history[0].session_label, "Parent");
        assert_eq!(history[0].interaction_count, 1);
        assert_eq!(history[0].participants.len(), 1);
        let participant = &history[0].participants[0];
        assert_eq!(participant.session_id, "claudecodeapp-agent-1");
        assert_eq!(
            participant.transcript_session_id.as_deref(),
            Some("claudecodeapp-agent-1")
        );
        assert_eq!(
            participant.parent_session_id.as_deref(),
            Some("claudecodeapp-parent")
        );
        assert_eq!(participant.session_label, "Research subagent");
        assert_eq!(participant.participant_kind, "subagent");
        assert_eq!(participant.actor_id.as_deref(), Some("1"));
        assert_eq!(
            participant.actor_label.as_deref(),
            Some("Research subagent")
        );
    }

    #[test]
    fn file_session_history_correlates_codex_turn_to_loadable_actor_transcript() {
        let conn = Connection::open_in_memory().expect("in-memory SQLite");
        SqliteRecordStore::init_tables(&conn).expect("initialize orgtrack schema");
        let store = SqliteRecordStore::new(&conn);
        for (session_id, source_session_id, title, parent_session_id) in [
            ("codexapp-parent", "parent", "Parent", None),
            (
                "codexapp-child-rollout",
                "child-rollout",
                "Explorer",
                Some("codexapp-parent"),
            ),
        ] {
            store
                .upsert_session(&SessionRecord {
                    schema_version: ORGTRACK_SCHEMA_VERSION,
                    source: "codex_app".to_string(),
                    source_session_id: source_session_id.to_string(),
                    session_id: session_id.to_string(),
                    title: title.to_string(),
                    status: None,
                    created_at: None,
                    updated_at: None,
                    completed_at: None,
                    workspace_path: Some("/repo".to_string()),
                    branch: None,
                    parent_session_id: parent_session_id.map(str::to_string),
                    org_member_id: None,
                    collaboration_origin: None,
                    metadata: AgentMetadata::default(),
                })
                .expect("upsert session");
        }
        store
            .upsert_session_actor(&SessionActorRecord {
                schema_version: SESSION_ACTOR_SCHEMA_VERSION,
                actor_record_id: "actor-record-1".to_string(),
                source: "codex_app".to_string(),
                source_session_id: "parent".to_string(),
                session_id: "codexapp-parent".to_string(),
                turn_id: Some("turn-1".to_string()),
                actor_id: "agent-1".to_string(),
                actor_type: Some("explorer".to_string()),
                started_at: Some("2026-07-14T01:00:00Z".to_string()),
                stopped_at: Some("2026-07-14T01:10:00Z".to_string()),
                transcript_session_id: Some("codexapp-child-rollout".to_string()),
                transcript_path: Some("/local/child-rollout.jsonl".to_string()),
            })
            .expect("upsert actor mapping");

        let history = project_file_session_history(
            &store,
            vec![ResourceInteractionRecord {
                schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
                interaction_id: "interaction-hook".to_string(),
                source: "codex_app".to_string(),
                source_session_id: Some("parent".to_string()),
                source_event_id: Some("tool-1".to_string()),
                session_id: "codexapp-parent".to_string(),
                turn_id: Some("turn-1".to_string()),
                actor_id: None,
                resource_id: "resource-1".to_string(),
                action: ResourceAction::Read,
                outcome: ResourceInteractionOutcome::Succeeded,
                occurred_at: "2026-07-14T01:05:00Z".to_string(),
                capture_method: ResourceInteractionCaptureMethod::Hook,
                attribution_precision: AttributionPrecision::SessionOnly,
            }],
        )
        .expect("project history");

        assert_eq!(history.len(), 1);
        assert_eq!(
            history[0].transcript_session_id.as_deref(),
            Some("codexapp-parent")
        );
        let participant = &history[0].participants[0];
        assert_eq!(participant.participant_kind, "subagent");
        assert_eq!(participant.actor_id.as_deref(), Some("agent-1"));
        assert_eq!(participant.actor_label.as_deref(), Some("Explorer"));
        assert_eq!(participant.attribution_precision, "correlated");
        assert_eq!(participant.session_id, "codexapp-child-rollout");
        assert_eq!(
            participant.transcript_session_id.as_deref(),
            Some("codexapp-child-rollout")
        );

        let exact_history = project_file_session_history(
            &store,
            vec![ResourceInteractionRecord {
                schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
                interaction_id: "interaction-exact-child".to_string(),
                source: "codex_app".to_string(),
                source_session_id: Some("child-rollout".to_string()),
                source_event_id: Some("tool-2".to_string()),
                session_id: "codexapp-child-rollout".to_string(),
                turn_id: Some("turn-1".to_string()),
                actor_id: Some("agent-1".to_string()),
                resource_id: "resource-1".to_string(),
                action: ResourceAction::Write,
                outcome: ResourceInteractionOutcome::Succeeded,
                occurred_at: "2026-07-14T01:06:00Z".to_string(),
                capture_method: ResourceInteractionCaptureMethod::Hook,
                attribution_precision: AttributionPrecision::Exact,
            }],
        )
        .expect("project exact child history");
        assert_eq!(exact_history.len(), 1);
        let exact_participant = &exact_history[0].participants[0];
        assert_eq!(exact_participant.session_id, "codexapp-child-rollout");
        assert_eq!(exact_participant.actor_label.as_deref(), Some("Explorer"));
        assert_eq!(
            exact_participant.transcript_session_id.as_deref(),
            Some("codexapp-child-rollout")
        );
    }
}

fn validate_tier(
    tier: Option<&str>,
    allow_raw_trajectory: Option<bool>,
) -> Result<OrgtrackTier, String> {
    let tier = OrgtrackTier::from_optional_str(tier)?;
    if tier.includes_trajectory() && allow_raw_trajectory != Some(true) {
        return Err(
            "Trajectory export can include prompts, tool payloads, file contents, and secrets. Pass allowRawTrajectory=true to opt in."
                .to_string(),
        );
    }
    Ok(tier)
}
