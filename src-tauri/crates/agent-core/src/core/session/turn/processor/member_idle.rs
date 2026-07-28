//! Member-idle notification emit point for the unified turn processor.
//!
//! Part of the Agent Org coordination layer.
//!
//! # What this is
//!
//! When a worker session running inside an `AgentOrgRun` finishes a turn
//! (success, cancel, or failure), [`maybe_emit_member_idle`] posts an
//! [`AgentMessage::MemberIdle`] row addressed to the coordinator's inbox.
//! The coordinator's next turn-boundary drain (see [`super::inbox_drain`])
//! will render it as a member-id-addressed idle notification so the
//! coordinator's LLM is told which worker has gone idle and is available
//! for new dispatch.
//!
//! # Why it's a hook + global
//!
//! The processor's success path does not have an `AgentInboxStore`
//! borrow plumbed in (it currently only writes through the org-context
//! drain machinery), and threading one through purely for this emit
//! would be a much larger surface change than the protocol fix
//! warrants. The hook is installed exactly once at app boot
//! (`agent_core::core::tools::impls::orchestration::member_idle::install_member_idle_hook`);
//! tests substitute a recording stub via the `test_overrides` module.
//!
//! # Invariants
//!
//! - **Coordinator never emits idle to itself.** Only runtimes with a
//!   canonical roster `member_id` can emit idle. The coordinator's root
//!   session has no worker `member_id`, and `agent_id` is never used to
//!   infer member identity.
//! - **System-sender only.** Production hook persists with
//!   `sender_agent_id = SYSTEM_SENDER_ID`. The LLM-callable
//!   `org_send_message` tool rejects `kind = "member_idle"` so a
//!   worker cannot forge an idle ack for a peer.
//! - **Fire-and-forget.** Emit failures are logged and swallowed —
//!   missing one notification is preferable to failing a turn that
//!   already produced output. Same contract as
//!   `MemberShutdownHook::cancel_member_session`.

use std::sync::{Arc, OnceLock};

use crate::coordination::agent_inbox::MemberIdleReason;
use crate::coordination::agent_org_tasks::{
    self, AgentOrgTaskStore, TaskExecutionMode, TaskStatus,
};
use crate::session::AgentExecMode;

/// Fire-and-forget emit hook. Production posts an
/// [`crate::coordination::agent_inbox::AgentMessage::MemberIdle`]
/// row to the coordinator's inbox; tests record the call without
/// touching SQLite.
///
/// `summary` is the optional last-peer-DM summary attached to the
/// idle notification so the coordinator's LLM has immediate context
/// for the worker's most recent direct message. orgii does not yet
/// compute this summary, so the production caller currently passes
/// `None`; the trait still accepts it so the hook signature stays
/// stable when the summary lookup is added.
///
/// `failure_reason` is required by `AgentMessage::MemberIdle::validate`
/// when `reason == Failed`; lifecycle finalization supplies the runtime
/// error string for failed member turns.
pub trait MemberIdleHook: Send + Sync {
    // The identity / payload args are deliberately flat: the emit site
    // has them as plain locals, packing them into a struct just to
    // satisfy clippy would push allocation noise into a hot-path no-op
    // (most calls return immediately because the session is the
    // coordinator).
    #[allow(clippy::too_many_arguments)]
    fn post_member_idle(
        &self,
        org_run_id: &str,
        coordinator_agent_id: &str,
        member_id: &str,
        member_agent_id: &str,
        member_name: &str,
        reason: MemberIdleReason,
        current_mode: Option<AgentExecMode>,
        summary: Option<String>,
        failure_reason: Option<String>,
        unfinished_task_ids: Vec<String>,
    );
}

/// No-op hook for tests / contexts where no real inbox store is wired.
/// Used by [`current_member_idle_hook`] as the fallback when neither
/// the production install nor a test override has been set.
pub struct NoopMemberIdleHook;

impl MemberIdleHook for NoopMemberIdleHook {
    #[allow(clippy::too_many_arguments)]
    fn post_member_idle(
        &self,
        _org_run_id: &str,
        _coordinator_agent_id: &str,
        _member_id: &str,
        _member_agent_id: &str,
        _member_name: &str,
        _reason: MemberIdleReason,
        _current_mode: Option<AgentExecMode>,
        _summary: Option<String>,
        _failure_reason: Option<String>,
        _unfinished_task_ids: Vec<String>,
    ) {
    }
}

static MEMBER_IDLE_HOOK: OnceLock<Arc<dyn MemberIdleHook>> = OnceLock::new();

/// Install the production [`MemberIdleHook`] at app boot. Idempotent:
/// subsequent calls silently no-op so per-test overrides via
/// [`test_overrides::set`] remain safe even after the production hook
/// is installed in the same process.
pub fn install_member_idle_hook(hook: Arc<dyn MemberIdleHook>) {
    let _ = MEMBER_IDLE_HOOK.set(hook);
}

/// Resolve the active hook: test override → production install →
/// no-op. Mirrors `inbox_drain::current_member_shutdown_hook`.
fn current_member_idle_hook() -> Arc<dyn MemberIdleHook> {
    test_overrides::current()
        .or_else(|| MEMBER_IDLE_HOOK.get().cloned())
        .unwrap_or_else(|| Arc::new(NoopMemberIdleHook) as Arc<dyn MemberIdleHook>)
}

mod test_overrides {
    use super::MemberIdleHook;
    use std::sync::{Arc, RwLock};

    static TEST_HOOK: RwLock<Option<Arc<dyn MemberIdleHook>>> = RwLock::new(None);

    pub fn current() -> Option<Arc<dyn MemberIdleHook>> {
        TEST_HOOK
            .read()
            .ok()
            .and_then(|guard| guard.as_ref().cloned())
    }

    #[cfg(test)]
    pub fn set(hook: Arc<dyn MemberIdleHook>) {
        if let Ok(mut guard) = TEST_HOOK.write() {
            *guard = Some(hook);
        }
    }

    #[cfg(test)]
    pub fn clear() {
        if let Ok(mut guard) = TEST_HOOK.write() {
            *guard = None;
        }
    }
}

/// RAII guard for tests: install a recording hook on construction and
/// tear it down on drop, so an in-test panic does not leak the global
/// for the next test in the same process. Mirrors
/// `inbox_drain::MemberShutdownHookGuard`.
#[cfg(test)]
pub struct MemberIdleHookGuard;

#[cfg(test)]
impl MemberIdleHookGuard {
    pub fn install(hook: Arc<dyn MemberIdleHook>) -> Self {
        test_overrides::set(hook);
        Self
    }
}

#[cfg(test)]
impl Drop for MemberIdleHookGuard {
    fn drop(&mut self) {
        test_overrides::clear();
    }
}

/// Decision: should the current member runtime emit a `MemberIdle`
/// notification at turn end?
///
/// Returns `Some((coordinator_agent_id, member_id, member_agent_id, member_name))`
/// only when `current_member_id` names a non-coordinator roster member.
/// `agent_id` is not a valid identity fallback: one AgentDefinition can back
/// multiple members in the same run.
pub(crate) fn idle_emit_target<'a>(
    current_member_id: Option<&str>,
    org_context: &'a crate::coordination::agent_org_runs::AgentOrgRunContext,
) -> Option<(&'a str, &'a str, &'a str, &'a str)> {
    let member_id = current_member_id?;
    let member = org_context
        .members
        .iter()
        .find(|member| member.member_id == member_id)?;
    Some((
        org_context.coordinator_agent_id.as_str(),
        member.member_id.as_str(),
        member.agent_id.as_str(),
        member.name.as_str(),
    ))
}

/// Return build tasks that still claim this idle worker is actively working.
/// Plan tasks are excluded because a durable plan approval may legitimately
/// keep them `in_progress` while the user or coordinator reviews the plan.
pub(crate) fn unfinished_build_task_ids_for_member(
    run_id: &str,
    member_id: &str,
) -> Result<Vec<String>, String> {
    Ok(AgentOrgTaskStore::list(run_id)?
        .into_iter()
        .filter(|task| {
            task.owner.as_deref() == Some(member_id)
                && task.status == TaskStatus::InProgress
                && agent_org_tasks::task_execution_mode(task) == TaskExecutionMode::Build
        })
        .map(|task| task.id)
        .collect())
}

/// Bounded same-turn correction used by the turn executor's existing Stop
/// gate. The executor asks at most once; this function never mutates task
/// state and never infers completion from natural-language output.
pub(crate) fn task_lifecycle_stop_feedback(
    run_id: &str,
    member_id: &str,
) -> Result<Option<String>, String> {
    let task_ids = unfinished_build_task_ids_for_member(run_id, member_id)?;
    if task_ids.is_empty() {
        return Ok(None);
    }
    Ok(Some(format!(
        "Agent Org task lifecycle check: your turn is about to end, but your owned build task(s) [{}] are still in_progress. Do not redo the substantive work. If the work is finished, call task_update for the exact task id with status=completed and output={{summary, content?, artifact_ids?}}. If it is not finished or is blocked, send the coordinator one task-bound explanation with org_send_message and leave the task in_progress. This correction is offered once; do not end silently.",
        task_ids.join(", ")
    )))
}

/// Emit a `MemberIdle` to the coordinator's inbox if the runtime has a
/// canonical roster `member_id`. No-op for the coordinator, non-org
/// sessions, ad-hoc delegate/shadow workers, or stale member ids.
pub fn maybe_emit_member_idle(
    org_context: Option<&crate::coordination::agent_org_runs::AgentOrgRunContext>,
    _agent_id: &str,
    current_member_id: Option<&str>,
    reason: MemberIdleReason,
    current_mode: Option<AgentExecMode>,
) {
    maybe_emit_member_idle_with_details(
        org_context,
        current_member_id,
        reason,
        current_mode,
        None,
        None,
        Vec::new(),
    );
}

pub fn maybe_emit_member_idle_with_details(
    org_context: Option<&crate::coordination::agent_org_runs::AgentOrgRunContext>,
    current_member_id: Option<&str>,
    reason: MemberIdleReason,
    current_mode: Option<AgentExecMode>,
    summary: Option<String>,
    failure_reason: Option<String>,
    unfinished_task_ids: Vec<String>,
) {
    let Some(org_context) = org_context else {
        return;
    };
    let Some((coordinator_agent_id, member_id, member_agent_id, member_name)) =
        idle_emit_target(current_member_id, org_context)
    else {
        return;
    };
    current_member_idle_hook().post_member_idle(
        &org_context.run_id,
        coordinator_agent_id,
        member_id,
        member_agent_id,
        member_name,
        reason,
        current_mode,
        summary,
        failure_reason,
        unfinished_task_ids,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coordination::agent_org_runs::{AgentOrgContextMember, AgentOrgRunContext};
    use crate::coordination::agent_org_tasks::{CreateTaskParams, TASK_METADATA_EXECUTION_MODE};
    use std::sync::{Mutex, MutexGuard};
    use test_helpers::test_env;

    /// Serialize the tests in this module that mutate the
    /// `test_overrides::TEST_HOOK` global. Without this, parallel
    /// `cargo test` workers race on the single override slot — one
    /// test's `clear()` (on guard drop) can clobber another test's
    /// freshly installed hook before it runs its assertion.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn serial_lock() -> MutexGuard<'static, ()> {
        match TEST_LOCK.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Recording stub: stores every `post_member_idle` call so tests
    /// can assert exact arguments without touching SQLite.
    #[derive(Default)]
    struct RecordingHook {
        calls: Mutex<Vec<RecordedCall>>,
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct RecordedCall {
        run_id: String,
        coordinator_agent_id: String,
        member_id: String,
        member_agent_id: String,
        member_name: String,
        reason: MemberIdleReason,
        current_mode: Option<AgentExecMode>,
        summary: Option<String>,
        failure_reason: Option<String>,
        unfinished_task_ids: Vec<String>,
    }

    impl MemberIdleHook for RecordingHook {
        #[allow(clippy::too_many_arguments)]
        fn post_member_idle(
            &self,
            run_id: &str,
            coordinator_agent_id: &str,
            member_id: &str,
            member_agent_id: &str,
            member_name: &str,
            reason: MemberIdleReason,
            current_mode: Option<AgentExecMode>,
            summary: Option<String>,
            failure_reason: Option<String>,
            unfinished_task_ids: Vec<String>,
        ) {
            self.calls.lock().unwrap().push(RecordedCall {
                run_id: run_id.into(),
                coordinator_agent_id: coordinator_agent_id.into(),
                member_id: member_id.into(),
                member_agent_id: member_agent_id.into(),
                member_name: member_name.into(),
                reason,
                current_mode,
                summary,
                failure_reason,
                unfinished_task_ids,
            });
        }
    }

    fn ctx_with_members(members: Vec<(&str, &str)>) -> AgentOrgRunContext {
        AgentOrgRunContext {
            run_id: "run-1".into(),
            org_id: "org-1".into(),
            org_name: "Org One".into(),
            org_role: "lead".into(),
            coordinator_agent_id: "coord".into(),
            coordinator_name: "Coordinator".into(),
            coordinator_role: "lead".into(),
            members: members
                .into_iter()
                .enumerate()
                .map(|(idx, (name, agent_id))| AgentOrgContextMember {
                    member_id: format!("m-{}", idx),
                    name: name.into(),
                    role: "engineer".into(),
                    agent_id: agent_id.into(),
                    parent_member_id: None,
                })
                .collect(),
            hierarchy_mode: Default::default(),
            plan_approval_policy: crate::definitions::orgs::PlanApprovalPolicy::Coordinator,
            root_session_id: Some("root-1".into()),
        }
    }

    fn seed_lifecycle_run() -> String {
        crate::coordination::agent_org_runs::AgentOrgRunStore::create(
            crate::coordination::agent_org_runs::CreateAgentOrgRunParams {
                org_id: "org-lifecycle-gate".to_string(),
                coordinator_agent_id: "coordinator".to_string(),
                root_session_id: None,
                org_snapshot: crate::definitions::orgs::OrgDefinition {
                    id: "org-lifecycle-gate".to_string(),
                    name: "Lifecycle Gate Test Org".to_string(),
                    role: "coordinator".to_string(),
                    agent_id: "coordinator".to_string(),
                    description: None,
                    hierarchy_mode: Default::default(),
                    plan_approval_policy: crate::definitions::orgs::PlanApprovalPolicy::Coordinator,
                    children: vec![crate::definitions::orgs::OrgMember {
                        id: "member-worker".to_string(),
                        name: "Worker".to_string(),
                        role: "builder".to_string(),
                        agent_id: "worker-agent".to_string(),
                        runtime_config: None,
                        children: Vec::new(),
                    }],
                },
                entry_mode:
                    crate::coordination::agent_org_runs::AgentOrgRunEntryMode::StandaloneSession,
                status: crate::coordination::agent_org_runs::AgentOrgRunStatus::Running,
                work_item_id: None,
                project_slug: None,
                routine_fire_id: None,
            },
        )
        .expect("seed lifecycle run")
        .id
    }

    fn seed_lifecycle_task(run_id: &str, id: &str, mode: TaskExecutionMode, status: TaskStatus) {
        AgentOrgTaskStore::create(CreateTaskParams {
            id: id.to_string(),
            org_run_id: run_id.to_string(),
            subject: id.to_string(),
            description: String::new(),
            active_form: None,
            owner: Some("member-worker".to_string()),
            status,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: Some(serde_json::json!({
                TASK_METADATA_EXECUTION_MODE: mode.as_wire(),
            })),
        })
        .expect("seed lifecycle task");
    }

    #[test]
    fn lifecycle_stop_feedback_only_reports_unfinished_build_tasks() {
        let _sandbox = test_env::sandbox();
        let conn = database::db::get_connection().expect("db");
        crate::coordination::agent_org_runs::init_schema(&conn).expect("run schema");
        crate::coordination::agent_org_tasks::init_schema(&conn).expect("task schema");
        let run_id = seed_lifecycle_run();
        seed_lifecycle_task(
            &run_id,
            "build-open",
            TaskExecutionMode::Build,
            TaskStatus::InProgress,
        );
        seed_lifecycle_task(
            &run_id,
            "build-done",
            TaskExecutionMode::Build,
            TaskStatus::Completed,
        );
        seed_lifecycle_task(
            &run_id,
            "plan-awaiting-approval",
            TaskExecutionMode::Plan,
            TaskStatus::InProgress,
        );

        let feedback = task_lifecycle_stop_feedback(&run_id, "member-worker")
            .expect("lifecycle check")
            .expect("unfinished build task should stop the turn once");
        assert!(feedback.contains("build-open"));
        assert!(!feedback.contains("build-done"));
        assert!(!feedback.contains("plan-awaiting-approval"));
    }

    #[test]
    fn lifecycle_stop_feedback_is_quiet_without_unfinished_build_work() {
        let _sandbox = test_env::sandbox();
        let conn = database::db::get_connection().expect("db");
        crate::coordination::agent_org_runs::init_schema(&conn).expect("run schema");
        crate::coordination::agent_org_tasks::init_schema(&conn).expect("task schema");
        let run_id = seed_lifecycle_run();
        seed_lifecycle_task(
            &run_id,
            "plan-awaiting-approval",
            TaskExecutionMode::Plan,
            TaskStatus::InProgress,
        );

        assert_eq!(
            task_lifecycle_stop_feedback(&run_id, "member-worker").expect("lifecycle check"),
            None
        );
    }

    #[test]
    fn idle_emit_target_skips_coordinator() {
        let ctx = ctx_with_members(vec![("Alice", "alice-1")]);
        assert!(idle_emit_target(None, &ctx).is_none());
    }

    #[test]
    fn idle_emit_target_skips_unknown_member_id() {
        let ctx = ctx_with_members(vec![("Alice", "alice-1")]);
        assert!(idle_emit_target(Some("ghost"), &ctx).is_none());
    }

    #[test]
    fn idle_emit_target_resolves_member_name() {
        let ctx = ctx_with_members(vec![("Alice", "alice-1"), ("Bob", "bob-1")]);
        let (coord, member_id, member_agent_id, name) =
            idle_emit_target(Some("m-1"), &ctx).expect("member found");
        assert_eq!(coord, "coord");
        assert_eq!(member_id, "m-1");
        assert_eq!(member_agent_id, "bob-1");
        assert_eq!(name, "Bob");
    }

    #[test]
    fn maybe_emit_skips_when_no_org_context() {
        let _serial = serial_lock();
        let hook = Arc::new(RecordingHook::default());
        let _guard = MemberIdleHookGuard::install(hook.clone());
        maybe_emit_member_idle(None, "alice-1", None, MemberIdleReason::Available, None);
        assert!(hook.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn maybe_emit_skips_for_coordinator() {
        let _serial = serial_lock();
        let hook = Arc::new(RecordingHook::default());
        let _guard = MemberIdleHookGuard::install(hook.clone());
        let ctx = ctx_with_members(vec![("Alice", "alice-1")]);
        maybe_emit_member_idle(Some(&ctx), "coord", None, MemberIdleReason::Available, None);
        assert!(hook.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn idle_emit_target_uses_runtime_member_id_when_agent_id_matches_coordinator() {
        let mut ctx = ctx_with_members(vec![("Alice", "builtin:sde")]);
        ctx.coordinator_agent_id = "builtin:sde".to_string();
        let (coord, member_id, member_agent_id, name) = idle_emit_target(Some("m-0"), &ctx)
            .expect("runtime member id should identify member even with shared agent id");
        assert_eq!(coord, "builtin:sde");
        assert_eq!(member_id, "m-0");
        assert_eq!(member_agent_id, "builtin:sde");
        assert_eq!(name, "Alice");
    }

    #[test]
    fn maybe_emit_skips_member_without_runtime_member_id() {
        let _serial = serial_lock();
        let hook = Arc::new(RecordingHook::default());
        let _guard = MemberIdleHookGuard::install(hook.clone());
        let ctx = ctx_with_members(vec![("Alice", "alice-1")]);
        maybe_emit_member_idle(
            Some(&ctx),
            "alice-1",
            None,
            MemberIdleReason::Available,
            Some(AgentExecMode::Plan),
        );
        assert!(hook.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn maybe_emit_routes_member_to_coordinator() {
        let _serial = serial_lock();
        let hook = Arc::new(RecordingHook::default());
        let _guard = MemberIdleHookGuard::install(hook.clone());
        let ctx = ctx_with_members(vec![("Alice", "alice-1")]);
        maybe_emit_member_idle(
            Some(&ctx),
            "alice-1",
            Some("m-0"),
            MemberIdleReason::Available,
            Some(AgentExecMode::Plan),
        );
        let calls = hook.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        let call = &calls[0];
        assert_eq!(call.run_id, "run-1");
        assert_eq!(call.coordinator_agent_id, "coord");
        assert_eq!(call.member_id, "m-0");
        assert_eq!(call.member_agent_id, "alice-1");
        assert_eq!(call.member_name, "Alice");
        assert_eq!(call.reason, MemberIdleReason::Available);
        assert_eq!(call.current_mode, Some(AgentExecMode::Plan));
        assert!(call.summary.is_none());
        assert!(call.failure_reason.is_none());
    }

    #[test]
    fn maybe_emit_propagates_interrupted_reason() {
        let _serial = serial_lock();
        let hook = Arc::new(RecordingHook::default());
        let _guard = MemberIdleHookGuard::install(hook.clone());
        let ctx = ctx_with_members(vec![("Alice", "alice-1")]);
        maybe_emit_member_idle(
            Some(&ctx),
            "alice-1",
            Some("m-0"),
            MemberIdleReason::Interrupted,
            Some(AgentExecMode::Build),
        );
        assert_eq!(
            hook.calls.lock().unwrap()[0].reason,
            MemberIdleReason::Interrupted
        );
    }
}
