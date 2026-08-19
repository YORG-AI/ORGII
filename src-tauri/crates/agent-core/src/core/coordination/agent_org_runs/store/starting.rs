use std::collections::HashSet;

use rusqlite::{params, OptionalExtension};

use database::db::{get_connection, with_sessions_writer};

use super::super::helpers::{flatten_members, insert_run, load_by_id, validate_entry_mode};
use super::super::materialization::{
    insert_initial_input, insert_materialization_intent, list_materializations_with_connection,
    list_recoverable_initial_inputs_with_connection, load_initial_input_by_turn_with_connection,
    load_initial_input_with_connection,
};
use super::super::progress::ensure_progress_in_conn;
use super::super::{
    AgentOrgInitialInput, AgentOrgMaterializationIntent, AgentOrgRunRecord, AgentOrgRunStatus,
    AgentOrgStartingFailure, CreateStartingAgentOrgRunParams, COORDINATOR_MEMBER_ID,
};
use super::AgentOrgRunStore;

impl AgentOrgRunStore {
    /// Create the authoritative Team construction envelope and every stable
    /// identity/input intent in one IMMEDIATE transaction.
    pub fn create_starting(
        params: CreateStartingAgentOrgRunParams,
    ) -> Result<AgentOrgRunRecord, String> {
        let entry_mode = validate_entry_mode(params.entry_mode.as_str())?;
        let org_snapshot_json = super::serialize_launch_snapshot(&params.org_snapshot)?;
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
                     FROM agent_org_runtime_member_materializations materialization
                     JOIN agent_org_runtime_runs run ON run.id=materialization.org_run_id
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
                    "materialization session mismatch for {run_id}/{member_id}: expected {expected_session_id}, got {session_id}"
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
                    "materialized Session {session_id} is missing for {run_id}/{member_id}"
                ));
            };
            let expected_parent = (member_id != COORDINATOR_MEMBER_ID).then_some(root_session_id);
            if persisted_agent_id.as_deref() != Some(agent_id.as_str())
                || persisted_member_id.as_deref() != Some(member_id)
                || parent_session_id != expected_parent
            {
                return Err(format!(
                    "materialized Session identity mismatch for {run_id}/{member_id}"
                ));
            }
            let changed = transaction
                .execute(
                    "UPDATE agent_org_runtime_member_materializations
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
                     FROM agent_org_runtime_runs WHERE id=?1",
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
                     FROM agent_org_runtime_member_materializations materialization
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
                    "materialization_identity_mismatch: {invalid_materialized_identities} certified Session identity row(s) are invalid for {run_id}"
                ));
            }
            let incomplete_materializations: i64 = transaction
                .query_row(
                    "SELECT COUNT(*) FROM agent_org_runtime_member_materializations
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
                    format!("initial input certificate missing for Starting run {run_id}")
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
                let admission = crate::coordination::agent_org_turn_contexts::AgentOrgTurnAdmission::starting_coordinator(
                    run_id,
                    &root_session_id,
                    &input.turn_intent_id,
                    Some(input.message_id.clone()),
                    expected_generation,
                );
                crate::coordination::agent_org_turn_contexts::accept_with_connection(
                    &transaction,
                    &admission,
                )?;
                transaction
                    .execute(
                        "UPDATE agent_org_runtime_initial_inputs
                         SET status='queued', updated_at=?2
                         WHERE org_run_id=?1 AND status='pending_persistence'",
                        params![run_id, chrono::Utc::now().to_rfc3339()],
                    )
                    .map_err(|error| error.to_string())?;
            } else if initial_input.is_some() {
                return Err(format!(
                    "unexpected initial input certificate for no-work Starting run {run_id}"
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
                    "UPDATE agent_org_runtime_runs
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
                    "UPDATE agent_org_runtime_initial_inputs
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
                    "UPDATE agent_org_runtime_runs
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
}
