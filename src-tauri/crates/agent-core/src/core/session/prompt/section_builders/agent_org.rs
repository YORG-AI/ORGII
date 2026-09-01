//! Agent Org run context: identity, task authority, roster, routing rules,
//! planning workflow, and the current task-board snapshot.

use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;
use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, Task, TaskStatus};

const AGENT_ORG_TASK_CONTEXT_LIMIT: usize = 12;

fn format_agent_org_task_for_prompt(task: &Task) -> String {
    const OWNER_PREVIEW_CHARS: usize = 120;
    const BLOCKER_PREVIEW_CHARS: usize = 120;
    const BLOCKER_PREVIEW_COUNT: usize = 3;
    let owner = task
        .owner
        .as_deref()
        .map(|owner| crate::utils::safe_truncate_chars_to_string(owner, OWNER_PREVIEW_CHARS))
        .unwrap_or_else(|| "unclaimed".to_string());
    let blocked = if task.blocked_by.is_empty() {
        "unblocked".to_string()
    } else {
        let preview = task
            .blocked_by
            .iter()
            .take(BLOCKER_PREVIEW_COUNT)
            .map(|id| crate::utils::safe_truncate_chars_to_string(id, BLOCKER_PREVIEW_CHARS))
            .collect::<Vec<_>>()
            .join(",");
        let omitted = task.blocked_by.len().saturating_sub(BLOCKER_PREVIEW_COUNT);
        format!(
            "blocked_by=[{}{}]",
            preview,
            if omitted > 0 {
                format!(",+{omitted} more")
            } else {
                String::new()
            }
        )
    };
    format!(
        "- `{}` [{}] owner={} {} — {}",
        task.id,
        task.status.as_wire(),
        owner,
        blocked,
        task.subject
    )
}

fn build_agent_org_task_snapshot(tasks: Result<Vec<Task>, String>) -> Vec<String> {
    let tasks = match tasks {
        Ok(tasks) => tasks,
        Err(err) => {
            return vec![format!(
                "- Task board snapshot unavailable: {err}. Call `task_list` before changing task state."
            )]
        }
    };
    if tasks.is_empty() {
        return vec!["- No tasks currently exist on this run.".to_string()];
    }

    let mut open_tasks: Vec<&Task> = tasks
        .iter()
        .filter(|task| task.status != TaskStatus::Completed)
        .collect();
    open_tasks.sort_by_key(|task| match task.status {
        TaskStatus::InProgress => 0,
        TaskStatus::Pending => 1,
        TaskStatus::Completed => 2,
    });

    let mut lines = Vec::new();
    for task in open_tasks.iter().take(AGENT_ORG_TASK_CONTEXT_LIMIT) {
        lines.push(format_agent_org_task_for_prompt(task));
    }

    let omitted_open = open_tasks.len().saturating_sub(lines.len());
    let completed_count = tasks
        .iter()
        .filter(|task| task.status == TaskStatus::Completed)
        .count();
    if omitted_open > 0 || completed_count > 0 {
        lines.push(format!(
            "- Snapshot truncated: {omitted_open} additional open task(s), {completed_count} completed task(s). Use `task_list` for the full board before creating duplicate work."
        ));
    }
    lines
}

pub fn build_agent_org_context_section(
    context: &crate::coordination::agent_org_runs::AgentOrgRunContext,
    current_agent_id: &str,
    current_member_id: Option<&str>,
) -> String {
    let tasks = AgentOrgTaskStore::list_operational(&context.run_id);
    build_agent_org_context_section_with_task_snapshot(
        context,
        current_agent_id,
        current_member_id,
        tasks,
    )
}

pub(crate) fn build_agent_org_context_section_with_task_snapshot(
    context: &crate::coordination::agent_org_runs::AgentOrgRunContext,
    _current_agent_id: &str,
    current_member_id: Option<&str>,
    task_snapshot: Result<Vec<Task>, String>,
) -> String {
    use crate::definitions::orgs::{HierarchyMode, PlanApprovalPolicy};
    let identity_line = match current_member_id {
        Some(member_id) if context.participant_by_member_id(member_id).is_some() => format!(
            "- **Your identity in this org:** member_id `{member_id}`."
        ),
        Some(member_id) => format!(
            "- **Your identity in this org:** unknown member_id `{member_id}`. You are not a canonical Agent Org participant."
        ),
        None => "- **Your identity in this org:** delegate/shadow worker. You are not a canonical Agent Org participant and you do not have an org member_id.".to_string(),
    };
    let task_authority_line = match current_member_id {
        Some(COORDINATOR_MEMBER_ID) => {
            "- **Your task authority:** coordinator — you may create, assign, reassign, edit, and repair tasks for every participant, and approve cross-workflow parallel overrides. You may NOT impersonate another member's work: only the current owner may set its task `in_progress`/`completed` or write its `output`. Assignment and dependency unblocking already wake the owner; do not start or complete the task on that member's behalf.".to_string()
        }
        Some(member_id) if context.participant_by_member_id(member_id).is_some() => {
            let direct_reports = context.direct_report_member_ids_for(member_id);
            if direct_reports.is_empty() {
                format!(
                    "- **Your task authority:** worker — you may create and modify only tasks for `{member_id}`. You may talk to peers when routing allows, but you may not assign or rewrite their work. Only you may record `in_progress`, `completed`, and `output` for tasks you own."
                )
            } else {
                format!(
                    "- **Your task authority:** manager — you may administer your own tasks and direct-report tasks only: `{}`. Peer and cross-branch work must go through the coordinator. For every task, only its current owner may record `in_progress`, `completed`, or `output`; do not impersonate a direct report's work.",
                    direct_reports.join("`, `")
                )
            }
        }
        _ => "- **Your task authority:** none — non-roster sessions cannot mutate the Agent Org task board.".to_string(),
    };
    let mut lines = vec![
        "## Agent Org Run".to_string(),
        String::new(),
        identity_line,
        format!("- **Run ID:** {}", context.run_id),
        format!("- **Org:** {} (`{}`)", context.org_name, context.org_id),
        format!("- **Org role:** {}", context.org_role),
        "- **Coordinator member_id:** `coordinator`".to_string(),
        format!(
            "- **Hierarchy mode:** {}",
            match context.hierarchy_mode {
                HierarchyMode::Flat => "flat",
                HierarchyMode::Soft => {
                    "soft (peer messaging is open; task authority follows the hierarchy)"
                }
                HierarchyMode::Strict => "strict (routing restricted — see rules below)",
            }
        ),
    ];

    if context.members.is_empty() {
        lines.push("- **Members:** none configured".to_string());
    } else {
        lines.push("- **Member IDs:**".to_string());
        for member in &context.members {
            match context.hierarchy_mode {
                HierarchyMode::Flat => {
                    lines.push(format!("  - `{}`", member.member_id));
                }
                HierarchyMode::Soft | HierarchyMode::Strict => {
                    let parent_member_id = member
                        .parent_member_id
                        .as_deref()
                        .unwrap_or(COORDINATOR_MEMBER_ID);
                    lines.push(format!(
                        "  - `{}` / reports_to `{}`",
                        member.member_id, parent_member_id
                    ));
                }
            }
        }
    }

    lines.push(String::new());
    lines.push("## Team task board".to_string());
    lines.push(String::new());
    lines.push(task_authority_line);
    lines.push(String::new());
    lines.push(
        "Do NOT use the generic `agent` tool to delegate work to roster members in this Agent Org. Roster members are already materialized as persistent sessions for this run. Use `task_create` and `task_update` only within the task authority stated above. Communication reachability and task authority are separate: being allowed to message a peer never grants permission to assign, reassign, edit, or delete that peer's work. Use `task_list` / `task_get` to inspect current state before an authorized change."
            .to_string(),
    );
    lines.push(String::new());
    lines.push(
        "For normal worker tasks, set `owner_member_id` for direct assignment to one specific member. An ownerless task is only a parked `awaiting coordinator assignment` state: set `eligible_member_ids` to the exact candidates, but no worker will self-claim or be woken. The coordinator must later choose the owner explicitly. `required_role` is only a human-readable hint and never authorizes a member by itself. Never create worker tasks with neither `owner_member_id` nor `eligible_member_ids`."
            .to_string(),
    );
    lines.push(String::new());
    lines.push(
        "For a new multi-stage request, the coordinator should prefer one `task_graph_create` call: give each node a local key and express the complete dependency graph with `depends_on`. The graph is validated and inserted atomically, so review/test/synthesis work cannot disappear between separate create calls. Use single `task_create` only for a genuinely incremental follow-up or repair. Every `task_create` must also make a separate scheduling decision with `dispatch_policy`. Use `dispatch_policy=immediate` only when the task can start now without another task's result. For review, testing, synthesis, or any consumer work, use `dispatch_policy=after_dependencies` plus `dependency_task_ids=[...]` with all upstream task ids. If a request omits currently-open work, `task_create` returns `requires_dependency_confirmation` or `requires_parallel_confirmation` guidance without creating anything. Add omitted ids when their outputs are needed. Only the coordinator may use `allow_parallel_with_unlisted_open_tasks=true`; members must send the proposed parallel work to the coordinator for approval. Dependent tasks remain pending and receive `TaskAssigned` only after their dependencies complete."
            .to_string(),
    );
    lines.push(String::new());
    lines.push(
        "Every `task_create` must also set `execution_mode`. Use `execution_mode=plan` only when the task's deliverable is a plan submitted with `create_plan`; use `execution_mode=build` for implementation, writing, review, testing, research, and all other work. The task assignment selects the member's next mode automatically. Inside an active Agent Org, never switch the Group chat or coordinator session into Plan mode in response to phrases such as 'plan then implement'; create a member Plan task instead. Do not send a separate mode-switch message. A Build task that bypasses an open Plan task is rejected for dependency confirmation unless the coordinator explicitly confirms that the work is independent."
            .to_string(),
    );
    lines.push(String::new());
    lines.push(
        "When choosing `eligible_member_ids`, use the roster member's role/name, not the member_id prefix alone. For example, planner members are for planning, decomposition, coordination, checklists, and synthesis. Implementer members are for implementation, writing deliverables, and production artifacts. Reviewer members are for review and quality gates. Tester members are for test execution, verification, and reproduction."
            .to_string(),
    );
    lines.push(String::new());
    lines.push(
        "Task assignment wakes idle members through their normal member-session runtime and queues work for running members without starting a second concurrent turn. Keep task state in the task board; use plain org messages for discussion, clarifications, and status notes that are not task-state transitions."
            .to_string(),
    );
    lines.push(String::new());
    lines.push(
        "When a member receives `TaskAssigned`, it must first call `task_update` for that exact task id with `status=in_progress` before doing the work. When done, the same owning member must call `task_update` with `status=completed` and `output={summary, content?, artifact_ids?}`; `summary` is required. Coordinators and managers must never perform these lifecycle/output calls for another owner. At turn end, the runtime gives a worker at most one bounded correction if a Build task is still `in_progress`; if it remains unresolved, `MemberIdle.unfinished_task_ids` tells the coordinator to retry or reassign instead of waiting silently. Plan tasks awaiting approval are excluded."
            .to_string(),
    );
    lines.push(String::new());
    lines.push(
        "The coordinator may announce that the whole Agent Org run is complete only after calling `task_list` and seeing `run_summary.completion_ready=true`. `open=0` alone is insufficient: a Reviewer may still be running, an inbox handoff may be unread, or a member plan may still await approval. When `completion_ready=false`, inspect `completion_blockers`, `active_member_ids`, `unread_inbox_count`, and `pending_plan_approval_count` and keep coordinating or wait quietly for the real event."
            .to_string(),
    );
    lines.push(String::new());
    lines.push(
        "When you receive `MemberIdle` with non-empty `unfinished_task_ids`, do not wait silently: ask that owner to finish its lifecycle or explicitly reassign the task. When `reason=failed`, the failed member's in-progress tasks become ownerless Pending rows; read failure_reason, inspect eligibility, and choose a new owner explicitly with `task_update owner_member_id`. Workers never self-claim ownerless work. Never assign outside `eligible_member_ids`, and do not ask one member to inspect another member's private failed context. If no recovery is possible, pause and report to the user."
            .to_string(),
    );
    lines.push(String::new());
    lines.push(
        "Before creating a task, compare against the snapshot below and call `task_list` when uncertain. If a task already exists, update it instead of creating a duplicate. Ownerless means waiting for explicit coordinator assignment, never an automatic claim pool. Workers must not set themselves as owner or set an ownerless task to `in_progress`; the coordinator first chooses `owner_member_id`, then normal TaskAssigned delivery wakes only that owner."
            .to_string(),
    );
    lines.push(String::new());
    lines.push(
        "Choose skills and tools from the user's actual request. For non-code work such as summaries, research, or writing, do not invoke GitHub issue-fix, repository, or code-audit workflows merely because those tools are available."
            .to_string(),
    );
    lines.push(String::new());
    lines.push("### Current task board snapshot".to_string());
    lines.extend(build_agent_org_task_snapshot(task_snapshot));
    lines.push(String::new());
    lines.push("## Org messaging".to_string());
    lines.push(String::new());
    lines.push(
        "Use the `org_send_message` tool to send a typed org message to exactly one coordinator/member participant in this org. The only routing field is `recipient_member_id`; never route by display name or agent id. Messages are persisted and surfaced to the recipient on its next turn — they do not interrupt the recipient's current turn. Every plain message to a non-coordinator worker must include `related_task_id` for unresolved, dependency-ready work already owned by that worker. Eligibility alone is not assignment; the coordinator must set `owner_member_id` before sending formal work instructions. Chat cannot create invisible work or bypass dependencies.".to_string(),
    );

    // Routing rules vary by hierarchy mode. The text below is what tells
    // the LLM how to actually behave; the structural roster above is
    // identical across modes (modulo the reports-to suffix).
    lines.push(String::new());
    match context.hierarchy_mode {
        HierarchyMode::Flat => {
            lines.push(
                "**Routing (flat):** there is no reporting hierarchy. Any member may message any other member, the coordinator, or itself directly. Treat all members as peers and pick the most relevant recipient for each message."
                    .to_string(),
            );
        }
        HierarchyMode::Soft => {
            lines.push(
                "**Routing (soft hierarchy):** the reports-to relationships listed above are *organizational hints*, not enforced rules. Prefer to coordinate through your manager for cross-team or multi-step work, but you may message any peer directly for quick factual questions, peer-level technical debate, or when escalating through the chain would obviously waste time. The runtime does not block any send."
                    .to_string(),
            );
        }
        HierarchyMode::Strict => {
            lines.push(
                "**Routing (strict hierarchy):** the runtime enforces who you can message. From any non-coordinator member you may only `org_send_message` to:\n\
                 1. your manager (the member listed under \"reports to\" for you), or\n\
                 2. your direct reports (members whose \"reports to\" is you), or\n\
                 3. the coordinator (always reachable as escape hatch — use this when stuck or when the right recipient is a sibling).\n\
                 Sibling-to-sibling sends are rejected with a structured error suggesting escalation. The coordinator may message any member directly. If you receive a sibling's request through the coordinator, treat it the same as a coordinator-issued request."
                    .to_string(),
            );
        }
    }
    lines.push(String::new());
    lines.push(
        "**Messaging is not delegation.** Do not use a `plain` message to bypass task authority by telling a peer or another branch to start formal work. Use messages for questions, discussion, handoff context, and proposals. Formal work must already exist as an authority-checked task; if an unauthorized peer asks you to start new work, route the proposal to the coordinator instead of silently creating or executing a second task chain."
            .to_string(),
    );
    lines.push(String::new());
    lines.push(
        "**Your normal text output is NOT visible to other agents in this org.** To communicate with another org participant you MUST call `org_send_message` with a listed `recipient_member_id`. Writing the message in your reply alone reaches the user, not the agent.".to_string(),
    );
    lines.push(String::new());
    lines.push(
        "Available message kinds: `plain` (free-form text — the common case), `shutdown_request` / `shutdown_response` (coordinator-driven graceful stop RPC — pair them with a sender-generated `request_id` the responder must echo), and, when this run uses coordinator plan approval, `plan_approval_response` (echo the plan request_id and set accepted/feedback). orgii's user permission and user mode-switch systems are separate; do NOT encode user-facing permission prompts as org messages.".to_string(),
    );
    lines.push(String::new());
    lines.push("### Planning workflow".to_string());
    lines.push(String::new());
    lines.push(
        "If a member must draft an implementation plan, risk review, migration plan, architecture proposal, or phased design, create its task with `execution_mode=plan`. The member enters Plan mode automatically, submits through `create_plan`, and stops. Approval completes that planning task and unlocks tasks that depend on it; the Planner is not woken into a fake Build turn.".to_string(),
    );
    lines.push(String::new());
    lines.push(match context.plan_approval_policy {
        PlanApprovalPolicy::Coordinator => "This run uses coordinator plan approval. When a member submits `create_plan`, review the durable inbox request, then send `kind=\"plan_approval_response\"` with the same `request_id`. `accepted=true` completes the source planning task and unlocks its dependants. `accepted=false` requires concrete `feedback` and wakes the Planner once in Plan mode for revision.".to_string(),
        PlanApprovalPolicy::User => "This run uses user plan approval. A submitted member plan appears in Group chat. Do not manufacture approval messages or bypass the gate; wait quietly until the user approves, edits and approves, or requests changes.".to_string(),
        PlanApprovalPolicy::Automatic => "This run uses automatic plan approval. A valid `create_plan` submission completes the source planning task immediately and unlocks its dependants; no coordinator approval message is needed.".to_string(),
    });
    lines.push(String::new());
    lines.push(
        "A root session explicitly launched by the user in Plan mode remains a separate, user-selected workflow and may use the coordinator's own `create_plan` Build approval surface. Once an Agent Org run has launched in Build mode, keep the coordinator in Build mode and use member Plan tasks. Only non-coordinator member plans use the internal coordinator approval path.".to_string(),
    );
    lines.join("\n")
}
