//! Canonical Agent Org companion context and per-Member dispatch ordering.
//!
//! `session_turn_intents` remains the generic lifecycle owner. This module
//! atomically attaches the Agent Org-only execution identity and, for Member
//! turns, allocates the one FIFO sequence shared by every typed source.

use rusqlite::{params, Connection, OptionalExtension};

use crate::definitions::orgs::{validate_launch_snapshot, AgentOrgLaunchSnapshot};
use crate::foundation::session_bridge::{TurnIntentBridgeSource, TurnIntentBridgeStatus};

use super::agent_org_runs::{AgentOrgRunStatus, COORDINATOR_MEMBER_ID};

const TASK_WAKE_CANDIDATE_LIMIT: i64 =
    crate::coordination::agent_org_payload_limits::TASK_RUN_MAX_OPEN_TASKS as i64 + 1;

const TASK_ASSISTANT_PERSISTENCE_TARGET_SQL: &str = "SELECT task.status,
            EXISTS(
                SELECT 1
                FROM agent_org_runtime_task_events event
                WHERE event.org_run_id=task.org_run_id
                  AND event.task_id=task.id
                  AND event.previous_owner=?3
                  AND event.next_owner=?3
                  AND event.previous_status='in_progress'
                  AND event.next_status=task.status
                  AND event.actor_kind='owner_execution'
                  AND event.actor_member_id=?3
                  AND event.source_turn_intent_id=?4
                  AND event.created_at=task.updated_at
                  AND event.rowid=(
                      SELECT MAX(latest.rowid)
                      FROM agent_org_runtime_task_events latest
                      WHERE latest.org_run_id=task.org_run_id
                        AND latest.task_id=task.id
                  )
            )
     FROM agent_org_runtime_tasks task
     WHERE task.org_run_id=?1 AND task.id=?2 AND task.owner=?3";

pub(crate) const TURN_CONTEXT_INVARIANT_PREFIX: &str = "agent_org_turn_context_invalid:";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentOrgTurnKind {
    Coordinator,
    TaskExecution,
    UserDirectedWork,
}

impl AgentOrgTurnKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Coordinator => "coordinator",
            Self::TaskExecution => "task_execution",
            Self::UserDirectedWork => "user_directed_work",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "coordinator" => Self::Coordinator,
            "task_execution" => Self::TaskExecution,
            "user_directed_work" => Self::UserDirectedWork,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentOrgTurnSourceKind {
    RootTurn,
    Task,
    DirectMember,
    GroupMention,
    MemberInbox,
}

impl AgentOrgTurnSourceKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::RootTurn => "root_turn",
            Self::Task => "task",
            Self::DirectMember => "direct_member",
            Self::GroupMention => "group_mention",
            Self::MemberInbox => "member_inbox",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "root_turn" => Self::RootTurn,
            "task" => Self::Task,
            "direct_member" => Self::DirectMember,
            "group_mention" => Self::GroupMention,
            "member_inbox" => Self::MemberInbox,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentOrgTurnContext {
    pub context_id: i64,
    pub session_id: String,
    pub turn_intent_id: String,
    pub org_run_id: String,
    pub participant_id: String,
    pub turn_kind: AgentOrgTurnKind,
    pub task_id: Option<String>,
    pub owner_member_id: Option<String>,
    pub dispatch_member_id: Option<String>,
    pub member_dispatch_sequence: Option<i64>,
    pub source_kind: AgentOrgTurnSourceKind,
    pub source_id: String,
    pub root_authority_turn_id: Option<String>,
    pub actor_version: Option<i64>,
    pub activation_generation: Option<i64>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AdmissionKind {
    Coordinator {
        expected_generation: Option<i64>,
    },
    TaskExecution {
        task_id: String,
        owner_member_id: String,
        activation_generation: i64,
    },
    UserDirectedWork {
        dispatch_member_id: String,
        source: UserDirectedSource,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum UserDirectedSource {
    DirectMember { source_event_id: String },
    GroupMention { source_inbox_id: i64 },
    MemberInbox { source_inbox_id: i64 },
}

/// Closed construction surface for all Agent Org Turn kinds. Product entry
/// points receive only the constructors they can prove from canonical data;
/// no caller can submit a free-form `turn_kind` string.
#[derive(Debug, Clone)]
pub(crate) struct AgentOrgTurnAdmission {
    org_run_id: String,
    session_id: String,
    turn_intent_id: String,
    client_message_id: Option<String>,
    base_source: TurnIntentBridgeSource,
    kind: AdmissionKind,
}

impl AgentOrgTurnAdmission {
    pub(crate) fn coordinator(
        org_run_id: impl Into<String>,
        session_id: impl Into<String>,
        turn_intent_id: impl Into<String>,
        client_message_id: Option<String>,
        base_source: TurnIntentBridgeSource,
    ) -> Self {
        Self {
            org_run_id: org_run_id.into(),
            session_id: session_id.into(),
            turn_intent_id: turn_intent_id.into(),
            client_message_id,
            base_source,
            kind: AdmissionKind::Coordinator {
                expected_generation: None,
            },
        }
    }

    pub(crate) fn starting_coordinator(
        org_run_id: impl Into<String>,
        session_id: impl Into<String>,
        turn_intent_id: impl Into<String>,
        client_message_id: Option<String>,
        expected_generation: i64,
    ) -> Self {
        let mut request = Self::coordinator(
            org_run_id,
            session_id,
            turn_intent_id,
            client_message_id,
            TurnIntentBridgeSource::AgentOrg,
        );
        request.kind = AdmissionKind::Coordinator {
            expected_generation: Some(expected_generation),
        };
        request
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn task_execution(
        org_run_id: impl Into<String>,
        session_id: impl Into<String>,
        turn_intent_id: impl Into<String>,
        client_message_id: Option<String>,
        task_id: impl Into<String>,
        owner_member_id: impl Into<String>,
        activation_generation: i64,
    ) -> Self {
        Self {
            org_run_id: org_run_id.into(),
            session_id: session_id.into(),
            turn_intent_id: turn_intent_id.into(),
            client_message_id,
            base_source: TurnIntentBridgeSource::AgentOrg,
            kind: AdmissionKind::TaskExecution {
                task_id: task_id.into(),
                owner_member_id: owner_member_id.into(),
                activation_generation,
            },
        }
    }

    pub(crate) fn task_continuation(
        org_run_id: impl Into<String>,
        session_id: impl Into<String>,
        turn_intent_id: impl Into<String>,
        client_message_id: Option<String>,
        task_id: impl Into<String>,
        owner_member_id: impl Into<String>,
        activation_generation: i64,
    ) -> Self {
        let mut request = Self::task_execution(
            org_run_id,
            session_id,
            turn_intent_id,
            client_message_id,
            task_id,
            owner_member_id,
            activation_generation,
        );
        request.base_source = TurnIntentBridgeSource::Resume;
        request
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn direct_member(
        org_run_id: impl Into<String>,
        session_id: impl Into<String>,
        turn_intent_id: impl Into<String>,
        client_message_id: Option<String>,
        dispatch_member_id: impl Into<String>,
        source_event_id: impl Into<String>,
    ) -> Self {
        Self {
            org_run_id: org_run_id.into(),
            session_id: session_id.into(),
            turn_intent_id: turn_intent_id.into(),
            client_message_id,
            base_source: TurnIntentBridgeSource::AgentOrg,
            kind: AdmissionKind::UserDirectedWork {
                dispatch_member_id: dispatch_member_id.into(),
                source: UserDirectedSource::DirectMember {
                    source_event_id: source_event_id.into(),
                },
            },
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn group_mention(
        org_run_id: impl Into<String>,
        session_id: impl Into<String>,
        turn_intent_id: impl Into<String>,
        client_message_id: Option<String>,
        dispatch_member_id: impl Into<String>,
        source_inbox_id: i64,
    ) -> Self {
        Self {
            org_run_id: org_run_id.into(),
            session_id: session_id.into(),
            turn_intent_id: turn_intent_id.into(),
            client_message_id,
            base_source: TurnIntentBridgeSource::AgentOrg,
            kind: AdmissionKind::UserDirectedWork {
                dispatch_member_id: dispatch_member_id.into(),
                source: UserDirectedSource::GroupMention { source_inbox_id },
            },
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn member_inbox(
        org_run_id: impl Into<String>,
        session_id: impl Into<String>,
        turn_intent_id: impl Into<String>,
        client_message_id: Option<String>,
        dispatch_member_id: impl Into<String>,
        source_inbox_id: i64,
    ) -> Self {
        Self {
            org_run_id: org_run_id.into(),
            session_id: session_id.into(),
            turn_intent_id: turn_intent_id.into(),
            client_message_id,
            base_source: TurnIntentBridgeSource::AgentOrg,
            kind: AdmissionKind::UserDirectedWork {
                dispatch_member_id: dispatch_member_id.into(),
                source: UserDirectedSource::MemberInbox { source_inbox_id },
            },
        }
    }
}

pub(super) fn create_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_runtime_member_dispatch_allocators (
            org_run_id TEXT NOT NULL,
            member_id TEXT NOT NULL CHECK(length(trim(member_id)) > 0),
            next_sequence INTEGER NOT NULL CHECK(next_sequence >= 1),
            PRIMARY KEY(org_run_id, member_id),
            FOREIGN KEY(org_run_id) REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS agent_org_runtime_turn_contexts (
            context_id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL CHECK(length(trim(session_id)) > 0),
            turn_intent_id TEXT NOT NULL CHECK(length(trim(turn_intent_id)) > 0),
            org_run_id TEXT NOT NULL,
            participant_id TEXT NOT NULL CHECK(length(trim(participant_id)) > 0),
            turn_kind TEXT NOT NULL,
            task_id TEXT,
            owner_member_id TEXT,
            dispatch_member_id TEXT,
            member_dispatch_sequence INTEGER,
            source_kind TEXT NOT NULL,
            source_id TEXT NOT NULL CHECK(length(trim(source_id)) > 0),
            root_authority_turn_id TEXT,
            actor_version INTEGER,
            activation_generation INTEGER,
            created_at TEXT NOT NULL,
            UNIQUE(session_id, turn_intent_id),
            FOREIGN KEY(session_id, turn_intent_id)
                REFERENCES session_turn_intents(session_id, turn_intent_id)
                ON DELETE CASCADE,
            FOREIGN KEY(org_run_id)
                REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE,
            CHECK(
                (turn_kind='coordinator'
                 AND participant_id='coordinator'
                 AND task_id IS NULL AND owner_member_id IS NULL
                 AND dispatch_member_id IS NULL AND member_dispatch_sequence IS NULL
                 AND source_kind='root_turn' AND source_id=turn_intent_id
                 AND root_authority_turn_id IS NULL AND actor_version IS NULL
                 AND activation_generation IS NOT NULL AND activation_generation >= 1)
                OR
                (turn_kind='task_execution'
                 AND task_id IS NOT NULL AND length(trim(task_id)) > 0
                 AND owner_member_id=participant_id
                 AND dispatch_member_id=participant_id
                 AND member_dispatch_sequence IS NOT NULL AND member_dispatch_sequence >= 1
                 AND source_kind='task' AND source_id=task_id
                 AND root_authority_turn_id IS NULL AND actor_version IS NULL
                 AND activation_generation IS NOT NULL AND activation_generation >= 1)
                OR
                (turn_kind='user_directed_work'
                 AND task_id IS NULL AND owner_member_id IS NULL
                 AND dispatch_member_id=participant_id
                 AND member_dispatch_sequence IS NOT NULL AND member_dispatch_sequence >= 1
                 AND actor_version IS NOT NULL AND actor_version >= 1
                 AND activation_generation IS NULL
                 AND (
                    (source_kind='direct_member'
                     AND root_authority_turn_id=turn_intent_id)
                    OR
                    (source_kind='group_mention'
                     AND root_authority_turn_id=turn_intent_id)
                    OR
                    (source_kind='member_inbox'
                     AND root_authority_turn_id IS NULL)
                 ))
            )
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_org_runtime_turn_contexts_member_sequence
            ON agent_org_runtime_turn_contexts(
                org_run_id, dispatch_member_id, member_dispatch_sequence
            )
            WHERE dispatch_member_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_turn_contexts_source
            ON agent_org_runtime_turn_contexts(
                org_run_id, source_kind, source_id, context_id
            );",
    )
}

/// Open the canonical writer transaction and accept exactly one typed turn.
pub(crate) fn accept(request: &AgentOrgTurnAdmission) -> Result<AgentOrgTurnContext, String> {
    database::db::with_sessions_writer(|| {
        let mut connection = database::db::get_connection().map_err(|error| error.to_string())?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let context = accept_with_connection(&transaction, request)?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(context)
    })
}

/// Admit one background Agent Org wake from canonical durable work.
///
/// Coordinator wakes stay Root-scoped. A Member wake is narrower: it may
/// create a `TaskExecution` Turn only when the oldest supported unread formal
/// row still points at a dependency-ready pending Task owned by that Member,
/// or at revision feedback for that Member's still-running planning Task.
/// The inbox row, Task, session materialization, generation, base Turn and
/// companion context are inspected and committed under one IMMEDIATE writer
/// transaction, so a caller cannot turn an arbitrary Member resume into Task
/// authority.
pub(crate) fn accept_wake(
    org_run_id: &str,
    session_id: &str,
    turn_intent_id: &str,
    client_message_id: Option<String>,
    member_id: &str,
) -> Result<AgentOrgTurnContext, String> {
    database::db::with_sessions_writer(|| {
        let mut connection = database::db::get_connection().map_err(|error| error.to_string())?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let context = accept_wake_with_connection(
            &transaction,
            org_run_id,
            session_id,
            turn_intent_id,
            client_message_id,
            member_id,
        )?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(context)
    })
}

fn accept_wake_with_connection(
    conn: &Connection,
    org_run_id: &str,
    session_id: &str,
    turn_intent_id: &str,
    client_message_id: Option<String>,
    member_id: &str,
) -> Result<AgentOrgTurnContext, String> {
    if has_live_pause_continuation(conn, org_run_id, member_id)? {
        return Err(invariant_error(format!(
            "Participant {member_id} already has a durable Pause continuation"
        )));
    }
    if member_id == COORDINATOR_MEMBER_ID {
        return accept_with_connection(
            conn,
            &AgentOrgTurnAdmission::coordinator(
                org_run_id,
                session_id,
                turn_intent_id,
                client_message_id,
                TurnIntentBridgeSource::Resume,
            ),
        );
    }

    let (task_id, activation_generation) =
        resolve_next_task_wake_binding(conn, org_run_id, session_id, member_id)?;
    accept_with_connection(
        conn,
        &AgentOrgTurnAdmission::task_execution(
            org_run_id,
            session_id,
            turn_intent_id,
            client_message_id,
            task_id,
            member_id,
            activation_generation,
        ),
    )
}

/// A Resume receipt is the sole owner of its participant until the persisted
/// continuation intent leaves the scheduler. This check lives inside the same
/// IMMEDIATE transaction as ordinary Wake admission, so the watchdog, unread
/// Inbox hooks, and restart recovery cannot enqueue a second formal Turn for
/// work that Resume is already continuing.
fn has_live_pause_continuation(
    conn: &Connection,
    org_run_id: &str,
    participant_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1
             FROM agent_org_runtime_pause_handoffs handoff
             JOIN agent_org_runtime_pause_episodes episode
               ON episode.episode_id=handoff.episode_id
             JOIN agent_org_runtime_runs run ON run.id=handoff.org_run_id
             JOIN agent_org_runtime_turn_contexts context
               ON context.session_id=handoff.session_id
              AND context.turn_intent_id=handoff.continuation_turn_intent_id
             JOIN session_turn_intents intent
               ON intent.session_id=handoff.session_id
              AND intent.turn_intent_id=handoff.continuation_turn_intent_id
             WHERE handoff.org_run_id=?1 AND handoff.participant_id=?2
               AND episode.status='consumed' AND run.status='running'
               AND handoff.continuation_status IN ('queued','dispatched')
               AND intent.status IN ('queued','running')
               AND context.activation_generation=run.activation_generation
         )",
        params![org_run_id, participant_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

/// Re-check the persisted authority immediately before a queued Agent Org
/// Turn is promoted to Running. Admission is intentionally not a lease: Task
/// cancellation/reassignment, dependency changes, member replacement, or an
/// activation-generation fence may happen while the scheduler queue waits.
pub(crate) fn revalidate_context_with_connection(
    conn: &Connection,
    session_id: &str,
    turn_intent_id: &str,
) -> Result<AgentOrgTurnContext, String> {
    let context = revalidate_live_formal_context_with_connection(conn, session_id, turn_intent_id)?;
    if context.turn_kind == AgentOrgTurnKind::TaskExecution {
        let task_id = context
            .task_id
            .as_deref()
            .ok_or_else(|| invariant_error("TaskExecution context has no task_id".to_string()))?;
        let owner_member_id = context.owner_member_id.as_deref().ok_or_else(|| {
            invariant_error("TaskExecution context has no owner_member_id".to_string())
        })?;
        validate_task_execution_target(conn, &context.org_run_id, task_id, owner_member_id)?;
    }
    Ok(context)
}

/// Re-check the authority for persisting one assistant iteration. This is a
/// later lifecycle phase than execution admission: the exact running Turn may
/// have already completed or failed its Task, but no other Turn or actor may
/// use that terminal Task as transcript authority.
pub(crate) fn revalidate_assistant_persistence_with_connection(
    conn: &Connection,
    session_id: &str,
    turn_intent_id: &str,
) -> Result<AgentOrgTurnContext, String> {
    let context = revalidate_live_formal_context_with_connection(conn, session_id, turn_intent_id)?;
    validate_assistant_persistence_base_turn(conn, &context)?;
    if context.turn_kind == AgentOrgTurnKind::TaskExecution {
        let task_id = context
            .task_id
            .as_deref()
            .ok_or_else(|| invariant_error("TaskExecution context has no task_id".to_string()))?;
        let owner_member_id = context.owner_member_id.as_deref().ok_or_else(|| {
            invariant_error("TaskExecution context has no owner_member_id".to_string())
        })?;
        validate_task_assistant_persistence_target(conn, &context, task_id, owner_member_id)?;
    }
    Ok(context)
}

/// Common formal-Turn authority shared by execution admission and assistant
/// persistence. Target-state rules intentionally stay in the two public phase
/// validators above.
fn revalidate_live_formal_context_with_connection(
    conn: &Connection,
    session_id: &str,
    turn_intent_id: &str,
) -> Result<AgentOrgTurnContext, String> {
    let context = require_context_with_connection(conn, session_id, turn_intent_id)?;
    let run: Option<(Option<String>, Option<String>, i64, String)> = conn
        .query_row(
            "SELECT root_session_id, org_snapshot_json, activation_generation, status
             FROM agent_org_runtime_runs WHERE id=?1",
            [&context.org_run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((root_session_id, snapshot_json, generation, status_raw)) = run else {
        return Err(invariant_error(format!(
            "run {} disappeared before Turn execution",
            context.org_run_id
        )));
    };
    let status = AgentOrgRunStatus::parse(&status_raw)
        .ok_or_else(|| invariant_error(format!("unknown run status {status_raw:?}")))?;
    if status == AgentOrgRunStatus::Archived {
        return Err(format!(
            "team_archived: Agent Org run {} is read-only",
            context.org_run_id
        ));
    }
    if status != AgentOrgRunStatus::Running {
        return Err(invariant_error(format!(
            "Turn execution requires a running Team, found {status}"
        )));
    }
    let snapshot_json = snapshot_json.ok_or_else(|| {
        invariant_error(format!(
            "run {} has no immutable launch snapshot",
            context.org_run_id
        ))
    })?;
    let snapshot: AgentOrgLaunchSnapshot = serde_json::from_str(&snapshot_json)
        .map_err(|error| invariant_error(format!("invalid launch snapshot JSON: {error}")))?;
    validate_launch_snapshot(&snapshot)
        .map_err(|error| invariant_error(format!("invalid launch snapshot: {error}")))?;

    match context.turn_kind {
        AgentOrgTurnKind::Coordinator => {
            if root_session_id.as_deref() != Some(session_id)
                || context.participant_id != COORDINATOR_MEMBER_ID
                || context.activation_generation != Some(generation)
            {
                return Err(invariant_error(
                    "Coordinator Turn no longer matches canonical Root/generation".to_string(),
                ));
            }
            resolve_materialization_version_for_context(
                conn,
                &context,
                COORDINATOR_MEMBER_ID,
                &snapshot.coordinator_agent_id,
            )?;
        }
        AgentOrgTurnKind::TaskExecution => {
            let task_id = context.task_id.as_deref().ok_or_else(|| {
                invariant_error("TaskExecution context has no task_id".to_string())
            })?;
            let owner_member_id = context.owner_member_id.as_deref().ok_or_else(|| {
                invariant_error("TaskExecution context has no owner_member_id".to_string())
            })?;
            if context.participant_id != owner_member_id
                || context.dispatch_member_id.as_deref() != Some(owner_member_id)
                || context.source_kind != AgentOrgTurnSourceKind::Task
                || context.source_id != task_id
                || context.activation_generation != Some(generation)
            {
                return Err(invariant_error(
                    "TaskExecution context no longer matches participant/generation".to_string(),
                ));
            }
            let agent_id = snapshot_member_agent_id(&snapshot, owner_member_id)?;
            resolve_materialization_version_for_context(conn, &context, owner_member_id, agent_id)?;
        }
        AgentOrgTurnKind::UserDirectedWork => {
            return Err(invariant_error(
                "UserDirectedWork execution is not enabled in the task-bound wake path".to_string(),
            ));
        }
    }
    Ok(context)
}

fn validate_assistant_persistence_base_turn(
    conn: &Connection,
    context: &AgentOrgTurnContext,
) -> Result<(), String> {
    let base: Option<(Option<String>, String)> = conn
        .query_row(
            "SELECT org_run_id,status FROM session_turn_intents
             WHERE session_id=?1 AND turn_intent_id=?2",
            params![&context.session_id, &context.turn_intent_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((base_run_id, base_status)) = base else {
        return Err(invariant_error(
            "assistant persistence has no base Turn".to_string(),
        ));
    };
    if base_run_id.as_deref() != Some(context.org_run_id.as_str()) {
        return Err(invariant_error(format!(
            "assistant persistence base Turn belongs to another run, expected {}",
            context.org_run_id
        )));
    }
    if base_status != TurnIntentBridgeStatus::Running.as_str() {
        return Err(invariant_error(format!(
            "assistant persistence requires the current running Turn, found {base_status}"
        )));
    }
    Ok(())
}

/// Resolve the persisted TaskExecution identity used by failure recovery.
/// A session-level status or Member id is never sufficient: the failed Turn
/// must name one Task, Owner, run, source, and activation generation.
pub(crate) fn require_task_failure_recovery_context_with_connection(
    conn: &Connection,
    session_id: &str,
    turn_intent_id: &str,
) -> Result<AgentOrgTurnContext, String> {
    let context = require_context_with_connection(conn, session_id, turn_intent_id)?;
    let task_id = context
        .task_id
        .as_deref()
        .ok_or_else(|| invariant_error("failure recovery context has no task_id".to_string()))?;
    let owner_member_id = context.owner_member_id.as_deref().ok_or_else(|| {
        invariant_error("failure recovery context has no owner_member_id".to_string())
    })?;
    if context.turn_kind != AgentOrgTurnKind::TaskExecution
        || context.participant_id != owner_member_id
        || context.dispatch_member_id.as_deref() != Some(owner_member_id)
        || context.source_kind != AgentOrgTurnSourceKind::Task
        || context.source_id != task_id
        || context
            .activation_generation
            .filter(|value| *value > 0)
            .is_none()
    {
        return Err(invariant_error(
            "failure recovery context is not an exact TaskExecution binding".to_string(),
        ));
    }
    let base: Option<(Option<String>, String)> = conn
        .query_row(
            "SELECT org_run_id,status FROM session_turn_intents
             WHERE session_id=?1 AND turn_intent_id=?2",
            params![session_id, turn_intent_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((base_run_id, base_status)) = base else {
        return Err(invariant_error(
            "failure recovery context has no base Turn".to_string(),
        ));
    };
    if base_run_id.as_deref() != Some(context.org_run_id.as_str())
        || !matches!(base_status.as_str(), "running" | "failed")
    {
        return Err(invariant_error(format!(
            "failure recovery base Turn is not running/failed in run {}",
            context.org_run_id
        )));
    }
    Ok(context)
}

/// Startup crash recovery may only continue when exactly one persisted,
/// running TaskExecution belongs to the abandoned Member session.
pub(crate) fn unique_running_task_execution_turn_for_recovery(
    conn: &Connection,
    org_run_id: &str,
    session_id: &str,
    owner_member_id: &str,
) -> Result<Option<String>, String> {
    let mut statement = conn
        .prepare(
            "SELECT context.turn_intent_id
             FROM agent_org_runtime_turn_contexts context
             JOIN session_turn_intents base
               ON base.session_id=context.session_id
              AND base.turn_intent_id=context.turn_intent_id
             WHERE context.org_run_id=?1
               AND context.session_id=?2
               AND context.turn_kind='task_execution'
               AND context.participant_id=?3
               AND context.owner_member_id=?3
               AND context.dispatch_member_id=?3
               AND context.task_id IS NOT NULL
               AND context.source_kind='task'
               AND context.source_id=context.task_id
               AND context.activation_generation IS NOT NULL
               AND base.org_run_id=?1
               AND base.status='running'
             ORDER BY context.created_at DESC,context.context_id DESC
             LIMIT 2",
        )
        .map_err(|error| error.to_string())?;
    let turns = statement
        .query_map(params![org_run_id, session_id, owner_member_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    match turns.as_slice() {
        [] => Ok(None),
        [turn_intent_id] => Ok(Some(turn_intent_id.clone())),
        _ => Err(invariant_error(format!(
            "abandoned Member session {session_id} has multiple running TaskExecution contexts"
        ))),
    }
}

fn resolve_next_task_wake_binding(
    conn: &Connection,
    org_run_id: &str,
    session_id: &str,
    member_id: &str,
) -> Result<(String, i64), String> {
    let generation: Option<i64> = conn
        .query_row(
            "SELECT activation_generation FROM agent_org_runtime_runs
             WHERE id=?1 AND status='running'",
            [org_run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let generation = generation.ok_or_else(|| {
        invariant_error(format!("Member wake requires running Team {org_run_id}"))
    })?;

    let mut statement = conn
        .prepare(
            "SELECT id, payload_kind, payload_json
             FROM agent_org_runtime_inbox
             WHERE org_run_id=?1
               AND recipient_member_id=?2
               AND read_at IS NULL
               AND payload_kind IN ('task_assigned','plan_approval_response')
               AND NOT EXISTS (
                   SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
                   WHERE resolution.inbox_id=agent_org_runtime_inbox.id
               )
             ORDER BY id ASC
             LIMIT ?3",
        )
        .map_err(|error| error.to_string())?;
    let candidates = statement
        .query_map(
            params![org_run_id, member_id, TASK_WAKE_CANDIDATE_LIMIT],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);

    if candidates.len() >= TASK_WAKE_CANDIDATE_LIMIT as usize {
        return Err(invariant_error(format!(
            "Member {member_id} has too many pending formal wake candidates"
        )));
    }

    for (inbox_id, payload_kind, payload_json) in candidates {
        let message: crate::coordination::agent_inbox::AgentMessage =
            match serde_json::from_str(&payload_json) {
                Ok(message) => message,
                Err(error) => {
                    tracing::warn!(
                        run_id = %org_run_id,
                        member_id,
                        inbox_id,
                        error = %error,
                        "ignoring malformed formal wake candidate"
                    );
                    continue;
                }
            };
        if let Err(error) = message.validate() {
            tracing::warn!(
                run_id = %org_run_id,
                member_id,
                inbox_id,
                error = %error,
                "ignoring invalid formal wake candidate"
            );
            continue;
        }

        let task_id = match (payload_kind.as_str(), message) {
            (
                "task_assigned",
                crate::coordination::agent_inbox::AgentMessage::TaskAssigned { task_id, .. },
            ) if task_is_pending_and_ready(conn, org_run_id, &task_id, member_id)? => task_id,
            (
                "plan_approval_response",
                crate::coordination::agent_inbox::AgentMessage::PlanApprovalResponse {
                    request_id,
                    accepted: false,
                    ..
                },
            ) => {
                let task_id = planning_revision_task(
                    conn,
                    org_run_id,
                    session_id,
                    member_id,
                    request_id.as_str(),
                )?;
                let Some(task_id) = task_id else {
                    continue;
                };
                task_id
            }
            _ => continue,
        };
        return Ok((task_id, generation));
    }

    Err(invariant_error(format!(
        "Member {member_id} has no canonical ready TaskExecution input"
    )))
}

fn task_is_pending_and_ready(
    conn: &Connection,
    org_run_id: &str,
    task_id: &str,
    member_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM agent_org_runtime_tasks task
             WHERE task.org_run_id=?1 AND task.id=?2
               AND task.owner=?3 AND task.status='pending'
               AND NOT EXISTS (
                   SELECT 1
                   FROM json_each(task.blocked_by_json) edge
                   LEFT JOIN agent_org_runtime_tasks blocker
                     ON blocker.org_run_id=task.org_run_id
                    AND blocker.id=CAST(edge.value AS TEXT)
                   WHERE edge.type<>'text'
                      OR blocker.id IS NULL
                      OR blocker.status<>'completed'
               )
         )",
        params![org_run_id, task_id, member_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

fn planning_revision_task(
    conn: &Connection,
    org_run_id: &str,
    session_id: &str,
    member_id: &str,
    request_id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT approval.source_task_id
         FROM agent_org_runtime_plan_approvals approval
         JOIN agent_org_runtime_tasks task
           ON task.org_run_id=approval.org_run_id
          AND task.id=approval.source_task_id
         JOIN agent_org_runtime_turn_contexts source_context
           ON source_context.session_id=approval.source_session_id
          AND source_context.turn_intent_id=approval.source_turn_intent_id
          AND source_context.org_run_id=approval.org_run_id
          AND source_context.turn_kind='task_execution'
          AND source_context.task_id=approval.source_task_id
          AND source_context.owner_member_id=approval.source_member_id
         WHERE approval.org_run_id=?1
           AND approval.request_id=?2
           AND approval.status='changes_requested'
           AND approval.source_member_id=?3
           AND approval.source_session_id=?4
           AND task.owner=?3
           AND task.status='in_progress'
           AND task.execution_mode='plan'
         LIMIT 1",
        params![org_run_id, request_id, member_id, session_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn validate_task_execution_target(
    conn: &Connection,
    org_run_id: &str,
    task_id: &str,
    owner_member_id: &str,
) -> Result<(), String> {
    let target: Option<String> = conn
        .query_row(
            "SELECT status FROM agent_org_runtime_tasks
             WHERE org_run_id=?1 AND id=?2 AND owner=?3",
            params![org_run_id, task_id, owner_member_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    match target.as_deref() {
        Some("pending")
            if task_is_pending_and_ready(conn, org_run_id, task_id, owner_member_id)? =>
        {
            Ok(())
        }
        Some("in_progress") => Ok(()),
        Some(status) => Err(invariant_error(format!(
            "TaskExecution target {task_id} is not runnable (status {status})"
        ))),
        None => Err(invariant_error(format!(
            "TaskExecution target {task_id} is missing or no longer owned by {owner_member_id}"
        ))),
    }
}

fn validate_task_assistant_persistence_target(
    conn: &Connection,
    context: &AgentOrgTurnContext,
    task_id: &str,
    owner_member_id: &str,
) -> Result<(), String> {
    let target: Option<(String, bool)> = conn
        .query_row(
            TASK_ASSISTANT_PERSISTENCE_TARGET_SQL,
            params![
                &context.org_run_id,
                task_id,
                owner_member_id,
                &context.turn_intent_id
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    match target.as_ref().map(|(status, exact_terminal)| (status.as_str(), *exact_terminal)) {
        Some(("pending", _))
            if task_is_pending_and_ready(conn, &context.org_run_id, task_id, owner_member_id)? =>
        {
            Ok(())
        }
        Some(("in_progress", _)) => Ok(()),
        Some(("completed" | "failed", true)) => Ok(()),
        Some(("completed" | "failed", false)) => Err(invariant_error(format!(
            "TaskExecution target {task_id} terminal provenance does not belong to Turn {}",
            context.turn_intent_id
        ))),
        Some((status, _)) => Err(invariant_error(format!(
            "TaskExecution target {task_id} cannot authorize assistant persistence (status {status})"
        ))),
        None => Err(invariant_error(format!(
            "TaskExecution target {task_id} is missing or no longer owned by {owner_member_id}"
        ))),
    }
}

/// Connection-scoped admission for lifecycle owners that already hold an
/// IMMEDIATE transaction (notably Starting completion).
pub(crate) fn accept_with_connection(
    conn: &Connection,
    request: &AgentOrgTurnAdmission,
) -> Result<AgentOrgTurnContext, String> {
    validate_non_empty(request)?;

    let base = read_base(conn, &request.session_id, &request.turn_intent_id)?;
    let existing = read_context_optional(conn, &request.session_id, &request.turn_intent_id)?;
    match (base, existing) {
        (Some(base), Some(context)) => {
            ensure_base_matches(request, &base)?;
            ensure_context_matches(request, &context)?;
            return Ok(context);
        }
        (Some(_), None) => {
            return Err(invariant_error(format!(
                "base Turn exists without companion context for {}/{}",
                request.session_id, request.turn_intent_id
            )))
        }
        (None, Some(_)) => {
            return Err(invariant_error(format!(
                "companion context exists without base Turn for {}/{}",
                request.session_id, request.turn_intent_id
            )))
        }
        (None, None) => {}
    }

    let canonical = resolve_canonical_admission(conn, request)?;
    let sequence = match canonical.dispatch_member_id.as_deref() {
        Some(member_id) => Some(allocate_member_sequence(
            conn,
            &request.org_run_id,
            member_id,
        )?),
        None => None,
    };

    crate::foundation::session_bridge::upsert_turn_intent_with_connection(
        conn,
        &request.session_id,
        &request.turn_intent_id,
        request.client_message_id.as_deref(),
        Some(&request.org_run_id),
        request.base_source,
        TurnIntentBridgeStatus::Queued,
    )?;

    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_turn_contexts (
            session_id, turn_intent_id, org_run_id, participant_id, turn_kind,
            task_id, owner_member_id, dispatch_member_id, member_dispatch_sequence,
            source_kind, source_id, root_authority_turn_id, actor_version,
            activation_generation, created_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
         )",
        params![
            &request.session_id,
            &request.turn_intent_id,
            &request.org_run_id,
            &canonical.participant_id,
            canonical.turn_kind.as_str(),
            canonical.task_id.as_deref(),
            canonical.owner_member_id.as_deref(),
            canonical.dispatch_member_id.as_deref(),
            sequence,
            canonical.source_kind.as_str(),
            &canonical.source_id,
            canonical.root_authority_turn_id.as_deref(),
            canonical.actor_version,
            canonical.activation_generation,
            &now,
        ],
    )
    .map_err(|error| invariant_error(format!("failed to insert companion context: {error}")))?;

    require_context_with_connection(conn, &request.session_id, &request.turn_intent_id)
}

#[derive(Debug)]
struct CanonicalAdmission {
    participant_id: String,
    turn_kind: AgentOrgTurnKind,
    task_id: Option<String>,
    owner_member_id: Option<String>,
    dispatch_member_id: Option<String>,
    source_kind: AgentOrgTurnSourceKind,
    source_id: String,
    root_authority_turn_id: Option<String>,
    actor_version: Option<i64>,
    activation_generation: Option<i64>,
}

fn resolve_canonical_admission(
    conn: &Connection,
    request: &AgentOrgTurnAdmission,
) -> Result<CanonicalAdmission, String> {
    let run: Option<(Option<String>, Option<String>, i64, String)> = conn
        .query_row(
            "SELECT root_session_id, org_snapshot_json, activation_generation, status
             FROM agent_org_runtime_runs WHERE id=?1",
            [&request.org_run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((root_session_id, snapshot_json, generation, status_raw)) = run else {
        return Err(invariant_error(format!(
            "run {} does not exist",
            request.org_run_id
        )));
    };
    let status = AgentOrgRunStatus::parse(&status_raw)
        .ok_or_else(|| invariant_error(format!("unknown run status {status_raw:?}")))?;
    let snapshot_json = snapshot_json.ok_or_else(|| {
        invariant_error(format!(
            "run {} has no immutable launch snapshot",
            request.org_run_id
        ))
    })?;
    let snapshot: AgentOrgLaunchSnapshot = serde_json::from_str(&snapshot_json)
        .map_err(|error| invariant_error(format!("invalid launch snapshot JSON: {error}")))?;
    validate_launch_snapshot(&snapshot)
        .map_err(|error| invariant_error(format!("invalid launch snapshot: {error}")))?;

    match &request.kind {
        AdmissionKind::Coordinator {
            expected_generation,
        } => {
            let root_session_id = root_session_id.ok_or_else(|| {
                invariant_error(format!("run {} has no canonical Root", request.org_run_id))
            })?;
            if root_session_id != request.session_id {
                return Err(invariant_error(format!(
                    "session {} is not canonical Root {}",
                    request.session_id, root_session_id
                )));
            }
            if let Some(expected) = expected_generation {
                if generation != *expected || status != AgentOrgRunStatus::Starting {
                    return Err(invariant_error(format!(
                        "Starting authority mismatch: expected generation {expected}, current generation {generation}, status {status}"
                    )));
                }
            } else if status == AgentOrgRunStatus::Archived {
                return Err(format!(
                    "team_archived: Agent Org run {} is read-only",
                    request.org_run_id
                ));
            } else if status != AgentOrgRunStatus::Running {
                return Err(invariant_error(format!(
                    "Coordinator Turn requires a running Team, found {status}"
                )));
            }
            resolve_materialization_version(
                conn,
                request,
                COORDINATOR_MEMBER_ID,
                &snapshot.coordinator_agent_id,
            )?;
            Ok(CanonicalAdmission {
                participant_id: COORDINATOR_MEMBER_ID.to_string(),
                turn_kind: AgentOrgTurnKind::Coordinator,
                task_id: None,
                owner_member_id: None,
                dispatch_member_id: None,
                source_kind: AgentOrgTurnSourceKind::RootTurn,
                source_id: request.turn_intent_id.clone(),
                root_authority_turn_id: None,
                actor_version: None,
                activation_generation: Some(generation),
            })
        }
        AdmissionKind::TaskExecution {
            task_id,
            owner_member_id,
            activation_generation,
        } => {
            if status == AgentOrgRunStatus::Archived {
                return Err(format!(
                    "team_archived: Agent Org run {} is read-only",
                    request.org_run_id
                ));
            }
            if status != AgentOrgRunStatus::Running || generation != *activation_generation {
                return Err(invariant_error(format!(
                    "TaskExecution authority mismatch for generation {activation_generation}; current generation {generation}, status {status}"
                )));
            }
            let agent_id = snapshot_member_agent_id(&snapshot, owner_member_id)?;
            resolve_materialization_version(conn, request, owner_member_id, agent_id)?;
            let task_owner: Option<Option<String>> = conn
                .query_row(
                    "SELECT owner FROM agent_org_runtime_tasks
                     WHERE org_run_id=?1 AND id=?2",
                    params![&request.org_run_id, task_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            if task_owner.flatten().as_deref() != Some(owner_member_id) {
                return Err(invariant_error(format!(
                    "Task {task_id} is not owned by canonical Member {owner_member_id}"
                )));
            }
            Ok(CanonicalAdmission {
                participant_id: owner_member_id.clone(),
                turn_kind: AgentOrgTurnKind::TaskExecution,
                task_id: Some(task_id.clone()),
                owner_member_id: Some(owner_member_id.clone()),
                dispatch_member_id: Some(owner_member_id.clone()),
                source_kind: AgentOrgTurnSourceKind::Task,
                source_id: task_id.clone(),
                root_authority_turn_id: None,
                actor_version: None,
                activation_generation: Some(generation),
            })
        }
        AdmissionKind::UserDirectedWork {
            dispatch_member_id,
            source,
        } => {
            if status == AgentOrgRunStatus::Archived {
                return Err(format!(
                    "team_archived: Agent Org run {} is read-only",
                    request.org_run_id
                ));
            }
            if matches!(
                status,
                AgentOrgRunStatus::Starting
                    | AgentOrgRunStatus::Failed
                    | AgentOrgRunStatus::Archived
            ) {
                return Err(invariant_error(format!(
                    "UserDirectedWork cannot enter Team status {status}"
                )));
            }
            let agent_id = snapshot_member_agent_id(&snapshot, dispatch_member_id)?;
            let actor_version =
                resolve_materialization_version(conn, request, dispatch_member_id, agent_id)?;
            let (source_kind, source_id, root_authority_turn_id) = match source {
                UserDirectedSource::DirectMember { source_event_id } => {
                    let source_exists: bool = conn
                        .query_row(
                            "SELECT EXISTS(
                                SELECT 1 FROM events WHERE id=?1 AND session_id=?2
                             )",
                            params![source_event_id, &request.session_id],
                            |row| row.get(0),
                        )
                        .map_err(|error| error.to_string())?;
                    if !source_exists {
                        return Err(invariant_error(format!(
                            "DirectMember source event {source_event_id} is not canonical"
                        )));
                    }
                    (
                        AgentOrgTurnSourceKind::DirectMember,
                        source_event_id.clone(),
                        Some(request.turn_intent_id.clone()),
                    )
                }
                UserDirectedSource::GroupMention { source_inbox_id } => {
                    validate_source_inbox(
                        conn,
                        &request.org_run_id,
                        dispatch_member_id,
                        *source_inbox_id,
                    )?;
                    (
                        AgentOrgTurnSourceKind::GroupMention,
                        source_inbox_id.to_string(),
                        Some(request.turn_intent_id.clone()),
                    )
                }
                UserDirectedSource::MemberInbox { source_inbox_id } => {
                    validate_source_inbox(
                        conn,
                        &request.org_run_id,
                        dispatch_member_id,
                        *source_inbox_id,
                    )?;
                    (
                        AgentOrgTurnSourceKind::MemberInbox,
                        source_inbox_id.to_string(),
                        None,
                    )
                }
            };
            Ok(CanonicalAdmission {
                participant_id: dispatch_member_id.clone(),
                turn_kind: AgentOrgTurnKind::UserDirectedWork,
                task_id: None,
                owner_member_id: None,
                dispatch_member_id: Some(dispatch_member_id.clone()),
                source_kind,
                source_id,
                root_authority_turn_id,
                actor_version: Some(actor_version),
                activation_generation: None,
            })
        }
    }
}

fn resolve_materialization_version(
    conn: &Connection,
    request: &AgentOrgTurnAdmission,
    member_id: &str,
    agent_id: &str,
) -> Result<i64, String> {
    let version: Option<i64> = conn
        .query_row(
            "SELECT materialization.generation
             FROM agent_org_runtime_member_materializations materialization
             JOIN agent_sessions session
               ON session.session_id=materialization.session_id
             WHERE materialization.org_run_id=?1
               AND materialization.member_id=?2
               AND materialization.agent_id=?3
               AND materialization.session_id=?4
               AND materialization.status='succeeded'
               AND session.agent_definition_id=?3
               AND session.org_member_id=?2
               AND materialization.generation=(
                   SELECT MAX(latest.generation)
                   FROM agent_org_runtime_member_materializations latest
                   WHERE latest.org_run_id=?1
                     AND latest.member_id=?2
                     AND latest.status='succeeded'
               )
             LIMIT 1",
            params![
                &request.org_run_id,
                member_id,
                agent_id,
                &request.session_id,
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    version.ok_or_else(|| {
        invariant_error(format!(
            "session {} is not the latest canonical materialization for {}/{}",
            request.session_id, request.org_run_id, member_id
        ))
    })
}

fn resolve_materialization_version_for_context(
    conn: &Connection,
    context: &AgentOrgTurnContext,
    member_id: &str,
    agent_id: &str,
) -> Result<i64, String> {
    let version: Option<i64> = conn
        .query_row(
            "SELECT materialization.generation
             FROM agent_org_runtime_member_materializations materialization
             JOIN agent_sessions session
               ON session.session_id=materialization.session_id
             WHERE materialization.org_run_id=?1
               AND materialization.member_id=?2
               AND materialization.agent_id=?3
               AND materialization.session_id=?4
               AND materialization.status='succeeded'
               AND session.agent_definition_id=?3
               AND session.org_member_id=?2
               AND materialization.generation=(
                   SELECT MAX(latest.generation)
                   FROM agent_org_runtime_member_materializations latest
                   WHERE latest.org_run_id=?1
                     AND latest.member_id=?2
                     AND latest.status='succeeded'
               )
             LIMIT 1",
            params![
                &context.org_run_id,
                member_id,
                agent_id,
                &context.session_id,
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    version.ok_or_else(|| {
        invariant_error(format!(
            "session {} is not the latest canonical materialization for {}/{}",
            context.session_id, context.org_run_id, member_id
        ))
    })
}

fn snapshot_member_agent_id<'a>(
    snapshot: &'a AgentOrgLaunchSnapshot,
    member_id: &str,
) -> Result<&'a str, String> {
    snapshot
        .members
        .iter()
        .find(|member| member.member_id == member_id)
        .map(|member| member.agent_id.as_str())
        .ok_or_else(|| invariant_error(format!("unknown canonical Member {member_id}")))
}

fn validate_source_inbox(
    conn: &Connection,
    org_run_id: &str,
    dispatch_member_id: &str,
    source_inbox_id: i64,
) -> Result<(), String> {
    let valid: bool = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM agent_org_runtime_inbox
                WHERE id=?1 AND org_run_id=?2 AND recipient_member_id=?3
             )",
            params![source_inbox_id, org_run_id, dispatch_member_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !valid {
        return Err(invariant_error(format!(
            "Inbox source {source_inbox_id} is not canonical for {org_run_id}/{dispatch_member_id}"
        )));
    }
    Ok(())
}

fn allocate_member_sequence(
    conn: &Connection,
    org_run_id: &str,
    member_id: &str,
) -> Result<i64, String> {
    conn.query_row(
        "INSERT INTO agent_org_runtime_member_dispatch_allocators (
            org_run_id, member_id, next_sequence
         ) VALUES (?1, ?2, 2)
         ON CONFLICT(org_run_id, member_id) DO UPDATE
             SET next_sequence=next_sequence + 1
         RETURNING next_sequence - 1",
        params![org_run_id, member_id],
        |row| row.get(0),
    )
    .map_err(|error| invariant_error(format!("failed to allocate Member sequence: {error}")))
}

#[derive(Debug)]
struct BaseTurn {
    client_message_id: Option<String>,
    org_run_id: Option<String>,
    source: String,
}

fn read_base(
    conn: &Connection,
    session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<BaseTurn>, String> {
    conn.query_row(
        "SELECT client_message_id, org_run_id, source
         FROM session_turn_intents
         WHERE session_id=?1 AND turn_intent_id=?2",
        params![session_id, turn_intent_id],
        |row| {
            Ok(BaseTurn {
                client_message_id: row.get(0)?,
                org_run_id: row.get(1)?,
                source: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn ensure_base_matches(request: &AgentOrgTurnAdmission, base: &BaseTurn) -> Result<(), String> {
    if base.client_message_id != request.client_message_id
        || base.org_run_id.as_deref() != Some(request.org_run_id.as_str())
        || base.source != request.base_source.as_str()
    {
        return Err(invariant_error(format!(
            "base Turn replay mismatch for {}/{}",
            request.session_id, request.turn_intent_id
        )));
    }
    Ok(())
}

fn ensure_context_matches(
    request: &AgentOrgTurnAdmission,
    context: &AgentOrgTurnContext,
) -> Result<(), String> {
    let common_matches = context.session_id == request.session_id
        && context.turn_intent_id == request.turn_intent_id
        && context.org_run_id == request.org_run_id;
    let kind_matches = match &request.kind {
        AdmissionKind::Coordinator {
            expected_generation,
        } => {
            context.turn_kind == AgentOrgTurnKind::Coordinator
                && context.participant_id == COORDINATOR_MEMBER_ID
                && context.source_kind == AgentOrgTurnSourceKind::RootTurn
                && context.source_id == request.turn_intent_id
                && expected_generation
                    .map(|generation| context.activation_generation == Some(generation))
                    .unwrap_or(true)
        }
        AdmissionKind::TaskExecution {
            task_id,
            owner_member_id,
            activation_generation,
        } => {
            context.turn_kind == AgentOrgTurnKind::TaskExecution
                && context.participant_id == *owner_member_id
                && context.task_id.as_deref() == Some(task_id)
                && context.owner_member_id.as_deref() == Some(owner_member_id)
                && context.dispatch_member_id.as_deref() == Some(owner_member_id)
                && context.source_kind == AgentOrgTurnSourceKind::Task
                && context.source_id == *task_id
                && context.activation_generation == Some(*activation_generation)
        }
        AdmissionKind::UserDirectedWork {
            dispatch_member_id,
            source,
        } => {
            let source_matches = match source {
                UserDirectedSource::DirectMember { source_event_id } => {
                    context.source_kind == AgentOrgTurnSourceKind::DirectMember
                        && context.source_id == *source_event_id
                        && context.root_authority_turn_id.as_deref()
                            == Some(request.turn_intent_id.as_str())
                }
                UserDirectedSource::GroupMention { source_inbox_id } => {
                    context.source_kind == AgentOrgTurnSourceKind::GroupMention
                        && context.source_id == source_inbox_id.to_string()
                        && context.root_authority_turn_id.as_deref()
                            == Some(request.turn_intent_id.as_str())
                }
                UserDirectedSource::MemberInbox { source_inbox_id } => {
                    context.source_kind == AgentOrgTurnSourceKind::MemberInbox
                        && context.source_id == source_inbox_id.to_string()
                        && context.root_authority_turn_id.is_none()
                }
            };
            context.turn_kind == AgentOrgTurnKind::UserDirectedWork
                && context.participant_id == *dispatch_member_id
                && context.dispatch_member_id.as_deref() == Some(dispatch_member_id)
                && source_matches
        }
    };
    if !common_matches || !kind_matches {
        return Err(invariant_error(format!(
            "companion context replay mismatch for {}/{}",
            request.session_id, request.turn_intent_id
        )));
    }
    Ok(())
}

fn validate_non_empty(request: &AgentOrgTurnAdmission) -> Result<(), String> {
    if request.org_run_id.trim().is_empty()
        || request.session_id.trim().is_empty()
        || request.turn_intent_id.trim().is_empty()
    {
        return Err(invariant_error(
            "run/session/turn identity must not be empty".to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn require_context_with_connection(
    conn: &Connection,
    session_id: &str,
    turn_intent_id: &str,
) -> Result<AgentOrgTurnContext, String> {
    read_context_optional(conn, session_id, turn_intent_id)?.ok_or_else(|| {
        invariant_error(format!(
            "missing companion context for {session_id}/{turn_intent_id}"
        ))
    })
}

/// Load an already-admitted typed Turn without creating or rewriting either
/// lifecycle row. Durable Pause continuations use this before enqueue; the
/// execute-time path still performs the full Running/generation revalidation.
pub(crate) fn require_existing_context(
    org_run_id: &str,
    session_id: &str,
    turn_intent_id: &str,
) -> Result<AgentOrgTurnContext, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    let context = require_context_with_connection(&conn, session_id, turn_intent_id)?;
    if context.org_run_id != org_run_id {
        return Err(invariant_error(format!(
            "continuation context run mismatch: expected {org_run_id}, found {}",
            context.org_run_id
        )));
    }
    Ok(context)
}

/// Validate only the lifecycle fence for a formal Turn. This narrower check
/// is used by the post-provider Inbox acknowledgement: the Turn may have
/// legitimately completed its Task, but it must still belong to the current
/// Working generation before it can consume formal input.
pub(crate) fn validate_formal_turn_generation_with_connection(
    conn: &Connection,
    session_id: &str,
    turn_intent_id: &str,
) -> Result<AgentOrgTurnContext, String> {
    let context = require_context_with_connection(conn, session_id, turn_intent_id)?;
    if !matches!(
        context.turn_kind,
        AgentOrgTurnKind::Coordinator | AgentOrgTurnKind::TaskExecution
    ) {
        return Err(invariant_error(
            "Inbox acknowledgement requires a formal Turn".to_string(),
        ));
    }
    let run: Option<(String, i64)> = conn
        .query_row(
            "SELECT status,activation_generation FROM agent_org_runtime_runs WHERE id=?1",
            [&context.org_run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((status, generation)) = run else {
        return Err(invariant_error("formal Turn run disappeared".to_string()));
    };
    if status == AgentOrgRunStatus::Archived.as_str() {
        return Err(format!(
            "team_archived: Agent Org run {} is read-only",
            context.org_run_id
        ));
    }
    if status != AgentOrgRunStatus::Running.as_str()
        || context.activation_generation != Some(generation)
    {
        return Err(invariant_error(format!(
            "formal Turn generation fence rejected status={status}, generation={generation}"
        )));
    }
    Ok(context)
}

fn read_context_optional(
    conn: &Connection,
    session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<AgentOrgTurnContext>, String> {
    conn.query_row(
        "SELECT context_id, session_id, turn_intent_id, org_run_id,
                participant_id, turn_kind, task_id, owner_member_id,
                dispatch_member_id, member_dispatch_sequence, source_kind,
                source_id, root_authority_turn_id, actor_version,
                activation_generation, created_at
         FROM agent_org_runtime_turn_contexts
         WHERE session_id=?1 AND turn_intent_id=?2",
        params![session_id, turn_intent_id],
        decode_context,
    )
    .optional()
    .map_err(|error| invariant_error(format!("failed to decode companion context: {error}")))
}

fn decode_context(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentOrgTurnContext> {
    let kind_raw: String = row.get(5)?;
    let source_raw: String = row.get(10)?;
    let turn_kind = AgentOrgTurnKind::parse(&kind_raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            5,
            rusqlite::types::Type::Text,
            format!("unknown Agent Org Turn kind {kind_raw:?}").into(),
        )
    })?;
    let source_kind = AgentOrgTurnSourceKind::parse(&source_raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            10,
            rusqlite::types::Type::Text,
            format!("unknown Agent Org Turn source {source_raw:?}").into(),
        )
    })?;
    Ok(AgentOrgTurnContext {
        context_id: row.get(0)?,
        session_id: row.get(1)?,
        turn_intent_id: row.get(2)?,
        org_run_id: row.get(3)?,
        participant_id: row.get(4)?,
        turn_kind,
        task_id: row.get(6)?,
        owner_member_id: row.get(7)?,
        dispatch_member_id: row.get(8)?,
        member_dispatch_sequence: row.get(9)?,
        source_kind,
        source_id: row.get(11)?,
        root_authority_turn_id: row.get(12)?,
        actor_version: row.get(13)?,
        activation_generation: row.get(14)?,
        created_at: row.get(15)?,
    })
}

/// Agent Org-owned restart reconciliation. Generic SDE recovery never joins
/// or queries the companion table.
pub fn reconcile_in_flight_after_restart(conn: &Connection) -> Result<usize, String> {
    // Decode every persisted in-flight context first. Unknown discriminants or
    // malformed rows stop reconciliation before any state is changed.
    let mut statement = conn
        .prepare(
            "SELECT context.context_id, context.session_id, context.turn_intent_id,
                    context.org_run_id, context.participant_id, context.turn_kind,
                    context.task_id, context.owner_member_id,
                    context.dispatch_member_id, context.member_dispatch_sequence,
                    context.source_kind, context.source_id,
                    context.root_authority_turn_id, context.actor_version,
                    context.activation_generation, context.created_at
             FROM agent_org_runtime_turn_contexts context
             JOIN session_turn_intents intent
               ON intent.session_id=context.session_id
              AND intent.turn_intent_id=context.turn_intent_id
             WHERE intent.status IN ('optimistic', 'queued', 'running')",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], decode_context)
        .map_err(|error| error.to_string())?;
    for row in rows {
        row.map_err(|error| invariant_error(format!("recovery decode failed: {error}")))?;
    }
    drop(statement);

    let now = chrono::Utc::now().to_rfc3339();
    let affected = conn
        .execute(
            "UPDATE session_turn_intents AS intent
             SET status='stale', updated_at=?1
             WHERE intent.org_run_id IS NOT NULL
               AND intent.status IN ('optimistic', 'queued')
               AND NOT (
                  intent.status='queued'
                  AND (
                   EXISTS (
                    SELECT 1
                    FROM agent_org_runtime_initial_inputs initial
                    JOIN agent_org_runtime_turn_contexts context
                      ON context.org_run_id=initial.org_run_id
                     AND context.turn_intent_id=initial.turn_intent_id
                    JOIN agent_org_runtime_runs run
                      ON run.id=initial.org_run_id
                    WHERE initial.org_run_id=intent.org_run_id
                      AND initial.turn_intent_id=intent.turn_intent_id
                      AND initial.status IN ('queued', 'dispatched')
                      AND initial.message_id=intent.client_message_id
                      AND context.session_id=intent.session_id
                      AND context.turn_kind='coordinator'
                      AND context.source_kind='root_turn'
                      AND context.activation_generation=run.activation_generation
                      AND run.root_session_id=intent.session_id
                      AND run.status='running'
                   )
                   OR EXISTS (
                    SELECT 1
                    FROM agent_org_runtime_pause_handoffs handoff
                    JOIN agent_org_runtime_pause_episodes episode
                      ON episode.episode_id=handoff.episode_id
                    JOIN agent_org_runtime_turn_contexts context
                      ON context.session_id=intent.session_id
                     AND context.turn_intent_id=intent.turn_intent_id
                    JOIN agent_org_runtime_runs run
                      ON run.id=handoff.org_run_id
                    WHERE handoff.org_run_id=intent.org_run_id
                      AND handoff.session_id=intent.session_id
                      AND handoff.continuation_turn_intent_id=intent.turn_intent_id
                      AND handoff.continuation_status IN ('queued','dispatched')
                      AND handoff.drain_status IN ('released','runtime_absent')
                      AND episode.status='consumed'
                      AND context.activation_generation=run.activation_generation
                      AND run.status='running'
                   )
                  )
               )",
            [&now],
        )
        .map_err(|error| error.to_string())?;

    let missing_running: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM session_turn_intents intent
             LEFT JOIN agent_org_runtime_turn_contexts context
               ON context.session_id=intent.session_id
              AND context.turn_intent_id=intent.turn_intent_id
             WHERE intent.org_run_id IS NOT NULL
               AND intent.status='running'
               AND context.context_id IS NULL",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if missing_running != 0 {
        tracing::error!(
            missing_running,
            event = "agent_org_running_turn_context_missing",
            "retained contextless running Agent Org Turns as unknown/in-flight"
        );
    }
    Ok(affected)
}

fn invariant_error(message: String) -> String {
    format!("{TURN_CONTEXT_INVARIANT_PREFIX} {message}")
}

#[cfg(test)]
mod tests;
