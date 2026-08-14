use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};

use crate::coordination::agent_member_interventions::AgentMemberInterventionStore;
use crate::coordination::agent_org_plan_approvals::AgentOrgPlanApprovalStore;
use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, Task, TaskStatus};
use crate::session::SessionStatus;
use database::db::{get_connection, with_sessions_writer};

use super::helpers::{
    context_for_run_record, flatten_members, insert_run, load_by_id, load_by_root_session,
    parent_session_id_of, row_to_run, validate_entry_mode, validate_status,
};
use super::materialization::{
    insert_initial_input, insert_materialization_intent, list_materializations_with_connection,
    list_recoverable_initial_inputs_with_connection, load_initial_input_by_turn_with_connection,
    load_initial_input_with_connection,
};
use super::progress::{
    ensure_progress_in_conn, load_progress_with_conn, mark_coordinator_observed_revision_with_conn,
    record_completion_request_in_tx, stage_coordinator_presented_with_conn,
};
use super::quiescence::load_and_assess;
use super::worker::{WorkerSessionInfo, WorkerSessionRuntime};
use super::{
    AgentOrgCompletionRequestOutcome, AgentOrgInitialInput, AgentOrgMaterializationIntent,
    AgentOrgQuiescenceAssessment, AgentOrgRunContext, AgentOrgRunProgress, AgentOrgRunRecord,
    AgentOrgRunStatus, AgentOrgStartingFailure, CreateAgentOrgRunParams,
    CreateStartingAgentOrgRunParams, COORDINATOR_MEMBER_ID,
};

use crate::definitions::orgs::serialize_launch_snapshot;

/// Stable machine prefix for permanent Session-identity failures raised by
/// the materialization / finish-Starting certificate checks in this store.
/// Launch recovery classifies retryable-vs-permanent on these prefixes; never
/// match the human-readable remainder of the message.
pub const MATERIALIZATION_IDENTITY_MISMATCH_PREFIX: &str = "materialization_identity_mismatch:";

/// Stable machine prefix for permanent initial-input certificate failures
/// raised by [`AgentOrgRunStore::finish_starting`].
pub const STARTING_INPUT_CERTIFICATE_ERROR_PREFIX: &str = "starting_input_certificate_invalid:";

/// True for permanent Session-identity failures from
/// [`AgentOrgRunStore::mark_materialization_succeeded`] /
/// [`AgentOrgRunStore::finish_starting`]. Retrying these can never succeed:
/// the durable identity certificate itself is wrong.
pub fn is_materialization_identity_mismatch_error(error: &str) -> bool {
    error.starts_with(MATERIALIZATION_IDENTITY_MISMATCH_PREFIX)
}

/// True for every permanent (non-retryable) failure class that
/// [`AgentOrgRunStore::finish_starting`] can return. Everything else from
/// that call is treated as transient and retried by the recovery owners.
pub fn is_permanent_finish_starting_error(error: &str) -> bool {
    is_materialization_identity_mismatch_error(error)
        || error.starts_with(STARTING_INPUT_CERTIFICATE_ERROR_PREFIX)
}

pub struct AgentOrgRunStore;

pub(crate) struct AgentOrgRunDeleteOutcome {
    plan_artifacts: Vec<(String, String)>,
    deleted: bool,
}

impl AgentOrgRunDeleteOutcome {
    pub(crate) fn deleted(&self) -> bool {
        self.deleted
    }
}

impl AgentOrgRunStore {
    /// Load Agent Org run metadata only for roots in the current page.
    ///
    /// Results are newest-first so callers can deterministically choose the
    /// first record if legacy data contains several runs for one root.
    pub fn list_runs_for_root_session_ids(
        root_session_ids: &[String],
    ) -> Result<Vec<AgentOrgRunRecord>, String> {
        if root_session_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = get_connection().map_err(|err| err.to_string())?;
        let placeholders = (1..=root_session_ids.len())
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT id,
                    org_id,
                    coordinator_agent_id,
                    root_session_id,
                    org_snapshot_json,
                    entry_mode,
                    status,
                    activation_generation,
                    has_initial_work,
                    work_item_id,
                    project_slug,
                    routine_fire_id,
                    summary,
                    last_error,
                    failure_json,
                    last_activity_outcome,
                    created_at,
                    updated_at,
                    idled_at
             FROM agent_org_runs
             WHERE root_session_id IN ({placeholders})
             ORDER BY updated_at DESC, id DESC"
        );
        let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(root_session_ids.iter()),
                row_to_run,
            )
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())
    }

    /// Test-fixture constructor: seeds a run row in an arbitrary status
    /// without the Starting construction envelope. Production launch goes
    /// exclusively through [`Self::create_starting`]; unit tests and the
    /// `#![cfg(debug_assertions)]` /test endpoints need arbitrary-status
    /// seeding, so this is compiled only for those builds.
    #[cfg(any(test, debug_assertions))]
    pub fn create(params: CreateAgentOrgRunParams) -> Result<AgentOrgRunRecord, String> {
        let entry_mode = validate_entry_mode(params.entry_mode.as_str())?;
        let status = validate_status(params.status.as_str())?;
        let org_snapshot_json = serialize_launch_snapshot(&params.org_snapshot)?;
        let now = chrono::Utc::now().to_rfc3339();
        let run = AgentOrgRunRecord {
            id: format!("agent-org-run-{}", uuid::Uuid::new_v4()),
            org_id: params.org_id,
            coordinator_agent_id: params.coordinator_agent_id,
            root_session_id: params.root_session_id,
            org_snapshot_json: Some(org_snapshot_json),
            entry_mode,
            status,
            activation_generation: 1,
            has_initial_work: false,
            work_item_id: params.work_item_id,
            project_slug: params.project_slug,
            routine_fire_id: params.routine_fire_id,
            summary: None,
            last_error: None,
            failure_json: None,
            last_activity_outcome: None,
            created_at: now.clone(),
            updated_at: now,
            idled_at: None,
        };

        with_sessions_writer(|| -> Result<(), String> {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            insert_run(&tx, &run).map_err(|err| err.to_string())?;
            ensure_progress_in_conn(&tx, &run.id)?;
            tx.commit().map_err(|err| err.to_string())
        })?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run.id);
        Ok(run)
    }

    /// Create the authoritative Team construction envelope and every stable
    /// identity/input intent in one IMMEDIATE transaction.
    pub fn create_starting(
        params: CreateStartingAgentOrgRunParams,
    ) -> Result<AgentOrgRunRecord, String> {
        let entry_mode = validate_entry_mode(params.entry_mode.as_str())?;
        let org_snapshot_json = serialize_launch_snapshot(&params.org_snapshot)?;
        let now = chrono::Utc::now().to_rfc3339();
        let run = AgentOrgRunRecord {
            id: format!("agent-org-run-{}", uuid::Uuid::new_v4()),
            org_id: params.org_id,
            coordinator_agent_id: params.coordinator_agent_id,
            root_session_id: Some(params.root_session_id.clone()),
            org_snapshot_json: Some(org_snapshot_json),
            entry_mode,
            status: AgentOrgRunStatus::Starting,
            activation_generation: 1,
            has_initial_work: params.initial_input.is_some(),
            work_item_id: params.work_item_id,
            project_slug: params.project_slug,
            routine_fire_id: params.routine_fire_id,
            summary: None,
            last_error: None,
            failure_json: None,
            last_activity_outcome: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            idled_at: None,
        };

        let mut member_ids = HashSet::new();
        let mut session_ids = HashSet::new();
        let mut expected_roster = flatten_members(&params.org_snapshot.members)
            .into_iter()
            .map(|member| (member.member_id, member.agent_id))
            .collect::<std::collections::HashMap<_, _>>();
        expected_roster.insert(
            COORDINATOR_MEMBER_ID.to_string(),
            run.coordinator_agent_id.clone(),
        );
        for intent in &params.materialization_intents {
            if intent.member_id.trim().is_empty()
                || intent.agent_id.trim().is_empty()
                || intent.session_id.trim().is_empty()
            {
                return Err("Agent Org materialization intent contains an empty identity".into());
            }
            if !member_ids.insert(intent.member_id.clone()) {
                return Err(format!(
                    "duplicate Agent Org materialization member_id: {}",
                    intent.member_id
                ));
            }
            if !session_ids.insert(intent.session_id.clone()) {
                return Err(format!(
                    "duplicate Agent Org materialization session_id: {}",
                    intent.session_id
                ));
            }
            if expected_roster.get(&intent.member_id) != Some(&intent.agent_id) {
                return Err(format!(
                    "Agent Org materialization roster does not match the launch snapshot for member {}",
                    intent.member_id
                ));
            }
            if intent.member_id == COORDINATOR_MEMBER_ID {
                if intent.session_id != params.root_session_id || !intent.succeeded {
                    return Err(
                        "Agent Org coordinator receipt must certify the canonical root Session"
                            .into(),
                    );
                }
            } else if intent.succeeded {
                return Err(format!(
                    "Agent Org member {} cannot be pre-certified before materialization",
                    intent.member_id
                ));
            }
        }
        if member_ids.len() != expected_roster.len()
            || expected_roster
                .keys()
                .any(|member_id| !member_ids.contains(member_id))
        {
            return Err(
                "Agent Org materialization roster does not exactly match the launch snapshot"
                    .into(),
            );
        }

        with_sessions_writer(|| -> Result<(), String> {
            let mut connection = get_connection().map_err(|error| error.to_string())?;
            let transaction = connection
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let coordinator_identity: Option<(Option<String>, Option<String>, Option<String>)> =
                transaction
                    .query_row(
                        "SELECT agent_definition_id, org_member_id, parent_session_id
                         FROM agent_sessions WHERE session_id=?1",
                        [&params.root_session_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()
                    .map_err(|error| error.to_string())?;
            if coordinator_identity
                != Some((
                    Some(run.coordinator_agent_id.clone()),
                    Some(COORDINATOR_MEMBER_ID.to_string()),
                    None,
                ))
            {
                return Err(format!(
                    "Agent Org coordinator Session identity is missing or mismatched: {}",
                    params.root_session_id
                ));
            }
            insert_run(&transaction, &run).map_err(|error| error.to_string())?;
            for intent in &params.materialization_intents {
                insert_materialization_intent(
                    &transaction,
                    &run.id,
                    run.activation_generation,
                    intent,
                    &now,
                )?;
            }
            if let Some(input) = params.initial_input.as_ref() {
                insert_initial_input(&transaction, &run.id, input, &now)?;
            }
            ensure_progress_in_conn(&transaction, &run.id)?;
            transaction.commit().map_err(|error| error.to_string())
        })?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run.id);
        Ok(run)
    }

    pub fn materializations(run_id: &str) -> Result<Vec<AgentOrgMaterializationIntent>, String> {
        let connection = get_connection().map_err(|error| error.to_string())?;
        list_materializations_with_connection(&connection, run_id)
    }

    pub fn initial_input(run_id: &str) -> Result<Option<AgentOrgInitialInput>, String> {
        let connection = get_connection().map_err(|error| error.to_string())?;
        load_initial_input_with_connection(&connection, run_id)
    }

    pub fn initial_input_for_turn(
        turn_intent_id: &str,
    ) -> Result<Option<AgentOrgInitialInput>, String> {
        let connection = get_connection().map_err(|error| error.to_string())?;
        load_initial_input_by_turn_with_connection(&connection, turn_intent_id)
    }

    pub fn recoverable_initial_inputs(limit: usize) -> Result<Vec<AgentOrgInitialInput>, String> {
        let connection = get_connection().map_err(|error| error.to_string())?;
        list_recoverable_initial_inputs_with_connection(&connection, limit)
    }

    pub fn load(run_id: &str) -> Result<Option<AgentOrgRunRecord>, String> {
        load_by_id(run_id).map_err(|error| error.to_string())
    }

    /// Certify one stable member identity after the exact persisted Session
    /// row has been read back. A retry of the same receipt is a no-op; a
    /// different identity can never satisfy it.
    pub fn mark_materialization_succeeded(
        run_id: &str,
        member_id: &str,
        generation: i64,
        session_id: &str,
    ) -> Result<bool, String> {
        with_sessions_writer(|| -> Result<bool, String> {
            let mut connection = get_connection().map_err(|error| error.to_string())?;
            let transaction = connection
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let receipt: Option<(String, String, String, String)> = transaction
                .query_row(
                    "SELECT materialization.agent_id, materialization.session_id,
                            run.root_session_id, materialization.status
                     FROM agent_org_member_materializations materialization
                     JOIN agent_org_runs run ON run.id=materialization.org_run_id
                     WHERE materialization.org_run_id=?1
                       AND materialization.member_id=?2
                       AND materialization.generation=?3
                       AND run.status='starting'
                       AND run.activation_generation=?3",
                    params![run_id, member_id, generation],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            let Some((agent_id, expected_session_id, root_session_id, status)) = receipt else {
                transaction.commit().map_err(|error| error.to_string())?;
                return Ok(false);
            };
            if expected_session_id != session_id {
                return Err(format!(
                    "{MATERIALIZATION_IDENTITY_MISMATCH_PREFIX} materialization session mismatch for {run_id}/{member_id}: expected {expected_session_id}, got {session_id}"
                ));
            }
            if status == "succeeded" {
                transaction.commit().map_err(|error| error.to_string())?;
                return Ok(false);
            }
            let persisted_identity: Option<(Option<String>, Option<String>, Option<String>)> =
                transaction
                    .query_row(
                        "SELECT agent_definition_id, org_member_id, parent_session_id
                         FROM agent_sessions WHERE session_id=?1",
                        [session_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()
                    .map_err(|error| error.to_string())?;
            let Some((persisted_agent_id, persisted_member_id, parent_session_id)) =
                persisted_identity
            else {
                return Err(format!(
                    "{MATERIALIZATION_IDENTITY_MISMATCH_PREFIX} materialized Session {session_id} is missing for {run_id}/{member_id}"
                ));
            };
            let expected_parent = (member_id != COORDINATOR_MEMBER_ID).then_some(root_session_id);
            if persisted_agent_id.as_deref() != Some(agent_id.as_str())
                || persisted_member_id.as_deref() != Some(member_id)
                || parent_session_id != expected_parent
            {
                return Err(format!(
                    "{MATERIALIZATION_IDENTITY_MISMATCH_PREFIX} materialized Session identity mismatch for {run_id}/{member_id}"
                ));
            }
            let changed = transaction
                .execute(
                    "UPDATE agent_org_member_materializations
                     SET status='succeeded', error_code=NULL, error_json=NULL,
                         updated_at=?5
                     WHERE org_run_id=?1 AND member_id=?2 AND generation=?3
                       AND session_id=?4 AND status='pending'",
                    params![
                        run_id,
                        member_id,
                        generation,
                        session_id,
                        chrono::Utc::now().to_rfc3339()
                    ],
                )
                .map_err(|error| error.to_string())?;
            transaction.commit().map_err(|error| error.to_string())?;
            Ok(changed == 1)
        })
    }

    /// Finish Starting only after the stable roster and initial-input
    /// certificate are complete. This is the sole Starting completion owner.
    pub fn finish_starting(
        run_id: &str,
        expected_generation: i64,
    ) -> Result<AgentOrgRunStatus, String> {
        let status = with_sessions_writer(|| -> Result<AgentOrgRunStatus, String> {
            let mut connection = get_connection().map_err(|error| error.to_string())?;
            let transaction = connection
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let run: Option<(String, String, i64, bool)> = transaction
                .query_row(
                    "SELECT status, root_session_id, activation_generation, has_initial_work
                     FROM agent_org_runs WHERE id=?1",
                    [run_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get::<_, i64>(3)? != 0,
                        ))
                    },
                )
                .optional()
                .map_err(|error| error.to_string())?;
            let Some((status_raw, root_session_id, generation, has_initial_work)) = run else {
                return Err(format!("agent_org_run_not_found: {run_id}"));
            };
            let current = AgentOrgRunStatus::parse(&status_raw)
                .ok_or_else(|| format!("unknown Agent Org run status: {status_raw:?}"))?;
            if current != AgentOrgRunStatus::Starting {
                transaction.commit().map_err(|error| error.to_string())?;
                return Ok(current);
            }
            if generation != expected_generation {
                return Err(format!(
                    "stale Starting generation for {run_id}: expected {expected_generation}, current {generation}"
                ));
            }
            let invalid_materialized_identities: i64 = transaction
                .query_row(
                    "SELECT COUNT(*)
                     FROM agent_org_member_materializations materialization
                     LEFT JOIN agent_sessions session
                       ON session.session_id=materialization.session_id
                     WHERE materialization.org_run_id=?1
                       AND materialization.generation=?2
                       AND materialization.status='succeeded'
                       AND (
                           session.session_id IS NULL
                           OR session.agent_definition_id IS NULL
                           OR session.agent_definition_id<>materialization.agent_id
                           OR session.org_member_id IS NULL
                           OR session.org_member_id<>materialization.member_id
                           OR (
                               materialization.member_id=?3
                               AND (
                                   materialization.session_id<>?4
                                   OR session.parent_session_id IS NOT NULL
                               )
                           )
                           OR (
                               materialization.member_id<>?3
                               AND (
                                   materialization.session_id=?4
                                   OR session.parent_session_id IS NULL
                                   OR session.parent_session_id<>?4
                               )
                           )
                       )",
                    params![
                        run_id,
                        expected_generation,
                        COORDINATOR_MEMBER_ID,
                        &root_session_id
                    ],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if invalid_materialized_identities != 0 {
                return Err(format!(
                    "{MATERIALIZATION_IDENTITY_MISMATCH_PREFIX} {invalid_materialized_identities} certified Session identity row(s) are invalid for {run_id}"
                ));
            }
            let incomplete_materializations: i64 = transaction
                .query_row(
                    "SELECT COUNT(*) FROM agent_org_member_materializations
                     WHERE org_run_id=?1 AND generation=?2 AND status<>'succeeded'",
                    params![run_id, expected_generation],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if incomplete_materializations != 0 {
                return Err(format!(
                    "team_not_materialized: {incomplete_materializations} receipt(s) incomplete for {run_id}"
                ));
            }
            let initial_input = load_initial_input_with_connection(&transaction, run_id)?;
            if has_initial_work {
                let input = initial_input.as_ref().ok_or_else(|| {
                    format!(
                        "{STARTING_INPUT_CERTIFICATE_ERROR_PREFIX} initial input certificate missing for Starting run {run_id}"
                    )
                })?;
                let message_exists: bool = transaction
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM agent_messages
                         WHERE id=?1 AND session_id=?2 AND role='user' AND content=?3)",
                        params![&input.message_id, &root_session_id, &input.content],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                let event_id = format!("user-message-{}", input.message_id);
                let event_exists: bool = transaction
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM events WHERE id=?1 AND session_id=?2)",
                        params![event_id, &root_session_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                if !message_exists || !event_exists {
                    return Err(format!(
                        "initial input is not durably materialized for Starting run {run_id}"
                    ));
                }
                crate::foundation::session_bridge::upsert_turn_intent_with_connection(
                    &transaction,
                    &root_session_id,
                    &input.turn_intent_id,
                    Some(&input.message_id),
                    Some(run_id),
                    crate::foundation::session_bridge::TurnIntentBridgeSource::AgentOrg,
                    crate::foundation::session_bridge::TurnIntentBridgeStatus::Queued,
                )?;
                transaction
                    .execute(
                        "UPDATE agent_org_initial_inputs
                         SET status='queued', updated_at=?2
                         WHERE org_run_id=?1 AND status='pending_persistence'",
                        params![run_id, chrono::Utc::now().to_rfc3339()],
                    )
                    .map_err(|error| error.to_string())?;
            } else if initial_input.is_some() {
                return Err(format!(
                    "{STARTING_INPUT_CERTIFICATE_ERROR_PREFIX} unexpected initial input certificate for no-work Starting run {run_id}"
                ));
            }

            let next = if has_initial_work {
                AgentOrgRunStatus::Running
            } else {
                AgentOrgRunStatus::Idle
            };
            let now = chrono::Utc::now().to_rfc3339();
            let changed = transaction
                .execute(
                    "UPDATE agent_org_runs
                     SET status=?1, updated_at=?2,
                         idled_at=CASE WHEN ?1='idle' THEN ?2 ELSE NULL END
                     WHERE id=?3 AND status='starting'
                       AND activation_generation=?4",
                    params![next.as_str(), &now, run_id, expected_generation],
                )
                .map_err(|error| error.to_string())?;
            if changed != 1 {
                return Err(format!("Starting transition lost for run {run_id}"));
            }
            transaction.commit().map_err(|error| error.to_string())?;
            Ok(next)
        })?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
        Ok(status)
    }

    pub fn mark_initial_input_dispatched(
        run_id: &str,
        turn_intent_id: &str,
    ) -> Result<bool, String> {
        with_sessions_writer(|| {
            let connection = get_connection().map_err(|error| error.to_string())?;
            let changed = connection
                .execute(
                    "UPDATE agent_org_initial_inputs
                     SET status='dispatched', updated_at=?3
                     WHERE org_run_id=?1 AND turn_intent_id=?2
                       AND status IN ('queued', 'dispatched')",
                    params![run_id, turn_intent_id, chrono::Utc::now().to_rfc3339()],
                )
                .map_err(|error| error.to_string())?;
            Ok(changed == 1)
        })
    }

    pub fn list_starting_runs(limit: usize) -> Result<Vec<AgentOrgRunRecord>, String> {
        Self::list_runs_by_status(AgentOrgRunStatus::Starting, limit)
    }

    /// Pause a running run. Only transitions `running → paused`; already
    /// non-running runs are left unchanged and return `Ok(false)` (idempotent).
    pub fn mark_paused(run_id: &str) -> Result<bool, String> {
        let paused = validate_status(AgentOrgRunStatus::Paused.as_str())?;
        let running = validate_status(AgentOrgRunStatus::Running.as_str())?;
        let now = chrono::Utc::now().to_rfc3339();
        let changed = with_sessions_writer(|| -> Result<bool, String> {
            let conn = get_connection().map_err(|err| err.to_string())?;
            let rows_changed = conn
                .execute(
                    "UPDATE agent_org_runs
                     SET status = ?1,
                         updated_at = ?2
                     WHERE id = ?3
                       AND status = ?4",
                    params![paused.as_str(), now, run_id, running.as_str()],
                )
                .map_err(|err| err.to_string())?;
            Ok(rows_changed > 0)
        })?;
        if changed {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
        }
        Ok(changed)
    }

    /// Apply the normal failed-member task disposition after crash recovery
    /// has converted stranded Running sessions to Abandoned. Tasks with an
    /// eligible peer return to the pool; sole-member work stays owned and
    /// pending for an explicit retry. The Team remains Running and is then
    /// reconciled from its Quiescence facts.
    pub fn requeue_abandoned_member_tasks_on_startup() -> Result<usize, String> {
        let mut changed = 0usize;
        for run in Self::list_running_runs(100)? {
            for worker in Self::list_descendant_worker_sessions(&run.id)? {
                if worker.status != SessionStatus::Abandoned {
                    continue;
                }
                let Some(member_id) = worker.member_id.as_deref() else {
                    continue;
                };
                changed +=
                    AgentOrgTaskStore::requeue_in_progress_for_owner(&run.id, member_id)?.len();
            }
        }
        Ok(changed)
    }

    /// Resume a paused run. Only transitions `paused → running`; already
    /// non-paused runs are left unchanged and return `Ok(false)` (idempotent).
    pub fn mark_resumed(run_id: &str) -> Result<bool, String> {
        let running = validate_status(AgentOrgRunStatus::Running.as_str())?;
        let paused = validate_status(AgentOrgRunStatus::Paused.as_str())?;
        let now = chrono::Utc::now().to_rfc3339();
        let changed = with_sessions_writer(|| -> Result<bool, String> {
            let conn = get_connection().map_err(|err| err.to_string())?;
            let rows_changed = conn
                .execute(
                    "UPDATE agent_org_runs
                     SET status = ?1,
                         updated_at = ?2
                     WHERE id = ?3
                       AND status = ?4",
                    params![running.as_str(), now, run_id, paused.as_str()],
                )
                .map_err(|err| err.to_string())?;
            Ok(rows_changed > 0)
        })?;
        if changed {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
        }
        Ok(changed)
    }

    pub fn fail_starting(
        run_id: &str,
        expected_generation: i64,
        failure: &AgentOrgStartingFailure,
    ) -> Result<bool, String> {
        let failure_json = serde_json::to_string(failure)
            .map_err(|error| format!("failed to serialize Starting failure: {error}"))?;
        let now = chrono::Utc::now().to_rfc3339();
        let changed = with_sessions_writer(|| -> Result<bool, String> {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            let changed = tx
                .execute(
                    "UPDATE agent_org_runs
                 SET status = 'failed',
                     last_error = ?2,
                     failure_json = ?3,
                     last_activity_outcome = 'failed',
                     updated_at = ?4
                 WHERE id = ?1 AND status='starting'
                   AND activation_generation=?5",
                    params![
                        run_id,
                        &failure.message,
                        &failure_json,
                        &now,
                        expected_generation
                    ],
                )
                .map_err(|err| err.to_string())?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok(changed == 1)
        })?;
        if changed {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
        }
        Ok(changed)
    }

    pub fn progress(run_id: &str) -> Result<Option<AgentOrgRunProgress>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        load_progress_with_conn(&conn, run_id)
    }

    /// Record which durable work revision is embedded in the coordinator's
    /// next prompt. A later successful coordinator turn promotes this staged
    /// revision to `observed`; newer concurrent task mutations remain newer.
    pub fn stage_coordinator_work_revision(run_id: &str) -> Result<Option<i64>, String> {
        let revision = with_sessions_writer(|| {
            let conn = get_connection().map_err(|err| err.to_string())?;
            stage_coordinator_presented_with_conn(&conn, run_id)
        })?;
        if revision.is_some() {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
        }
        Ok(revision)
    }

    /// Stage the coordinator's presented work revision and read the task
    /// board from the same SQLite snapshot. Prompt construction uses this so
    /// the revision certificate can never describe a newer board than the
    /// task snapshot actually rendered to the provider.
    pub fn stage_coordinator_work_revision_and_load_tasks(
        run_id: &str,
    ) -> Result<(Option<i64>, Vec<Task>), String> {
        let (revision, tasks) =
            with_sessions_writer(|| -> Result<(Option<i64>, Vec<Task>), String> {
                let mut conn = get_connection().map_err(|err| err.to_string())?;
                let tx = conn
                    .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                    .map_err(|err| err.to_string())?;
                let revision = stage_coordinator_presented_with_conn(&tx, run_id)?;
                let tasks = AgentOrgTaskStore::list_operational_with_connection(&tx, run_id)?;
                tx.commit().map_err(|err| err.to_string())?;
                Ok((revision, tasks))
            })?;
        if revision.is_some() {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
        }
        Ok((revision, tasks))
    }

    pub fn mark_coordinator_observed_work_revision(
        run_id: &str,
        presented_work_revision: i64,
    ) -> Result<Option<i64>, String> {
        let observed_revision = with_sessions_writer(|| {
            let conn = get_connection().map_err(|err| err.to_string())?;
            mark_coordinator_observed_revision_with_conn(&conn, run_id, presented_work_revision)
        })?;
        if observed_revision.is_some() {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
        }
        Ok(observed_revision)
    }

    /// Persist a coordinator-only completion request without forcing the run
    /// terminal. Quiescence still waits for delivery, approvals, interventions,
    /// sessions, and work-observation invariants to become safe.
    pub fn request_completion(
        run_id: &str,
        summary: &str,
    ) -> Result<AgentOrgCompletionRequestOutcome, String> {
        let outcome = with_sessions_writer(|| {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            let status: Option<String> = tx
                .query_row(
                    "SELECT status FROM agent_org_runs WHERE id=?1",
                    params![run_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|err| err.to_string())?;
            let Some(status) = status else {
                return Err(format!("agent_org_run_not_found: {run_id}"));
            };
            if status != AgentOrgRunStatus::Running.as_str() {
                return Err(format!(
                    "agent_org_run_not_mutable: run {run_id} is {status}"
                ));
            }

            let unresolved_task_ids = {
                let mut stmt = tx
                    .prepare(
                        "SELECT id FROM agent_org_tasks
                         WHERE org_run_id=?1 AND status<>?2
                         ORDER BY created_at ASC, id ASC",
                    )
                    .map_err(|err| err.to_string())?;
                let rows = stmt
                    .query_map(params![run_id, TaskStatus::Completed.as_wire()], |row| {
                        row.get::<_, String>(0)
                    })
                    .map_err(|err| err.to_string())?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|err| err.to_string())?
            };
            if !unresolved_task_ids.is_empty() {
                tx.commit().map_err(|err| err.to_string())?;
                return Ok(AgentOrgCompletionRequestOutcome::OpenTasks {
                    unresolved_task_ids,
                });
            }
            let progress = record_completion_request_in_tx(&tx, run_id, summary)?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok(AgentOrgCompletionRequestOutcome::Recorded { progress })
        })?;
        if matches!(&outcome, AgentOrgCompletionRequestOutcome::Recorded { .. }) {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
        }
        Ok(outcome)
    }

    pub fn assess_run_quiescence(run_id: &str) -> Result<AgentOrgQuiescenceAssessment, String> {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Deferred)
            .map_err(|err| err.to_string())?;
        let assessment = load_and_assess(&tx, run_id)?;
        tx.commit().map_err(|err| err.to_string())?;
        Ok(assessment)
    }

    /// Assess quiescence and, when the certificate allows, present its exact
    /// generation and work-revision facts to the atomic Working→Idle CAS.
    /// Shared by every post-turn / lifecycle / watchdog reconcile site so
    /// they cannot drift on the certificate protocol.
    pub fn try_reconcile_to_idle(run_id: &str) -> Result<bool, String> {
        let assessment = Self::assess_run_quiescence(run_id)?;
        let Some(generation) = assessment.facts.activation_generation else {
            return Ok(false);
        };
        let Some(work_revision) = assessment
            .facts
            .progress
            .as_ref()
            .map(|progress| progress.work_revision)
        else {
            return Ok(false);
        };
        Self::try_transition_working_to_idle(run_id, generation, work_revision)
    }

    /// Atomically commit the only automatic lifecycle transition owned by
    /// PR 1. Both snapshot certificates are required so a stale finalizer or
    /// watchdog pass cannot idle a newer activation or newer work graph.
    pub fn try_transition_working_to_idle(
        run_id: &str,
        expected_generation: i64,
        expected_work_revision: i64,
    ) -> Result<bool, String> {
        let changed = with_sessions_writer(|| -> Result<bool, String> {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            let assessment = load_and_assess(&tx, run_id)?;
            if assessment.facts.run_status != Some(AgentOrgRunStatus::Running)
                || assessment.facts.activation_generation != Some(expected_generation)
                || assessment
                    .facts
                    .progress
                    .as_ref()
                    .map(|progress| progress.work_revision)
                    != Some(expected_work_revision)
                || assessment.decision != super::AgentOrgQuiescenceDecision::Quiescent
            {
                tx.commit().map_err(|err| err.to_string())?;
                return Ok(false);
            }
            let now = chrono::Utc::now().to_rfc3339();
            let completion_summary = assessment
                .facts
                .progress
                .as_ref()
                .and_then(|progress| progress.completion_summary.as_deref());
            let changed = tx
                .execute(
                    "UPDATE agent_org_runs
                         SET status='idle',
                             summary=COALESCE(?1, summary),
                             last_activity_outcome='completed',
                             updated_at=?2,
                             idled_at=?2
                         WHERE id=?3 AND status='running'
                           AND activation_generation=?4
                           AND EXISTS (
                               SELECT 1 FROM agent_org_run_progress progress
                               WHERE progress.org_run_id=agent_org_runs.id
                                 AND progress.work_revision=?5
                           )",
                    params![
                        completion_summary,
                        &now,
                        run_id,
                        expected_generation,
                        expected_work_revision,
                    ],
                )
                .map_err(|err| err.to_string())?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok(changed == 1)
        })?;
        if changed {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
        }
        Ok(changed)
    }

    /// Resolve the org-run context for an arbitrary session — works for
    /// both the root (coordinator) session and materialized member sessions
    /// linked to the same Agent Org run.
    ///
    /// Strategy: try the direct `root_session_id` lookup first; if that
    /// misses, walk the persisted `agent_sessions.parent_session_id`
    /// chain upward (using the existing `idx_agent_sessions_parent`
    /// index) and retry the lookup at each ancestor. The first ancestor
    /// that anchors an `agent_org_runs` row wins.
    ///
    /// The persisted parent chain serves as the reverse-resolution
    /// path. `root_session_id` remains the **single anchor** for an org
    /// run — no per-subagent rows are added (avoids a second source of
    /// truth and the corresponding unify-then-reshuffle reshape).
    ///
    /// Bounded to `MAX_PARENT_WALK_DEPTH` hops so a corrupt or cyclic
    /// parent chain can't cause an unbounded scan during session init.
    pub fn context_for_run(run_id: &str) -> Result<Option<AgentOrgRunContext>, String> {
        let Some(run) = load_by_id(run_id).map_err(|err| err.to_string())? else {
            return Ok(None);
        };
        Ok(Some(context_for_run_record(&run)?))
    }

    pub fn context_for_session_with_parent_walk(
        session_id: &str,
    ) -> Result<Option<AgentOrgRunContext>, String> {
        let Some(run) = Self::run_for_session_with_parent_walk(session_id)? else {
            return Ok(None);
        };
        Ok(Some(context_for_run_record(&run)?))
    }

    pub fn root_session_id_for_session_with_parent_walk(
        session_id: &str,
    ) -> Result<Option<String>, String> {
        Ok(Self::run_for_session_with_parent_walk(session_id)?.and_then(|run| run.root_session_id))
    }

    pub fn run_id_for_session_with_parent_walk(session_id: &str) -> Result<Option<String>, String> {
        Ok(Self::run_for_session_with_parent_walk(session_id)?.map(|run| run.id))
    }

    pub fn is_root_session(org_run_id: &str, session_id: &str) -> Result<bool, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let root_session_id: Option<String> = conn
            .query_row(
                "SELECT root_session_id FROM agent_org_runs WHERE id = ?1",
                params![org_run_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?
            .flatten();
        Ok(root_session_id.as_deref() == Some(session_id))
    }

    fn run_for_session_with_parent_walk(
        session_id: &str,
    ) -> Result<Option<AgentOrgRunRecord>, String> {
        const MAX_PARENT_WALK_DEPTH: usize = 16;

        let mut current_id = session_id.to_string();
        let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
        for hop in 0..=MAX_PARENT_WALK_DEPTH {
            if !visited.insert(current_id.clone()) {
                tracing::warn!(
                    session_id = %session_id,
                    cycle_at = %current_id,
                    "[agent_org_runs] parent_session_id chain has a cycle; aborting walk"
                );
                return Ok(None);
            }
            if let Some(run) = load_by_root_session(&current_id).map_err(|err| err.to_string())? {
                return Ok(Some(run));
            }
            if hop == MAX_PARENT_WALK_DEPTH {
                tracing::warn!(
                    session_id = %session_id,
                    last_visited = %current_id,
                    "[agent_org_runs] parent_session_id walk exceeded max depth ({}); giving up",
                    MAX_PARENT_WALK_DEPTH
                );
                return Ok(None);
            }
            match parent_session_id_of(&current_id).map_err(|err| err.to_string())? {
                Some(parent) => current_id = parent,
                None => return Ok(None),
            }
        }
        Ok(None)
    }

    /// List every persisted run that has anchored a coordinator session,
    /// across all orgs, ordered by `updated_at DESC`. Used by the Inbox
    /// page to render its flat list of chats — each row is one run.
    ///
    /// Runs whose `root_session_id` is still `NULL` (created but the
    /// coordinator session row has not landed yet) are excluded; the
    /// Inbox renders those as transient client-side draft rows until the
    /// anchor exists.
    pub fn list_runs(limit: usize) -> Result<Vec<AgentOrgRunRecord>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id,
                        org_id,
                        coordinator_agent_id,
                        root_session_id,
                        org_snapshot_json,
                        entry_mode,
                        status,
                        activation_generation,
                        has_initial_work,
                        work_item_id,
                        project_slug,
                        routine_fire_id,
                        summary,
                        last_error,
                        failure_json,
                        last_activity_outcome,
                        created_at,
                        updated_at,
                        idled_at
                 FROM agent_org_runs
                 WHERE root_session_id IS NOT NULL
                 ORDER BY updated_at DESC
                 LIMIT ?1",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![limit as i64], row_to_run)
            .map_err(|err| err.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|err| err.to_string())?);
        }
        Ok(out)
    }

    /// List runs currently in `running` status, oldest-updated first. Periodic
    /// callers must pass their explicit bounded batch size.
    pub fn list_running_runs(limit: usize) -> Result<Vec<AgentOrgRunRecord>, String> {
        Self::list_runs_by_status(AgentOrgRunStatus::Running, limit)
    }

    fn list_runs_by_status(
        status: AgentOrgRunStatus,
        limit: usize,
    ) -> Result<Vec<AgentOrgRunRecord>, String> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let bounded_limit = i64::try_from(limit)
            .map_err(|_| format!("Agent Org run list limit is too large: {limit}"))?;
        let conn = get_connection().map_err(|err| err.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id,
                        org_id,
                        coordinator_agent_id,
                        root_session_id,
                        org_snapshot_json,
                        entry_mode,
                        status,
                        activation_generation,
                        has_initial_work,
                        work_item_id,
                        project_slug,
                        routine_fire_id,
                        summary,
                        last_error,
                        failure_json,
                        last_activity_outcome,
                        created_at,
                        updated_at,
                        idled_at
                 FROM agent_org_runs
                 WHERE root_session_id IS NOT NULL
                   AND status = ?1
                 ORDER BY updated_at ASC, id ASC
                 LIMIT ?2",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![status.as_str(), bounded_limit], row_to_run)
            .map_err(|err| err.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|err| err.to_string())?);
        }
        Ok(out)
    }

    /// Return the current status of the run without fetching the full record.
    pub fn get_run_status(run_id: &str) -> Result<Option<AgentOrgRunStatus>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        Self::get_run_status_with_connection(&conn, run_id)
    }

    pub(crate) fn get_run_status_with_connection(
        conn: &Connection,
        run_id: &str,
    ) -> Result<Option<AgentOrgRunStatus>, String> {
        let status_raw: Option<String> = conn
            .query_row(
                "SELECT status FROM agent_org_runs WHERE id = ?1 LIMIT 1",
                params![run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| err.to_string())?;
        Ok(status_raw.as_deref().and_then(AgentOrgRunStatus::parse))
    }

    /// Read the canonical quiescence facts and decision from an existing
    /// connection or read transaction. Run View and task-list projections use
    /// this to keep all of their independently-shaped rows on one SQLite
    /// snapshot instead of opening a fresh connection for each block.
    pub(crate) fn quiescence_assessment_with_connection(
        conn: &Connection,
        run_id: &str,
    ) -> Result<AgentOrgQuiescenceAssessment, String> {
        load_and_assess(conn, run_id)
    }

    pub fn delete_by_id(run_id: &str) -> Result<(), String> {
        let outcome = with_sessions_writer(|| -> Result<AgentOrgRunDeleteOutcome, String> {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            let outcome = Self::delete_by_id_with_connection(&tx, run_id)?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok(outcome)
        })?;

        Self::finish_delete(run_id, outcome);
        Ok(())
    }

    pub(crate) fn delete_by_id_with_connection(
        conn: &Connection,
        run_id: &str,
    ) -> Result<AgentOrgRunDeleteOutcome, String> {
        let plan_artifacts = {
            let mut stmt = conn
                .prepare(
                    "SELECT DISTINCT approval.source_session_id, approval.plan_path
                     FROM agent_org_plan_approvals approval
                     WHERE approval.org_run_id=?1
                       AND NOT EXISTS (
                         SELECT 1 FROM agent_org_plan_approvals other
                         WHERE other.plan_path=approval.plan_path
                           AND other.org_run_id<>?1
                       )",
                )
                .map_err(|err| err.to_string())?;
            let rows = stmt
                .query_map(params![run_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|err| err.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?
        };

        // Intent ownership is explicit. The hierarchy delete caller rejects
        // nested run roots before reaching this helper; standalone run cleanup
        // still deletes only rows owned by the requested run.
        conn.execute(
            "DELETE FROM session_turn_intents WHERE org_run_id=?1",
            params![run_id],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "DELETE FROM agent_inbox_materializations
             WHERE inbox_id IN (
                 SELECT id FROM agent_inbox WHERE org_run_id=?1
             )",
            params![run_id],
        )
        .map_err(|err| {
            format!("failed to delete agent_inbox_materializations rows for {run_id}: {err}")
        })?;
        for table in [
            "agent_org_plan_approvals",
            "agent_org_recovery_attempts",
            "agent_org_task_events",
            "agent_org_tasks",
            "agent_inbox_delivery_resolutions",
            "agent_inbox",
            "agent_member_interventions",
            "agent_org_run_progress",
            "agent_org_task_run_schema_migrations",
        ] {
            conn.execute(
                &format!("DELETE FROM {table} WHERE org_run_id=?1"),
                params![run_id],
            )
            .map_err(|err| format!("failed to delete {table} rows for {run_id}: {err}"))?;
        }
        let deleted = conn
            .execute("DELETE FROM agent_org_runs WHERE id=?1", params![run_id])
            .map_err(|err| err.to_string())?
            > 0;
        Ok(AgentOrgRunDeleteOutcome {
            plan_artifacts,
            deleted,
        })
    }

    pub(crate) fn finish_delete(run_id: &str, outcome: AgentOrgRunDeleteOutcome) {
        // SQLite is the source of truth. Files are derived artifacts, so they
        // are cleaned only after the transaction commits and failures are
        // logged without resurrecting already-deleted durable state.
        for (source_session_id, plan_path) in outcome.plan_artifacts {
            if let Err(err) = AgentOrgPlanApprovalStore::remove_managed_plan_artifact(
                &source_session_id,
                &plan_path,
            ) {
                tracing::warn!(
                    run_id,
                    source_session_id,
                    plan_path,
                    error = %err,
                    "failed to remove managed Agent Org plan artifact after run deletion"
                );
            }
        }
        if outcome.deleted {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
        }
    }

    /// Find the freshest materialized worker session for a canonical roster
    /// `member_id` inside `org_run_id`.
    pub fn find_worker_session_by_member_id(
        org_run_id: &str,
        member_id: &str,
    ) -> Result<Option<WorkerSessionInfo>, String> {
        let mut sessions =
            Self::list_worker_sessions_by_member_ids(org_run_id, &[member_id.to_string()])?;
        Ok(sessions.pop().map(|session| WorkerSessionInfo {
            session_id: session.session_id,
            status: session.status,
            updated_at: session.updated_at,
        }))
    }

    pub fn find_coordinator_session_by_member_id(
        org_run_id: &str,
        member_id: &str,
    ) -> Result<Option<WorkerSessionInfo>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        Self::find_coordinator_session_by_member_id_with_connection(&conn, org_run_id, member_id)
    }

    pub(crate) fn find_coordinator_session_by_member_id_with_connection(
        conn: &Connection,
        org_run_id: &str,
        member_id: &str,
    ) -> Result<Option<WorkerSessionInfo>, String> {
        if member_id != COORDINATOR_MEMBER_ID {
            return Ok(None);
        }
        let row: Option<(String, String, String)> = conn
            .query_row(
                "SELECT s.session_id,
                        s.status,
                        s.updated_at
                 FROM agent_org_runs r
                 JOIN agent_sessions s ON s.session_id = r.root_session_id
                 WHERE r.id = ?1
                 LIMIT 1",
                params![org_run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|err| err.to_string())?;

        let Some((session_id, status_raw, updated_at)) = row else {
            return Ok(None);
        };
        let status = crate::core::session::SessionStatus::parse(&status_raw).ok_or_else(|| {
            format!("unknown coordinator session status for {session_id}: {status_raw:?}")
        })?;
        Ok(Some(WorkerSessionInfo {
            session_id,
            status,
            updated_at,
        }))
    }

    /// Return the freshest descendant session for each requested roster
    /// `member_id`. UI read models use this instead of `agent_definition_id`
    /// because multiple roster members may run the same AgentDefinition.
    pub fn list_worker_sessions_by_member_ids(
        org_run_id: &str,
        member_ids: &[String],
    ) -> Result<Vec<WorkerSessionRuntime>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        Self::list_worker_sessions_by_member_ids_with_connection(&conn, org_run_id, member_ids)
    }

    pub(crate) fn list_worker_sessions_by_member_ids_with_connection(
        conn: &Connection,
        org_run_id: &str,
        member_ids: &[String],
    ) -> Result<Vec<WorkerSessionRuntime>, String> {
        let requested: HashSet<&str> = member_ids
            .iter()
            .map(String::as_str)
            .filter(|member_id| !member_id.is_empty())
            .collect();
        if requested.is_empty() {
            return Ok(Vec::new());
        }

        let sessions = Self::list_descendant_worker_sessions_with_connection(conn, org_run_id)?;
        let mut seen = HashSet::new();
        Ok(sessions
            .into_iter()
            .filter(|session| {
                session
                    .member_id
                    .as_deref()
                    .is_some_and(|member_id| requested.contains(member_id))
            })
            .filter(|session| seen.insert(session.member_id.clone()))
            .collect())
    }

    /// Canonical member ids captured in the immutable launch snapshot.
    ///
    /// Recovery must not consult the user's current Agent Org definition: a
    /// team can be edited while an older run is still alive. `None` is kept
    /// for historical rows that predate launch snapshots; callers may still
    /// classify a materialized session, but must not invent roster membership.
    pub(crate) fn snapshot_member_ids_with_connection(
        conn: &Connection,
        org_run_id: &str,
    ) -> Result<Option<HashSet<String>>, String> {
        let snapshot_json: Option<String> = conn
            .query_row(
                "SELECT org_snapshot_json FROM agent_org_runs WHERE id=?1",
                params![org_run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| err.to_string())?
            .flatten();
        let Some(snapshot_json) = snapshot_json else {
            return Ok(None);
        };
        let snapshot: crate::definitions::orgs::AgentOrgLaunchSnapshot =
            serde_json::from_str(&snapshot_json).map_err(|err| {
                format!("failed to parse Agent Org launch snapshot for run {org_run_id}: {err}")
            })?;
        crate::definitions::orgs::validate_launch_snapshot(&snapshot).map_err(|err| {
            format!("invalid Agent Org launch snapshot for run {org_run_id}: {err}")
        })?;
        Ok(Some(
            flatten_members(&snapshot.members)
                .into_iter()
                .map(|member| member.member_id)
                .collect(),
        ))
    }

    pub fn list_descendant_worker_sessions(
        org_run_id: &str,
    ) -> Result<Vec<WorkerSessionRuntime>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        Self::list_descendant_worker_sessions_with_connection(&conn, org_run_id)
    }

    pub(crate) fn list_descendant_worker_sessions_with_connection(
        conn: &Connection,
        org_run_id: &str,
    ) -> Result<Vec<WorkerSessionRuntime>, String> {
        let root_session_id: Option<String> = conn
            .query_row(
                "SELECT root_session_id FROM agent_org_runs WHERE id = ?1",
                params![org_run_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?
            .flatten();
        let Some(root) = root_session_id else {
            return Ok(Vec::new());
        };
        let interventions =
            AgentMemberInterventionStore::list_active_with_connection(conn, org_run_id)?
                .into_iter()
                .map(|record| (record.member_id.clone(), record))
                .collect::<HashMap<_, _>>();

        let mut stmt = conn
            .prepare(
                "WITH RECURSIVE descendants(session_id) AS (
                     SELECT session_id
                     FROM agent_sessions child
                     WHERE child.parent_session_id = ?1
                       AND NOT EXISTS (
                           SELECT 1 FROM agent_org_runs nested
                           WHERE nested.id <> ?2
                             AND nested.root_session_id = child.session_id
                       )
                     UNION
                     SELECT s.session_id
                     FROM agent_sessions s
                     JOIN descendants d ON s.parent_session_id = d.session_id
                     WHERE NOT EXISTS (
                         SELECT 1 FROM agent_org_runs nested
                         WHERE nested.id <> ?2
                           AND nested.root_session_id = s.session_id
                     )
                 ), ranked AS (
                     SELECT s.agent_definition_id,
                            s.org_member_id,
                            s.session_id,
                            s.status,
                            s.updated_at,
                            ROW_NUMBER() OVER (
                                PARTITION BY CASE
                                    WHEN s.org_member_id IS NOT NULL
                                        THEN 'member:' || s.org_member_id
                                    ELSE 'session:' || s.session_id
                                END
                                ORDER BY s.updated_at DESC, s.session_id DESC
                            ) AS rank
                     FROM agent_sessions s
                     JOIN descendants d USING (session_id)
                     WHERE s.agent_definition_id IS NOT NULL
                 )
                 SELECT agent_definition_id, org_member_id, session_id, status, updated_at
                 FROM ranked
                 WHERE rank = 1
                 ORDER BY updated_at DESC, session_id DESC",
            )
            .map_err(|err| err.to_string())?;

        let rows = stmt
            .query_map(params![root.clone(), org_run_id], |row| {
                let status_raw: String = row.get(3)?;
                let status =
                    crate::core::session::SessionStatus::parse(&status_raw).ok_or_else(|| {
                        rusqlite::Error::FromSqlConversionFailure(
                            3,
                            rusqlite::types::Type::Text,
                            format!("unknown SessionStatus value: {status_raw:?}").into(),
                        )
                    })?;
                let agent_definition_id: String = row.get(0)?;
                let org_member_id: Option<String> = row.get(1)?;
                let intervention = org_member_id
                    .as_deref()
                    .and_then(|member_id| interventions.get(member_id).cloned());
                Ok(WorkerSessionRuntime {
                    intervention,
                    agent_definition_id: Some(agent_definition_id),
                    cli_agent_type: None,
                    member_id: org_member_id,
                    session_id: row.get(2)?,
                    parent_session_id: Some(root.clone()),
                    status,
                    updated_at: row.get(4)?,
                })
            })
            .map_err(|err| err.to_string())?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|err| err.to_string())?);
        }

        let mut cli_stmt = conn
            .prepare(
                "SELECT cli_agent_type, org_member_id, session_id, status, updated_at
                 FROM code_sessions
                 WHERE parent_session_id = ?1
                   AND org_member_id IS NOT NULL
                   AND cli_agent_type IS NOT NULL
                 ORDER BY updated_at DESC, session_id DESC",
            )
            .map_err(|err| err.to_string())?;
        let cli_rows = cli_stmt
            .query_map(params![root.clone()], |row| {
                let status_raw: String = row.get(3)?;
                let status =
                    crate::core::session::SessionStatus::parse(&status_raw).ok_or_else(|| {
                        rusqlite::Error::FromSqlConversionFailure(
                            3,
                            rusqlite::types::Type::Text,
                            format!("unknown CLI SessionStatus value: {status_raw:?}").into(),
                        )
                    })?;
                let cli_agent_type: String = row.get(0)?;
                let org_member_id: Option<String> = row.get(1)?;
                let intervention = org_member_id
                    .as_deref()
                    .and_then(|member_id| interventions.get(member_id).cloned());
                Ok(WorkerSessionRuntime {
                    intervention,
                    agent_definition_id: None,
                    cli_agent_type: Some(cli_agent_type),
                    member_id: org_member_id,
                    session_id: row.get(2)?,
                    parent_session_id: Some(root.clone()),
                    status,
                    updated_at: row.get(4)?,
                })
            })
            .map_err(|err| err.to_string())?;
        for row in cli_rows {
            out.push(row.map_err(|err| err.to_string())?);
        }

        out.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                // Historical databases can contain both a Rust and a CLI
                // session for one member at the same timestamp. Rust is the
                // only supported Agent Org transport, so it wins an exact tie.
                .then_with(|| {
                    left.cli_agent_type
                        .is_some()
                        .cmp(&right.cli_agent_type.is_some())
                })
                .then_with(|| right.session_id.cmp(&left.session_id))
        });

        // Rust and CLI sessions live in different tables, so neither table's
        // window function can suppress an older duplicate from the other
        // transport.  Apply the canonical-member rule once more after the
        // combined freshness sort.  Historical rows without a member id are
        // distinct sessions; do not guess that they belong to one member.
        let mut seen_canonical_workers = HashSet::new();
        out.retain(|session| {
            let key = session
                .member_id
                .as_ref()
                .map(|member_id| format!("member:{member_id}"))
                .unwrap_or_else(|| format!("session:{}", session.session_id));
            seen_canonical_workers.insert(key)
        });
        Ok(out)
    }
}
