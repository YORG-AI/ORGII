//! Parent identity inheritance and child-session persistence.

use tracing::warn;

use crate::definitions::AgentDefinition;

use super::request::LaunchRequest;
use super::AgentTool;

#[derive(Default)]
pub(super) struct ParentInheritance {
    pub(super) account_id: Option<String>,
    pub(super) key_source: core_types::key_source::KeySource,
    pub(super) agent_exec_mode: Option<String>,
    pub(super) native_harness_type: Option<String>,
    pub(super) product_mode: Option<String>,
}

impl AgentTool {
    /// Read the authoritative parent row for billing, native harness, and
    /// execution/product-mode inheritance. Missing rows remain best-effort,
    /// matching the pre-modularization launch path.
    pub(super) fn read_parent_inheritance(&self, parent_session_id: &str) -> ParentInheritance {
        match crate::session::persistence::get_session(parent_session_id) {
            Ok(Some(parent)) => ParentInheritance {
                account_id: parent.account_id,
                key_source: parent.key_source,
                agent_exec_mode: parent.agent_exec_mode,
                native_harness_type: parent.native_harness_type,
                product_mode: parent.product_mode,
            },
            Ok(None) => {
                warn!(
                    "[agent] Worker spawn: parent session {} has no agent_sessions row \
                     yet — defaulting child account_id=None, key_source=OwnKey, \
                     agent_exec_mode=None. This is expected only when the parent is \
                     itself mid-creation; otherwise it indicates a lifecycle ordering bug.",
                    parent_session_id
                );
                ParentInheritance::default()
            }
            Err(err) => {
                warn!(
                    "[agent] Worker spawn: failed to read parent session {} for \
                     identity inheritance: {} — defaulting child account_id=None, \
                     key_source=OwnKey, agent_exec_mode=None, native_harness_type=None",
                    parent_session_id, err
                );
                ParentInheritance::default()
            }
        }
    }

    pub(super) fn persist_child_session(
        &self,
        request: &LaunchRequest,
        agent: &AgentDefinition,
        subagent_session_id: &str,
        parent_session_id: &str,
        model: &str,
        inheritance: ParentInheritance,
    ) {
        let record = crate::session::persistence::UnifiedSessionRecord {
            session_id: subagent_session_id.to_string(),
            name: format!(
                "{} ({})",
                agent.name,
                crate::utils::safe_truncate_chars_to_string(&request.description, 60)
            ),
            status: crate::session::SessionStatus::Running.as_str().to_string(),
            model: Some(model.to_string()),
            account_id: inheritance.account_id,
            key_source: inheritance.key_source,
            session_type: crate::session::persistence::session_type::SUBAGENT.to_string(),
            parent_session_id: Some(parent_session_id.to_string()),
            parent_event_id: None,
            agent_definition_id: Some(request.agent_id.clone()),
            // Preserve the parent workspace identity even when the worker's
            // actual working directory becomes an isolated worktree.
            workspace_path: self.config.workspace_path.clone(),
            agent_exec_mode: inheritance.agent_exec_mode,
            product_mode: inheritance.product_mode,
            native_harness_type: inheritance.native_harness_type,
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            ..Default::default()
        };
        if let Err(err) = crate::session::persistence::upsert_session(&record) {
            warn!(
                "[agent] Failed to persist child session {}: {}",
                subagent_session_id, err
            );
        }
    }
}
