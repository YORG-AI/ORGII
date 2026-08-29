use serde_json::{json, Value};

const BACKGROUND_WORK_ACTIVE_REASON: &str = "turn_owned_background_work_active";

fn current_task_snapshot(
    session_id: &str,
    turn_intent_id: &str,
    arguments: &Value,
) -> Option<Value> {
    let requested_task_id = arguments.get("id")?.as_str()?;
    let context = crate::coordination::agent_org_turn_contexts::optional_context_for_session(
        session_id,
        turn_intent_id,
    )
    .ok()??;
    if context.task_id.as_deref() != Some(requested_task_id) {
        return None;
    }
    let task = crate::coordination::agent_org_tasks::AgentOrgTaskStore::get(
        &context.org_run_id,
        requested_task_id,
    )
    .ok()??;
    Some(json!({
        "id": task.id,
        "subject": task.subject,
        "description": task.description,
        "active_form": task.active_form,
        "owner_member_id": task.owner,
        "status": task.status.as_wire(),
        "execution_mode": task.execution_mode.as_wire(),
        "blocks": task.blocks,
        "blocked_by": task.blocked_by,
    }))
}

pub(super) fn deferred_terminal_task_update_result(
    session_id: &str,
    turn_intent_id: &str,
    arguments: &Value,
) -> String {
    let mut result = json!({
        "rejected": true,
        "completion_deferred": true,
        "reason_code": BACKGROUND_WORK_ACTIVE_REASON,
        "task_status_unchanged": true,
        "guidance": "Task completion is deferred while this exact Turn still owns active or unconsumed background work. Await or stop that work, consume its terminal result in this Turn, then retry task_update. The durable Task status has not changed."
    });
    if let Some(task) = current_task_snapshot(session_id, turn_intent_id, arguments) {
        result["task"] = task;
    }
    result.to_string()
}
