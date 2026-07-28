use std::sync::Arc;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::coordination::agent_inbox::{
    AgentInboxDeliveryResolutionKind, AgentInboxStore, ResolveInboxDeliveryError,
    ResolveInboxDeliveryParams,
};
use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;
use crate::tools::names as tool_names;
use crate::tools::traits::{params_schema, parse_params, CallContext, Tool, ToolError};

use super::TaskToolsContext;

/// Explicit operator action for an Inbox row that cannot reach its original
/// recipient. This is intentionally not an automatic forwarding API: typed
/// messages can carry task/approval semantics that must be reconstructed by
/// the normal task/message tools rather than copied to a guessed identity.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum OrgInboxRepairParams {
    Inspect {
        inbox_id: i64,
    },
    Cancel {
        inbox_id: i64,
        reason: String,
    },
    Supersede {
        inbox_id: i64,
        reason: String,
        #[serde(default)]
        replacement_inbox_id: Option<i64>,
        #[serde(default)]
        replacement_task_id: Option<String>,
    },
}

pub struct OrgInboxRepairTool {
    ctx: Arc<TaskToolsContext>,
}

impl OrgInboxRepairTool {
    pub fn new(ctx: Arc<TaskToolsContext>) -> Self {
        Self { ctx }
    }
}

#[async_trait]
impl Tool for OrgInboxRepairTool {
    fn name(&self) -> &str {
        tool_names::ORG_INBOX_REPAIR
    }

    fn description(&self) -> &str {
        "Inspect or explicitly resolve an undeliverable Agent Org Inbox row. Coordinator-only. The original row remains durable and unread for audit. Use cancel only when the delivery is intentionally abandoned; use supersede only after creating a valid replacement message with org_send_message or replacement task with task_create/task_update."
    }

    fn category(&self) -> &str {
        crate::tools::categories::ORCHESTRATION
    }

    fn parameters(&self) -> Value {
        params_schema::<OrgInboxRepairParams>()
    }

    async fn execute_text(
        &self,
        params_value: Value,
        _ctx: &CallContext,
    ) -> Result<String, ToolError> {
        if !self.ctx.is_coordinator() {
            return Err(ToolError::InvalidParams(
                "org_inbox_repair is coordinator-only".to_string(),
            ));
        }
        let params: OrgInboxRepairParams = parse_params(params_value)?;
        let run_id = self.ctx.org_context.run_id.clone();

        match params {
            OrgInboxRepairParams::Inspect { inbox_id } => {
                let inspect_run_id = run_id.clone();
                let (row, resolution) = tokio::task::spawn_blocking(move || {
                    let row = AgentInboxStore::get_by_id_for_run(&inspect_run_id, inbox_id)?;
                    let resolution =
                        AgentInboxStore::delivery_resolution_for_inbox(&inspect_run_id, inbox_id)?;
                    Ok::<_, String>((row, resolution))
                })
                .await
                .map_err(|err| {
                    ToolError::ExecutionFailed(format!(
                        "org_inbox_repair inspect worker failed: {err}"
                    ))
                })?
                .map_err(ToolError::ExecutionFailed)?;
                let row = row.ok_or_else(|| {
                    ToolError::InvalidParams(format!(
                        "Inbox row {inbox_id} does not belong to the current Agent Org run"
                    ))
                })?;
                serde_json::to_string(&json!({
                    "outcome": "inspected",
                    "org_run_id": run_id,
                    "inbox_row": row,
                    "delivery_resolution": resolution,
                    "guidance": "If the original recipient can be restored, leave this row pending. Otherwise create a valid replacement through org_send_message or task tools, then call org_inbox_repair with action=supersede; use cancel only for an intentional discard."
                }))
                .map_err(|err| {
                    ToolError::ExecutionFailed(format!(
                        "org_inbox_repair inspect serialization failed: {err}"
                    ))
                })
            }
            OrgInboxRepairParams::Cancel { inbox_id, reason } => {
                resolve(
                    &run_id,
                    inbox_id,
                    AgentInboxDeliveryResolutionKind::Cancelled,
                    reason,
                    None,
                    None,
                )
                .await
            }
            OrgInboxRepairParams::Supersede {
                inbox_id,
                reason,
                replacement_inbox_id,
                replacement_task_id,
            } => {
                resolve(
                    &run_id,
                    inbox_id,
                    AgentInboxDeliveryResolutionKind::Superseded,
                    reason,
                    replacement_inbox_id,
                    replacement_task_id,
                )
                .await
            }
        }
    }
}

async fn resolve(
    run_id: &str,
    inbox_id: i64,
    resolution_kind: AgentInboxDeliveryResolutionKind,
    reason: String,
    replacement_inbox_id: Option<i64>,
    replacement_task_id: Option<String>,
) -> Result<String, ToolError> {
    let params = ResolveInboxDeliveryParams {
        inbox_id,
        org_run_id: run_id.to_string(),
        resolved_by_member_id: COORDINATOR_MEMBER_ID.to_string(),
        resolution_kind,
        reason,
        replacement_inbox_id,
        replacement_task_id,
    };
    let resolution = tokio::task::spawn_blocking(move || AgentInboxStore::resolve_delivery(params))
        .await
        .map_err(|err| {
            ToolError::ExecutionFailed(format!("org_inbox_repair worker failed: {err}"))
        })?
        .map_err(|error| match error {
            ResolveInboxDeliveryError::Constraint(message) => ToolError::InvalidParams(format!(
                "Agent Org Inbox repair was not applied: {message}"
            )),
            ResolveInboxDeliveryError::Storage(message) => ToolError::ExecutionFailed(format!(
                "Agent Org Inbox repair storage failed: {message}"
            )),
        })?;
    serde_json::to_string(&json!({
        "outcome": resolution.resolution_kind.as_str(),
        "org_run_id": run_id,
        "delivery_resolution": resolution,
        "guidance": "The original Inbox row remains durable and unread as audit evidence, but no longer blocks delivery/finality. Re-inspect task_list and the replacement work before requesting completion."
    }))
    .map_err(|err| {
        ToolError::ExecutionFailed(format!(
            "org_inbox_repair result serialization failed: {err}"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coordination::agent_inbox::AgentMessage;
    use crate::coordination::agent_org_runs::{
        AgentOrgContextMember, AgentOrgRunContext, AgentOrgRunEntryMode, AgentOrgRunStatus,
        AgentOrgRunStore, CreateAgentOrgRunParams,
    };
    use crate::definitions::orgs::{HierarchyMode, OrgDefinition, OrgMember, PlanApprovalPolicy};
    use crate::session::persistence::{upsert_session, UnifiedSessionRecord};
    use crate::tools::impls::orchestration::org_send_message::NoopInboxWakeHook;
    use crate::tools::traits::Tool;
    use database::db::get_connection;
    use rusqlite::params;

    struct Fixture {
        _sandbox: test_helpers::test_env::SandboxGuard,
        run_id: String,
        inbox_id: i64,
        coordinator: Arc<TaskToolsContext>,
        worker: Arc<TaskToolsContext>,
    }

    fn fixture() -> Fixture {
        let sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("test sqlite connection");
        crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
        crate::session::persistence::init(&conn).expect("session schema");
        crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schemas");

        let org = OrgDefinition {
            id: format!("org-inbox-repair-{}", uuid::Uuid::new_v4()),
            name: "Inbox Repair Org".into(),
            role: "Coordinator".into(),
            agent_id: "coordinator-agent".into(),
            description: None,
            hierarchy_mode: HierarchyMode::Soft,
            plan_approval_policy: PlanApprovalPolicy::Coordinator,
            children: vec![OrgMember {
                id: "worker".into(),
                name: "Worker".into(),
                role: "Implementer".into(),
                agent_id: "worker-agent".into(),
                runtime_config: None,
                children: Vec::new(),
            }],
        };
        let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
            org_id: org.id.clone(),
            coordinator_agent_id: org.agent_id.clone(),
            root_session_id: Some("root-inbox-repair".into()),
            org_snapshot: org,
            entry_mode: AgentOrgRunEntryMode::StandaloneSession,
            status: AgentOrgRunStatus::Running,
            work_item_id: None,
            project_slug: None,
            routine_fire_id: None,
        })
        .expect("create run");
        let now = chrono::Utc::now().to_rfc3339();
        upsert_session(&UnifiedSessionRecord {
            session_id: "root-inbox-repair".into(),
            name: "Coordinator".into(),
            status: "idle".into(),
            created_at: now.clone(),
            updated_at: now,
            session_type: "sde".into(),
            org_member_id: Some(COORDINATOR_MEMBER_ID.into()),
            agent_definition_id: Some("coordinator-agent".into()),
            ..Default::default()
        })
        .expect("seed coordinator session");

        let message = AgentMessage::Plain {
            summary: "Undeliverable work".into(),
            text: "Preserve this original message".into(),
        };
        conn.execute(
            "INSERT INTO agent_inbox (
                 recipient_agent_id, recipient_member_id,
                 sender_agent_id, sender_member_id, org_run_id,
                 payload_kind, payload_json, created_at
             ) VALUES (
                 'removed-agent', NULL,
                 'coordinator-agent', 'coordinator', ?1,
                 'plain', ?2, ?3
             )",
            params![
                &run.id,
                serde_json::to_string(&message).unwrap(),
                chrono::Utc::now().to_rfc3339(),
            ],
        )
        .expect("seed legacy undeliverable row");
        let inbox_id = conn.last_insert_rowid();

        let org_context = Arc::new(AgentOrgRunContext {
            run_id: run.id.clone(),
            org_id: "org-inbox-repair".into(),
            org_name: "Inbox Repair Org".into(),
            org_role: "Coordinator".into(),
            coordinator_agent_id: "coordinator-agent".into(),
            coordinator_name: "Coordinator".into(),
            coordinator_role: "Coordinator".into(),
            members: vec![AgentOrgContextMember {
                member_id: "worker".into(),
                name: "Worker".into(),
                role: "Implementer".into(),
                agent_id: "worker-agent".into(),
                parent_member_id: None,
            }],
            hierarchy_mode: HierarchyMode::Soft,
            plan_approval_policy: PlanApprovalPolicy::Coordinator,
            root_session_id: Some("root-inbox-repair".into()),
        });
        let make_context = |member_id: &str, agent_id: &str| {
            Arc::new(TaskToolsContext {
                org_context: Arc::clone(&org_context),
                caller_agent_id: agent_id.into(),
                caller_member_id: member_id.into(),
                wake_hook: Arc::new(NoopInboxWakeHook),
            })
        };

        Fixture {
            _sandbox: sandbox,
            run_id: run.id,
            inbox_id,
            coordinator: make_context(COORDINATOR_MEMBER_ID, "coordinator-agent"),
            worker: make_context("worker", "worker-agent"),
        }
    }

    #[tokio::test]
    async fn coordinator_can_cancel_an_undeliverable_row_without_faking_read() {
        let fixture = fixture();
        let result = OrgInboxRepairTool::new(fixture.coordinator)
            .execute_text(
                json!({
                    "action": "cancel",
                    "inbox_id": fixture.inbox_id,
                    "reason": "The removed member's work is intentionally abandoned"
                }),
                &CallContext::default(),
            )
            .await
            .expect("coordinator repair succeeds");
        assert_eq!(
            serde_json::from_str::<Value>(&result).unwrap()["outcome"],
            "cancelled"
        );
        let row = AgentInboxStore::get_by_id_for_run(&fixture.run_id, fixture.inbox_id)
            .unwrap()
            .unwrap();
        assert!(row.read_at.is_none());
        assert!(
            AgentInboxStore::delivery_resolution_for_inbox(&fixture.run_id, fixture.inbox_id)
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    async fn worker_cannot_resolve_inbox_delivery() {
        let fixture = fixture();
        let error = OrgInboxRepairTool::new(fixture.worker)
            .execute_text(
                json!({
                    "action": "cancel",
                    "inbox_id": fixture.inbox_id,
                    "reason": "Worker must not discard it"
                }),
                &CallContext::default(),
            )
            .await
            .expect_err("worker repair is denied");
        assert!(matches!(error, ToolError::InvalidParams(_)));
        assert!(
            AgentInboxStore::delivery_resolution_for_inbox(&fixture.run_id, fixture.inbox_id)
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn terminal_run_rejects_inbox_delivery_mutation() {
        let fixture = fixture();
        let conn = get_connection().expect("test sqlite connection");
        conn.execute(
            "UPDATE agent_org_runs SET status='completed' WHERE id=?1",
            params![&fixture.run_id],
        )
        .expect("complete run");
        let error = OrgInboxRepairTool::new(fixture.coordinator)
            .execute_text(
                json!({
                    "action": "cancel",
                    "inbox_id": fixture.inbox_id,
                    "reason": "Too late"
                }),
                &CallContext::default(),
            )
            .await
            .expect_err("terminal run mutation is denied");
        assert!(matches!(error, ToolError::InvalidParams(_)));
        assert!(
            AgentInboxStore::delivery_resolution_for_inbox(&fixture.run_id, fixture.inbox_id)
                .unwrap()
                .is_none()
        );
    }
}
