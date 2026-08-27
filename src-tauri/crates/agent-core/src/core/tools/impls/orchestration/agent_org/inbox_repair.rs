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
use crate::coordination::agent_org_tasks::TaskGraphWriterAdmin;
use crate::coordination::agent_org_tool_receipts::{
    AgentOrgToolReceiptAbort, AgentOrgToolReceiptKey, AgentOrgToolReceiptStore,
};
use crate::tools::names as tool_names;
use crate::tools::traits::{params_schema, parse_params, CallContext, Tool, ToolError};

use super::{classify_task_receipt_error, TaskToolsContext};

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
        call_ctx: &CallContext,
    ) -> Result<String, ToolError> {
        call_ctx.require_tool_authority(self.name())?;
        if !self.ctx.is_coordinator() {
            return Err(ToolError::InvalidParams(
                "org_inbox_repair is coordinator-only".to_string(),
            ));
        }
        let canonical_params = params_value.clone();
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
                    call_ctx,
                    canonical_params,
                    ResolveInboxDeliveryParams {
                        inbox_id,
                        org_run_id: run_id.clone(),
                        resolved_by_member_id: COORDINATOR_MEMBER_ID.to_string(),
                        resolution_kind: AgentInboxDeliveryResolutionKind::Cancelled,
                        reason,
                        replacement_inbox_id: None,
                        replacement_task_id: None,
                    },
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
                    call_ctx,
                    canonical_params,
                    ResolveInboxDeliveryParams {
                        inbox_id,
                        org_run_id: run_id.clone(),
                        resolved_by_member_id: COORDINATOR_MEMBER_ID.to_string(),
                        resolution_kind: AgentInboxDeliveryResolutionKind::Superseded,
                        reason,
                        replacement_inbox_id,
                        replacement_task_id,
                    },
                )
                .await
            }
        }
    }
}

async fn resolve(
    run_id: &str,
    call_ctx: &CallContext,
    canonical_params: Value,
    params: ResolveInboxDeliveryParams,
) -> Result<String, ToolError> {
    let actor =
        TaskGraphWriterAdmin::new(call_ctx.session_id.clone(), call_ctx.turn_intent_id.clone())
            .map_err(ToolError::InvalidParams)?;
    let receipt_key = AgentOrgToolReceiptKey::from_call_context(run_id.to_string(), call_ctx)?;
    let run_id = run_id.to_string();
    let receipt = tokio::task::spawn_blocking({
        let run_id = run_id.clone();
        move || {
            AgentOrgToolReceiptStore::execute(
                receipt_key,
                tool_names::ORG_INBOX_REPAIR,
                params.resolution_kind.as_str(),
                &canonical_params,
                |tx| {
                    if let Err(error) = actor.validate_canonical_coordinator(tx, &run_id) {
                        return match classify_task_receipt_error(error) {
                            Ok(error) => Ok(Err(error)),
                            Err(abort) => Err(abort),
                        };
                    }
                    match AgentInboxStore::resolve_delivery_in_tx(tx, params) {
                        Ok(resolution) => serde_json::to_string(&json!({
                            "outcome": resolution.resolution_kind.as_str(),
                            "org_run_id": run_id,
                            "delivery_resolution": resolution,
                            "guidance": "The original Inbox row remains durable and unread as audit evidence, but no longer blocks delivery/Quiescence. Re-inspect task_list and the replacement work before requesting completion."
                        }))
                        .map(Ok)
                        .map_err(AgentOrgToolReceiptAbort::storage),
                        Err(ResolveInboxDeliveryError::Constraint(message)) => Ok(Err(
                            ToolError::InvalidParams(format!(
                                "Agent Org Inbox repair was not applied: {message}"
                            )),
                        )),
                        Err(ResolveInboxDeliveryError::Storage(message)) => {
                            Err(AgentOrgToolReceiptAbort::storage(message))
                        }
                    }
                },
            )
        }
    })
        .await
        .map_err(|err| {
            ToolError::ExecutionFailed(format!("org_inbox_repair worker failed: {err}"))
        })??;
    if receipt.is_fresh() {
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run_id);
    }
    receipt.result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coordination::agent_inbox::AgentMessage;
    use crate::coordination::agent_org_runs::{
        AgentOrgContextMember, AgentOrgRunContext, AgentOrgRunEntryMode, AgentOrgRunStatus,
        AgentOrgRunStore, CreateAgentOrgRunParams,
    };
    use crate::definitions::orgs::{FlatOrgMember, OrgDefinition, PlanApprovalPolicy};
    use crate::session::persistence::{upsert_session, UnifiedSessionRecord};
    use crate::tools::impls::orchestration::org_send_message::NoopInboxWakeHook;
    use crate::tools::traits::Tool;
    use database::db::get_connection;
    use rusqlite::params;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_CALL_ID: AtomicU64 = AtomicU64::new(1);

    fn repair_call_context() -> CallContext {
        CallContext {
            session_id: "root-inbox-repair".to_string(),
            turn_intent_id: "repair-turn".to_string(),
            call_id: format!(
                "repair-call-{}",
                NEXT_CALL_ID.fetch_add(1, Ordering::Relaxed)
            ),
            ..Default::default()
        }
        .with_authority(
            crate::tools::call_context::ToolCallAuthority::PersistedAgentOrg(
                crate::tools::call_context::AgentOrgTurnToolProfile::CoordinatorOrchestration,
            ),
        )
    }

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
        conn.execute_batch(
            "CREATE TABLE session_turn_intents (
                session_id TEXT NOT NULL,
                turn_intent_id TEXT NOT NULL,
                client_message_id TEXT,
                org_run_id TEXT,
                source TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(session_id,turn_intent_id)
            );",
        )
        .expect("Turn intent schema");
        crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schemas");

        let org = OrgDefinition {
            id: format!("org-inbox-repair-{}", uuid::Uuid::new_v4()),
            name: "Inbox Repair Org".into(),
            role: "Coordinator".into(),
            agent_id: "coordinator-agent".into(),
            description: None,
            plan_approval_policy: PlanApprovalPolicy::Coordinator,
            members: vec![FlatOrgMember {
                member_id: "worker".into(),
                name: "Worker".into(),
                role: "Implementer".into(),
                agent_id: "worker-agent".into(),
                runtime_config: None,
            }],
            additional_task_graph_writer_member_ids: Vec::new(),
            member_communication_links: Vec::new(),
        };
        let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
            org_id: org.id.clone(),
            coordinator_agent_id: org.agent_id.clone(),
            root_session_id: Some("root-inbox-repair".into()),
            org_snapshot: (&org).into(),
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
        conn.execute(
            "INSERT INTO agent_org_runtime_member_materializations (
                 org_run_id,member_id,agent_id,generation,session_id,
                 authority_class,status,created_at,updated_at
             ) VALUES (?1,'coordinator','coordinator-agent',?2,
                       'root-inbox-repair','formal','succeeded',?3,?3)",
            params![
                &run.id,
                run.activation_generation,
                chrono::Utc::now().to_rfc3339()
            ],
        )
        .expect("seed canonical coordinator materialization");
        conn.execute(
            "INSERT INTO session_turn_intents (
                 session_id,turn_intent_id,org_run_id,source,status,created_at,updated_at
             ) VALUES ('root-inbox-repair','repair-turn',?1,'agent_org','running',?2,?2)",
            params![&run.id, chrono::Utc::now().to_rfc3339()],
        )
        .expect("seed base Turn");
        conn.execute(
            "INSERT INTO agent_org_runtime_turn_contexts (
                 session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
                 source_kind,source_id,activation_generation,created_at
             ) VALUES ('root-inbox-repair','repair-turn',?1,'coordinator','coordinator',
                       'root_turn','repair-turn',?2,?3)",
            params![
                &run.id,
                run.activation_generation,
                chrono::Utc::now().to_rfc3339()
            ],
        )
        .expect("seed coordinator Turn context");

        let message = AgentMessage::Plain {
            summary: "Undeliverable work".into(),
            text: "Preserve this original message".into(),
        };
        conn.execute(
            "INSERT INTO agent_org_runtime_inbox (
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
            }],
            plan_approval_policy: PlanApprovalPolicy::Coordinator,
            capability_index: Default::default(),
            root_session_id: Some("root-inbox-repair".into()),
        });
        let make_context = |member_id: &str, agent_id: &str| {
            Arc::new(TaskToolsContext {
                org_context: Arc::clone(&org_context),
                caller_agent_id: agent_id.into(),
                caller_member_id: member_id.into(),
                wake_hook: Arc::new(NoopInboxWakeHook),
                app_state: None,
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
        let call = repair_call_context();
        let request = json!({
            "action": "cancel",
            "inbox_id": fixture.inbox_id,
            "reason": "The removed member's work is intentionally abandoned"
        });
        let result = OrgInboxRepairTool::new(fixture.coordinator.clone())
            .execute_text(request.clone(), &call)
            .await
            .expect("coordinator repair succeeds");
        let replay = OrgInboxRepairTool::new(fixture.coordinator.clone())
            .execute_text(request, &call)
            .await
            .expect("same repair call replays");
        assert_eq!(replay, result);
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
                &repair_call_context(),
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
            "UPDATE agent_org_runtime_runs
             SET status='archived',activation_generation=activation_generation+1,
                 archived_at=?2,archive_receipt_id=?3
             WHERE id=?1",
            params![
                &fixture.run_id,
                chrono::Utc::now().to_rfc3339(),
                format!("{}-archive-receipt", fixture.run_id)
            ],
        )
        .expect("archive run");
        let error = OrgInboxRepairTool::new(fixture.coordinator)
            .execute_text(
                json!({
                    "action": "cancel",
                    "inbox_id": fixture.inbox_id,
                    "reason": "Too late"
                }),
                &repair_call_context(),
            )
            .await
            .expect_err("terminal run mutation is denied");
        assert!(error.to_string().contains("team_archived"), "{error}");
        assert!(
            AgentInboxStore::delivery_resolution_for_inbox(&fixture.run_id, fixture.inbox_id)
                .unwrap()
                .is_none()
        );
    }
}
