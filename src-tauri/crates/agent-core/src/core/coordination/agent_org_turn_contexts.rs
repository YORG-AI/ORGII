//! Canonical Agent Org companion context and per-Member dispatch ordering.
//!
//! `session_turn_intents` remains the generic lifecycle owner. This module
//! atomically attaches the Agent Org-only execution identity and, for Member
//! turns, allocates the one FIFO sequence shared by every typed source.

use rusqlite::{params, Connection, OptionalExtension};

use crate::definitions::orgs::{validate_launch_snapshot, AgentOrgLaunchSnapshot};
use crate::foundation::session_bridge::{TurnIntentBridgeSource, TurnIntentBridgeStatus};

use super::agent_org_runs::{AgentOrgRunStatus, COORDINATOR_MEMBER_ID};

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
                  AND EXISTS (
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
