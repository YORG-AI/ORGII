//! Processor construction and per-turn setup.
//!
//! Owns [`UnifiedMessageProcessor::new`] plus the derived per-turn inputs the
//! rest of the pipeline reads off `&self`: the exec-mode tool policy overlay,
//! the iteration cap, the workspace root, and the pre-message file-history
//! snapshot taken before any tool can run.

use std::sync::Arc;
use tracing::{debug, info, warn};

use crate::model_context::compaction::CompactionState;
use crate::model_context::microcompact::ReplacementState;
use crate::model_context::session_memory::{SessionMemoryCompactConfig, SessionMemoryConfig};
use crate::tools::policy::ResolvedToolPolicy;

use super::{ProcessorParams, UnifiedMessageProcessor};

impl UnifiedMessageProcessor {
    /// Creates a new unified message processor.
    ///
    /// Reads session-level configuration directly from `runtime` and
    /// per-session mutable state from `session`. No relay structs.
    pub fn new(params: ProcessorParams) -> Self {
        let ProcessorParams {
            runtime,
            session,
            policy,
            channel,
            chat_id,
            agent_mode,
            ide_context,
            app_handle,
            screenshot_store,
            event_handler_config,
        } = params;

        // `agent_id` is the routing key for everything that operates on
        // an `AgentDefinition` (policy lookups, agent_org inbox routing,
        // member_idle notifications, learnings scoping). When the runtime
        // was assembled without a definition (legacy bare `state.set_runtime`
        // path that no longer fires, or a misconfigured agent_org spawn),
        // we fall back to `session.id` so unrelated subsystems keep
        // working — but this also silently makes inbox_drain /
        // member_idle a no-op (they query rows by `recipient_agent_id =
        // <definition_id>`, which won't match a session_id). Warn so the
        // miss is diagnosable instead of presenting as "agent_org
        // session that never receives anything".
        let agent_id = runtime.agent_definition_id.clone().unwrap_or_else(|| {
            if runtime.agent_org_context.is_some() {
                warn!(
                    session_id = %session.id,
                    "[unified_processor] agent_org session has no agent_definition_id; \
                     falling back to session.id for agent_id — inbox_drain and member_idle \
                     will not match definition-keyed rows"
                );
            } else {
                debug!(
                    session_id = %session.id,
                    "[unified_processor] runtime has no agent_definition_id; \
                     falling back to session.id for agent_id"
                );
            }
            session.id.clone()
        });

        let sm_state = Arc::clone(&session.sm_state);

        Self {
            runtime,
            session,
            policy,
            agent_id,
            channel,
            chat_id,
            agent_mode,
            ide_context,
            app_handle,
            screenshot_store,
            event_handler_config,
            compaction_state: tokio::sync::Mutex::new(CompactionState::default()),
            sm_state,
            sm_config: SessionMemoryConfig::default(),
            sm_compact_config: SessionMemoryCompactConfig::default(),
            replacement_state: tokio::sync::Mutex::new(ReplacementState::new()),
            rounds_since_todo: tokio::sync::Mutex::new(None),
            rounds_since_subagent_reminder: tokio::sync::Mutex::new(None),
            turn_prefetch_hook: tokio::sync::Mutex::new(None),
        }
    }

    /// Tool policy actually used for this turn, including the exec-mode
    /// overlay. Product mode is not a tool overlay: `org2-pm` enforces
    /// it at the application boundary via the injected ORGII_MODE.
    pub(super) fn effective_tool_policy(&self) -> Arc<ResolvedToolPolicy> {
        match self.agent_mode {
            Some(mode) => Arc::new(self.policy.with_exec_mode(mode)),
            None => Arc::clone(&self.policy),
        }
    }

    /// Iteration cap for this turn: takes the lower of the session-model cap
    /// and the exec-mode cap so that read-only modes cannot loop more than
    /// their mode-specific ceiling even if the agent definition sets a higher
    /// `max_iterations` on the session model.
    pub(super) fn effective_max_iterations(&self) -> Option<u32> {
        use crate::session::AgentExecMode;
        let session_cap = super::super::turn_max_iterations_from_session_model(
            self.runtime.resolved.session_model.max_iterations,
        );
        let mode_cap: Option<u32> = match self.agent_mode {
            Some(AgentExecMode::Plan) => Some(30),
            Some(AgentExecMode::Ask) => Some(30),
            Some(AgentExecMode::Review) => Some(30),
            _ => None,
        };
        match (session_cap, mode_cap) {
            (Some(sc), Some(mc)) => Some(sc.min(mc)),
            (sc, mc) => sc.or(mc),
        }
    }

    /// Workspace root path from the session workspace.
    pub(super) fn workspace_root(&self) -> Option<std::path::PathBuf> {
        Some(
            self.runtime
                .workspace_state
                .read()
                .working_dir()
                .to_path_buf(),
        )
    }

    /// Records a pre-message anchor snapshot in the DB so the rewind logic
    /// has a stable handle for "this user message" even when no tools end up
    /// running. The snapshot manifest itself is empty (no captured files);
    /// `event_handler::take_snapshot` adds per-tool-call snapshots as edits
    /// happen during the turn, and `file_history::rewind_to_message` walks
    /// all DB rows whose `created_at` is at-or-after the target.
    pub(super) async fn take_pre_message_snapshot(&self, session_id: &str) {
        if self.event_handler_config.workspace_path.is_none() {
            return;
        }

        match crate::tools::file_history::make_snapshot(session_id) {
            Ok(snapshot_id) => {
                info!(
                    "[unified_processor] Pre-message file_history snapshot: {}",
                    snapshot_id
                );
                if let Err(err) = super::super::super::persistence::save_snapshot(
                    session_id,
                    "__pre_message__",
                    &snapshot_id,
                ) {
                    warn!(
                        "[unified_processor] Failed to persist pre-message snapshot row: {}",
                        err
                    );
                }
            }
            Err(err) => {
                warn!(
                    "[unified_processor] Pre-message file_history snapshot failed: {}",
                    err
                );
            }
        }
    }
}
