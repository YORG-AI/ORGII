//! Pure helper functions for the agent run launch service.
//!
//! Extracted from `launch.rs` to keep that file focused on the public API and
//! the two main orchestration entry points.

use std::collections::HashMap;

use core_types::key_source::KeySource;

use crate::coordination::agent_org_runs::AgentOrgRunStore;
use crate::definitions::orgs::{OrgMember, OrgMemberRuntimeConfig};
use crate::session::turn::streaming::{
    broadcast_agent_error_structured, classify_streaming_error_message, StreamingError,
};

use super::launch_workspace::release_work_item_execution_lock_if_present;

#[allow(clippy::too_many_arguments)]
// Failure handling deliberately receives each durable identifier and log
// message explicitly so cleanup cannot accidentally reuse stale launch state.
pub(super) async fn handle_background_launch_failure(
    session_id: &str,
    agent_org_run_id: Option<&str>,
    project_slug: Option<&str>,
    work_item_id: Option<&str>,
    app_handle: Option<&tauri::AppHandle>,
    message: &str,
    run_mark_warning: &str,
    session_mark_warning: &str,
) {
    tracing::warn!("{}", message);
    if let Some(run_id) = agent_org_run_id {
        if let Err(mark_err) = AgentOrgRunStore::mark_failed(run_id, message) {
            tracing::warn!(
                run_id = %run_id,
                error = %mark_err,
                "{}",
                run_mark_warning
            );
        }
    }
    release_work_item_execution_lock_if_present(project_slug, work_item_id, session_id, app_handle)
        .await;
    broadcast_launch_send_error(session_id, message);
    crate::lifecycle::persist_session_error_event(app_handle, session_id, message);
    if let Err(mark_err) = mark_session_failed(session_id.to_string()).await {
        tracing::warn!(
            session_id = %session_id,
            error = %mark_err,
            "{}",
            session_mark_warning
        );
    }
}

pub(super) fn apply_member_launch_overrides_to_snapshot(
    members: &mut [OrgMember],
    overrides: &HashMap<String, crate::definitions::orgs::OrgMemberLaunchOverride>,
) -> Result<(), String> {
    crate::definitions::orgs::apply_overrides_to_member_tree(
        members,
        overrides,
        "Agent Org launch override",
    )
}

pub(super) fn validate_launch_agent_definitions(
    agent_definition_id: Option<&str>,
    org_definition: Option<&crate::definitions::orgs::OrgDefinition>,
) -> Result<(), String> {
    use std::collections::HashSet;

    use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;
    use crate::definitions::orgs::is_cli_agent_org_reference;

    let store = crate::definitions::definitions_store();

    if let Some(definition_id) = agent_definition_id.filter(|id| !id.trim().is_empty()) {
        if store.get(definition_id).is_none() {
            return Err(format!(
                "Agent definition '{}' does not exist; remove the stale session or choose an existing Agent definition before launching",
                definition_id
            ));
        }
    }

    if let Some(org) = org_definition {
        let mut missing: Vec<String> = Vec::new();
        let mut unsupported_cli: Vec<String> = Vec::new();
        let mut member_ids = HashSet::new();
        let mut invalid_member_ids: Vec<String> = Vec::new();
        let mut duplicate_member_ids: Vec<String> = Vec::new();
        if !org.agent_id.trim().is_empty() {
            if is_cli_agent_org_reference(&org.agent_id) {
                unsupported_cli.push(format!("coordinator '{}'", org.agent_id));
            } else if store.get(&org.agent_id).is_none() {
                missing.push(format!("coordinator '{}'", org.agent_id));
            }
        }
        for member in flatten_org_members(&org.children) {
            let member_id = member.id.trim();
            if member_id.is_empty() {
                invalid_member_ids.push(format!("member '{}' has empty id", member.name));
            } else if member_id == COORDINATOR_MEMBER_ID {
                invalid_member_ids.push(format!(
                    "member '{}' uses reserved id '{}'",
                    member.name, COORDINATOR_MEMBER_ID
                ));
            } else if !member_ids.insert(member_id.to_string()) {
                duplicate_member_ids.push(member_id.to_string());
            }

            if is_cli_agent_org_reference(&member.agent_id) {
                unsupported_cli.push(format!("member '{}' ({})", member.id, member.agent_id));
            } else if store.get(&member.agent_id).is_none() {
                missing.push(format!("member '{}' ({})", member.name, member.agent_id));
            }
        }
        if !unsupported_cli.is_empty() {
            return Err(format!(
                "CLI Agent Org participants are not supported yet because they cannot drain the Agent Org inbox or use task tools: {}",
                unsupported_cli.join(", ")
            ));
        }
        duplicate_member_ids.sort();
        duplicate_member_ids.dedup();
        if !invalid_member_ids.is_empty() || !duplicate_member_ids.is_empty() {
            let mut reasons = Vec::new();
            reasons.extend(invalid_member_ids);
            if !duplicate_member_ids.is_empty() {
                reasons.push(format!(
                    "duplicate member_id value(s): {}",
                    duplicate_member_ids.join(", ")
                ));
            }
            return Err(format!(
                "Agent Org '{}' has invalid member_id configuration: {}",
                org.name,
                reasons.join(", ")
            ));
        }
        if !missing.is_empty() {
            return Err(format!(
                "Agent Org '{}' references missing Agent definition(s): {}",
                org.name,
                missing.join(", ")
            ));
        }
    }

    Ok(())
}

pub(super) fn clean_runtime_value(value: Option<&String>) -> Option<String> {
    value
        .map(|raw| raw.trim())
        .filter(|trimmed| !trimmed.is_empty())
        .map(str::to_string)
}

pub(super) fn member_runtime_model(
    config: Option<&OrgMemberRuntimeConfig>,
    fallback: &Option<String>,
) -> Option<String> {
    config
        .and_then(|cfg| {
            clean_runtime_value(cfg.model.as_ref())
                .or_else(|| clean_runtime_value(cfg.listing_model.as_ref()))
        })
        .or_else(|| fallback.clone())
}

pub(super) fn member_runtime_account_id(
    config: Option<&OrgMemberRuntimeConfig>,
    fallback: &Option<String>,
) -> Option<String> {
    config
        .and_then(|cfg| clean_runtime_value(cfg.account_id.as_ref()))
        .or_else(|| fallback.clone())
}

pub(super) fn member_runtime_tier(config: Option<&OrgMemberRuntimeConfig>) -> Option<String> {
    config.and_then(|cfg| clean_runtime_value(cfg.tier.as_ref()))
}

pub(super) fn member_runtime_key_source(
    config: Option<&OrgMemberRuntimeConfig>,
    fallback: &KeySource,
) -> Result<KeySource, String> {
    match config.and_then(|cfg| clean_runtime_value(cfg.key_source.as_ref())) {
        Some(raw) => KeySource::parse(&raw).ok_or_else(|| format!("Unknown key_source: {raw:?}")),
        None => Ok(*fallback),
    }
}

pub(super) fn member_runtime_native_harness_type(
    config: Option<&OrgMemberRuntimeConfig>,
    fallback: &Option<String>,
) -> Result<Option<String>, String> {
    match config.and_then(|cfg| clean_runtime_value(cfg.native_harness_type.as_ref())) {
        Some(raw) => core_types::providers::NativeHarnessType::parse(&raw)
            .ok_or_else(|| format!("Unknown native_harness_type: {raw:?}"))
            .map(|parsed| Some(parsed.as_str().to_string())),
        None => Ok(fallback.clone()),
    }
}

pub(super) fn provenance_fields(
    provenance: &super::LaunchProvenance,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    use super::LaunchProvenance;
    match provenance {
        LaunchProvenance::UserSession => (None, None, None, None),
        LaunchProvenance::WorkItem {
            project_slug,
            work_item_id,
            agent_role,
            ..
        } => (
            project_slug.clone(),
            Some(work_item_id.clone()),
            agent_role.clone(),
            None,
        ),
        LaunchProvenance::RoutineFire {
            routine_fire_id, ..
        } => (None, None, None, Some(routine_fire_id.clone())),
    }
}

pub(super) fn provenance_lock_reason(
    provenance: &super::LaunchProvenance,
) -> project_management::projects::types::WorkItemExecutionLockReason {
    use super::LaunchProvenance;
    use project_management::projects::types::WorkItemExecutionLockReason;
    match provenance {
        LaunchProvenance::WorkItem { lock_reason, .. } => lock_reason.clone(),
        _ => WorkItemExecutionLockReason::ManualStart,
    }
}

pub(super) fn broadcast_launch_send_error(session_id: &str, message: &str) {
    let error = StreamingError::new(
        message.to_string(),
        classify_streaming_error_message(message),
    );
    broadcast_agent_error_structured(session_id, &error);
}

pub(super) async fn mark_session_failed(session_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let Some(mut record) =
            crate::session::persistence::get_session(&session_id).map_err(|err| err.to_string())?
        else {
            return Ok(());
        };
        record.status = crate::session::SessionStatus::Failed.as_str().to_string();
        record.updated_at = chrono::Utc::now().to_rfc3339();
        crate::session::persistence::upsert_session(&record).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

pub(super) fn derive_name(explicit: Option<&str>, content: &str) -> String {
    use super::MAX_AUTO_NAME_LEN;
    if let Some(name) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        return name.to_string();
    }
    let first_line = content.lines().find(|line| !line.trim().is_empty());
    let seed = first_line.unwrap_or("New session").trim();
    let truncated: String = crate::utils::safe_truncate_chars_to_string(&seed, MAX_AUTO_NAME_LEN);
    if truncated.is_empty() {
        "New session".to_string()
    } else {
        truncated
    }
}

pub(super) fn flatten_org_members(members: &[OrgMember]) -> Vec<OrgMember> {
    let mut flattened = Vec::new();
    for member in members {
        flattened.push(member.clone());
        flattened.extend(flatten_org_members(&member.children));
    }
    flattened
}

#[cfg(test)]
mod provenance_tests {
    use super::provenance_fields;
    use crate::core::session::launch::LaunchProvenance;
    use project_management::projects::types::WorkItemExecutionLockReason;

    #[test]
    fn standalone_work_item_keeps_session_linkage_without_project_scope() {
        let provenance = LaunchProvenance::WorkItem {
            project_slug: None,
            work_item_id: "WI-0042".to_string(),
            agent_role: Some("custom".to_string()),
            lock_reason: WorkItemExecutionLockReason::ManualStart,
        };

        let (project_slug, work_item_id, agent_role, routine_fire_id) =
            provenance_fields(&provenance);
        assert_eq!(project_slug, None);
        assert_eq!(work_item_id.as_deref(), Some("WI-0042"));
        assert_eq!(agent_role.as_deref(), Some("custom"));
        assert_eq!(routine_fire_id, None);
    }
}
