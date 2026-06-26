//! Pure helpers used by both `execute_text` and unit tests.
//!
//! Keeping these as free functions (not methods on `AgentTool`) lets the
//! test module exercise them without standing up a full `AgentTool`
//! (registry, provider, runtime).

use serde_json::Value;

pub fn optional_nonempty_string_param(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

use crate::config::ReliabilityConfig;
use crate::coordination::agent_org_runs::AgentOrgRunContext;
use crate::definitions::builtin::{
    is_builtin_agent, BUILTIN_PREFIX, EXPLORE_AGENT_ID, GENERAL_AGENT_ID,
};
use crate::definitions::AgentDefinition;
use crate::tools::impls::coding::exec::registry as job_registry;
use crate::tools::traits::ToolError;

/// RAII guard that guarantees a terminal job event is emitted for a subagent
/// worker on EVERY exit path — including a panic inside the turn loop that
/// unwinds past the explicit `mark_exited` calls.
///
/// Both the background and foreground paths register a job and then run
/// `execute_turn`, writing the authoritative `Completed`/`Failed` status in a
/// result `match` afterwards. If the turn loop panics and unwinds, that match
/// never runs, the registry row stays `Running` forever, and the UI pin bar
/// shows a ghost "running" subagent until app restart.
///
/// Arm the guard right after registering the job; call [`FinalizeGuard::disarm`]
/// once the real verdict is written. `mark_exited` is idempotent and
/// `Killed`-sticky, so a late guard fire after a cooperative kill is also safe.
pub(super) struct FinalizeGuard {
    handle: String,
    armed: bool,
}

impl FinalizeGuard {
    pub(super) fn new(handle: String) -> Self {
        Self {
            handle,
            armed: true,
        }
    }

    /// Mark the authoritative status as already written; the guard becomes a
    /// no-op on drop.
    pub(super) fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for FinalizeGuard {
    fn drop(&mut self) {
        if self.armed {
            tracing::warn!(
                "[agent] subagent worker '{}' exited without writing a terminal \
                 status (likely a panic in the turn loop); emitting Failed so the \
                 job registry and UI release the row",
                self.handle
            );
            job_registry::mark_exited(&self.handle, job_registry::JobStatus::Failed);
        }
    }
}

/// Wire-format vocabulary for the `subagent_type` field on
/// `subagent:*` Tauri events and the parent `agent` tool_call stamp.
///
/// Keep these in sync with the frontend label tables. The renderer
/// uses these strings as discriminants for icon / panel selection
/// (see `src/util/ui/terminal/naming.ts` and
/// `src/util/session/sessionDispatch.ts`).
pub mod subagent_type {
    /// Built-in `explore` subagent (read-only codebase search).
    pub const EXPLORE: &str = "explore";

    /// Built-in `general` subagent (full tool access). The wire label
    /// is `"generalPurpose"` for compatibility with the frontend
    /// mapping tables; do not change without also updating those.
    pub const GENERAL_PURPOSE: &str = "generalPurpose";

    /// `mode = "shadow"` clone of the parent agent.
    pub const SHADOW: &str = "shadow";

    /// User-defined (non-builtin) agent.
    pub const CUSTOM: &str = "custom";
}

/// Compute the wire-format `subagent_type` label for a given launched
/// agent. Used as a single source of truth across foreground /
/// background launch paths and parent-stamp persistence.
///
/// - `builtin:explore`  → [`subagent_type::EXPLORE`]
/// - `builtin:general`  → [`subagent_type::GENERAL_PURPOSE`]
/// - `builtin:<other>`  → trailing component (e.g. `project-manager`)
/// - non-builtin id     → [`subagent_type::CUSTOM`]
///
/// Shadow mode does NOT call this (it always emits
/// [`subagent_type::SHADOW`] regardless of the cloned agent id).
pub fn subagent_type_label(agent_id: &str) -> String {
    if agent_id == EXPLORE_AGENT_ID {
        subagent_type::EXPLORE.to_string()
    } else if agent_id == GENERAL_AGENT_ID {
        subagent_type::GENERAL_PURPOSE.to_string()
    } else if is_builtin_agent(agent_id) {
        agent_id
            .strip_prefix(BUILTIN_PREFIX)
            .unwrap_or(agent_id)
            .to_string()
    } else {
        subagent_type::CUSTOM.to_string()
    }
}

/// Outcome of resolving `agent_id` from launch params. `fallback` is true
/// when delegate mode ran without an explicit id — the caller typically
/// wants to emit a warn log in that case.
pub struct ResolvedAgentId {
    pub agent_id: String,
    pub fallback: bool,
}

/// Resolves the `agent_id` param for both `delegate` and `shadow` modes.
///
/// Neither mode rejects a missing `agent_id`: both fall back to
/// `GENERAL_AGENT_ID`. `subagent_type` is optional with a
/// general-purpose default — a conditional `required` ("required only
/// in delegate mode") can't be expressed in a plain JSON Schema that
/// every provider respects, so we keep the schema simple and absorb
/// the ambiguity at runtime.
///
/// `fallback` is `true` only for the delegate-without-id case, because
/// shadow mode *legitimately* ignores this field.
pub fn resolve_agent_id_for_execute(params: &Value) -> ResolvedAgentId {
    let mode = params
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("delegate");
    let is_shadow = mode == "shadow";
    let explicit = params.get("agent_id").and_then(|v| v.as_str());
    match explicit {
        Some(id) => ResolvedAgentId {
            agent_id: id.to_string(),
            fallback: false,
        },
        None => ResolvedAgentId {
            agent_id: GENERAL_AGENT_ID.to_string(),
            fallback: !is_shadow,
        },
    }
}

/// Returns true if `resume_session_id` has the shape this system actually
/// produces: `<prefix>-<agent_id>-<uuid>` where the trailing UUID always
/// contributes exactly 5 dash-separated segments. Tolerates agent ids with
/// embedded dashes/colons (e.g. `builtin:general`) by taking the last 5
/// segments, rejoining, and parsing as a UUID.
///
/// Used as a cheap pre-check before hitting `load_llm_history`, which
/// would otherwise return an empty history for a hallucinated id and
/// surface as "No persisted history found".
pub fn looks_like_valid_subagent_session_id(s: &str) -> bool {
    let segments: Vec<&str> = s.split('-').collect();
    if segments.len() < 5 {
        return false;
    }
    let tail = segments[segments.len() - 5..].join("-");
    uuid::Uuid::parse_str(&tail).is_ok()
}

/// Guard that keeps Agent Org roster participants separate from
/// private sub-agent delegation.
///
/// Roster lifecycle rules:
///
/// - Roster member sessions are materialized at Agent Org launch time.
///   The `agent` tool is only for private sub-agent delegation, not for
///   creating or re-creating teammates.
/// - A coordinator/member may not spawn the coordinator or a roster
///   participant. They communicate with teammates through
///   `org_send_message` and the shared task queue.
/// - A non-coordinator member may not spawn any background sub-agent; it
///   would outlive the member session and detach from the org run lifecycle.
///
/// Returns `Some(ToolError)` when a session participating in an Agent
/// Org run violates those rules.
///
/// Returns `None` for:
/// - Non-org sessions (`agent_org_context == None`).
/// - Shadow mode (no new persistent participant is created — shadow is
///   an internal subagent reuse path).
/// - Foreground spawns of ordinary non-roster sub-agents
///   (`builtin:explore`, `builtin:general`, fork, custom helper agents).
///
/// `AgentDefinition` does not carry a `background: bool` field — only
/// the caller-supplied `background` param is checked here. If a
/// definition-level background flag is ever introduced, extend this
/// helper to gate on the resolved agent definition as well.
pub fn org_roster_spawn_rejection(
    is_shadow: bool,
    is_org_member: bool,
    agent_org_context: Option<&AgentOrgRunContext>,
    target_agent_id: &str,
    is_background: bool,
) -> Option<ToolError> {
    if is_shadow {
        return None;
    }
    let org_context = agent_org_context?;

    let target_is_coordinator = target_agent_id == org_context.coordinator_agent_id;
    let target_is_member = org_context
        .members
        .iter()
        .any(|member| member.agent_id == target_agent_id);
    let target_is_org_participant = target_is_coordinator || target_is_member;

    if target_is_org_participant {
        return Some(ToolError::ExecutionFailed(format!(
            "Agent Org sessions cannot spawn roster participant '{target_agent_id}' with the \
             `agent` tool. Roster member sessions are materialized when the Agent Org launches; \
             use `org_send_message` or the shared task queue to coordinate with org participants."
        )));
    }

    if is_org_member && is_background {
        return Some(ToolError::ExecutionFailed(format!(
            "Org members cannot spawn background sub-agents. Their lifecycle is tied to \
             the org run; a background agent would outlive the member session. Set \
             `background: false` (or omit it) and run '{target_agent_id}' synchronously."
        )));
    }

    None
}

/// Guard that enforces "a subagent may NOT spawn another subagent".
///
/// Returns `Some(ToolError)` when the caller is already running as a
/// subagent (its `delegation_chain` is non-empty). Returns `None` at the
/// root session, where `agent` tool calls are legitimate.
///
/// Lives as a pure helper so it can be unit-tested without standing
/// up a full `AgentTool` (registry, provider, runtime).
pub fn subagent_of_subagent_rejection(delegation_chain: &[String]) -> Option<ToolError> {
    if delegation_chain.is_empty() {
        return None;
    }
    let chain_display = delegation_chain.join(" -> ");
    Some(ToolError::ExecutionFailed(format!(
        "Subagents cannot spawn other subagents. Current delegation chain: \
         {chain_display}. Complete the current task directly with your own \
         tools, or return control to the parent agent and let it decide \
         whether another subagent is needed."
    )))
}

/// Build the tool_result message returned to the parent agent when a
/// background subagent is launched.
///
/// Pure function of `agent_name` + `session_id` so it can be unit/e2e
/// tested without standing up a full background spawn. The contract this
/// message must honour (pinned by `subagent-launch-msg-no-poll`):
///   - includes the subagent's session_id (the DB key the parent queries)
///   - tells the parent it will be notified automatically + NOT to poll
///   - hands the parent a ready-made sqlite3 query over `agent_messages`
///     instead of pointing it at `await_output` for progress checks
pub fn background_launch_message(agent_name: &str, session_id: &str) -> String {
    format!(
        "Subagent '{}' launched in background.\n\
         Session ID: {}\n\
         You will be notified automatically when it finishes (via the Background Jobs system reminder).\n\
         Do NOT call await_output repeatedly to poll.\n\
         Proceed with other work. If you want to check the subagent's progress, \
         you can query its session data:\n  \
         sqlite3 ~/.orgii/sessions.db \"SELECT role, substr(content,1,200), tool_name \
         FROM agent_messages WHERE session_id='{}' ORDER BY sequence DESC LIMIT 10\"",
        agent_name, session_id, session_id
    )
}

/// Resolve the model + reliability bundle a sub-agent should run with.
///
/// Precedence:
///
///   1. `params.model = "fast"` — caller picked the fast variant of the
///      *parent's* model. Explicit pin: no reliability override.
///   2. `params.model = "<explicit>"` — caller pinned a specific model.
///      Same: explicit override carries no reliability.
///   3. `agent.selected_model_id` — sub-agent's own definition. Its
///      `reliability.fallback_models` (if any) becomes the runtime
///      fallback list, with the primary filtered out.
///   4. None of the above — fall through to the parent's currently
///      active model. No reliability override.
///
/// `parent_model` is always returned as a last resort so the caller can
/// still construct *some* turn config when the definition is incomplete.
pub fn resolve_subagent_model(
    agent: &AgentDefinition,
    explicit_param_model: Option<&str>,
    parent_model: &str,
) -> (String, Option<ReliabilityConfig>) {
    if let Some(explicit) = explicit_param_model {
        if explicit == "fast" {
            return (
                crate::providers::model_hints::fast_model_hint(parent_model),
                None,
            );
        }
        return (explicit.to_string(), None);
    }

    let primary = match agent.selected_model_id.as_deref() {
        Some(p) if !p.is_empty() => p,
        _ => return (parent_model.to_string(), None),
    };

    let mut reliability = agent.reliability.clone().unwrap_or_default();
    reliability.fallback_models = reliability
        .fallback_models
        .into_iter()
        .filter(|model| !model.is_empty() && model.as_str() != primary)
        .collect();
    (primary.to_string(), Some(reliability))
}

#[cfg(test)]
mod resolve_subagent_model_tests {
    use super::*;
    use crate::core::config::ReliabilityConfig;
    use crate::definitions::schema::AgentDefinition;

    fn make_agent_with_model(
        primary: Option<&str>,
        fallbacks: Option<Vec<&str>>,
    ) -> AgentDefinition {
        let mut agent = AgentDefinition::default();
        agent.id = "custom:test".to_string();
        agent.name = "Test".to_string();
        agent.selected_model_id = primary.map(|s| s.to_string());
        agent.reliability = fallbacks.map(|models| ReliabilityConfig {
            fallback_models: models.into_iter().map(|m| m.to_string()).collect(),
            ..Default::default()
        });
        agent
    }

    #[test]
    fn explicit_param_model_drops_reliability() {
        let agent = make_agent_with_model(Some("claude-opus-4"), Some(vec!["claude-sonnet-4"]));
        let (model, reliability) = resolve_subagent_model(&agent, Some("gpt-5"), "claude-haiku-4");

        assert_eq!(model, "gpt-5");
        assert!(
            reliability.is_none(),
            "explicit override must drop reliability"
        );
    }

    #[test]
    fn explicit_fast_resolves_to_fast_model_no_reliability() {
        let agent = make_agent_with_model(Some("claude-opus-4"), None);
        let (_model, reliability) =
            resolve_subagent_model(&agent, Some("fast"), "claude-opus-4-20250514");
        assert!(reliability.is_none(), "fast override must drop reliability");
    }

    #[test]
    fn definition_primary_with_fallbacks_produces_fallback_models() {
        let agent = make_agent_with_model(
            Some("claude-opus-4"),
            Some(vec!["claude-sonnet-4", "gpt-5"]),
        );
        let (model, reliability) = resolve_subagent_model(&agent, None, "parent-model");

        assert_eq!(model, "claude-opus-4");
        let rel = reliability.expect("definition path must produce reliability");
        assert_eq!(rel.fallback_models, vec!["claude-sonnet-4", "gpt-5"]);
    }

    #[test]
    fn definition_primary_filters_self_from_fallbacks() {
        let agent = make_agent_with_model(
            Some("claude-opus-4"),
            Some(vec!["claude-opus-4", "claude-sonnet-4"]),
        );
        let (_model, reliability) = resolve_subagent_model(&agent, None, "parent-model");
        let rel = reliability.expect("definition path must produce reliability");
        assert_eq!(
            rel.fallback_models,
            vec!["claude-sonnet-4"],
            "primary must not appear in the fallback list"
        );
    }

    #[test]
    fn no_definition_model_falls_back_to_parent_no_reliability() {
        let agent = make_agent_with_model(None, Some(vec!["gpt-5"]));
        let (model, reliability) = resolve_subagent_model(&agent, None, "claude-opus-4");

        assert_eq!(
            model, "claude-opus-4",
            "missing primary must fall through to parent"
        );
        assert!(
            reliability.is_none(),
            "parent-fallback path must NOT carry reliability"
        );
    }

    #[test]
    fn empty_definition_primary_falls_back_to_parent() {
        let agent = make_agent_with_model(Some(""), Some(vec!["gpt-5"]));
        let (model, reliability) = resolve_subagent_model(&agent, None, "claude-opus-4");

        assert_eq!(model, "claude-opus-4");
        assert!(reliability.is_none());
    }
}
