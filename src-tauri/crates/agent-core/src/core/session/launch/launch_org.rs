//! Receipt-driven Agent Org Starting convergence.
//!
//! The stable roster is committed before any Session row is created. Every
//! retry therefore targets the exact same member/session identity instead of
//! minting a replacement after a crash.

use std::collections::HashMap;

use core_types::key_source::KeySource;

use crate::coordination::agent_org_runs::{
    AgentOrgMaterializationStatus, AgentOrgRunStore, AgentOrgStartingFailure, COORDINATOR_MEMBER_ID,
};
use crate::definitions::orgs::{is_cli_agent_org_reference, OrgDefinition, OrgMember};
use crate::session::persistence::{
    self as session_persistence, session_type, UnifiedSessionRecord,
};
use crate::session::IdeContext;
use crate::state::AgentAppState;

use super::launch_helpers::{
    flatten_org_members, member_runtime_account_id, member_runtime_key_source,
    member_runtime_model, member_runtime_native_harness_type,
};

#[derive(Debug)]
pub(super) struct AgentOrgMaterializationError {
    failure: AgentOrgStartingFailure,
    retryable: bool,
}

impl AgentOrgMaterializationError {
    fn permanent(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            failure: AgentOrgStartingFailure::new(code, message),
            retryable: false,
        }
    }

    fn retryable(message: impl Into<String>) -> Self {
        Self {
            failure: AgentOrgStartingFailure::new(
                "materialization_temporarily_unavailable",
                message,
            ),
            retryable: true,
        }
    }

    pub(super) fn is_retryable(&self) -> bool {
        self.retryable
    }

    pub(super) fn failure(&self) -> &AgentOrgStartingFailure {
        &self.failure
    }
}

impl std::fmt::Display for AgentOrgMaterializationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.failure.message)
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn materialize_org_member_sessions(
    org_run_id: &str,
    org: &OrgDefinition,
    root_session_id: &str,
    _root_session_name: &str,
    workspace_path: &str,
    model: Option<String>,
    account_id: Option<String>,
    key_source: Option<String>,
    agent_exec_mode: Option<String>,
    native_harness_type: Option<String>,
    work_item_id: Option<String>,
    project_slug: Option<String>,
) -> Result<Vec<String>, AgentOrgMaterializationError> {
    let workspace_path = workspace_path.to_string();
    let root_session_id = root_session_id.to_string();
    let org_name = org.name.clone();
    let model = model.filter(|value| !value.trim().is_empty());
    let key_source = match key_source
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(raw) => KeySource::parse(raw).ok_or_else(|| {
            AgentOrgMaterializationError::permanent(
                "invalid_member_runtime_config",
                format!("Unknown key_source: {raw:?}"),
            )
        })?,
        None => KeySource::default(),
    };
    let native_harness_type = native_harness_type
        .filter(|value| !value.trim().is_empty())
        .map(|raw| {
            core_types::providers::NativeHarnessType::parse(&raw)
                .ok_or_else(|| {
                    AgentOrgMaterializationError::permanent(
                        "invalid_member_runtime_config",
                        format!("Unknown native_harness_type: {raw:?}"),
                    )
                })
                .map(|parsed| parsed.as_str().to_string())
        })
        .transpose()?;
    let agent_exec_mode = agent_exec_mode.filter(|mode| !mode.trim().is_empty());
    let members = flatten_org_members(&org.children)
        .into_iter()
        .map(|member| (member.id.clone(), member))
        .collect::<HashMap<String, OrgMember>>();
    let receipts = AgentOrgRunStore::materializations(org_run_id)
        .map_err(AgentOrgMaterializationError::retryable)?;
    let mut materialized_session_ids = Vec::new();
    for receipt in receipts {
        if receipt.member_id == COORDINATOR_MEMBER_ID {
            continue;
        }
        if receipt.status == AgentOrgMaterializationStatus::Succeeded {
            materialized_session_ids.push(receipt.session_id);
            continue;
        }
        let member = members.get(&receipt.member_id).ok_or_else(|| {
            AgentOrgMaterializationError::permanent(
                "materialization_identity_mismatch",
                format!(
                    "materialization receipt references missing canonical member {}",
                    receipt.member_id
                ),
            )
        })?;
        if member.agent_id != receipt.agent_id {
            return Err(AgentOrgMaterializationError::permanent(
                "materialization_identity_mismatch",
                format!(
                    "materialization receipt agent mismatch for member {}",
                    receipt.member_id
                ),
            ));
        }
        if is_cli_agent_org_reference(&member.agent_id) {
            return Err(AgentOrgMaterializationError::permanent(
                "unsupported_member_runtime",
                format!(
                    "CLI Agent Org member {} cannot be materialized on the canonical lifecycle path",
                    member.id
                ),
            ));
        }

        let session_id = receipt.session_id.clone();
        let member = member.clone();
        let workspace_path = workspace_path.clone();
        let root_session_id = root_session_id.clone();
        let model = model.clone();
        let account_id = account_id.clone();
        let agent_exec_mode = agent_exec_mode.clone();
        let native_harness_type = native_harness_type.clone();
        let work_item_id = work_item_id.clone();
        let project_slug = project_slug.clone();
        let member_config = member.runtime_config.as_ref();
        let member_model = member_runtime_model(member_config, &model);
        let member_account_id = member_runtime_account_id(member_config, &account_id);
        let member_key_source =
            member_runtime_key_source(member_config, &key_source).map_err(|error| {
                AgentOrgMaterializationError::permanent("invalid_member_runtime_config", error)
            })?;
        let member_native_harness_type =
            member_runtime_native_harness_type(member_config, &native_harness_type).map_err(
                |error| {
                    AgentOrgMaterializationError::permanent("invalid_member_runtime_config", error)
                },
            )?;
        let persisted_session_id = tokio::task::spawn_blocking(move || {
            if let Some(existing) = session_persistence::get_session(&session_id)
                .map_err(|error| AgentOrgMaterializationError::retryable(error.to_string()))?
            {
                let identity_matches = existing.agent_definition_id.as_deref()
                    == Some(member.agent_id.as_str())
                    && existing.org_member_id.as_deref() == Some(member.id.as_str())
                    && existing.parent_session_id.as_deref() == Some(root_session_id.as_str());
                if !identity_matches {
                    return Err(AgentOrgMaterializationError::permanent(
                        "materialization_identity_mismatch",
                        format!("stable materialization Session identity mismatch: {session_id}"),
                    ));
                }
                return Ok(session_id);
            }
            let now = chrono::Utc::now().to_rfc3339();
            let session = UnifiedSessionRecord {
                session_id: session_id.clone(),
                name: format!("{} · {}", member.name, member.role),
                status: crate::session::SessionStatus::Idle.as_str().to_string(),
                model: member_model,
                account_id: member_account_id,
                workspace_path: Some(workspace_path),
                org_id: Some(project_management::projects::types::PERSONAL_ORG_ID.to_string()),
                user_input: None,
                total_tokens: 0,
                created_at: now.clone(),
                updated_at: now,
                session_type: session_type::ORG_MEMBER.to_string(),
                work_item_id: work_item_id.clone(),
                product_mode: work_item_id.as_ref().map(|_| "project".to_string()),
                agent_role: Some(member.role),
                project_slug,
                agent_definition_id: Some(member.agent_id),
                org_member_id: Some(member.id),
                parent_session_id: Some(root_session_id),
                key_source: member_key_source,
                agent_exec_mode,
                native_harness_type: member_native_harness_type,
                ..Default::default()
            };
            session_persistence::upsert_session(&session)
                .map_err(|error| AgentOrgMaterializationError::retryable(error.to_string()))?;
            Ok::<_, AgentOrgMaterializationError>(session_id)
        })
        .await
        .map_err(|error| AgentOrgMaterializationError::retryable(error.to_string()))??;
        AgentOrgRunStore::mark_materialization_succeeded(
            org_run_id,
            &receipt.member_id,
            receipt.generation,
            &persisted_session_id,
        )
        .map_err(|error| {
            // Typed classification: the store stamps permanent identity
            // failures with a stable machine prefix. Matching prose (the old
            // `.contains("identity mismatch")`) missed the store's
            // "materialization session mismatch" wording and retried a
            // permanently wrong identity forever.
            if crate::coordination::agent_org_runs::is_materialization_identity_mismatch_error(
                &error,
            ) {
                AgentOrgMaterializationError::permanent("materialization_identity_mismatch", error)
            } else {
                AgentOrgMaterializationError::retryable(error)
            }
        })?;
        materialized_session_ids.push(persisted_session_id);
    }

    tracing::info!(
        run_id = %org_run_id,
        org_name = %org_name,
        member_sessions = materialized_session_ids.len(),
        "[session_launch] converged Agent Org member materialization receipts"
    );
    Ok(materialized_session_ids)
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn send_initial_turn(
    state: &AgentAppState,
    session_id: &str,
    content: String,
    model: Option<String>,
    account_id: Option<String>,
    workspace_root: String,
    native_harness_type: Option<core_types::providers::NativeHarnessType>,
    mode: Option<String>,
    images: Option<Vec<String>>,
    ide_context: Option<IdeContext>,
    agent_definition_id: Option<String>,
    sub_agent_ids: Vec<String>,
    intent_org_run_id: Option<String>,
    client_message_id: Option<String>,
    turn_intent_id: Option<String>,
    source: crate::foundation::session_bridge::TurnIntentBridgeSource,
) -> Result<(), String> {
    if sub_agent_ids.is_empty() {
        crate::state::commands::session::message::send_message_impl(
            state,
            session_id.to_string(),
            content,
            None,
            crate::state::commands::session::identity::IdentityOverrides {
                model,
                account_id,
                workspace_root: Some(workspace_root),
                native_harness_type,
            },
            mode,
            images,
            ide_context,
            false,
            false,
            client_message_id,
            turn_intent_id,
            None,
            intent_org_run_id,
            source,
        )
        .await?;
        return Ok(());
    }

    let model = model.ok_or_else(|| "model is required for sub-agent launch".to_string())?;
    let launch_spec = crate::init::launch_spec::AgentLaunchSpec::work_item_session(
        state,
        session_id,
        &model,
        account_id.as_deref().unwrap_or_default(),
        std::path::PathBuf::from(&workspace_root),
        agent_definition_id.as_deref(),
        &sub_agent_ids,
    )
    .await?;
    crate::init::init_session(state, launch_spec).await?;

    crate::state::commands::session::message::send_message_impl(
        state,
        session_id.to_string(),
        content,
        None,
        crate::state::commands::session::identity::IdentityOverrides {
            model: Some(model),
            account_id,
            workspace_root: Some(workspace_root),
            native_harness_type,
        },
        mode,
        images,
        ide_context,
        false,
        false,
        client_message_id,
        turn_intent_id,
        None,
        intent_org_run_id,
        crate::foundation::session_bridge::TurnIntentBridgeSource::AgentOrg,
    )
    .await?;
    Ok(())
}

pub(super) async fn cleanup_session_after_org_run_create_failure(session_id: String) {
    let cleanup = tokio::task::spawn_blocking(move || {
        crate::session::persistence::delete_session(&session_id)
    })
    .await;

    match cleanup {
        Ok(Ok(())) => {}
        Ok(Err(err)) => tracing::warn!(
            error = %err,
            "[session_launch] failed to clean up session after Agent Org run creation failure"
        ),
        Err(err) => tracing::warn!(
            error = %err,
            "[session_launch] failed to join cleanup after Agent Org run creation failure"
        ),
    }
}
