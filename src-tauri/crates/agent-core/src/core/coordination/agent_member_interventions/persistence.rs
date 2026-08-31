use rusqlite::{Connection, OptionalExtension, Result as SqliteResult};

use super::{AgentMemberInterventionRecord, AppliedReturnToWorkOutcome, MemberInterventionStatus};

pub(crate) fn create_schema(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_runtime_member_interventions (
            intervention_receipt_id TEXT PRIMARY KEY,
            org_run_id TEXT NOT NULL,
            member_id TEXT NOT NULL CHECK(length(trim(member_id)) > 0),
            agent_id TEXT NOT NULL CHECK(length(trim(agent_id)) > 0),
            session_id TEXT NOT NULL CHECK(length(trim(session_id)) > 0),
            status TEXT NOT NULL CHECK(status IN (
                'yield_requested','active','return_requested','cleared','failed'
            )),
            source_event_id TEXT NOT NULL CHECK(length(trim(source_event_id)) > 0),
            original_task_id TEXT,
            original_turn_intent_id TEXT,
            original_member_dispatch_sequence INTEGER,
            runtime_lease_id TEXT,
            dialog_turn_generation TEXT,
            entered_at TEXT NOT NULL,
            last_user_activity_at TEXT NOT NULL,
            yield_requested_at TEXT,
            yield_released_at TEXT,
            yield_timed_out_at TEXT,
            return_request_id TEXT,
            return_outcome TEXT CHECK(return_outcome IS NULL OR return_outcome IN (
                'restored_task','cleared_paused','cleared_idle','no_longer_needed'
            )),
            continuation_turn_intent_id TEXT,
            cleared_revision INTEGER,
            cleared_at TEXT,
            failure_reason TEXT,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(org_run_id) REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE,
            CHECK((runtime_lease_id IS NULL) = (dialog_turn_generation IS NULL)),
            CHECK((original_task_id IS NULL) = (original_turn_intent_id IS NULL)),
            CHECK((cleared_at IS NULL) = (status NOT IN ('cleared','failed')))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_org_member_intervention_active
            ON agent_org_runtime_member_interventions(org_run_id, member_id)
            WHERE status IN ('yield_requested','active','return_requested');
        CREATE INDEX IF NOT EXISTS idx_agent_org_member_intervention_session
            ON agent_org_runtime_member_interventions(session_id, status, updated_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_org_member_intervention_return_request
            ON agent_org_runtime_member_interventions(org_run_id, return_request_id)
            WHERE return_request_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_org_member_intervention_continuation
            ON agent_org_runtime_member_interventions(session_id, continuation_turn_intent_id)
            WHERE continuation_turn_intent_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_org_member_intervention_public_timeline
            ON agent_org_runtime_member_interventions(
                org_run_id,cleared_at,intervention_receipt_id
            ) WHERE status='cleared';
        CREATE TABLE IF NOT EXISTS agent_org_runtime_member_intervention_turns (
            intervention_receipt_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            turn_intent_id TEXT NOT NULL,
            source_event_id TEXT NOT NULL,
            dispatch_content TEXT NOT NULL CHECK(length(trim(dispatch_content)) > 0),
            display_content TEXT NOT NULL CHECK(length(trim(display_content)) > 0),
            member_dispatch_sequence INTEGER NOT NULL CHECK(member_dispatch_sequence >= 1),
            chain_position INTEGER NOT NULL CHECK(chain_position >= 1),
            status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','abandoned')),
            enqueued_at TEXT NOT NULL,
            started_at TEXT,
            terminal_at TEXT,
            failure_reason TEXT,
            PRIMARY KEY(intervention_receipt_id, turn_intent_id),
            UNIQUE(intervention_receipt_id, chain_position),
            UNIQUE(source_event_id),
            FOREIGN KEY(intervention_receipt_id)
                REFERENCES agent_org_runtime_member_interventions(intervention_receipt_id)
                ON DELETE CASCADE,
            FOREIGN KEY(session_id, turn_intent_id)
                REFERENCES session_turn_intents(session_id, turn_intent_id)
                ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_member_intervention_turn_queue
            ON agent_org_runtime_member_intervention_turns(
                intervention_receipt_id, status, member_dispatch_sequence
            );",
    )
}

pub(super) const INTERVENTION_SELECT: &str = "SELECT
    intervention.intervention_receipt_id,
    intervention.org_run_id,
    intervention.member_id,
    intervention.agent_id,
    intervention.session_id,
    intervention.status,
    intervention.source_event_id,
    intervention.original_task_id,
    intervention.original_turn_intent_id,
    intervention.original_member_dispatch_sequence,
    intervention.runtime_lease_id,
    intervention.dialog_turn_generation,
    (SELECT COUNT(*) FROM agent_org_runtime_member_intervention_turns chain
      WHERE chain.intervention_receipt_id=intervention.intervention_receipt_id
        AND chain.status IN ('queued','running')),
    intervention.entered_at,
    intervention.last_user_activity_at,
    intervention.yield_requested_at,
    intervention.yield_released_at,
    intervention.yield_timed_out_at,
    intervention.return_request_id,
    intervention.return_outcome,
    intervention.continuation_turn_intent_id,
    intervention.cleared_revision,
    intervention.cleared_at,
    intervention.failure_reason
 FROM agent_org_runtime_member_interventions intervention";

pub(super) fn row_to_intervention(
    row: &rusqlite::Row<'_>,
) -> SqliteResult<AgentMemberInterventionRecord> {
    let status_raw: String = row.get(5)?;
    let status = MemberInterventionStatus::parse(&status_raw).ok_or_else(|| {
        rusqlite::Error::InvalidColumnType(
            5,
            format!("status={status_raw}"),
            rusqlite::types::Type::Text,
        )
    })?;
    let return_outcome_raw: Option<String> = row.get(19)?;
    let return_outcome = return_outcome_raw
        .as_deref()
        .and_then(AppliedReturnToWorkOutcome::parse);
    Ok(AgentMemberInterventionRecord {
        intervention_receipt_id: row.get(0)?,
        org_run_id: row.get(1)?,
        member_id: row.get(2)?,
        agent_id: row.get(3)?,
        session_id: row.get(4)?,
        status,
        source_event_id: row.get(6)?,
        original_task_id: row.get(7)?,
        original_turn_intent_id: row.get(8)?,
        original_member_dispatch_sequence: row.get(9)?,
        runtime_lease_id: row.get(10)?,
        dialog_turn_generation: row.get(11)?,
        queued_user_directed_count: row.get(12)?,
        entered_at: row.get(13)?,
        last_user_activity_at: row.get(14)?,
        yield_requested_at: row.get(15)?,
        yield_released_at: row.get(16)?,
        yield_timed_out_at: row.get(17)?,
        return_request_id: row.get(18)?,
        return_outcome,
        continuation_turn_intent_id: row.get(20)?,
        cleared_revision: row.get(21)?,
        cleared_at: row.get(22)?,
        failure_reason: row.get(23)?,
    })
}

pub(super) fn get_by_receipt_with_connection(
    conn: &Connection,
    receipt_id: &str,
) -> Result<Option<AgentMemberInterventionRecord>, String> {
    conn.query_row(
        &format!("{INTERVENTION_SELECT} WHERE intervention.intervention_receipt_id=?1"),
        [receipt_id],
        row_to_intervention,
    )
    .optional()
    .map_err(|error| error.to_string())
}
