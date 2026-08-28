use serde_json::{json, Value};

use super::{
    E2eFakeProvider, AGENT_ORG_PLAN_REVISION_MARKER, CREATE_PLAN_TOOL, TASK_GRAPH_CREATE_TOOL,
    TASK_UPDATE_TOOL,
};

fn tools(names: &[&str]) -> Vec<Value> {
    names.iter().map(|name| json!({ "name": name })).collect()
}

#[test]
fn coordinator_creates_plan_and_dependent_build_through_the_real_tool_surface() {
    let messages = vec![json!({
        "role": "user",
        "content": format!(
            "Run {AGENT_ORG_PLAN_REVISION_MARKER}scenario_1 planner=planner-member implementer=implementer-member"
        )
    })];
    let calls = E2eFakeProvider::agent_org_plan_revision_tool_calls(
        &messages,
        Some(&tools(&[TASK_GRAPH_CREATE_TOOL])),
    );

    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].name, TASK_GRAPH_CREATE_TOOL);
    let tasks = calls[0].arguments["tasks"].as_array().unwrap();
    assert_eq!(tasks[0]["owner_member_id"], "planner-member");
    assert_eq!(tasks[0]["execution_mode"], "plan");
    assert_eq!(tasks[1]["owner_member_id"], "implementer-member");
    assert_eq!(tasks[1]["depends_on"], json!(["plan"]));
}

#[test]
fn planner_submits_a_new_immutable_revision_only_after_rejection() {
    let assignment = format!(
        "Task assigned by coordinator: E2E plan\nTask ID: plan-task\nExecution mode: plan\n{AGENT_ORG_PLAN_REVISION_MARKER}scenario_2"
    );
    let tool_surface = tools(&[TASK_UPDATE_TOOL, CREATE_PLAN_TOOL]);
    let mut messages = vec![json!({ "role": "user", "content": assignment })];

    let start = E2eFakeProvider::agent_org_plan_revision_tool_calls(&messages, Some(&tool_surface));
    assert_eq!(start[0].name, TASK_UPDATE_TOOL);
    assert_eq!(start[0].arguments["operation"], "start");

    messages.push(json!({ "role": "tool", "content": "started" }));
    let initial =
        E2eFakeProvider::agent_org_plan_revision_tool_calls(&messages, Some(&tool_surface));
    assert_eq!(initial[0].name, CREATE_PLAN_TOOL);
    assert_eq!(initial[0].arguments["new_plan"], false);
    assert!(initial[0].arguments["content"]
        .as_str()
        .unwrap()
        .contains("Initial user-reviewed plan scenario_2"));

    messages.push(json!({ "role": "tool", "content": "PLAN_SUBMITTED_END_TURN" }));
    assert!(
        E2eFakeProvider::agent_org_plan_revision_tool_calls(&messages, Some(&tool_surface),)
            .is_empty()
    );

    messages.push(json!({
        "role": "user",
        "content": "Plan rejected\nPlease add explicit checkpoints."
    }));
    let revised =
        E2eFakeProvider::agent_org_plan_revision_tool_calls(&messages, Some(&tool_surface));
    assert_eq!(revised[0].name, CREATE_PLAN_TOOL);
    assert_eq!(revised[0].arguments["new_plan"], false);
    assert!(revised[0].arguments["content"]
        .as_str()
        .unwrap()
        .contains("Revised user-reviewed plan scenario_2"));
}

#[test]
fn planner_revision_uses_explicit_feedback_identity_without_old_assignment_history() {
    let messages = vec![json!({
        "role": "user",
        "content": format!(
            "<plan_approval_response accepted=\"false\" next_mode=\"plan\">Please add checkpoints. {AGENT_ORG_PLAN_REVISION_MARKER}scenario_3 task=plan-task</plan_approval_response>"
        )
    })];

    let revised = E2eFakeProvider::agent_org_plan_revision_tool_calls(
        &messages,
        Some(&tools(&[CREATE_PLAN_TOOL])),
    );

    assert_eq!(revised.len(), 1);
    assert_eq!(revised[0].name, CREATE_PLAN_TOOL);
    assert_eq!(revised[0].arguments["source_task_id"], "plan-task");
    assert!(revised[0].arguments["content"]
        .as_str()
        .unwrap()
        .contains("scenario_3"));
}
