//! Durable certificates for the one-time construction of an Agent Org Team.
//!
//! These rows describe stable identities, not live Provider runtimes.  A
//! restart retries the same `(member_id, agent_id, session_id)` intent and can
//! therefore never mint a second identity for the same Team generation.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOrgMaterializationAuthority {
    Starting,
    Formal,
    UserDirected,
}

impl AgentOrgMaterializationAuthority {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Formal => "formal",
            Self::UserDirected => "user_directed",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "starting" => Self::Starting,
            "formal" => Self::Formal,
            "user_directed" => Self::UserDirected,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOrgMaterializationStatus {
    Pending,
    Succeeded,
    Failed,
}

impl AgentOrgMaterializationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "pending" => Self::Pending,
            "succeeded" => Self::Succeeded,
            "failed" => Self::Failed,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgMaterializationIntent {
    pub org_run_id: String,
    pub member_id: String,
    pub agent_id: String,
    pub generation: i64,
    pub session_id: String,
    pub authority: AgentOrgMaterializationAuthority,
    pub status: AgentOrgMaterializationStatus,
    pub error_code: Option<String>,
    pub error_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateAgentOrgMaterializationIntent {
    pub member_id: String,
    pub agent_id: String,
    pub session_id: String,
    pub succeeded: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOrgInitialInputStatus {
    PendingPersistence,
    Queued,
    Dispatched,
}

impl AgentOrgInitialInputStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PendingPersistence => "pending_persistence",
            Self::Queued => "queued",
            Self::Dispatched => "dispatched",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "pending_persistence" => Self::PendingPersistence,
            "queued" => Self::Queued,
            "dispatched" => Self::Dispatched,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgInitialInput {
    pub org_run_id: String,
    pub turn_intent_id: String,
    pub message_id: String,
    pub content: String,
    /// Canonical launch-time attachments/context required to replay this exact
    /// accepted input after a crash.  The launch owner validates and decodes
    /// the versioned JSON; the lifecycle store treats it as opaque evidence.
    pub payload_json: String,
    pub status: AgentOrgInitialInputStatus,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateAgentOrgInitialInput {
    pub turn_intent_id: String,
    pub message_id: String,
    pub content: String,
    pub payload_json: String,
}

pub(super) fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_member_materializations (
            org_run_id TEXT NOT NULL,
            member_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            generation INTEGER NOT NULL CHECK(generation >= 1),
            session_id TEXT NOT NULL,
            authority_class TEXT NOT NULL CHECK(authority_class IN (
                'starting', 'formal', 'user_directed'
            )),
            status TEXT NOT NULL CHECK(status IN (
                'pending', 'succeeded', 'failed'
            )),
            error_code TEXT,
            error_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(org_run_id, member_id, generation),
            UNIQUE(org_run_id, session_id),
            FOREIGN KEY(org_run_id) REFERENCES agent_org_runs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_materializations_pending
            ON agent_org_member_materializations(status, org_run_id, generation);

        CREATE TABLE IF NOT EXISTS agent_org_initial_inputs (
            org_run_id TEXT PRIMARY KEY,
            turn_intent_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            content TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN (
                'pending_persistence', 'queued', 'dispatched'
            )),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(turn_intent_id),
            UNIQUE(message_id),
            FOREIGN KEY(org_run_id) REFERENCES agent_org_runs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_initial_inputs_dispatch
            ON agent_org_initial_inputs(status, org_run_id);",
    )
}

pub(super) fn insert_materialization_intent(
    conn: &Connection,
    org_run_id: &str,
    generation: i64,
    intent: &CreateAgentOrgMaterializationIntent,
    now: &str,
) -> Result<(), String> {
    let status = if intent.succeeded {
        AgentOrgMaterializationStatus::Succeeded
    } else {
        AgentOrgMaterializationStatus::Pending
    };
    conn.execute(
        "INSERT INTO agent_org_member_materializations (
            org_run_id, member_id, agent_id, generation, session_id,
            authority_class, status, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 'starting', ?6, ?7, ?7)",
        params![
            org_run_id,
            &intent.member_id,
            &intent.agent_id,
            generation,
            &intent.session_id,
            status.as_str(),
            now,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn insert_initial_input(
    conn: &Connection,
    org_run_id: &str,
    input: &CreateAgentOrgInitialInput,
    now: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO agent_org_initial_inputs (
            org_run_id, turn_intent_id, message_id, content, payload_json,
            status, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![
            org_run_id,
            &input.turn_intent_id,
            &input.message_id,
            &input.content,
            &input.payload_json,
            AgentOrgInitialInputStatus::PendingPersistence.as_str(),
            now,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn list_materializations_with_connection(
    conn: &Connection,
    org_run_id: &str,
) -> Result<Vec<AgentOrgMaterializationIntent>, String> {
    let mut statement = conn
        .prepare(
            "SELECT org_run_id, member_id, agent_id, generation, session_id,
                    authority_class, status, error_code, error_json,
                    created_at, updated_at
             FROM agent_org_member_materializations
             WHERE org_run_id=?1
             ORDER BY member_id ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([org_run_id], row_to_materialization)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub(super) fn load_initial_input_with_connection(
    conn: &Connection,
    org_run_id: &str,
) -> Result<Option<AgentOrgInitialInput>, String> {
    conn.query_row(
        "SELECT org_run_id, turn_intent_id, message_id, content, payload_json,
                status, created_at, updated_at
         FROM agent_org_initial_inputs WHERE org_run_id=?1",
        [org_run_id],
        row_to_initial_input,
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(super) fn load_initial_input_by_turn_with_connection(
    conn: &Connection,
    turn_intent_id: &str,
) -> Result<Option<AgentOrgInitialInput>, String> {
    conn.query_row(
        "SELECT org_run_id, turn_intent_id, message_id, content, payload_json,
                status, created_at, updated_at
         FROM agent_org_initial_inputs WHERE turn_intent_id=?1",
        [turn_intent_id],
        row_to_initial_input,
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(super) fn list_recoverable_initial_inputs_with_connection(
    conn: &Connection,
    limit: usize,
) -> Result<Vec<AgentOrgInitialInput>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let limit = i64::try_from(limit)
        .map_err(|_| format!("initial input recovery limit is too large: {limit}"))?;
    let mut statement = conn
        .prepare(
            "SELECT initial.org_run_id, initial.turn_intent_id,
                    initial.message_id, initial.content, initial.payload_json,
                    initial.status,
                    initial.created_at, initial.updated_at
             FROM agent_org_initial_inputs initial
             JOIN agent_org_runs run ON run.id=initial.org_run_id
             JOIN session_turn_intents turn
               ON turn.org_run_id=initial.org_run_id
              AND turn.turn_intent_id=initial.turn_intent_id
             WHERE run.status='running'
               AND initial.status IN ('queued', 'dispatched')
               AND turn.status='queued'
             ORDER BY initial.updated_at ASC, initial.org_run_id ASC
             LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([limit], row_to_initial_input)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn row_to_materialization(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<AgentOrgMaterializationIntent> {
    let authority_raw: String = row.get(5)?;
    let status_raw: String = row.get(6)?;
    let authority = AgentOrgMaterializationAuthority::parse(&authority_raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            5,
            rusqlite::types::Type::Text,
            format!("unknown materialization authority: {authority_raw:?}").into(),
        )
    })?;
    let status = AgentOrgMaterializationStatus::parse(&status_raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            6,
            rusqlite::types::Type::Text,
            format!("unknown materialization status: {status_raw:?}").into(),
        )
    })?;
    Ok(AgentOrgMaterializationIntent {
        org_run_id: row.get(0)?,
        member_id: row.get(1)?,
        agent_id: row.get(2)?,
        generation: row.get(3)?,
        session_id: row.get(4)?,
        authority,
        status,
        error_code: row.get(7)?,
        error_json: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn row_to_initial_input(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentOrgInitialInput> {
    let status_raw: String = row.get(5)?;
    let status = AgentOrgInitialInputStatus::parse(&status_raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            5,
            rusqlite::types::Type::Text,
            format!("unknown initial input status: {status_raw:?}").into(),
        )
    })?;
    Ok(AgentOrgInitialInput {
        org_run_id: row.get(0)?,
        turn_intent_id: row.get(1)?,
        message_id: row.get(2)?,
        content: row.get(3)?,
        payload_json: row.get(4)?,
        status,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}
