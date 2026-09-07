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
    pub(crate) const fn as_str(self) -> &'static str {
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
    GroupRoot,
    Task,
    DirectMember,
    GroupMention,
    MemberInbox,
}

impl AgentOrgTurnSourceKind {
    /// Both sources execute through the one canonical Coordinator Root
    /// runtime. `GroupRoot` changes only where the user message and reply are
    /// projected; it does not create a second authority class.
    pub(crate) const fn is_coordinator_root(self) -> bool {
        matches!(self, Self::RootTurn | Self::GroupRoot)
    }

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::RootTurn => "root_turn",
            Self::GroupRoot => "group_root",
            Self::Task => "task",
            Self::DirectMember => "direct_member",
            Self::GroupMention => "group_mention",
            Self::MemberInbox => "member_inbox",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "root_turn" => Self::RootTurn,
            "group_root" => Self::GroupRoot,
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
    pub coordinator_work_revision: Option<i64>,
    pub coordinator_observed_task_ids: Vec<String>,
    pub terminal_reason: Option<String>,
    pub created_at: String,
}

impl AgentOrgTurnContext {
    pub(crate) fn is_user_directed_work(&self) -> bool {
        self.turn_kind == AgentOrgTurnKind::UserDirectedWork
    }

    pub(crate) fn direct_source_event_id(&self) -> Option<&str> {
        (self.turn_kind == AgentOrgTurnKind::UserDirectedWork
            && self.source_kind == AgentOrgTurnSourceKind::DirectMember)
            .then_some(self.source_id.as_str())
    }

    pub(crate) fn group_root_source_event_id(&self) -> Option<&str> {
        (self.turn_kind == AgentOrgTurnKind::Coordinator
            && self.source_kind == AgentOrgTurnSourceKind::GroupRoot)
            .then_some(self.source_id.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AdmissionKind {
    Coordinator {
        expected_generation: Option<i64>,
    },
    GroupRoot {
        source_event_id: String,
    },
    TaskExecution {
        task_id: String,
        owner_member_id: String,
        activation_generation: i64,
        authority_source: Option<super::agent_org_finality::TaskExecutionAuthoritySource>,
    },
    UserDirectedWork {
        dispatch_member_id: String,
        source: UserDirectedAdmissionSource,
    },
    CoordinatorMemberInbox {
        source_inbox_id: i64,
        root_authority_turn_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum UserDirectedAdmissionSource {
    DirectMember {
        source_event_id: String,
    },
    GroupMention {
        source_inbox_id: i64,
    },
    MemberInbox {
        source_inbox_id: i64,
        root_authority_turn_id: String,
    },
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

    pub(crate) fn group_root(
        org_run_id: impl Into<String>,
        session_id: impl Into<String>,
        turn_intent_id: impl Into<String>,
        client_message_id: Option<String>,
        source_event_id: impl Into<String>,
    ) -> Self {
        Self {
            org_run_id: org_run_id.into(),
            session_id: session_id.into(),
            turn_intent_id: turn_intent_id.into(),
            client_message_id,
            base_source: TurnIntentBridgeSource::UserSubmit,
            kind: AdmissionKind::GroupRoot {
                source_event_id: source_event_id.into(),
            },
        }
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
                authority_source: None,
            },
        }
    }

    pub(crate) fn with_task_execution_authority_source(
        mut self,
        source: super::agent_org_finality::TaskExecutionAuthoritySource,
    ) -> Self {
        if let AdmissionKind::TaskExecution {
            authority_source, ..
        } = &mut self.kind
        {
            *authority_source = Some(source);
        }
        self
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
                source: UserDirectedAdmissionSource::DirectMember {
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
                source: UserDirectedAdmissionSource::GroupMention { source_inbox_id },
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
        root_authority_turn_id: impl Into<String>,
    ) -> Self {
        Self {
            org_run_id: org_run_id.into(),
            session_id: session_id.into(),
            turn_intent_id: turn_intent_id.into(),
            client_message_id,
            base_source: TurnIntentBridgeSource::AgentOrg,
            kind: AdmissionKind::UserDirectedWork {
                dispatch_member_id: dispatch_member_id.into(),
                source: UserDirectedAdmissionSource::MemberInbox {
                    source_inbox_id,
                    root_authority_turn_id: root_authority_turn_id.into(),
                },
            },
        }
    }

    pub(crate) fn coordinator_member_inbox(
        org_run_id: impl Into<String>,
        session_id: impl Into<String>,
        turn_intent_id: impl Into<String>,
        client_message_id: Option<String>,
        source_inbox_id: i64,
        root_authority_turn_id: impl Into<String>,
    ) -> Self {
        Self {
            org_run_id: org_run_id.into(),
            session_id: session_id.into(),
            turn_intent_id: turn_intent_id.into(),
            client_message_id,
            base_source: TurnIntentBridgeSource::AgentOrg,
            kind: AdmissionKind::CoordinatorMemberInbox {
                source_inbox_id,
                root_authority_turn_id: root_authority_turn_id.into(),
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
            coordinator_work_revision INTEGER,
            coordinator_observed_task_ids_json TEXT NOT NULL DEFAULT '[]'
                CHECK(json_valid(coordinator_observed_task_ids_json)=1
                      AND json_type(coordinator_observed_task_ids_json)='array'
                      AND json_array_length(coordinator_observed_task_ids_json) <= 32),
            terminal_reason TEXT,
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
                 AND (
                    (source_kind IN ('root_turn','group_root')
                     AND (source_kind<>'root_turn' OR source_id=turn_intent_id)
                     AND root_authority_turn_id IS NULL AND actor_version IS NULL
                     AND activation_generation IS NOT NULL AND activation_generation >= 1
                     AND (coordinator_work_revision IS NULL OR coordinator_work_revision >= 0)
                     AND (terminal_reason IS NULL OR terminal_reason='waiting_for_org_event'))
                    OR
                    (source_kind='member_inbox'
                     AND root_authority_turn_id IS NOT NULL
                     AND length(trim(root_authority_turn_id)) > 0
                     AND actor_version IS NOT NULL AND actor_version >= 1
                     AND activation_generation IS NULL
                     AND coordinator_work_revision IS NULL
                     AND coordinator_observed_task_ids_json='[]' AND terminal_reason IS NULL)
                 ))
                OR
                (turn_kind='task_execution'
                 AND task_id IS NOT NULL AND length(trim(task_id)) > 0
                 AND owner_member_id=participant_id
                 AND dispatch_member_id=participant_id
                 AND member_dispatch_sequence IS NOT NULL AND member_dispatch_sequence >= 1
                 AND source_kind='task' AND source_id=task_id
                 AND root_authority_turn_id IS NULL AND actor_version IS NULL
                 AND activation_generation IS NOT NULL AND activation_generation >= 1
                 AND coordinator_work_revision IS NULL
                 AND coordinator_observed_task_ids_json='[]' AND terminal_reason IS NULL)
                OR
                (turn_kind='user_directed_work'
                 AND task_id IS NULL AND owner_member_id IS NULL
                 AND dispatch_member_id=participant_id
                 AND member_dispatch_sequence IS NOT NULL AND member_dispatch_sequence >= 1
                 AND actor_version IS NOT NULL AND actor_version >= 1
                 AND activation_generation IS NULL
                 AND coordinator_work_revision IS NULL
                 AND coordinator_observed_task_ids_json='[]' AND terminal_reason IS NULL
                 AND (
                    (source_kind='direct_member'
                     AND root_authority_turn_id=turn_intent_id)
                    OR
                    (source_kind='group_mention'
                     AND root_authority_turn_id=turn_intent_id)
                    OR
                    (source_kind='member_inbox'
                     AND root_authority_turn_id IS NOT NULL
                     AND length(trim(root_authority_turn_id)) > 0)
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
            );
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_turn_contexts_group_root_session
            ON agent_org_runtime_turn_contexts(session_id, context_id, source_id)
            WHERE source_kind='group_root';
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_turn_contexts_public_timeline
            ON agent_org_runtime_turn_contexts(org_run_id, created_at, context_id)
            WHERE source_kind IN ('group_root','group_mention');",
    )
}

/// Check the one persisted Member FIFO shared by TaskExecution and every UDW
/// source. Direct intervention may bypass only earlier formal TaskExecution
/// after its separate durable yield receipt becomes active; it may never pass
/// an earlier UDW item.
pub(crate) fn member_dispatch_is_fifo_head_with_connection(
    conn: &Connection,
    org_run_id: &str,
    member_id: &str,
    member_dispatch_sequence: i64,
    direct_intervention_may_bypass_formal: bool,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT NOT EXISTS(
             SELECT 1
             FROM agent_org_runtime_turn_contexts earlier
             JOIN session_turn_intents intent
               ON intent.session_id=earlier.session_id
              AND intent.turn_intent_id=earlier.turn_intent_id
             WHERE earlier.org_run_id=?1
               AND earlier.dispatch_member_id=?2
               AND earlier.member_dispatch_sequence<?3
               AND earlier.turn_kind IN ('task_execution','user_directed_work')
               AND intent.status IN ('optimistic','queued','running')
               AND (earlier.turn_kind='user_directed_work' OR ?4=0)
         )",
        params![
            org_run_id,
            member_id,
            member_dispatch_sequence,
            i64::from(direct_intervention_may_bypass_formal),
        ],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
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
/// at revision feedback for that Member's still-running planning Task, or at
/// a Coordinator reply durably bound to that Member's current in-progress
/// TaskExecution.
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

    let binding = resolve_next_task_wake_binding(conn, org_run_id, session_id, member_id)?;
    accept_with_connection(
        conn,
        &AgentOrgTurnAdmission::task_execution(
            org_run_id,
            session_id,
            turn_intent_id,
            client_message_id,
            binding.task_id,
            member_id,
            binding.activation_generation,
        )
        .with_task_execution_authority_source(binding.authority_source),
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
    let context = revalidate_live_context_with_connection(conn, session_id, turn_intent_id)?;
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
    let context = revalidate_live_context_with_connection(conn, session_id, turn_intent_id)?;
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
fn revalidate_live_context_with_connection(
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
        return Err(super::agent_org_finality::AgentOrgTurnFailure::new(
            super::agent_org_finality::AgentOrgTurnFailureKind::TargetTerminal,
            "team_archived",
            format!("Agent Org run {} is read-only", context.org_run_id),
        )
        .encode());
    }
    let lifecycle_allows_turn = match context.turn_kind {
        AgentOrgTurnKind::Coordinator => {
            matches!(status, AgentOrgRunStatus::Running | AgentOrgRunStatus::Idle)
                || (context.source_kind == AgentOrgTurnSourceKind::MemberInbox
                    && status == AgentOrgRunStatus::Paused)
        }
        AgentOrgTurnKind::TaskExecution => status == AgentOrgRunStatus::Running,
        AgentOrgTurnKind::UserDirectedWork => matches!(
            status,
            AgentOrgRunStatus::Running | AgentOrgRunStatus::Idle | AgentOrgRunStatus::Paused
        ),
    };
    if !lifecycle_allows_turn {
        return Err(invariant_error(format!(
            "Turn {:?} cannot execute in Team status {status}",
            context.turn_kind
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
            {
                return Err(invariant_error(
                    "Coordinator Turn no longer matches the canonical Root".to_string(),
                ));
            }
            let materialization_version = resolve_materialization_version_for_context(
                conn,
                &context,
                COORDINATOR_MEMBER_ID,
                &snapshot.coordinator_agent_id,
            )?;
            if context.source_kind.is_coordinator_root() {
                if context.activation_generation != Some(generation)
                    || context.actor_version.is_some()
                    || context.root_authority_turn_id.is_some()
                {
                    return Err(invariant_error(
                        "formal Coordinator Turn no longer matches its generation".to_string(),
                    ));
                }
                if context.source_kind == AgentOrgTurnSourceKind::GroupRoot {
                    let source_exists: bool = conn
                        .query_row(
                            "SELECT EXISTS(
                                 SELECT 1 FROM events
                                 WHERE id=?1 AND session_id=?2
                                   AND function_name='user_message'
                                   AND json_valid(result_json)
                                   AND json_extract(result_json, '$.turnIntentId')=?3
                             )",
                            params![&context.source_id, session_id, turn_intent_id],
                            |row| row.get(0),
                        )
                        .map_err(|error| error.to_string())?;
                    if !source_exists {
                        return Err(invariant_error(
                            "Coordinator GroupRoot source event disappeared".to_string(),
                        ));
                    }
                }
            } else if context.source_kind == AgentOrgTurnSourceKind::MemberInbox {
                if context.root_authority_turn_id.is_none()
                    || context.activation_generation.is_some()
                    || context.actor_version != Some(materialization_version)
                {
                    return Err(invariant_error(
                        "Coordinator MemberInbox Turn no longer matches its durable authority"
                            .to_string(),
                    ));
                }
                let binding_matches: bool = conn
                    .query_row(
                        "SELECT EXISTS(
                             SELECT 1
                             FROM agent_org_runtime_user_directed_coordinator_bindings binding
                             JOIN agent_org_runtime_inbox inbox ON inbox.id=binding.source_inbox_id
                             WHERE binding.org_run_id=?1
                               AND binding.session_id=?2
                               AND binding.turn_intent_id=?3
                               AND binding.source_inbox_id=CAST(?4 AS INTEGER)
                               AND binding.root_authority_turn_id=?5
                               AND binding.status IN ('pending','started')
                               AND inbox.delivery_class='user_directed'
                               AND inbox.recipient_member_id='coordinator'
                         )",
                        params![
                            &context.org_run_id,
                            session_id,
                            turn_intent_id,
                            &context.source_id,
                            context.root_authority_turn_id.as_deref(),
                        ],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                if !binding_matches {
                    return Err(invariant_error(
                        "Coordinator MemberInbox binding no longer matches the exact Turn"
                            .to_string(),
                    ));
                }
            } else {
                return Err(invariant_error(
                    "Coordinator Turn has an unsupported source kind".to_string(),
                ));
            }
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
                return Err(super::agent_org_finality::AgentOrgTurnFailure::new(
                    super::agent_org_finality::AgentOrgTurnFailureKind::StaleGeneration,
                    "task_execution_context_stale",
                    "TaskExecution context no longer matches participant/generation",
                )
                .encode());
            }
            let agent_id = snapshot_member_agent_id(&snapshot, owner_member_id)?;
            resolve_materialization_version_for_context(conn, &context, owner_member_id, agent_id)?;
        }
        AgentOrgTurnKind::UserDirectedWork => {
            let member_id = context.dispatch_member_id.as_deref().ok_or_else(|| {
                invariant_error("UserDirectedWork context has no dispatch Member".to_string())
            })?;
            if context.participant_id != member_id
                || !matches!(
                    context.source_kind,
                    AgentOrgTurnSourceKind::DirectMember
                        | AgentOrgTurnSourceKind::GroupMention
                        | AgentOrgTurnSourceKind::MemberInbox
                )
                || context.root_authority_turn_id.is_none()
                || context.activation_generation.is_some()
            {
                return Err(invariant_error(
                    "UserDirectedWork no longer matches source/participant authority".to_string(),
                ));
            }
            let agent_id = snapshot_member_agent_id(&snapshot, member_id)?;
            let materialization_version =
                resolve_materialization_version_for_context(conn, &context, member_id, agent_id)?;
            if context.actor_version != Some(materialization_version) {
                return Err(invariant_error(format!(
                    "UserDirectedWork actor version {:?} is stale; canonical version is {materialization_version}",
                    context.actor_version
                )));
            }
            let source_exists: bool = match context.source_kind {
                AgentOrgTurnSourceKind::DirectMember => conn
                    .query_row(
                        "SELECT EXISTS(
                             SELECT 1 FROM events
                             WHERE id=?1 AND session_id=?2 AND function_name='user_message'
                         )",
                        params![&context.source_id, session_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?,
                AgentOrgTurnSourceKind::GroupMention | AgentOrgTurnSourceKind::MemberInbox => conn
                    .query_row(
                        "SELECT EXISTS(
                             SELECT 1 FROM agent_org_runtime_inbox
                             WHERE id=CAST(?1 AS INTEGER) AND org_run_id=?2
                               AND recipient_member_id=?3
                               AND delivery_class='user_directed'
                         )",
                        params![&context.source_id, &context.org_run_id, member_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?,
                _ => false,
            };
            if !source_exists {
                return Err(invariant_error(format!(
                    "UserDirectedWork source {} disappeared",
                    context.source_id
                )));
            }
            let delivery_matches: bool = conn
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1
                         FROM agent_org_runtime_user_directed_deliveries delivery
                         WHERE delivery.org_run_id=?1
                           AND delivery.session_id=?2
                           AND delivery.turn_intent_id=?3
                           AND delivery.dispatch_member_id=?4
                           AND delivery.member_dispatch_sequence=?5
                           AND delivery.source_kind=?6
                           AND COALESCE(CAST(delivery.source_inbox_id AS TEXT),delivery.source_event_id)=?7
                           AND delivery.root_authority_turn_id=?8
                           AND delivery.status IN ('pending','started')
                     )",
                    params![
                        &context.org_run_id,
                        session_id,
                        turn_intent_id,
                        member_id,
                        context.member_dispatch_sequence,
                        context.source_kind.as_str(),
                        &context.source_id,
                        context.root_authority_turn_id.as_deref(),
                    ],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if !delivery_matches {
                return Err(invariant_error(
                    "UserDirectedWork delivery receipt no longer matches the exact Turn"
                        .to_string(),
                ));
            }
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
        return Err(super::agent_org_finality::AgentOrgTurnFailure::new(
            super::agent_org_finality::AgentOrgTurnFailureKind::TargetTerminal,
            "assistant_persistence_turn_terminal",
            format!("assistant persistence requires the current running Turn, found {base_status}"),
        )
        .encode());
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

struct TaskWakeBinding {
    task_id: String,
    activation_generation: i64,
    authority_source: super::agent_org_finality::TaskExecutionAuthoritySource,
}

fn resolve_next_task_wake_binding(
    conn: &Connection,
    org_run_id: &str,
    session_id: &str,
    member_id: &str,
) -> Result<TaskWakeBinding, String> {
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
               AND delivery_class='formal_work'
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

        let (task_id, source_kind) = match (payload_kind.as_str(), message) {
            (
                "task_assigned",
                crate::coordination::agent_inbox::AgentMessage::TaskAssigned { task_id, .. },
            ) if task_is_pending_and_ready(conn, org_run_id, &task_id, member_id)? => (
                task_id,
                super::agent_org_finality::TaskExecutionAuthoritySourceKind::Assignment,
            ),
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
                (
                    task_id,
                    super::agent_org_finality::TaskExecutionAuthoritySourceKind::PlanRevision,
                )
            }
            _ => continue,
        };
        return Ok(TaskWakeBinding {
            task_id,
            activation_generation: generation,
            authority_source: super::agent_org_finality::TaskExecutionAuthoritySource::inbox(
                source_kind,
                inbox_id,
            ),
        });
    }

    if let Some((inbox_id, task_id)) =
        crate::coordination::agent_inbox::oldest_unread_task_message_binding_with_connection(
            conn, org_run_id, member_id, None,
        )?
    {
        return Ok(TaskWakeBinding {
            task_id,
            activation_generation: generation,
            authority_source: super::agent_org_finality::TaskExecutionAuthoritySource::inbox(
                super::agent_org_finality::TaskExecutionAuthoritySourceKind::CoordinatorMessage,
                inbox_id,
            ),
        });
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
    if super::agent_org_task_handoffs::replacement_dispatch_is_blocked_with_connection(
        conn, org_run_id, task_id,
    )? {
        return Ok(false);
    }
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
        "SELECT revision.source_task_id
         FROM agent_org_runtime_plan_revisions revision
         JOIN agent_org_runtime_plan_decisions decision
           ON decision.plan_revision_id=revision.plan_revision_id
         JOIN agent_org_runtime_tasks task
           ON task.org_run_id=revision.org_run_id
          AND task.id=revision.source_task_id
         JOIN agent_org_runtime_turn_contexts source_context
           ON source_context.session_id=revision.source_session_id
          AND source_context.turn_intent_id=revision.source_turn_intent_id
          AND source_context.org_run_id=revision.org_run_id
          AND source_context.turn_kind='task_execution'
          AND source_context.task_id=revision.source_task_id
          AND source_context.owner_member_id=revision.source_member_id
         WHERE revision.org_run_id=?1
           AND decision.request_id=?2
           AND decision.status='changes_requested'
           AND revision.source_member_id=?3
           AND revision.source_session_id=?4
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
        Some(("completed" | "failed", false)) => Err(
            super::agent_org_finality::AgentOrgTurnFailure::new(
                super::agent_org_finality::AgentOrgTurnFailureKind::AuthorityConflict,
                "task_terminal_owned_by_sibling_turn",
                format!(
                    "TaskExecution target {task_id} terminal provenance does not belong to Turn {}",
                    context.turn_intent_id
                ),
            )
            .encode(),
        ),
        // Writer cancellation/reassignment freezes the durable Task but does
        // not revoke or stop the already-running Provider Turn. The exact
        // bound Turn must therefore be allowed to append its ordinary
        // assistant transcript and become terminal; Task lifecycle/output and
        // other formal mutations remain rejected by their owning Store gates.
        Some(("cancelled", _)) => Ok(()),
        Some((status, _)) => Err(super::agent_org_finality::AgentOrgTurnFailure::new(
            super::agent_org_finality::AgentOrgTurnFailureKind::TargetTerminal,
            "assistant_persistence_target_terminal",
            format!(
                "TaskExecution target {task_id} cannot authorize assistant persistence (status {status})"
            ),
        )
        .encode()),
        None => Err(super::agent_org_finality::AgentOrgTurnFailure::new(
            super::agent_org_finality::AgentOrgTurnFailureKind::AuthorityConflict,
            "assistant_persistence_target_changed",
            format!(
                "TaskExecution target {task_id} is missing or no longer owned by {owner_member_id}"
            ),
        )
        .encode()),
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
            claim_requested_task_execution_authority(conn, request, &context)?;
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

    // Final-summary work reuses the ordinary Root Coordinator runtime and
    // Turn kind. Its receipt, not a parallel runtime lane, narrows this exact
    // Resume Turn to read-only summary authority before policy assembly.
    if canonical.turn_kind == AgentOrgTurnKind::Coordinator
        && matches!(request.base_source, TurnIntentBridgeSource::Resume)
    {
        crate::coordination::agent_org_final_summary::claim_pending_for_coordinator_turn_in_tx(
            conn,
            &request.org_run_id,
            &request.session_id,
            &request.turn_intent_id,
        )?;
    }

    let context =
        require_context_with_connection(conn, &request.session_id, &request.turn_intent_id)?;
    claim_requested_task_execution_authority(conn, request, &context)?;
    Ok(context)
}

fn claim_requested_task_execution_authority(
    conn: &Connection,
    request: &AgentOrgTurnAdmission,
    context: &AgentOrgTurnContext,
) -> Result<(), String> {
    let AdmissionKind::TaskExecution {
        authority_source, ..
    } = &request.kind
    else {
        return Ok(());
    };
    let source = authority_source.as_ref().ok_or_else(|| {
        super::agent_org_finality::AgentOrgTurnFailure::new(
            super::agent_org_finality::AgentOrgTurnFailureKind::CorruptState,
            "task_execution_authority_source_missing",
            "TaskExecution admission requires an exact assignment or continuation receipt",
        )
        .encode()
    })?;
    super::agent_org_finality::claim_task_execution_in_tx(conn, context, source)
        .map_err(|failure| failure.encode())
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
            } else if !matches!(status, AgentOrgRunStatus::Running | AgentOrgRunStatus::Idle) {
                return Err(invariant_error(format!(
                    "Coordinator Turn requires a running or Idle Team, found {status}"
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
        AdmissionKind::GroupRoot { source_event_id } => {
            let root_session_id = root_session_id.ok_or_else(|| {
                invariant_error(format!("run {} has no canonical Root", request.org_run_id))
            })?;
            if root_session_id != request.session_id {
                return Err(invariant_error(format!(
                    "session {} is not canonical Root {}",
                    request.session_id, root_session_id
                )));
            }
            if status == AgentOrgRunStatus::Archived {
                return Err(format!(
                    "team_archived: Agent Org run {} is read-only",
                    request.org_run_id
                ));
            }
            if !matches!(status, AgentOrgRunStatus::Running | AgentOrgRunStatus::Idle) {
                return Err(invariant_error(format!(
                    "Coordinator GroupRoot Turn requires a running or Idle Team, found {status}"
                )));
            }
            resolve_materialization_version(
                conn,
                request,
                COORDINATOR_MEMBER_ID,
                &snapshot.coordinator_agent_id,
            )?;
            let source_exists: bool = conn
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM events
                         WHERE id=?1 AND session_id=?2
                           AND function_name='user_message'
                           AND json_valid(result_json)
                           AND json_extract(result_json, '$.turnIntentId')=?3
                     )",
                    params![
                        source_event_id,
                        &request.session_id,
                        &request.turn_intent_id
                    ],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if !source_exists {
                return Err(invariant_error(format!(
                    "GroupRoot source event {source_event_id} is not canonical for Turn {}",
                    request.turn_intent_id
                )));
            }
            Ok(CanonicalAdmission {
                participant_id: COORDINATOR_MEMBER_ID.to_string(),
                turn_kind: AgentOrgTurnKind::Coordinator,
                task_id: None,
                owner_member_id: None,
                dispatch_member_id: None,
                source_kind: AgentOrgTurnSourceKind::GroupRoot,
                source_id: source_event_id.clone(),
                root_authority_turn_id: None,
                actor_version: None,
                activation_generation: Some(generation),
            })
        }
        AdmissionKind::TaskExecution {
            task_id,
            owner_member_id,
            activation_generation,
            authority_source: _,
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
        AdmissionKind::CoordinatorMemberInbox {
            source_inbox_id,
            root_authority_turn_id,
        } => {
            if !matches!(
                status,
                AgentOrgRunStatus::Running | AgentOrgRunStatus::Idle | AgentOrgRunStatus::Paused
            ) {
                return Err(invariant_error(format!(
                    "Coordinator MemberInbox cannot enter Team status {status}"
                )));
            }
            let root_session_id = root_session_id.ok_or_else(|| {
                invariant_error(format!("run {} has no canonical Root", request.org_run_id))
            })?;
            if root_session_id != request.session_id {
                return Err(invariant_error(format!(
                    "session {} is not canonical Root {}",
                    request.session_id, root_session_id
                )));
            }
            let actor_version = resolve_materialization_version(
                conn,
                request,
                COORDINATOR_MEMBER_ID,
                &snapshot.coordinator_agent_id,
            )?;
            validate_source_inbox(
                conn,
                &request.org_run_id,
                COORDINATOR_MEMBER_ID,
                *source_inbox_id,
            )?;
            Ok(CanonicalAdmission {
                participant_id: COORDINATOR_MEMBER_ID.to_string(),
                turn_kind: AgentOrgTurnKind::Coordinator,
                task_id: None,
                owner_member_id: None,
                dispatch_member_id: None,
                source_kind: AgentOrgTurnSourceKind::MemberInbox,
                source_id: source_inbox_id.to_string(),
                root_authority_turn_id: Some(root_authority_turn_id.clone()),
                actor_version: Some(actor_version),
                activation_generation: None,
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
                UserDirectedAdmissionSource::DirectMember { source_event_id } => {
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
                UserDirectedAdmissionSource::GroupMention { source_inbox_id } => {
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
                UserDirectedAdmissionSource::MemberInbox {
                    source_inbox_id,
                    root_authority_turn_id,
                } => {
                    validate_source_inbox(
                        conn,
                        &request.org_run_id,
                        dispatch_member_id,
                        *source_inbox_id,
                    )?;
                    (
                        AgentOrgTurnSourceKind::MemberInbox,
                        source_inbox_id.to_string(),
                        Some(root_authority_turn_id.clone()),
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
                  AND delivery_class='user_directed'
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
        AdmissionKind::GroupRoot { source_event_id } => {
            context.turn_kind == AgentOrgTurnKind::Coordinator
                && context.participant_id == COORDINATOR_MEMBER_ID
                && context.source_kind == AgentOrgTurnSourceKind::GroupRoot
                && context.source_id == *source_event_id
                && context.activation_generation.is_some()
                && context.actor_version.is_none()
                && context.root_authority_turn_id.is_none()
        }
        AdmissionKind::TaskExecution {
            task_id,
            owner_member_id,
            activation_generation,
            ..
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
        AdmissionKind::CoordinatorMemberInbox {
            source_inbox_id,
            root_authority_turn_id,
        } => {
            context.turn_kind == AgentOrgTurnKind::Coordinator
                && context.participant_id == COORDINATOR_MEMBER_ID
                && context.source_kind == AgentOrgTurnSourceKind::MemberInbox
                && context.source_id == source_inbox_id.to_string()
                && context.root_authority_turn_id.as_deref()
                    == Some(root_authority_turn_id.as_str())
        }
        AdmissionKind::UserDirectedWork {
            dispatch_member_id,
            source,
        } => {
            let source_matches = match source {
                UserDirectedAdmissionSource::DirectMember { source_event_id } => {
                    context.source_kind == AgentOrgTurnSourceKind::DirectMember
                        && context.source_id == *source_event_id
                        && context.root_authority_turn_id.as_deref()
                            == Some(request.turn_intent_id.as_str())
                }
                UserDirectedAdmissionSource::GroupMention { source_inbox_id } => {
                    context.source_kind == AgentOrgTurnSourceKind::GroupMention
                        && context.source_id == source_inbox_id.to_string()
                        && context.root_authority_turn_id.as_deref()
                            == Some(request.turn_intent_id.as_str())
                }
                UserDirectedAdmissionSource::MemberInbox {
                    source_inbox_id,
                    root_authority_turn_id,
                } => {
                    context.source_kind == AgentOrgTurnSourceKind::MemberInbox
                        && context.source_id == source_inbox_id.to_string()
                        && context.root_authority_turn_id.as_deref()
                            == Some(root_authority_turn_id.as_str())
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

/// Load one persisted companion context from its canonical Session/Turn
/// identity. Per-Turn tool assembly uses this without re-deriving a run id.
pub(crate) fn require_existing_context_for_session(
    session_id: &str,
    turn_intent_id: &str,
) -> Result<AgentOrgTurnContext, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    require_context_with_connection(&conn, session_id, turn_intent_id)
}

/// Load an Agent Org context if this Session/Turn belongs to one. Ordinary
/// SDE turns deliberately return `None` without creating Agent Org state.
pub(crate) fn optional_context_for_session(
    session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<AgentOrgTurnContext>, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    read_context_optional(&conn, session_id, turn_intent_id)
}

/// Revalidate the persisted authority at the moment of a tool call. This is
/// intentionally later than Turn admission so cancellation, reassignment,
/// generation fences, and lifecycle changes cannot reuse a warm policy.
pub(crate) fn revalidate_context_for_execution(
    session_id: &str,
    turn_intent_id: &str,
) -> Result<AgentOrgTurnContext, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    revalidate_context_with_connection(&conn, session_id, turn_intent_id)
}

/// Mark an exact Coordinator Turn as event-waiting only when no durable fact
/// arrived after the trigger/revision claimed for its prompt. Returning false
/// means a newer trigger exists and the caller must perform a fresh read.
pub(crate) fn mark_waiting_for_org_event_if_current(
    org_run_id: &str,
    session_id: &str,
    turn_intent_id: &str,
) -> Result<bool, String> {
    coordinator_wait_gate(org_run_id, session_id, turn_intent_id, false)
        .map(|gate| gate == CoordinatorTaskListGate::WaitForEvent)
}

pub(crate) fn gate_coordinator_task_list(
    org_run_id: &str,
    session_id: &str,
    turn_intent_id: &str,
) -> Result<CoordinatorTaskListGate, String> {
    coordinator_wait_gate(org_run_id, session_id, turn_intent_id, true)
}

fn coordinator_wait_gate(
    org_run_id: &str,
    session_id: &str,
    turn_intent_id: &str,
    allow_initial_empty_task_list: bool,
) -> Result<CoordinatorTaskListGate, String> {
    database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
        let context = revalidate_context_with_connection(&tx, session_id, turn_intent_id)?;
        if context.org_run_id != org_run_id
            || context.turn_kind != AgentOrgTurnKind::Coordinator
            || !context.source_kind.is_coordinator_root()
        {
            return Err(invariant_error(
                "waiting_for_org_event requires exact Coordinator authority".to_string(),
            ));
        }
        let has_completion_certificate: bool = tx
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM agent_org_runtime_run_completion_certificates
                     WHERE org_run_id=?1
                       AND coordinator_session_id=?2
                       AND coordinator_turn_intent_id=?3
                 )",
                params![org_run_id, session_id, turn_intent_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if has_completion_certificate {
            tx.commit().map_err(|error| error.to_string())?;
            return Ok(CoordinatorTaskListGate::WaitForEvent);
        }
        let work_revision: i64 = tx
            .query_row(
                "SELECT work_revision
                 FROM agent_org_runtime_run_progress WHERE org_run_id=?1",
                [org_run_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let newer_formal_fact: bool = tx
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM agent_org_runtime_formal_trigger_receipts
                     WHERE org_run_id=?1 AND status='pending'
                 )",
                [org_run_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let current =
            context.coordinator_work_revision == Some(work_revision) && !newer_formal_fact;
        if !current {
            tx.commit().map_err(|error| error.to_string())?;
            return Ok(CoordinatorTaskListGate::ReadCurrentSnapshot);
        }
        let initial_empty_task_list = allow_initial_empty_task_list
            && work_revision == 0
            && tx
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1
                         FROM agent_org_runtime_runs run
                         JOIN agent_org_runtime_initial_inputs initial
                           ON initial.org_run_id=run.id
                         WHERE run.id=?1
                           AND run.root_session_id=?2
                           AND run.has_initial_work=1
                           AND initial.turn_intent_id=?3
                           AND NOT EXISTS (
                               SELECT 1 FROM agent_org_runtime_tasks task
                               WHERE task.org_run_id=run.id
                           )
                           AND NOT EXISTS (
                               SELECT 1
                               FROM agent_org_runtime_run_completion_certificates certificate
                               WHERE certificate.org_run_id=run.id
                           )
                     )",
                    params![org_run_id, session_id, turn_intent_id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|error| error.to_string())?;
        if initial_empty_task_list {
            tx.commit().map_err(|error| error.to_string())?;
            return Ok(CoordinatorTaskListGate::InitialEmptyTaskListBypass);
        }
        let updated = tx
            .execute(
                "UPDATE agent_org_runtime_turn_contexts
                 SET terminal_reason='waiting_for_org_event'
                 WHERE org_run_id=?1 AND session_id=?2 AND turn_intent_id=?3
                   AND turn_kind='coordinator'
                   AND source_kind IN ('root_turn','group_root')
                   AND terminal_reason IS NULL",
                params![org_run_id, session_id, turn_intent_id],
            )
            .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(
            if updated == 1 || context.terminal_reason.as_deref() == Some("waiting_for_org_event") {
                CoordinatorTaskListGate::WaitForEvent
            } else {
                CoordinatorTaskListGate::ReadCurrentSnapshot
            },
        )
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CoordinatorTaskListGate {
    ReadCurrentSnapshot,
    InitialEmptyTaskListBypass,
    WaitForEvent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CoordinatorTaskObservation {
    First,
    Repeat,
    NewTriggerPending,
}

/// Atomically claim the one permitted full read of a Task for this exact
/// Coordinator trigger/revision. Repeated reads never query the Task table;
/// they persist the event-waiting terminal reason in this same transaction.
pub(crate) fn claim_coordinator_task_observation(
    org_run_id: &str,
    session_id: &str,
    turn_intent_id: &str,
    task_id: &str,
) -> Result<CoordinatorTaskObservation, String> {
    database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
        let context = revalidate_context_with_connection(&tx, session_id, turn_intent_id)?;
        if context.org_run_id != org_run_id
            || context.turn_kind != AgentOrgTurnKind::Coordinator
            || !context.source_kind.is_coordinator_root()
        {
            return Err(invariant_error(
                "Task observation requires exact Coordinator authority".to_string(),
            ));
        }
        let work_revision: i64 = tx
            .query_row(
                "SELECT work_revision
                 FROM agent_org_runtime_run_progress WHERE org_run_id=?1",
                [org_run_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let newer_formal_fact: bool = tx
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM agent_org_runtime_formal_trigger_receipts
                     WHERE org_run_id=?1 AND status='pending'
                 )",
                [org_run_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let current =
            context.coordinator_work_revision == Some(work_revision) && !newer_formal_fact;
        if !current {
            tx.commit().map_err(|error| error.to_string())?;
            return Ok(CoordinatorTaskObservation::NewTriggerPending);
        }
        if context
            .coordinator_observed_task_ids
            .iter()
            .any(|observed| observed == task_id)
        {
            tx.execute(
                "UPDATE agent_org_runtime_turn_contexts
                 SET terminal_reason='waiting_for_org_event'
                 WHERE context_id=?1 AND terminal_reason IS NULL",
                [context.context_id],
            )
            .map_err(|error| error.to_string())?;
            tx.commit().map_err(|error| error.to_string())?;
            return Ok(CoordinatorTaskObservation::Repeat);
        }
        let mut observed = context.coordinator_observed_task_ids;
        if observed.len() >= 32 {
            return Err(invariant_error(
                "Coordinator Task observation cache exceeded 32 entries".to_string(),
            ));
        }
        observed.push(task_id.to_string());
        let observed_json = serde_json::to_string(&observed).map_err(|error| error.to_string())?;
        tx.execute(
            "UPDATE agent_org_runtime_turn_contexts
             SET coordinator_observed_task_ids_json=?2
             WHERE context_id=?1 AND terminal_reason IS NULL",
            params![context.context_id, observed_json],
        )
        .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(CoordinatorTaskObservation::First)
    })
}

/// Resolve the exact EventStore source for a DirectMember Turn. Callers first
/// gate on Agent Org runtime context, so ordinary SDE performs no companion
/// lookup; formal and other typed Agent Org sources return `None`.
pub(crate) fn direct_source_event_for_turn(
    session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<String>, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    let context = read_context_optional(&conn, session_id, turn_intent_id)?;
    Ok(context.and_then(|context| context.direct_source_event_id().map(ToString::to_string)))
}

/// Resolve the exact Group-origin user event for a Coordinator Root Turn.
/// Ordinary Root turns deliberately return `None`, so their history remains
/// visible only on the Coordinator page.
pub(crate) fn group_root_source_event_for_turn(
    session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<String>, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    let context = read_context_optional(&conn, session_id, turn_intent_id)?;
    Ok(context.and_then(|context| {
        context
            .group_root_source_event_id()
            .map(ToString::to_string)
    }))
}

/// Exact EventStore user-event ids whose only user-facing location is the
/// Team Group projection. The app-layer history loader uses this authority to
/// remove whole GroupRoot rounds from the ordinary Coordinator projection;
/// the durable EventStore rows themselves remain untouched for Provider
/// continuity and exact reply lookup.
#[doc(hidden)]
pub fn group_root_source_event_ids_for_session(
    session_id: &str,
) -> Result<std::collections::HashSet<String>, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    group_root_source_event_ids_for_session_with_connection(&conn, session_id)
}

fn group_root_source_event_ids_for_session_with_connection(
    conn: &Connection,
    session_id: &str,
) -> Result<std::collections::HashSet<String>, String> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT source_id
             FROM agent_org_runtime_turn_contexts
             WHERE session_id=?1 AND source_kind='group_root'
             ORDER BY context_id ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([session_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<std::collections::HashSet<_>>>()
        .map_err(|error| error.to_string())
}

/// User facts created before the dispatcher starts must not be appended a
/// second time by the generic turn processor.
pub(crate) fn pre_persisted_source_event_for_turn(
    session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<String>, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    let context = read_context_optional(&conn, session_id, turn_intent_id)?;
    Ok(context.and_then(|context| {
        context
            .direct_source_event_id()
            .or_else(|| context.group_root_source_event_id())
            .map(ToString::to_string)
    }))
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
    if context.turn_kind != AgentOrgTurnKind::TaskExecution
        && !(context.turn_kind == AgentOrgTurnKind::Coordinator
            && context.source_kind.is_coordinator_root())
    {
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
                activation_generation, coordinator_work_revision,
                coordinator_observed_task_ids_json,
                terminal_reason, created_at
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
    let observed_raw: String = row.get(16)?;
    let coordinator_observed_task_ids = serde_json::from_str(&observed_raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(16, rusqlite::types::Type::Text, error.into())
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
        coordinator_work_revision: row.get(15)?,
        coordinator_observed_task_ids,
        terminal_reason: row.get(17)?,
        created_at: row.get(18)?,
    })
}

/// Agent Org-owned restart reconciliation. Generic SDE recovery never joins
/// or queries the companion table. Started Coordinator Turns are failed
/// because their in-memory scheduler disappeared with the old process;
/// TaskExecution Turns remain available to exact task/process recovery.
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
                    context.activation_generation,
                    context.coordinator_work_revision,
                    context.coordinator_observed_task_ids_json,
                    context.terminal_reason,
                    context.created_at
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
    let abandoned = conn
        .execute(
            "UPDATE agent_org_runtime_member_intervention_turns AS chain
             SET status='abandoned',terminal_at=?1,failure_reason='app_restart_after_start'
             WHERE chain.status='running'
               AND EXISTS (
                   SELECT 1 FROM session_turn_intents intent
                   WHERE intent.session_id=chain.session_id
                     AND intent.turn_intent_id=chain.turn_intent_id
                     AND intent.status='running'
               )",
            [&now],
        )
        .map_err(|error| error.to_string())?;
    conn.execute(
        "UPDATE agent_org_member_turn_admissions AS admission
         SET status='unknown',reason_code='app_restart_after_start',
             terminal_at=?1,updated_at=?1
         WHERE admission.status='committed'
           AND EXISTS (
               SELECT 1 FROM agent_org_runtime_member_intervention_turns chain
               WHERE chain.session_id=admission.session_id
                 AND chain.turn_intent_id=admission.turn_intent_id
                 AND chain.status='abandoned'
                 AND chain.failure_reason='app_restart_after_start'
           )",
        [&now],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "UPDATE session_turn_intents AS intent
         SET status='failed',updated_at=?1
         WHERE intent.status='running'
           AND EXISTS (
               SELECT 1
               FROM agent_org_runtime_member_intervention_turns chain
                   WHERE chain.session_id=intent.session_id
                 AND chain.turn_intent_id=intent.turn_intent_id
                 AND chain.status='abandoned'
           )",
        [&now],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "UPDATE agent_org_runtime_member_interventions AS intervention
         SET failure_reason='user_directed_turn_abandoned_after_restart',updated_at=?1
         WHERE intervention.status IN ('yield_requested','active','return_requested')
           AND EXISTS (
               SELECT 1 FROM agent_org_runtime_member_intervention_turns chain
               WHERE chain.intervention_receipt_id=intervention.intervention_receipt_id
                 AND chain.status='abandoned'
           )",
        [&now],
    )
    .map_err(|error| error.to_string())?;
    // A Coordinator Turn is executed by this process's in-memory dialog
    // scheduler. Once that process has restarted there is no runtime that can
    // finish the Turn, so retaining it as `running` creates a permanent false
    // quiescence blocker. TaskExecution Turns are deliberately excluded here:
    // startup task recovery still needs their exact running binding, and an
    // owned subprocess can require the separate handoff/unknown-state path.
    let failed_coordinator_turns = conn
        .execute(
            "UPDATE session_turn_intents AS intent
             SET status='failed',updated_at=?1
             WHERE intent.org_run_id IS NOT NULL
               AND intent.status='running'
               AND EXISTS (
                   SELECT 1
                   FROM agent_org_runtime_turn_contexts context
                   WHERE context.session_id=intent.session_id
                     AND context.turn_intent_id=intent.turn_intent_id
                     AND context.turn_kind='coordinator'
               )",
            [&now],
        )
        .map_err(|error| error.to_string())?;
    // Historical builds could admit sibling TaskExecution Turns before an
    // exact execution lease existed. Prefer the live Turn named by the Task's
    // latest pending->in_progress provenance; only fall back to the newest
    // context when the old data contains no such proof.
    let marked_duplicate_task_contexts = conn
        .execute(
            "WITH live AS (
                 SELECT context.context_id,context.org_run_id,context.task_id,
                        context.activation_generation,context.session_id,
                        context.turn_intent_id,
                        ROW_NUMBER() OVER (
                            PARTITION BY context.org_run_id,context.task_id,
                                         context.activation_generation
                            ORDER BY
                              CASE WHEN EXISTS (
                                  SELECT 1
                                  FROM agent_org_runtime_task_events event
                                  WHERE event.org_run_id=context.org_run_id
                                    AND event.task_id=context.task_id
                                    AND event.previous_status='pending'
                                    AND event.next_status='in_progress'
                                    AND event.source_turn_intent_id=context.turn_intent_id
                                    AND event.rowid=(
                                        SELECT MAX(latest.rowid)
                                        FROM agent_org_runtime_task_events latest
                                        WHERE latest.org_run_id=context.org_run_id
                                          AND latest.task_id=context.task_id
                                          AND latest.previous_status='pending'
                                          AND latest.next_status='in_progress'
                                    )
                              ) THEN 0 ELSE 1 END,
                              context.context_id DESC
                        ) AS authority_rank
                 FROM agent_org_runtime_turn_contexts context
                 JOIN session_turn_intents intent
                   ON intent.session_id=context.session_id
                  AND intent.turn_intent_id=context.turn_intent_id
                 WHERE context.turn_kind='task_execution'
                   AND context.task_id IS NOT NULL
                   AND context.activation_generation IS NOT NULL
                   AND intent.status IN ('optimistic','queued','running')
             )
             INSERT OR IGNORE INTO agent_org_task_execution_reconciliations (
                 context_id,org_run_id,task_id,activation_generation,session_id,
                 turn_intent_id,disposition,reason_code,reconciled_at
             )
             SELECT context_id,org_run_id,task_id,activation_generation,session_id,
                    turn_intent_id,'conflict_rejected','duplicate_execution_rejected',?1
             FROM live WHERE authority_rank>1",
            [&now],
        )
        .map_err(|error| error.to_string())?;
    let failed_duplicate_task_turns = conn
        .execute(
            "UPDATE session_turn_intents AS intent
             SET status=CASE WHEN intent.status='running' THEN 'failed' ELSE 'stale' END,
                 updated_at=?1
             WHERE intent.org_run_id IS NOT NULL
               AND intent.status IN ('optimistic','queued','running')
               AND EXISTS (
                   SELECT 1 FROM agent_org_task_execution_reconciliations reconciliation
                   WHERE reconciliation.session_id=intent.session_id
                     AND reconciliation.turn_intent_id=intent.turn_intent_id
                     AND reconciliation.reason_code='duplicate_execution_rejected'
               )",
            [&now],
        )
        .map_err(|error| error.to_string())?;
    let runtime_absent_yields = conn
        .execute(
            "UPDATE agent_org_runtime_member_interventions
             SET status='active',yield_released_at=COALESCE(yield_released_at,?1),
                 failure_reason=COALESCE(failure_reason,'runtime_absent_after_restart'),
                 updated_at=?1
             WHERE status='yield_requested'",
            [&now],
        )
        .map_err(|error| error.to_string())?;
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
                   OR EXISTS (
                    SELECT 1
                    FROM agent_org_runtime_member_intervention_turns chain
                    JOIN agent_org_runtime_member_interventions intervention
                      ON intervention.intervention_receipt_id=chain.intervention_receipt_id
                    JOIN agent_org_runtime_turn_contexts context
                      ON context.session_id=chain.session_id
                     AND context.turn_intent_id=chain.turn_intent_id
                    JOIN agent_org_runtime_runs run ON run.id=context.org_run_id
                    WHERE chain.session_id=intent.session_id
                      AND chain.turn_intent_id=intent.turn_intent_id
                      AND chain.status='queued'
                      AND intervention.status IN ('yield_requested','active','return_requested')
                      AND context.turn_kind='user_directed_work'
                      AND context.source_kind='direct_member'
                      AND run.status IN ('running','idle','paused')
                   )
                   OR EXISTS (
                    SELECT 1
                    FROM agent_org_runtime_user_directed_deliveries delivery
                    JOIN agent_org_runtime_turn_contexts context
                      ON context.session_id=delivery.session_id
                     AND context.turn_intent_id=delivery.turn_intent_id
                    JOIN agent_org_runtime_runs run ON run.id=delivery.org_run_id
                    WHERE delivery.session_id=intent.session_id
                      AND delivery.turn_intent_id=intent.turn_intent_id
                      AND delivery.status='pending'
                      AND context.turn_kind='user_directed_work'
                      AND run.status IN ('running','idle','paused')
                   )
                   OR EXISTS (
                    SELECT 1
                    FROM agent_org_runtime_user_directed_coordinator_bindings binding
                    JOIN agent_org_runtime_turn_contexts context
                      ON context.session_id=binding.session_id
                     AND context.turn_intent_id=binding.turn_intent_id
                    JOIN agent_org_runtime_runs run ON run.id=binding.org_run_id
                    WHERE binding.session_id=intent.session_id
                      AND binding.turn_intent_id=intent.turn_intent_id
                      AND binding.status='pending'
                      AND context.turn_kind='coordinator'
                      AND context.source_kind='member_inbox'
                      AND run.status IN ('running','idle','paused')
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
    Ok(affected
        + abandoned
        + failed_coordinator_turns
        + marked_duplicate_task_contexts
        + failed_duplicate_task_turns
        + runtime_absent_yields)
}

fn invariant_error(message: String) -> String {
    format!("{TURN_CONTEXT_INVARIANT_PREFIX} {message}")
}

#[cfg(test)]
mod tests;
