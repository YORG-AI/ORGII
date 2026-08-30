//! Per-call framework metadata threaded explicitly to every `Tool::execute`.
//!
//! `CallContext` replaces the previous mechanism of injecting `__call_id`
//! and `__session_id` into the params `Value` itself
//! (`turn_executor::tool_execution::inject_framework_meta` + boundary
//! stripping in `parse_params` / MCP bridge). That mechanism was a
//! data + metadata polyglot — every new consumer path had to remember to
//! strip the reserved namespace, and we shipped two real bugs after
//! adding `__session_id` (strict agent-org task tools rejecting every
//! call; `__session_id` leaking to external MCP servers).
//!
//! Threading a typed context makes the contract compiler-enforced and
//! gives a single, obvious place to add future framework keys (e.g.,
//! `turn_index`, `parent_call_id`) without touching the params pipeline.
//!
//! ## Semantics
//!
//! - `call_id`: identifies one tool invocation within a turn. Sourced
//!   from `ToolUse.id` (Anthropic) or the synthesized id for OpenAI-
//!   compatible streaming. Used by the MCP bridge to stamp
//!   `agent:mcp_progress` events and by orchestration tools that need
//!   per-call correlation.
//!
//! - `session_id`: the *dispatching* session's id. Per-call attribution
//!   is race-free even when background subagents (which inherit the
//!   parent's `ToolRegistry`) run concurrently — unlike the legacy
//!   `ToolRegistry::set_session_key` shared mutable state that was the
//!   root cause of the `create_plan` subagent-misattribution saga.
//!
//! - `turn_intent_id` and `projected_inbox_ids`: identify the exact durable
//!   turn and Inbox batch whose effects become committed only after this turn
//!   succeeds. Agent Org Quiescence uses them to build a prospective
//!   completion certificate without guessing or subtracting unrelated work.
//!
//! ## Defaults
//!
//! `CallContext::default()` is deliberately untrusted. Test fixtures and
//! direct in-process callers that execute a work capability must opt into a
//! trusted SDE authority explicitly; production dispatch derives authority
//! from the persisted Agent Org Turn profile immediately before each call.

use tokio_util::sync::CancellationToken;

use super::error::ToolError;

#[cfg(test)]
mod final_summary_tests;

/// Persisted Agent Org work profile carried to the lowest tool adapter.
///
/// This is intentionally separate from a registry instance: a directly
/// constructed Tool still sees the exact caller authority and fails closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentOrgTurnToolProfile {
    CoordinatorOrchestration,
    SummaryOnly,
    TaskExecution,
    UserDirectedWorker,
    UserDirectedWriter,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum ToolCallAuthority {
    #[default]
    Unknown,
    TrustedSde,
    PersistedAgentOrg(AgentOrgTurnToolProfile),
}

/// Exact runtime owner of subprocesses started by one dialog Turn.
///
/// All four fields travel together so a delayed Pause callback cannot target
/// a newer runtime or a different Turn that happens to reuse the Session.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TurnProcessOwner {
    pub session_id: String,
    pub turn_intent_id: String,
    pub runtime_lease_id: String,
    pub dialog_turn_generation: String,
}

/// Per-Turn process lifecycle control threaded to tool execution.
///
/// The token is level-triggered and never reset. A shell that transitions to
/// background after Pause therefore observes the cancellation immediately
/// instead of missing a short pulse on the Session's ordinary cancel flag.
#[derive(Debug, Clone)]
pub struct TurnProcessControl {
    pub owner: TurnProcessOwner,
    pub background_cancel: CancellationToken,
    /// Agent Org work consumes every owned background result inside this
    /// exact Turn. Ordinary SDE controls leave this false.
    pub require_owned_job_finality: bool,
}

impl PartialEq for TurnProcessControl {
    fn eq(&self, other: &Self) -> bool {
        self.owner == other.owner
            && self.require_owned_job_finality == other.require_owned_job_finality
    }
}

impl Eq for TurnProcessControl {}

/// Per-call framework metadata.
///
/// Threaded explicitly by `turn_executor::tool_execution` to every
/// `Tool::execute` / `Tool::execute_text` call. Tools that need
/// framework identity (MCP bridge, create_plan, orchestration tools
/// that correlate with parent state) read it from here; tools that
/// don't need it just bind `_ctx`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CallContext {
    /// Identifier of this individual tool invocation within the turn.
    pub call_id: String,
    /// Identifier of the dispatching session.
    pub session_id: String,
    /// Durable lifecycle identity of the dispatching turn. Empty for
    /// maintenance/direct test calls that do not belong to a real turn.
    pub turn_intent_id: String,
    /// Exact Agent Org Inbox rows held by this turn's deferred drain guard.
    /// These rows are acknowledged only when the turn succeeds.
    pub projected_inbox_ids: Vec<i64>,
    /// Exact owner and level-triggered cancellation for shell processes
    /// started by this Turn. Direct/maintenance calls intentionally use None.
    pub turn_process_control: Option<TurnProcessControl>,
    /// Trusted caller class. The zero/default value is fail-closed.
    pub(crate) authority: ToolCallAuthority,
    /// One-shot release for adapters with a narrow side-effect admission
    /// point. Absent for ordinary SDE and non-TaskExecution calls.
    pub(crate) task_effect_fence_release: Option<
        crate::coordination::agent_org_task_execution_fence::TaskExecutionEffectFenceRelease,
    >,
}

impl CallContext {
    /// Construct a populated context. Production dispatch sites use this.
    pub fn new(call_id: impl Into<String>, session_id: impl Into<String>) -> Self {
        Self {
            call_id: call_id.into(),
            session_id: session_id.into(),
            turn_intent_id: String::new(),
            projected_inbox_ids: Vec::new(),
            turn_process_control: None,
            authority: ToolCallAuthority::Unknown,
            task_effect_fence_release: None,
        }
    }

    pub fn for_turn(
        call_id: impl Into<String>,
        session_id: impl Into<String>,
        turn_intent_id: impl Into<String>,
        projected_inbox_ids: Vec<i64>,
    ) -> Self {
        Self::for_runtime_turn(
            call_id,
            session_id,
            turn_intent_id,
            projected_inbox_ids,
            None,
        )
    }

    pub fn for_runtime_turn(
        call_id: impl Into<String>,
        session_id: impl Into<String>,
        turn_intent_id: impl Into<String>,
        projected_inbox_ids: Vec<i64>,
        turn_process_control: Option<TurnProcessControl>,
    ) -> Self {
        Self {
            call_id: call_id.into(),
            session_id: session_id.into(),
            turn_intent_id: turn_intent_id.into(),
            projected_inbox_ids,
            turn_process_control,
            authority: ToolCallAuthority::Unknown,
            task_effect_fence_release: None,
        }
    }

    pub(crate) fn with_authority(mut self, authority: ToolCallAuthority) -> Self {
        self.authority = authority;
        self
    }

    pub(crate) fn with_task_effect_fence_release(
        mut self,
        release: crate::coordination::agent_org_task_execution_fence::TaskExecutionEffectFenceRelease,
    ) -> Self {
        self.task_effect_fence_release = Some(release);
        self
    }

    pub(crate) fn release_task_effect_fence(&self) {
        if let Some(release) = self.task_effect_fence_release.as_ref() {
            release.release();
        }
    }

    /// Explicit authority for isolated direct callers that are acting as an
    /// ordinary SDE rather than a persisted Agent Org Turn.
    #[cfg(test)]
    pub(crate) fn trusted_sde() -> Self {
        Self::default().with_authority(ToolCallAuthority::TrustedSde)
    }

    /// Owning-adapter guard for tools that Coordinator must never execute.
    /// Registry schema/execution checks remain defense in depth; they are not
    /// the authority source for this verdict.
    pub(crate) fn require_tool_authority(&self, tool_name: &str) -> Result<(), ToolError> {
        let allowed = match self.authority {
            ToolCallAuthority::Unknown => false,
            ToolCallAuthority::TrustedSde => true,
            ToolCallAuthority::PersistedAgentOrg(profile) => {
                !self.session_id.trim().is_empty()
                    && !self.turn_intent_id.trim().is_empty()
                    && crate::tools::policy::resolve_persisted_agent_org_tool_authority(
                        &self.session_id,
                        &self.turn_intent_id,
                    )
                    .is_ok_and(|current| {
                        current.profile == profile
                            && crate::tools::policy::agent_org_profile_allows_tool(
                                current.profile,
                                tool_name,
                            )
                    })
                    || self.persisted_store_replay_authority(profile, tool_name)
            }
        };
        if allowed {
            Ok(())
        } else {
            Err(ToolError::ExecutionFailed(format!(
                "tool_authority_denied:{tool_name}"
            )))
        }
    }

    /// Durable Agent Org Store tools own exactly-once replay. Once their
    /// persisted Turn becomes stale (for example after Archive or handoff),
    /// they may enter only far enough to return an existing receipt or let the
    /// typed Store reject a new mutation. File/process/browser/MCP/delegate
    /// tools never use this fallback.
    fn persisted_store_replay_authority(
        &self,
        profile: AgentOrgTurnToolProfile,
        tool_name: &str,
    ) -> bool {
        if self.session_id.trim().is_empty()
            || self.turn_intent_id.trim().is_empty()
            || !matches!(
                tool_name,
                crate::tools::names::TASK_CREATE
                    | crate::tools::names::TASK_GRAPH_CREATE
                    | crate::tools::names::TASK_UPDATE
                    | crate::tools::names::ORG_SEND_MESSAGE
                    | crate::tools::names::ORG_INBOX_REPAIR
                    | crate::tools::names::ORG_RUN_COMPLETE
            )
        {
            return false;
        }
        crate::coordination::agent_org_turn_contexts::optional_context_for_session(
            &self.session_id,
            &self.turn_intent_id,
        )
        .ok()
        .flatten()
        .is_some_and(|context| {
            let persisted_profile = match context.turn_kind {
                crate::coordination::agent_org_turn_contexts::AgentOrgTurnKind::Coordinator => {
                    if context.source_kind
                        == crate::coordination::agent_org_turn_contexts::AgentOrgTurnSourceKind::MemberInbox
                    {
                        match crate::coordination::agent_org_runs::AgentOrgRunStore::get_run_status(
                            &context.org_run_id,
                        ) {
                            Ok(Some(
                                crate::coordination::agent_org_runs::AgentOrgRunStatus::Paused,
                            )) => Some(AgentOrgTurnToolProfile::SummaryOnly),
                            Ok(Some(
                                crate::coordination::agent_org_runs::AgentOrgRunStatus::Running
                                | crate::coordination::agent_org_runs::AgentOrgRunStatus::Idle,
                            )) => Some(AgentOrgTurnToolProfile::CoordinatorOrchestration),
                            _ => None,
                        }
                    } else {
                        let is_summary_turn = database::db::get_connection()
                            .map_err(|error| error.to_string())
                            .and_then(|conn| {
                                crate::coordination::agent_org_final_summary::is_summary_turn_with_connection(
                                    &conn,
                                    &context.session_id,
                                    &context.turn_intent_id,
                                )
                            });
                        coordinator_replay_profile(is_summary_turn)
                    }
                }
                crate::coordination::agent_org_turn_contexts::AgentOrgTurnKind::TaskExecution => {
                    Some(AgentOrgTurnToolProfile::TaskExecution)
                }
                crate::coordination::agent_org_turn_contexts::AgentOrgTurnKind::UserDirectedWork => {
                    None
                }
            };
            persisted_profile == Some(profile)
                && crate::tools::policy::agent_org_profile_allows_tool(profile, tool_name)
        })
    }
}

fn coordinator_replay_profile(
    is_summary_turn: Result<bool, String>,
) -> Option<AgentOrgTurnToolProfile> {
    match is_summary_turn {
        Ok(true) => Some(AgentOrgTurnToolProfile::SummaryOnly),
        Ok(false) => Some(AgentOrgTurnToolProfile::CoordinatorOrchestration),
        Err(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_call_authority_is_fail_closed_and_profile_exact() {
        assert!(matches!(
            CallContext::default().require_tool_authority(crate::tools::names::READ_FILE),
            Err(ToolError::ExecutionFailed(message))
                if message == "tool_authority_denied:read_file"
        ));

        let coordinator_without_persisted_turn = CallContext::default().with_authority(
            ToolCallAuthority::PersistedAgentOrg(AgentOrgTurnToolProfile::CoordinatorOrchestration),
        );
        assert!(matches!(
            coordinator_without_persisted_turn
                .require_tool_authority(crate::tools::names::READ_FILE),
            Err(ToolError::ExecutionFailed(message))
                if message == "tool_authority_denied:read_file"
        ));

        CallContext::trusted_sde()
            .require_tool_authority(crate::tools::names::RUN_SHELL)
            .unwrap();
    }
}
