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
        if context.org_run_id != org_run_id {
            return Err("task_graph_writer_context_mismatch".to_string());
        }
        let (status, generation, snapshot) = load_run_snapshot(conn, org_run_id)?;
        let is_coordinator = context.turn_kind == AgentOrgTurnKind::Coordinator
            && context.participant_id == COORDINATOR_MEMBER_ID
            && context.task_id.is_none()
            && context.owner_member_id.is_none();
        if is_coordinator {
            validate_running_generation(
                org_run_id,
                status,
                generation,
                context.activation_generation,
            )?;
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
        } else {
            let is_bound_writer_execution = context.turn_kind == AgentOrgTurnKind::TaskExecution
                && context.task_id.is_some()
                && context.owner_member_id.as_deref() == Some(context.participant_id.as_str())
                && context.participant_id != COORDINATOR_MEMBER_ID
                && snapshot
                    .additional_task_graph_writer_member_ids
                    .iter()
                    .any(|member_id| member_id == &context.participant_id);
            let is_user_directed_writer = context.turn_kind == AgentOrgTurnKind::UserDirectedWork
                && context.task_id.is_none()
                && context.owner_member_id.is_none()
                && context.dispatch_member_id.as_deref() == Some(context.participant_id.as_str())
                && context.participant_id != COORDINATOR_MEMBER_ID
                && snapshot
                    .additional_task_graph_writer_member_ids
                    .iter()
                    .any(|member_id| member_id == &context.participant_id);
            if is_bound_writer_execution {
                validate_running_generation(
                    org_run_id,
                    status,
                    generation,
                    context.activation_generation,
                )?;
            } else if is_user_directed_writer {
                crate::coordination::agent_org_turn_contexts::revalidate_context_with_connection(
                    conn,
                    &self.session_id,
                    &self.turn_intent_id,
                )?;
                match status {
                    AgentOrgRunStatus::Running | AgentOrgRunStatus::Idle => {}
                    AgentOrgRunStatus::Paused => {
                        return Err(format!(
                            "team_paused_resume_required: Agent Org run {org_run_id} must be resumed before changing formal work"
                        ));
                    }
                    _ => {
                        return Err(crate::coordination::agent_org_runs::mutation_blocked_error(
                            org_run_id,
                            status.as_str(),
                        ));
                    }
                }
            } else {
                return Err("task_graph_writer_context_mismatch".to_string());
            }
        }
        Ok(TaskActorAudit {
            kind: TaskActorKind::GraphWriter,
            participant_id: context.participant_id,
            turn_intent_id: Some(context.turn_intent_id),
            activation_generation: generation,
        })
    }

    pub(crate) fn validate_canonical_coordinator(
        &self,
        conn: &rusqlite::Connection,
        org_run_id: &str,
    ) -> Result<(), String> {
        let audit = self.validate(conn, org_run_id)?;
        if audit.participant_id != COORDINATOR_MEMBER_ID {
            return Err("agent_org_coordinator_context_required".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct TaskOwnerExecution {
    session_id: String,
    turn_intent_id: String,
}

/// Narrow authority used only by the immutable PlanRevision decision owner.
///
/// A Plan decision may legitimately happen after Pause/Resume has fenced the
/// Planner Turn that authored the revision.  The old Turn remains provenance,
/// but it must not be reused as current Task-mutation authority.  These
/// variants identify the actor that owns the current decision transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PlanDecisionTaskAuthority {
    User {
        root_session_id: String,
    },
    Coordinator {
        session_id: String,
        turn_intent_id: String,
    },
    Automatic {
        session_id: String,
        turn_intent_id: String,
    },
}

impl PlanDecisionTaskAuthority {
    pub(crate) fn user(root_session_id: impl Into<String>) -> Result<Self, String> {
        let root_session_id = root_session_id.into();
        if root_session_id.trim().is_empty() {
            return Err("plan_decision_root_session_required".to_string());
        }
        Ok(Self::User { root_session_id })
    }

    pub(crate) fn coordinator(
        session_id: impl Into<String>,
        turn_intent_id: impl Into<String>,
    ) -> Result<Self, String> {
        let session_id = session_id.into();
        let turn_intent_id = turn_intent_id.into();
        if session_id.trim().is_empty() || turn_intent_id.trim().is_empty() {
            return Err("plan_decision_coordinator_context_required".to_string());
        }
        Ok(Self::Coordinator {
            session_id,
            turn_intent_id,
        })
    }

    pub(crate) fn automatic(
        session_id: impl Into<String>,
        turn_intent_id: impl Into<String>,
    ) -> Result<Self, String> {
        let session_id = session_id.into();
        let turn_intent_id = turn_intent_id.into();
        if session_id.trim().is_empty() || turn_intent_id.trim().is_empty() {
            return Err("plan_decision_automatic_context_required".to_string());
        }
        Ok(Self::Automatic {
            session_id,
            turn_intent_id,
        })
    }
}

/// Typed authority for a user clicking Cancel/Reassign in the canonical root
/// Run View. This is not model authority: the Store transaction revalidates
/// the exact root Session and current Running generation.
#[derive(Debug, Clone)]
pub struct UserTaskHandoffAdmin {
    root_session_id: String,
    request_id: String,
}

impl UserTaskHandoffAdmin {
    pub fn new(
        root_session_id: impl Into<String>,
        request_id: impl Into<String>,
    ) -> Result<Self, String> {
        let actor = Self {
            root_session_id: root_session_id.into(),
            request_id: request_id.into(),
        };
        if actor.root_session_id.trim().is_empty() || actor.request_id.trim().is_empty() {
            return Err("user_task_handoff_context_required".to_string());
        }
        Ok(actor)
    }

    pub(crate) fn validate(
        &self,
        conn: &rusqlite::Connection,
        org_run_id: &str,
    ) -> Result<TaskActorAudit, String> {
        let row: Option<(String, i64, Option<String>)> = conn
            .query_row(
                "SELECT status,activation_generation,root_session_id
                 FROM agent_org_runtime_runs WHERE id=?1",
                [org_run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some((status, generation, root_session_id)) = row else {
            return Err(format!("agent_org_run_not_found: {org_run_id}"));
        };
        if status != AgentOrgRunStatus::Running.as_str() {
            return Err(crate::coordination::agent_org_runs::mutation_blocked_error(
                org_run_id, &status,
            ));
        }
        if root_session_id.as_deref() != Some(self.root_session_id.as_str()) {
            return Err("user_task_handoff_requires_canonical_root_session".to_string());
        }
        Ok(TaskActorAudit {
            kind: TaskActorKind::System,
            participant_id: format!("user:task_handoff:{}", self.request_id),
            // Replacements still require a stable creation-source reference,
            // but a Run View click is not a model Turn. Preserve that
            // distinction with a namespaced user-intent identity instead of
            // manufacturing a session_turn_intents row or borrowing the last
            // Coordinator Turn.
            turn_intent_id: Some(format!("user_task_handoff:{}", self.request_id)),
            activation_generation: generation,
        })
    }

    pub(crate) fn request_id(&self) -> &str {
        &self.request_id
    }
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
            activation_generation: context
                .activation_generation
                .ok_or_else(|| "task_owner_generation_missing".to_string())?,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SystemTaskOperation {
    ArchiveCancel,
    RecoveryRequeue,
    RecoveryFail,
    ShutdownRelease,
}

impl SystemTaskOperation {
    pub(crate) const fn as_wire(self) -> &'static str {
        match self {
            Self::ArchiveCancel => "archive_cancel",
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
        if self.operation == SystemTaskOperation::ArchiveCancel {
            let archive: Option<(String, i64, i64)> = conn
                .query_row(
                    "SELECT run.status,run.activation_generation,archive.archive_generation
                     FROM agent_org_runtime_archive_episodes archive
                     JOIN agent_org_runtime_runs run ON run.id=archive.org_run_id
                     WHERE archive.org_run_id=?1 AND archive.archive_receipt_id=?2",
                    params![org_run_id, &self.receipt_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            let Some((status, run_generation, archive_generation)) = archive else {
                return Err("system_task_archive_receipt_invalid".to_string());
            };
            if status != AgentOrgRunStatus::Archived.as_str()
                || run_generation != self.generation
                || archive_generation != self.generation
            {
                return Err("system_task_archive_generation_mismatch".to_string());
            }
            return Ok(TaskActorAudit {
                kind: TaskActorKind::System,
                participant_id: format!("system:{}", self.operation.as_wire()),
                turn_intent_id: None,
                activation_generation: self.generation,
            });
        }

        validate_run_and_generation(conn, org_run_id, Some(self.generation))?;
        let action_kind = match self.operation {
            SystemTaskOperation::ArchiveCancel => unreachable!("handled above"),
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
            SystemTaskOperation::ArchiveCancel => unreachable!("handled above"),
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
            activation_generation: self.generation,
        })
    }

    pub(crate) fn receipt_id(&self) -> &str {
        &self.receipt_id
    }

    pub(crate) const fn action_kind(&self) -> &'static str {
        match self.operation {
            SystemTaskOperation::ArchiveCancel => "team_archive",
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
    pub(crate) activation_generation: i64,
}

fn validate_run_and_generation(
    conn: &rusqlite::Connection,
    org_run_id: &str,
    expected_generation: Option<i64>,
) -> Result<crate::definitions::orgs::AgentOrgLaunchSnapshot, String> {
    let (status, generation, snapshot) = load_run_snapshot(conn, org_run_id)?;
    validate_running_generation(org_run_id, status, generation, expected_generation)?;
    Ok(snapshot)
}

fn validate_running_generation(
    org_run_id: &str,
    status: AgentOrgRunStatus,
    generation: i64,
    expected_generation: Option<i64>,
) -> Result<(), String> {
    if status != AgentOrgRunStatus::Running {
        return Err(crate::coordination::agent_org_runs::mutation_blocked_error(
            org_run_id,
            status.as_str(),
        ));
    }
    if expected_generation != Some(generation) {
        return Err("task_actor_generation_mismatch".to_string());
    }
    Ok(())
}

fn load_run_snapshot(
    conn: &rusqlite::Connection,
    org_run_id: &str,
) -> Result<
    (
        AgentOrgRunStatus,
        i64,
        crate::definitions::orgs::AgentOrgLaunchSnapshot,
    ),
    String,
> {
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
    let snapshot_json = snapshot_json.ok_or_else(|| "task_actor_snapshot_missing".to_string())?;
    let snapshot: crate::definitions::orgs::AgentOrgLaunchSnapshot =
        serde_json::from_str(&snapshot_json)
            .map_err(|error| format!("task_actor_snapshot_invalid: {error}"))?;
    crate::definitions::orgs::validate_launch_snapshot(&snapshot)
        .map_err(|error| format!("task_actor_snapshot_invalid: {error}"))?;
    Ok((status, generation, snapshot))
}
