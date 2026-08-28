//! Read-time projection that reconnects historical Agent Org `create_plan`
//! tool calls to their immutable formal PlanRevision.
//!
//! The provider transcript intentionally stores the original tool result, not
//! the server-owned approval identifiers created inside the durable Agent Org
//! transaction. Team Overview reads the formal tables directly, while a cold
//! Planner transcript used to see only that unadorned provider result and hid
//! the plan card. This module joins the exact receipt identity back to the
//! immutable revision without rewriting the append-only transcript.

use database::db::get_connection;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};

use crate::agent_sessions::event_pipeline::types::SessionEvent;

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentOrgPlanHistoryBinding {
    call_id: String,
    approval_id: String,
    plan_revision_id: String,
    revision_number: u64,
    source_task_id: String,
    status: String,
    plan_title: String,
    plan_path: String,
    plan_content: String,
}

pub(super) fn rehydrate_agent_org_plan_history(session_id: &str, events: &mut [SessionEvent]) {
    if !events.iter().any(is_create_plan_tool_call) {
        return;
    }
    let mut call_ids = events
        .iter()
        .filter(|event| is_create_plan_tool_call(event))
        .filter_map(|event| event.call_id.clone())
        .collect::<Vec<_>>();
    call_ids.sort();
    call_ids.dedup();

    let bindings = match get_connection()
        .map_err(|error| error.to_string())
        .and_then(|conn| list_bindings_with_connection(&conn, session_id, &call_ids))
    {
        Ok(bindings) => bindings,
        Err(error) => {
            tracing::warn!(
                session_id,
                error = %error,
                "failed to restore Agent Org plan identities into session history"
            );
            return;
        }
    };

    apply_bindings(events, &bindings);
}

fn list_bindings_with_connection(
    conn: &Connection,
    session_id: &str,
    call_ids: &[String],
) -> Result<Vec<AgentOrgPlanHistoryBinding>, String> {
    let mut statement = conn
        .prepare(
            "SELECT receipt.call_id,decision.approval_id,revision.plan_revision_id,
                    revision.revision_number,revision.source_task_id,decision.status,
                    revision.plan_title,revision.plan_path,revision.plan_content
               FROM agent_org_runtime_plan_revisions revision
               JOIN agent_org_runtime_plan_decisions decision
                 ON decision.plan_revision_id=revision.plan_revision_id
               JOIN agent_org_runtime_tool_call_receipts receipt
                 ON receipt.org_run_id=revision.org_run_id
                AND receipt.session_id=revision.source_session_id
                AND receipt.turn_intent_id=revision.source_turn_intent_id
                AND receipt.tool_name='create_plan'
                AND receipt.operation='agent_org_submit'
              WHERE revision.source_session_id=?1
                AND receipt.call_id=?2
              ORDER BY revision.created_at ASC,revision.plan_revision_id ASC",
        )
        .map_err(|error| error.to_string())?;
    call_ids
        .iter()
        .map(|call_id| {
            statement
                .query_row(params![session_id, call_id], |row| {
                    let revision_number: i64 = row.get(3)?;
                    let revision_number = u64::try_from(revision_number).map_err(|_| {
                        rusqlite::Error::IntegralValueOutOfRange(3, revision_number)
                    })?;
                    Ok(AgentOrgPlanHistoryBinding {
                        call_id: row.get(0)?,
                        approval_id: row.get(1)?,
                        plan_revision_id: row.get(2)?,
                        revision_number,
                        source_task_id: row.get(4)?,
                        status: row.get(5)?,
                        plan_title: row.get(6)?,
                        plan_path: row.get(7)?,
                        plan_content: row.get(8)?,
                    })
                })
                .optional()
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|bindings| bindings.into_iter().flatten().collect())
}

fn apply_bindings(events: &mut [SessionEvent], bindings: &[AgentOrgPlanHistoryBinding]) {
    for event in events
        .iter_mut()
        .filter(|event| is_create_plan_tool_call(event))
    {
        let Some(call_id) = event.call_id.as_deref() else {
            continue;
        };
        let Some(binding) = bindings.iter().find(|binding| binding.call_id == call_id) else {
            continue;
        };

        let args = object_or_empty(&mut event.args);
        insert_string_if_missing(args, "planId", &binding.approval_id);
        insert_string_if_missing(args, "approvalId", &binding.approval_id);
        insert_string_if_missing(args, "planRevisionId", &binding.plan_revision_id);
        insert_number_if_missing(args, "planRevisionNumber", binding.revision_number);
        insert_string_if_missing(args, "sourceTaskId", &binding.source_task_id);
        insert_string_if_missing(args, "title", &binding.plan_title);
        insert_string_if_missing(args, "planPath", &binding.plan_path);
        insert_string_if_missing(args, "content", &binding.plan_content);

        let result = object_or_empty(&mut event.result);
        insert_string_if_missing(result, "planId", &binding.approval_id);
        insert_string_if_missing(result, "approvalId", &binding.approval_id);
        insert_string_if_missing(result, "planRevisionId", &binding.plan_revision_id);
        insert_number_if_missing(result, "planRevisionNumber", binding.revision_number);
        insert_string_if_missing(result, "sourceTaskId", &binding.source_task_id);
        insert_string_if_missing(result, "status", &binding.status);

        event.recompute_extracted();
    }
}

fn is_create_plan_tool_call(event: &SessionEvent) -> bool {
    event.action_type == "tool_call" && event.function_name.eq_ignore_ascii_case("create_plan")
}

fn object_or_empty(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value
        .as_object_mut()
        .expect("value was normalized to a JSON object")
}

fn insert_string_if_missing(target: &mut Map<String, Value>, key: &str, value: &str) {
    if target
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|existing| !existing.trim().is_empty())
    {
        return;
    }
    target.insert(key.to_string(), Value::String(value.to_string()));
}

fn insert_number_if_missing(target: &mut Map<String, Value>, key: &str, value: u64) {
    target
        .entry(key.to_string())
        .or_insert_with(|| Value::Number(value.into()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_sessions::event_pipeline::types::{
        ActivityStatus, EventDisplayStatus, EventDisplayVariant, EventSource,
    };

    fn create_plan_event(call_id: &str) -> SessionEvent {
        SessionEvent {
            id: format!("tool-call-{call_id}"),
            chunk_id: None,
            session_id: "planner-session".to_string(),
            created_at: "2026-08-29T00:00:00Z".to_string(),
            function_name: "create_plan".to_string(),
            ui_canonical: "create_plan".to_string(),
            action_type: "tool_call".to_string(),
            args: serde_json::json!({"title": "Provider title"}),
            result: serde_json::json!({"content": "PLAN_SUBMITTED_END_TURN:{}"}),
            source: EventSource::Assistant,
            display_text: "Create plan".to_string(),
            display_status: EventDisplayStatus::Completed,
            display_variant: EventDisplayVariant::ToolCall,
            activity_status: ActivityStatus::Processed,
            thread_id: None,
            process_id: None,
            call_id: Some(call_id.to_string()),
            file_path: None,
            command: None,
            is_delta: None,
            repo_id: None,
            repo_path: None,
            extracted: None,
            payload_refs: Vec::new(),
            shell_replay: None,
            shell_replay_bookmarks: None,
            last_extract_at: None,
        }
    }

    fn create_binding(call_id: &str) -> AgentOrgPlanHistoryBinding {
        AgentOrgPlanHistoryBinding {
            call_id: call_id.to_string(),
            approval_id: "approval-2".to_string(),
            plan_revision_id: "revision-2".to_string(),
            revision_number: 2,
            source_task_id: "plan-task-2".to_string(),
            status: "approved".to_string(),
            plan_title: "Formal title".to_string(),
            plan_path: "/tmp/formal-plan.md".to_string(),
            plan_content: "# Formal plan".to_string(),
        }
    }

    #[test]
    fn historical_create_plan_event_recovers_formal_revision_identity_and_content() {
        let mut events = vec![create_plan_event("call-2")];

        apply_bindings(&mut events, &[create_binding("call-2")]);

        let event = &events[0];
        assert_eq!(event.args["planId"], "approval-2");
        assert_eq!(event.args["approvalId"], "approval-2");
        assert_eq!(event.args["planRevisionId"], "revision-2");
        assert_eq!(event.args["planRevisionNumber"], 2);
        assert_eq!(event.args["content"], "# Formal plan");
        assert_eq!(event.result["status"], "approved");
        assert_eq!(event.result["sourceTaskId"], "plan-task-2");
        assert_eq!(event.args["title"], "Provider title");
    }

    #[test]
    fn history_projection_matches_only_the_exact_create_plan_receipt_call() {
        let mut events = vec![create_plan_event("call-1"), create_plan_event("call-2")];

        apply_bindings(&mut events, &[create_binding("call-2")]);

        assert!(events[0].args.get("planRevisionId").is_none());
        assert_eq!(events[1].args["planRevisionId"], "revision-2");
    }

    #[test]
    fn existing_provider_identity_is_never_overwritten_by_read_projection() {
        let mut event = create_plan_event("call-2");
        event.args["planId"] = Value::String("provider-plan".to_string());
        event.args["planRevisionId"] = Value::String("provider-revision".to_string());
        let mut events = vec![event];

        apply_bindings(&mut events, &[create_binding("call-2")]);

        assert_eq!(events[0].args["planId"], "provider-plan");
        assert_eq!(events[0].args["planRevisionId"], "provider-revision");
        assert_eq!(events[0].result["planRevisionId"], "revision-2");
    }

    #[test]
    fn binding_query_uses_formal_revision_and_exact_tool_receipt_identity() {
        let conn = Connection::open_in_memory().expect("open sqlite");
        conn.execute_batch(
            "CREATE TABLE agent_org_runtime_plan_revisions (
                 plan_revision_id TEXT PRIMARY KEY,org_run_id TEXT NOT NULL,
                 source_task_id TEXT NOT NULL,source_session_id TEXT NOT NULL,
                 source_turn_intent_id TEXT NOT NULL,revision_number INTEGER NOT NULL,
                 plan_title TEXT NOT NULL,plan_path TEXT NOT NULL,plan_content TEXT NOT NULL,
                 created_at TEXT NOT NULL
             );
             CREATE TABLE agent_org_runtime_plan_decisions (
                 approval_id TEXT PRIMARY KEY,plan_revision_id TEXT NOT NULL,status TEXT NOT NULL
             );
             CREATE TABLE agent_org_runtime_tool_call_receipts (
                 org_run_id TEXT NOT NULL,session_id TEXT NOT NULL,turn_intent_id TEXT NOT NULL,
                 call_id TEXT NOT NULL,tool_name TEXT NOT NULL,operation TEXT NOT NULL
             );
             INSERT INTO agent_org_runtime_plan_revisions VALUES
                 ('revision-2','run-1','plan-task-2','planner-session','turn-2',2,
                  'Formal title','/tmp/formal-plan.md','# Formal plan','2026-08-29T00:00:00Z');
             INSERT INTO agent_org_runtime_plan_decisions VALUES
                 ('approval-2','revision-2','approved');
             INSERT INTO agent_org_runtime_tool_call_receipts VALUES
                 ('run-1','planner-session','turn-2','call-2','create_plan','agent_org_submit'),
                 ('run-1','planner-session','turn-2','wrong-tool','task_create','create');",
        )
        .expect("seed formal plan tables");

        let bindings = list_bindings_with_connection(
            &conn,
            "planner-session",
            &["call-2".to_string(), "missing-call".to_string()],
        )
        .expect("query plan history bindings");

        assert_eq!(bindings, vec![create_binding("call-2")]);
        assert!(
            list_bindings_with_connection(&conn, "other-session", &["call-2".to_string()])
                .expect("query other session")
                .is_empty()
        );
    }
}
