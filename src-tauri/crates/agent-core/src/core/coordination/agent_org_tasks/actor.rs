//! Typed authority for every durable Agent Org Task mutation.
//!
//! These values carry only the claimed identity.  Store transactions always
//! resolve the persisted companion context again before accepting a write.

use rusqlite::{params, OptionalExtension};

use crate::coordination::agent_org_runs::{AgentOrgRunStatus, COORDINATOR_MEMBER_ID};
use crate::coordination::agent_org_turn_contexts::{
    require_context_with_connection, AgentOrgTurnKind,
};

#[derive(Debug, Clone)]
pub struct TaskGraphWriterAdmin {
    session_id: String,
    turn_intent_id: String,
}

impl TaskGraphWriterAdmin {
    pub fn new(
        session_id: impl Into<String>,
        turn_intent_id: impl Into<String>,
    ) -> Result<Self, String> {
        let actor = Self {
            session_id: session_id.into(),
            turn_intent_id: turn_intent_id.into(),
        };
        if actor.session_id.trim().is_empty() || actor.turn_intent_id.trim().is_empty() {
            return Err("task_graph_writer_context_required".to_string());
        }
        Ok(actor)
    }

    pub(crate) fn validate(
        &self,
        conn: &rusqlite::Connection,
        org_run_id: &str,
    ) -> Result<TaskActorAudit, String> {
        let context =
            require_context_with_connection(conn, &self.session_id, &self.turn_intent_id)?;
        validate_run_and_generation(conn, org_run_id, context.activation_generation)?;
        if context.org_run_id != org_run_id
            || context.turn_kind != AgentOrgTurnKind::Coordinator
            || context.participant_id != COORDINATOR_MEMBER_ID
            || context.task_id.is_some()
            || context.owner_member_id.is_some()
        {
            return Err("task_graph_writer_context_mismatch".to_string());
        }
        let root_session_id: Option<String> = conn
            .query_row(
                "SELECT root_session_id FROM agent_org_runtime_runs WHERE id=?1",
                [org_run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .flatten();
        if root_session_id.as_deref() != Some(self.session_id.as_str()) {
            return Err("task_graph_writer_not_canonical_root".to_string());
        }
        Ok(TaskActorAudit {
            kind: TaskActorKind::GraphWriter,
            participant_id: context.participant_id,
            turn_intent_id: Some(context.turn_intent_id),
        })
    }
}

#[derive(Debug, Clone)]
pub struct TaskOwnerExecution {
    session_id: String,
    turn_intent_id: String,
}

impl TaskOwnerExecution {
    pub fn new(
        session_id: impl Into<String>,
        turn_intent_id: impl Into<String>,
    ) -> Result<Self, String> {
        let actor = Self {
            session_id: session_id.into(),
            turn_intent_id: turn_intent_id.into(),
        };
        if actor.session_id.trim().is_empty() || actor.turn_intent_id.trim().is_empty() {
            return Err("task_owner_context_required".to_string());
        }
        Ok(actor)
    }

    pub(crate) fn validate(
        &self,
        conn: &rusqlite::Connection,
        org_run_id: &str,
        task_id: &str,
    ) -> Result<TaskActorAudit, String> {
        let context =
            require_context_with_connection(conn, &self.session_id, &self.turn_intent_id)?;
        validate_run_and_generation(conn, org_run_id, context.activation_generation)?;
        if context.org_run_id != org_run_id
            || context.turn_kind != AgentOrgTurnKind::TaskExecution
            || context.task_id.as_deref() != Some(task_id)
            || context.owner_member_id.as_deref() != Some(context.participant_id.as_str())
            || context.participant_id == COORDINATOR_MEMBER_ID
        {
            return Err("task_owner_context_mismatch".to_string());
        }
        Ok(TaskActorAudit {
            kind: TaskActorKind::OwnerExecution,
            participant_id: context.participant_id,
            turn_intent_id: Some(context.turn_intent_id),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SystemTaskOperation {
    RecoveryRequeue,
    RecoveryFail,
    ShutdownRelease,
}

impl SystemTaskOperation {
    pub(crate) const fn as_wire(self) -> &'static str {
        match self {
            Self::RecoveryRequeue => "recovery_requeue",
            Self::RecoveryFail => "recovery_fail",
            Self::ShutdownRelease => "shutdown_release",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct SystemArchiveOrRecovery {
    receipt_id: String,
    generation: i64,
    operation: SystemTaskOperation,
}

impl SystemArchiveOrRecovery {
    pub(crate) fn new(
        receipt_id: impl Into<String>,
        generation: i64,
        operation: SystemTaskOperation,
    ) -> Result<Self, String> {
        let receipt_id = receipt_id.into();
        if receipt_id.trim().is_empty() || generation < 1 {
            return Err("system_task_actor_invalid".to_string());
        }
        Ok(Self {
            receipt_id,
            generation,
            operation,
        })
    }

    pub(crate) fn validate(
        &self,
        conn: &rusqlite::Connection,
        org_run_id: &str,
        target_key: &str,
    ) -> Result<TaskActorAudit, String> {
        validate_run_and_generation(conn, org_run_id, Some(self.generation))?;
        let action_kind = match self.operation {
            SystemTaskOperation::RecoveryRequeue | SystemTaskOperation::RecoveryFail => {
                "task_failure_recovery"
            }
            SystemTaskOperation::ShutdownRelease => "task_shutdown_release",
        };
        let receipt: Option<(String, i64)> = conn
            .query_row(
                "SELECT action_kind, attempts
                 FROM agent_org_runtime_recovery_attempts
                 WHERE org_run_id=?1 AND reservation_token=?2
                   AND action_kind=?3 AND target_key=?4",
                params![org_run_id, &self.receipt_id, action_kind, target_key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some((persisted_action_kind, attempts)) = receipt else {
            return Err("system_task_recovery_receipt_invalid".to_string());
        };
        let operation_matches_receipt = match self.operation {
            SystemTaskOperation::RecoveryRequeue => {
                persisted_action_kind == "task_failure_recovery"
                    && !crate::coordination::agent_org_watchdog::task_failure_recovery_attempts_exhausted(attempts)
            }
            SystemTaskOperation::RecoveryFail => {
                persisted_action_kind == "task_failure_recovery"
                    && crate::coordination::agent_org_watchdog::task_failure_recovery_attempts_exhausted(attempts)
            }
            SystemTaskOperation::ShutdownRelease => {
                persisted_action_kind == "task_shutdown_release"
            }
        };
        if !operation_matches_receipt {
            return Err("system_task_recovery_operation_mismatch".to_string());
        }
        Ok(TaskActorAudit {
            kind: TaskActorKind::System,
            participant_id: format!("system:{}", self.operation.as_wire()),
            turn_intent_id: None,
        })
    }

    pub(crate) fn receipt_id(&self) -> &str {
        &self.receipt_id
    }

    pub(crate) const fn action_kind(&self) -> &'static str {
        match self.operation {
            SystemTaskOperation::RecoveryRequeue | SystemTaskOperation::RecoveryFail => {
                "task_failure_recovery"
            }
            SystemTaskOperation::ShutdownRelease => "task_shutdown_release",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TaskActorKind {
    GraphWriter,
    OwnerExecution,
    System,
}

impl TaskActorKind {
    pub(crate) const fn as_wire(self) -> &'static str {
        match self {
            Self::GraphWriter => "graph_writer",
            Self::OwnerExecution => "owner_execution",
            Self::System => "system",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct TaskActorAudit {
    pub(crate) kind: TaskActorKind,
    pub(crate) participant_id: String,
    pub(crate) turn_intent_id: Option<String>,
}

fn validate_run_and_generation(
    conn: &rusqlite::Connection,
    org_run_id: &str,
    expected_generation: Option<i64>,
) -> Result<(), String> {
    let row: Option<(String, i64, Option<String>)> = conn
        .query_row(
            "SELECT status, activation_generation, org_snapshot_json
             FROM agent_org_runtime_runs WHERE id=?1",
            [org_run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((status_raw, generation, snapshot_json)) = row else {
        return Err(format!("agent_org_run_not_found: {org_run_id}"));
    };
    let status = AgentOrgRunStatus::parse(&status_raw)
        .ok_or_else(|| format!("unknown Agent Org run status: {status_raw}"))?;
    if status != AgentOrgRunStatus::Running {
        return Err(format!(
            "agent_org_run_not_mutable: run {org_run_id} is {status}"
        ));
    }
    if expected_generation != Some(generation) {
        return Err("task_actor_generation_mismatch".to_string());
    }
    let snapshot_json = snapshot_json.ok_or_else(|| "task_actor_snapshot_missing".to_string())?;
    let snapshot: crate::definitions::orgs::AgentOrgLaunchSnapshot =
        serde_json::from_str(&snapshot_json)
            .map_err(|error| format!("task_actor_snapshot_invalid: {error}"))?;
    crate::definitions::orgs::validate_launch_snapshot(&snapshot)
        .map_err(|error| format!("task_actor_snapshot_invalid: {error}"))
}
