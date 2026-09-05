//! Additive durable authority for Agent Org Task execution and finality.
//!
//! The original `agent_org_runtime_*` schema is a frozen compatibility
//! contract. These companion tables are deliberately outside that namespace:
//! they can be created idempotently for existing databases while older builds
//! safely ignore and preserve them.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

pub(crate) const TASK_EXECUTION_ALREADY_ACTIVE: &str = "task_execution_already_active";
const FAILURE_PREFIX: &str = "agent_org_turn_failure:";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentOrgTurnFailureKind {
    TransientStorage,
    AuthorityConflict,
    TargetTerminal,
    StaleGeneration,
    CorruptState,
}

impl AgentOrgTurnFailureKind {
    pub(crate) const fn permits_task_recovery(self) -> bool {
        matches!(self, Self::TransientStorage)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentOrgTurnFailure {
    pub kind: AgentOrgTurnFailureKind,
    pub reason_code: String,
    pub detail: String,
}

impl AgentOrgTurnFailure {
    pub(crate) fn new(
        kind: AgentOrgTurnFailureKind,
        reason_code: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            reason_code: reason_code.into(),
            detail: detail.into(),
        }
    }

    pub(crate) fn encode(&self) -> String {
        let payload = serde_json::to_string(self).unwrap_or_else(|_| {
            r#"{"kind":"corrupt_state","reasonCode":"failure_encoding_failed","detail":"Agent Org failure could not be encoded"}"#.to_string()
        });
        format!("{FAILURE_PREFIX}{payload}")
    }

    pub(crate) fn decode(value: &str) -> Option<Self> {
        let payload = value.strip_prefix(FAILURE_PREFIX)?;
        serde_json::from_str(payload).ok()
    }

    pub(crate) fn decode_or_corrupt(value: impl Into<String>, reason_code: &'static str) -> Self {
        let value = value.into();
        Self::decode(&value)
            .unwrap_or_else(|| Self::new(AgentOrgTurnFailureKind::CorruptState, reason_code, value))
    }

    pub(crate) fn from_storage_error(reason_code: &'static str, error: rusqlite::Error) -> Self {
        let kind = match &error {
            rusqlite::Error::SqliteFailure(code, _)
                if matches!(
                    code.code,
                    rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                ) =>
            {
                AgentOrgTurnFailureKind::TransientStorage
            }
            _ => AgentOrgTurnFailureKind::CorruptState,
        };
        Self::new(kind, reason_code, error.to_string())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TaskExecutionAuthoritySourceKind {
    Assignment,
    PlanRevision,
    CoordinatorMessage,
    PauseResume,
    InterventionReturn,
}

impl TaskExecutionAuthoritySourceKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Assignment => "assignment",
            Self::PlanRevision => "plan_revision",
            Self::CoordinatorMessage => "coordinator_message",
            Self::PauseResume => "pause_resume",
            Self::InterventionReturn => "intervention_return",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TaskExecutionAuthoritySource {
    pub kind: TaskExecutionAuthoritySourceKind,
    pub receipt_id: String,
    pub source_inbox_id: Option<i64>,
}

impl TaskExecutionAuthoritySource {
    pub(crate) fn inbox(kind: TaskExecutionAuthoritySourceKind, inbox_id: i64) -> Self {
        Self {
            kind,
            receipt_id: format!("inbox:{inbox_id}"),
            source_inbox_id: Some(inbox_id),
        }
    }

    pub(crate) fn receipt(
        kind: TaskExecutionAuthoritySourceKind,
        receipt_id: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            receipt_id: receipt_id.into(),
            source_inbox_id: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeRemovalReceipt {
    pub id: String,
    pub org_run_id: String,
    pub work_episode_id: String,
    pub target_task_id: String,
    pub root_user_event_id: String,
    pub request_id: String,
    pub actor_session_id: String,
    pub status: String,
    pub created_at: String,
}

pub(crate) fn create_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_task_execution_leases (
            lease_id TEXT PRIMARY KEY,
            org_run_id TEXT NOT NULL,
            work_episode_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            activation_generation INTEGER NOT NULL CHECK(activation_generation >= 1),
            execution_epoch INTEGER NOT NULL CHECK(execution_epoch >= 1),
            owner_member_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            turn_intent_id TEXT NOT NULL,
            source_kind TEXT NOT NULL CHECK(source_kind IN (
                'assignment','plan_revision','coordinator_message',
                'pause_resume','intervention_return','legacy_repair'
            )),
            continuation_receipt_id TEXT NOT NULL,
            source_inbox_id INTEGER,
            prior_lease_id TEXT,
            state TEXT NOT NULL CHECK(state IN ('active','released','frozen','conflict')),
            terminal_reason_code TEXT,
            created_at TEXT NOT NULL,
            terminal_at TEXT,
            UNIQUE(session_id, turn_intent_id),
            UNIQUE(org_run_id, work_episode_id, task_id, activation_generation, execution_epoch),
            UNIQUE(continuation_receipt_id),
            FOREIGN KEY(org_run_id, task_id)
                REFERENCES agent_org_runtime_tasks(org_run_id, id) ON DELETE CASCADE,
            FOREIGN KEY(work_episode_id)
                REFERENCES agent_org_runtime_work_episodes(id) ON DELETE CASCADE,
            FOREIGN KEY(source_inbox_id)
                REFERENCES agent_org_runtime_inbox(id) ON DELETE SET NULL,
            FOREIGN KEY(prior_lease_id)
                REFERENCES agent_org_task_execution_leases(lease_id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_org_task_execution_one_live
            ON agent_org_task_execution_leases(
                org_run_id,work_episode_id,task_id,activation_generation
            ) WHERE state='active';
        CREATE INDEX IF NOT EXISTS idx_agent_org_task_execution_turn
            ON agent_org_task_execution_leases(session_id,turn_intent_id,state);
        CREATE INDEX IF NOT EXISTS idx_agent_org_task_execution_task
            ON agent_org_task_execution_leases(org_run_id,task_id,execution_epoch DESC);

        CREATE TABLE IF NOT EXISTS agent_org_task_execution_reconciliations (
            context_id INTEGER PRIMARY KEY,
            org_run_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            activation_generation INTEGER NOT NULL,
            session_id TEXT NOT NULL,
            turn_intent_id TEXT NOT NULL,
            disposition TEXT NOT NULL CHECK(disposition='conflict_rejected'),
            reason_code TEXT NOT NULL CHECK(reason_code='duplicate_execution_rejected'),
            reconciled_at TEXT NOT NULL,
            UNIQUE(session_id,turn_intent_id),
            FOREIGN KEY(context_id)
                REFERENCES agent_org_runtime_turn_contexts(context_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_task_execution_reconciliation_task
            ON agent_org_task_execution_reconciliations(
                org_run_id,task_id,activation_generation
            );

        CREATE TABLE IF NOT EXISTS agent_org_scope_removal_receipts (
            receipt_id TEXT PRIMARY KEY,
            org_run_id TEXT NOT NULL,
            work_episode_id TEXT NOT NULL,
            target_task_id TEXT NOT NULL,
            root_user_event_id TEXT NOT NULL,
            request_id TEXT NOT NULL,
            request_digest TEXT NOT NULL,
            actor_session_id TEXT NOT NULL,
            actor_kind TEXT NOT NULL CHECK(actor_kind='run_view_user'),
            status TEXT NOT NULL CHECK(status IN ('recorded','revoked')),
            created_at TEXT NOT NULL,
            revoked_at TEXT,
            UNIQUE(org_run_id, request_id),
            UNIQUE(root_user_event_id),
            FOREIGN KEY(org_run_id, target_task_id)
                REFERENCES agent_org_runtime_tasks(org_run_id, id) ON DELETE CASCADE,
            FOREIGN KEY(work_episode_id)
                REFERENCES agent_org_runtime_work_episodes(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_scope_removal_episode
            ON agent_org_scope_removal_receipts(org_run_id,work_episode_id,target_task_id);

        CREATE TABLE IF NOT EXISTS agent_org_scope_resolution_receipts (
            resolution_id TEXT PRIMARY KEY,
            root_receipt_id TEXT NOT NULL,
            org_run_id TEXT NOT NULL,
            work_episode_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            resolution_kind TEXT NOT NULL CHECK(resolution_kind IN (
                'dependency_cancelled','dependency_replaced','dependency_detached'
            )),
            replacement_task_id TEXT,
            source_turn_intent_id TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(root_receipt_id,task_id,resolution_kind),
            FOREIGN KEY(root_receipt_id)
                REFERENCES agent_org_scope_removal_receipts(receipt_id) ON DELETE CASCADE,
            FOREIGN KEY(org_run_id,task_id)
                REFERENCES agent_org_runtime_tasks(org_run_id,id) ON DELETE CASCADE,
            FOREIGN KEY(work_episode_id)
                REFERENCES agent_org_runtime_work_episodes(id) ON DELETE CASCADE,
            CHECK(
                (resolution_kind='dependency_replaced' AND replacement_task_id IS NOT NULL)
                OR (resolution_kind<>'dependency_replaced' AND replacement_task_id IS NULL)
            )
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_scope_resolution_episode
            ON agent_org_scope_resolution_receipts(org_run_id,work_episode_id,task_id);

        CREATE TABLE IF NOT EXISTS agent_org_coordinator_completion_rechecks (
            org_run_id TEXT NOT NULL,
            source_session_id TEXT NOT NULL,
            source_turn_intent_id TEXT NOT NULL,
            activation_generation INTEGER NOT NULL,
            work_revision INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending','materialized','resolved')),
            inbox_id INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(org_run_id,source_session_id,source_turn_intent_id),
            FOREIGN KEY(inbox_id) REFERENCES agent_org_runtime_inbox(id) ON DELETE SET NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_org_completion_recheck_inbox
            ON agent_org_coordinator_completion_rechecks(inbox_id)
            WHERE inbox_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_org_completion_recheck_pending
            ON agent_org_coordinator_completion_rechecks(org_run_id,status,work_revision);",
    )
}

mod coordinator_recheck;
mod execution_authority;
mod restart_reconciliation;
mod scope_closure;
mod task_delivery_settlement;

pub(crate) use coordinator_recheck::{
    final_coordinator_revision_for_turn, finalize_turn, record_task_mutation_in_tx,
};
pub(crate) use execution_authority::{
    claim_task_execution_in_tx, freeze_run_generation_leases_in_tx, release_turn_lease_in_tx,
};
pub(crate) use restart_reconciliation::reconcile_after_restart;
pub(crate) use scope_closure::{
    create_scope_removal_in_tx, record_scope_detachments_in_tx, record_scope_resolution_in_tx,
    scope_removal_by_request_in_tx, valid_scope_removal_for_task,
    validate_scope_removal_reason_in_tx,
};
pub(crate) use task_delivery_settlement::settle_task_bound_deliveries_in_tx;
