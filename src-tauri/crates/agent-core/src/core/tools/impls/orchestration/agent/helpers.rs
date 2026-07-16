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
                 status (panic or hard-abort after kill); emitting a terminal \
                 verdict so the job registry, UI, and child-session row release",
                self.handle
            );
            // Killed-sticky: if kill_subagent already stamped Killed, this
            // Failed write is ignored; otherwise (panic) Failed is correct.
            job_registry::mark_exited(&self.handle, job_registry::JobStatus::Failed);
            // Also close the durable `agent_sessions` row. broadcast_complete/
            // broadcast_error normally do this, but a hard-aborted task (kill
            // watchdog) or a panic never reaches them — leaving the child row
            // `running` forever, which keeps the monitoring pin-bar clip open
            // (endedAt=null → frontend renders an eternally-running card).
            if let Err(err) = crate::session::persistence::update_status(
                &self.handle,
                crate::session::SessionStatus::Cancelled,
            ) {
                tracing::warn!(
                    "[agent] FinalizeGuard failed to close child session row '{}': {}",
                    self.handle,
                    err
                );
            }
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

/// RAII guard for the provisional "running" broadcast emitted at spawn
/// entry — BEFORE the slow init phase (provider preflight, registry
/// build, worktree creation) that precedes real job registration.
///
/// Without it the frontend's live-subagent signal only turns on when the
/// job registers (after init), so the planning footer / Stop affordance
/// vanish for the whole creation window and the session looks hung.
///
/// Real registration re-broadcasts "running" for the same handle
/// (idempotent upsert on the FE job map), at which point the caller
/// `disarm()`s this guard. If init fails/early-returns first, Drop
/// broadcasts "failed" so the provisional row never sticks as a ghost
/// "running" entry.
pub struct ProvisionalJobGuard {
    parent_session_id: String,
    handle: String,
    agent_name: String,
    subagent_type: String,
    armed: bool,
}

impl ProvisionalJobGuard {
    pub fn announce(
        parent_session_id: &str,
        handle: &str,
        agent_name: &str,
        subagent_type: &str,
    ) -> Self {
        crate::tools::impls::coding::exec::registry::broadcast_subagent_job_changed(
            parent_session_id,
            handle,
            agent_name,
            subagent_type,
            "running",
        );
        Self {
            parent_session_id: parent_session_id.to_string(),
            handle: handle.to_string(),
            agent_name: agent_name.to_string(),
            subagent_type: subagent_type.to_string(),
            armed: true,
        }
    }

    /// Call once real registration has taken over the handle.
    pub fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ProvisionalJobGuard {
    fn drop(&mut self) {
        if self.armed {
            crate::tools::impls::coding::exec::registry::broadcast_subagent_job_changed(
                &self.parent_session_id,
                &self.handle,
                &self.agent_name,
                &self.subagent_type,
                "failed",
            );
        }
    }
}

/// One-shot agents whose results skip the usage/resume trailer — these are
/// fire-and-forget research helpers where the ~150-char trailer is dead
/// weight at high call volume and resuming them is not a meaningful flow.
const ONE_SHOT_AGENT_IDS: &[&str] = &[crate::definitions::builtin::EXPLORE_AGENT_ID];

/// Append the usage/resume trailer to a successful foreground subagent
/// result, telling the parent what the run cost and how to continue it.
///
/// Skipped for one-shot agents (Explore) — mirroring the reference
/// implementation's decision that the trailer is pure overhead there.
pub fn append_result_trailer(
    response: String,
    agent_definition_id: &str,
    session_id: &str,
    total_tokens: i64,
    tool_uses: usize,
) -> String {
    if ONE_SHOT_AGENT_IDS.contains(&agent_definition_id) {
        return response;
    }
    format!(
        "{response}\n\n---\nsession_id: {session_id} (pass as resume_session_id to continue this agent)\n<usage>total_tokens: {total_tokens}\ntool_uses: {tool_uses}</usage>"
    )
}

/// Count tool calls in a subagent transcript (assistant messages'
/// `tool_calls` arrays) for the usage trailer.
pub fn count_tool_uses(messages: &[serde_json::Value]) -> usize {
    messages
        .iter()
        .filter_map(|msg| msg.get("tool_calls").and_then(|tc| tc.as_array()))
        .map(|arr| arr.len())
        .sum()
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
/// `inherit_parent_verbatim` controls step 4 only: fork/shadow workers
/// share the parent conversation's request prefix, so they must inherit
/// the parent model VERBATIM — reasoning suffix included — or the forked
/// request runs on a different model/thinking config and gets zero
/// prompt-cache reuse. Delegate workers pass `false` and keep the
/// suffix-stripping default.
///
/// `parent_model` is always returned as a last resort so the caller can
/// still construct *some* turn config when the definition is incomplete.
pub fn resolve_subagent_model(
    agent: &AgentDefinition,
    explicit_param_model: Option<&str>,
    parent_model: &str,
    inherit_parent_verbatim: bool,
) -> (String, Option<ReliabilityConfig>) {
    if let Some(explicit) = explicit_param_model
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
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
        _ => {
            if inherit_parent_verbatim {
                return (parent_model.to_string(), None);
            }
            // Workers inheriting the parent model drop its reasoning/thinking
            // suffix (e.g. `-high`): parallel workers should default to the
            // base model unless their prompt or definition explicitly asks for
            // extra effort. Explicit `model` params and definition-pinned
            // models above stay untouched.
            let parsed = crate::providers::thinking_mode::parse_model_variant(parent_model);
            if parsed.level.is_some() || parsed.thinking {
                return (parsed.base_model, None);
            }
            return (parent_model.to_string(), None);
        }
    };

    let mut reliability = agent.reliability.clone().unwrap_or_default();
    reliability
        .fallback_models
        .retain(|model| !model.is_empty() && model.as_str() != primary);
    (primary.to_string(), Some(reliability))
}

/// Repo root + base branch a worker task needs to decide worktree disposal
/// after an `isolation: "worktree"` run terminates.
pub(super) struct WorktreeCleanup {
    pub workspace_root: std::path::PathBuf,
    pub base_branch: Option<String>,
}

/// Post-run worktree disposition (reference parity: the worktree is KEPT
/// when the worker made changes, removed only when clean).
///
/// - Dirty or committed-ahead worktree → keep worktree AND branch (the
///   session's Pending merge metadata stays), return
///   `(worktree_path, branch)` so the caller can surface the location in
///   the worker result / completion notification.
/// - Clean worktree → full cleanup (worktree + branch + merge metadata).
/// - Changes-check failure → keep and return `None`: never destroy work
///   that cannot be proven absent.
pub(super) async fn dispose_worktree_after_run(
    cleanup: WorktreeCleanup,
    session_id: &str,
    log_prefix: &'static str,
) -> Option<(String, String)> {
    let sid = session_id.to_string();
    let joined =
        tokio::task::spawn_blocking(move || -> Result<Option<(String, String)>, String> {
            let state = git::worktree::session_worktree_state(
                &cleanup.workspace_root,
                &sid,
                cleanup.base_branch.as_deref(),
            )?;
            if state.has_changes() {
                return Ok(Some((
                    state.worktree_path.to_string_lossy().into_owned(),
                    state.branch,
                )));
            }
            git::worktree::remove_session_worktree(&cleanup.workspace_root, &sid, true)?;
            // The Pending merge-status row would otherwise dangle on a
            // deleted branch.
            let _ = crate::session::persistence::clear_worktree_metadata(&sid);
            Ok(None)
        })
        .await;
    match joined {
        Ok(Ok(kept)) => {
            if let Some((ref path, ref branch)) = kept {
                tracing::info!(
                    "[{log_prefix}] worker '{session_id}' left changes; keeping worktree {path} (branch {branch})"
                );
            }
            kept
        }
        Ok(Err(err)) => {
            tracing::warn!(
                "[{log_prefix}] worktree disposition failed for '{session_id}': {err}; \
                 keeping the worktree (never destroy unverified work)"
            );
            None
        }
        Err(join_err) => {
            tracing::warn!(
                "[{log_prefix}] worktree disposition task for '{session_id}' did not \
                 complete cleanly: {join_err}; keeping the worktree"
            );
            None
        }
    }
}

/// Note prefixed to a worker result when its isolation worktree was kept.
/// `worktree_path:` / `worktree_branch:` lines mirror the reference
/// harness's tool_result fields; prefixing (not appending) keeps the note
/// visible when the Background Jobs reminder head-truncates a long result.
pub(super) fn worktree_kept_note(worktree_path: &str, branch: &str) -> String {
    format!(
        "worktree_path: {worktree_path}\n\
         worktree_branch: {branch}\n\
         The worker left changes in its isolated worktree, so the worktree and \
         branch were KEPT (not auto-deleted). Review and merge the branch, or \
         remove the worktree, when done."
    )
}

/// Prefix `result` with the kept-worktree note when disposition kept it.
pub(super) fn prepend_worktree_note(
    result: String,
    kept_worktree: Option<&(String, String)>,
) -> String {
    match kept_worktree {
        Some((path, branch)) => {
            format!("{}\n\n{}", worktree_kept_note(path, branch), result)
        }
        None => result,
    }
}

/// File name of a worker's persisted full final report inside
/// `app_paths::tool_results_dir(<worker session id>)`.
const FULL_RESULT_FILE_NAME: &str = "final-report.md";

/// Persist the worker's FULL final message to its tool-results directory
/// when it exceeds the Background Jobs reminder inline cap, and prefix a
/// pointer so the parent can `read_file` the complete report even after
/// the reminder truncates the inline excerpt (the reminder keeps the HEAD
/// of the result, so the pointer survives). Results at or under the cap —
/// and results whose persistence fails — pass through unchanged.
pub(super) fn with_full_result_pointer(session_id: &str, result: String) -> String {
    use crate::core::session::turn::background_reminder::INLINE_RESULT_MAX_CHARS;
    if result.len() <= INLINE_RESULT_MAX_CHARS {
        return result;
    }
    let dir = app_paths::tool_results_dir(session_id);
    let write_result = std::fs::create_dir_all(&dir).and_then(|_| {
        let path = dir.join(FULL_RESULT_FILE_NAME);
        std::fs::write(&path, &result).map(|_| path)
    });
    match write_result {
        Ok(path) => format!(
            "[Full report saved to: {} — the inline text below may be truncated; \
             use read_file on that path for the complete report]\n{}",
            path.display(),
            result
        ),
        Err(err) => {
            tracing::warn!(
                "[agent] failed to persist full final report for '{}' ({} chars): {}",
                session_id,
                result.len(),
                err
            );
            result
        }
    }
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
        let (model, reliability) =
            resolve_subagent_model(&agent, Some("gpt-5"), "claude-haiku-4", false);

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
            resolve_subagent_model(&agent, Some("fast"), "claude-opus-4-20250514", false);
        assert!(reliability.is_none(), "fast override must drop reliability");
    }

    #[test]
    fn blank_explicit_param_model_is_ignored() {
        let agent = make_agent_with_model(None, None);
        let (model, reliability) = resolve_subagent_model(&agent, Some(""), "gpt-5.5", false);

        assert_eq!(model, "gpt-5.5");
        assert!(reliability.is_none());
    }

    #[test]
    fn whitespace_explicit_param_model_is_ignored() {
        let agent = make_agent_with_model(None, None);
        let (model, reliability) =
            resolve_subagent_model(&agent, Some("   \n\t"), "gpt-5.5", false);

        assert_eq!(model, "gpt-5.5");
        assert!(reliability.is_none());
    }

    #[test]
    fn definition_primary_with_fallbacks_produces_fallback_models() {
        let agent = make_agent_with_model(
            Some("claude-opus-4"),
            Some(vec!["claude-sonnet-4", "gpt-5"]),
        );
        let (model, reliability) = resolve_subagent_model(&agent, None, "parent-model", false);

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
        let (_model, reliability) = resolve_subagent_model(&agent, None, "parent-model", false);
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
        let (model, reliability) = resolve_subagent_model(&agent, None, "claude-opus-4", false);

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
        let (model, reliability) = resolve_subagent_model(&agent, None, "claude-opus-4", false);

        assert_eq!(model, "claude-opus-4");
        assert!(reliability.is_none());
    }

    /// Workers inheriting the parent model drop reasoning suffixes by
    /// default; explicit params and definition-pinned models keep them.
    #[test]
    fn inherited_parent_model_strips_reasoning_suffix() {
        let mut explore = make_agent_with_model(None, None);
        explore.id = crate::definitions::builtin::EXPLORE_AGENT_ID.to_string();

        let (model, _) = resolve_subagent_model(&explore, None, "gpt-5.4-high", false);
        assert_eq!(model, "gpt-5.4", "explore must strip the reasoning suffix");

        let general = make_agent_with_model(None, None);
        let (model, _) = resolve_subagent_model(&general, None, "claude-opus-4-8-high", false);
        assert_eq!(
            model, "claude-opus-4-8",
            "general workers inherit the base model"
        );

        // Suffix-free parent model passes through unchanged.
        let (model, _) = resolve_subagent_model(&general, None, "claude-fable-5", false);
        assert_eq!(model, "claude-fable-5");

        // Explicit param model is respected.
        let (model, _) =
            resolve_subagent_model(&explore, Some("gpt-5.4-high"), "claude-fable-5", false);
        assert_eq!(model, "gpt-5.4-high");

        // Definition-pinned models are respected.
        let pinned = make_agent_with_model(Some("claude-opus-4-8-high"), None);
        let (model, _) = resolve_subagent_model(&pinned, None, "claude-fable-5", false);
        assert_eq!(model, "claude-opus-4-8-high");
    }

    /// Fork/shadow workers share the parent's request prefix, so the
    /// parent-inherit fallback must return the model VERBATIM (reasoning
    /// suffix included) — otherwise the fork gets zero prompt-cache reuse.
    #[test]
    fn fork_or_shadow_inherits_parent_model_verbatim() {
        let general = make_agent_with_model(None, None);

        let (model, reliability) = resolve_subagent_model(&general, None, "gpt-5.4-high", true);
        assert_eq!(model, "gpt-5.4-high", "fork must keep the reasoning suffix");
        assert!(reliability.is_none());

        let (model, _) = resolve_subagent_model(&general, None, "claude-opus-4-8-high", true);
        assert_eq!(model, "claude-opus-4-8-high");

        // Explicit param model still wins over verbatim inherit.
        let (model, _) = resolve_subagent_model(&general, Some("gpt-5"), "gpt-5.4-high", true);
        assert_eq!(model, "gpt-5");

        // A definition-pinned model still wins over verbatim inherit.
        let pinned = make_agent_with_model(Some("claude-opus-4"), None);
        let (model, _) = resolve_subagent_model(&pinned, None, "gpt-5.4-high", true);
        assert_eq!(model, "claude-opus-4");
    }
}

#[cfg(test)]
mod result_note_tests {
    use super::*;

    #[test]
    fn worktree_note_prepended_only_when_kept() {
        let kept = Some(("/wt/path".to_string(), "agent/x".to_string()));
        let noted = prepend_worktree_note("report body".to_string(), kept.as_ref());
        assert!(noted.starts_with("worktree_path: /wt/path\n"), "{noted}");
        assert!(noted.contains("worktree_branch: agent/x"));
        assert!(noted.contains("KEPT"));
        assert!(noted.ends_with("report body"));

        let untouched = prepend_worktree_note("report body".to_string(), None);
        assert_eq!(untouched, "report body");
    }

    #[test]
    fn small_result_passes_through_without_pointer_or_file() {
        let session = format!("agent-pointer-test-{}", uuid::Uuid::new_v4().simple());
        let out = with_full_result_pointer(&session, "short report".to_string());
        assert_eq!(out, "short report");
        assert!(
            !app_paths::tool_results_dir(&session).exists(),
            "no file must be written for small results"
        );
    }

    #[test]
    fn oversized_result_is_persisted_and_pointer_prepended() {
        let session = format!("agent-pointer-test-{}", uuid::Uuid::new_v4().simple());
        let big = "line of report\n".repeat(1_000); // 15K chars > 8K cap
        let out = with_full_result_pointer(&session, big.clone());
        assert!(out.starts_with("[Full report saved to: "), "{}", &out[..80]);
        assert!(out.ends_with(&big), "full text must stay inline too");

        let path = app_paths::tool_results_dir(&session).join("final-report.md");
        let persisted = std::fs::read_to_string(&path).expect("full report file must exist");
        assert_eq!(persisted, big, "file must hold the untruncated report");
        std::fs::remove_dir_all(app_paths::tool_results_dir(&session)).ok();
    }
}
