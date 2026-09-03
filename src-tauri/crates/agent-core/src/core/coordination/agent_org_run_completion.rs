//! Certificate-backed Agent Org outcomes.
//!
//! `org_run_complete` is only a candidate submission. This module is the
//! single transactional owner that proves the current episode's Task closure
//! and durable blockers before an outcome can be projected or idled.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::Digest;

use super::agent_org_runs::{
    guaranteed_current_turn_effects_with_connection, AgentOrgRunStatus, AgentOrgRunStore,
    COORDINATOR_MEMBER_ID,
};
use super::agent_org_tasks::{AgentOrgTaskStore, Task, TaskStatus};

const RUN_COMPLETION_VALIDATOR_VERSION: i64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RunCompletionOutcome {
    Delivered,
    Cancelled,
    Failed,
}

impl RunCompletionOutcome {
    pub const fn as_wire(self) -> &'static str {
        match self {
            Self::Delivered => "delivered",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }

    pub const fn last_activity_outcome(self) -> &'static str {
        match self {
            Self::Delivered => "completed",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        Ok(match value {
            "delivered" => Self::Delivered,
            "cancelled" => Self::Cancelled,
            "failed" => Self::Failed,
            other => return Err(format!("unknown RunCompletion outcome: {other}")),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCompletionCertificate {
    pub id: String,
    pub org_run_id: String,
    pub activation_generation: i64,
    pub work_revision: i64,
    pub request_id: String,
    pub request_digest: String,
    pub outcome: RunCompletionOutcome,
    pub summary: String,
    pub coordinator_session_id: String,
    pub coordinator_turn_intent_id: String,
    pub evidence_task_ids: Vec<String>,
    pub closure_task_ids: Vec<String>,
    pub task_output_refs: Vec<RunCompletionTaskOutputRef>,
    pub resolution_links: Vec<RunCompletionResolutionLink>,
    pub validator_version: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCompletionTaskOutputRef {
    pub task_id: String,
    pub output_digest: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunCompletionResolutionKind {
    CompletedOutput,
    Replacement,
    UserScopeRemoved,
    Cancelled,
    Failed,
    MissingOutput,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCompletionResolutionLink {
    pub task_id: String,
    pub kind: RunCompletionResolutionKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_by_task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_event_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct RunCompletionProof {
    closure_task_ids: Vec<String>,
    task_output_refs: Vec<RunCompletionTaskOutputRef>,
    resolution_links: Vec<RunCompletionResolutionLink>,
}

pub struct RunCompletionCandidate<'a> {
    pub request_id: &'a str,
    pub request_digest: &'a str,
    pub outcome: RunCompletionOutcome,
    pub summary: &'a str,
    pub evidence_task_ids: &'a [String],
    pub coordinator_session_id: &'a str,
    pub coordinator_turn_intent_id: &'a str,
    pub projected_inbox_ids: &'a [i64],
}

/// Read-only projection of whether a `delivered` candidate would pass the
/// certificate owner right now. This is guidance for the Coordinator, never
/// delivery authority: `certify_in_tx` always revalidates in its own
/// IMMEDIATE transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunCompletionCandidateState {
    Ready,
    Blocked,
    NotApplicable,
    Certified,
}

impl RunCompletionCandidateState {
    pub const fn as_wire(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Blocked => "blocked",
            Self::NotApplicable => "not_applicable",
            Self::Certified => "certified",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RunCompletionCandidateBlocker {
    RunUnavailable,
    StaleCoordinatorSnapshot,
    SessionsActive {
        count: usize,
        member_ids: Vec<String>,
    },
    CorruptTaskData {
        count: usize,
    },
    UnknownTurnIntents {
        count: usize,
    },
    PendingFormalMaterializations {
        count: usize,
    },
    ActiveRecoveryReservations {
        count: usize,
    },
    PendingPlanApprovals {
        count: usize,
    },
    UnreadInbox {
        count: usize,
    },
    InFlightTurnIntents {
        count: usize,
    },
    OpenTasks {
        count: usize,
        task_ids: Vec<String>,
    },
    UnresolvedTaskHandoffs {
        count: usize,
    },
    StaleCompletionCertificate {
        certificate_work_revision: i64,
        current_work_revision: i64,
    },
    TaskClosureIncomplete {
        count: usize,
        task_ids: Vec<String>,
    },
    InvalidScopeRemoval {
        task_ids: Vec<String>,
    },
    InvalidReplacementChain {
        task_ids: Vec<String>,
    },
    ValidationError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RunCompletionCandidateAssessment {
    pub state: RunCompletionCandidateState,
    pub checked_outcome: RunCompletionOutcome,
    pub activation_generation: Option<i64>,
    pub work_revision: Option<i64>,
    pub blockers: Vec<RunCompletionCandidateBlocker>,
}

impl RunCompletionCandidateAssessment {
    fn new(
        state: RunCompletionCandidateState,
        activation_generation: Option<i64>,
        work_revision: Option<i64>,
        blockers: Vec<RunCompletionCandidateBlocker>,
    ) -> Self {
        Self {
            state,
            checked_outcome: RunCompletionOutcome::Delivered,
            activation_generation,
            work_revision,
            blockers,
        }
    }

    fn validation_error() -> Self {
        Self::new(
            RunCompletionCandidateState::Blocked,
            None,
            None,
            vec![RunCompletionCandidateBlocker::ValidationError],
        )
    }
}

pub(crate) fn create_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_runtime_run_completion_certificates (
            id TEXT PRIMARY KEY,
            org_run_id TEXT NOT NULL,
            activation_generation INTEGER NOT NULL CHECK(activation_generation >= 1),
            work_revision INTEGER NOT NULL CHECK(work_revision >= 0),
            request_id TEXT NOT NULL CHECK(trim(request_id) <> ''),
            request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
            outcome TEXT NOT NULL CHECK(outcome IN ('delivered','cancelled','failed')),
            summary TEXT NOT NULL CHECK(trim(summary) <> ''),
            coordinator_session_id TEXT NOT NULL CHECK(trim(coordinator_session_id) <> ''),
            coordinator_turn_intent_id TEXT NOT NULL CHECK(trim(coordinator_turn_intent_id) <> ''),
            evidence_task_ids_json TEXT NOT NULL CHECK(json_valid(evidence_task_ids_json)=1 AND json_type(evidence_task_ids_json)='array'),
            closure_task_ids_json TEXT NOT NULL CHECK(json_valid(closure_task_ids_json)=1 AND json_type(closure_task_ids_json)='array'),
            task_output_refs_json TEXT NOT NULL CHECK(json_valid(task_output_refs_json)=1 AND json_type(task_output_refs_json)='array'),
            resolution_links_json TEXT NOT NULL CHECK(json_valid(resolution_links_json)=1 AND json_type(resolution_links_json)='array'),
            validator_version INTEGER NOT NULL CHECK(validator_version=1),
            created_at TEXT NOT NULL,
            UNIQUE(org_run_id, activation_generation),
            UNIQUE(org_run_id, activation_generation, request_id),
            FOREIGN KEY (org_run_id) REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_run_completion_certificates_turn
            ON agent_org_runtime_run_completion_certificates(
                coordinator_session_id,coordinator_turn_intent_id
            );",
    )
}

const COMPLETION_BLOCKER_ID_PREVIEW_LIMIT: usize = 16;

/// Assess the current episode with the same closure and blocker rules used by
/// `certify_in_tx`. Database corruption and unknown validation failures are
/// deliberately collapsed to a typed blocker so prompt construction fails
/// closed without leaking raw SQLite details to the provider.
pub fn assess_delivered_candidate_with_connection(
    conn: &Connection,
    org_run_id: &str,
    coordinator_session_id: &str,
    coordinator_turn_intent_id: &str,
    projected_inbox_ids: &[i64],
) -> RunCompletionCandidateAssessment {
    let result = AgentOrgRunStore::quiescence_assessment_with_connection(conn, org_run_id)
        .and_then(|quiescence| {
            try_assess_delivered_candidate_with_connection(
                conn,
                org_run_id,
                coordinator_session_id,
                coordinator_turn_intent_id,
                projected_inbox_ids,
                &quiescence,
            )
        });
    result.unwrap_or_else(|error| {
        tracing::warn!(
            org_run_id,
            error,
            "[agent_org_completion] delivered-candidate assessment failed closed"
        );
        RunCompletionCandidateAssessment::validation_error()
    })
}

pub fn assess_delivered_candidate_from_quiescence_with_connection(
    conn: &Connection,
    org_run_id: &str,
    coordinator_session_id: &str,
    coordinator_turn_intent_id: &str,
    projected_inbox_ids: &[i64],
    quiescence: &crate::coordination::agent_org_runs::AgentOrgQuiescenceAssessment,
) -> RunCompletionCandidateAssessment {
    try_assess_delivered_candidate_with_connection(
        conn,
        org_run_id,
        coordinator_session_id,
        coordinator_turn_intent_id,
        projected_inbox_ids,
        quiescence,
    )
    .unwrap_or_else(|error| {
        tracing::warn!(
            org_run_id,
            error,
            "[agent_org_completion] delivered-candidate assessment failed closed"
        );
        RunCompletionCandidateAssessment::validation_error()
    })
}

fn try_assess_delivered_candidate_with_connection(
    conn: &Connection,
    org_run_id: &str,
    coordinator_session_id: &str,
    coordinator_turn_intent_id: &str,
    projected_inbox_ids: &[i64],
    quiescence: &crate::coordination::agent_org_runs::AgentOrgQuiescenceAssessment,
) -> Result<RunCompletionCandidateAssessment, String> {
    let generation = quiescence.facts.activation_generation;
    let work_revision = quiescence
        .facts
        .progress
        .as_ref()
        .map(|progress| progress.work_revision);
    if quiescence.facts.run_status != Some(AgentOrgRunStatus::Running)
        || generation.is_none()
        || work_revision.is_none()
    {
        return Ok(RunCompletionCandidateAssessment::new(
            RunCompletionCandidateState::Blocked,
            generation,
            work_revision,
            vec![RunCompletionCandidateBlocker::RunUnavailable],
        ));
    }
    let generation = generation.expect("checked above");
    let work_revision = work_revision.expect("checked above");

    if let Some(certificate) = quiescence.facts.completion_certificate.as_ref() {
        if certificate.work_revision == work_revision {
            return Ok(RunCompletionCandidateAssessment::new(
                RunCompletionCandidateState::Certified,
                Some(generation),
                Some(work_revision),
                Vec::new(),
            ));
        }
        return Ok(RunCompletionCandidateAssessment::new(
            RunCompletionCandidateState::Blocked,
            Some(generation),
            Some(work_revision),
            vec![RunCompletionCandidateBlocker::StaleCompletionCertificate {
                certificate_work_revision: certificate.work_revision,
                current_work_revision: work_revision,
            }],
        ));
    }

    let (task_count, open_task_count): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN status IN ('pending','in_progress') THEN 1 ELSE 0 END),0)
             FROM agent_org_runtime_tasks
             WHERE org_run_id=?1 AND activation_generation=?2",
            params![org_run_id, generation],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| error.to_string())?;
    let task_count =
        usize::try_from(task_count).map_err(|_| "run_completion_task_count_invalid".to_string())?;
    let open_task_count = usize::try_from(open_task_count)
        .map_err(|_| "run_completion_open_task_count_invalid".to_string())?;
    if task_count == 0 {
        return Ok(RunCompletionCandidateAssessment::new(
            RunCompletionCandidateState::NotApplicable,
            Some(generation),
            Some(work_revision),
            Vec::new(),
        ));
    }

    let context = crate::coordination::agent_org_turn_contexts::require_context_with_connection(
        conn,
        coordinator_session_id,
        coordinator_turn_intent_id,
    );
    let context_is_current = context.is_ok_and(|context| {
        context.org_run_id == org_run_id
            && context.participant_id == COORDINATOR_MEMBER_ID
            && quiescence.facts.root_session_id.as_deref() == Some(coordinator_session_id)
            && context.turn_kind
                == crate::coordination::agent_org_turn_contexts::AgentOrgTurnKind::Coordinator
            && context.activation_generation == Some(generation)
            && context.coordinator_work_revision == Some(work_revision)
    });
    if !context_is_current {
        return Ok(RunCompletionCandidateAssessment::new(
            RunCompletionCandidateState::Blocked,
            Some(generation),
            Some(work_revision),
            vec![RunCompletionCandidateBlocker::StaleCoordinatorSnapshot],
        ));
    }

    let guaranteed = guaranteed_current_turn_effects_with_connection(
        conn,
        org_run_id,
        quiescence.facts.root_session_id.as_deref(),
        coordinator_session_id,
        coordinator_turn_intent_id,
        projected_inbox_ids,
    )?;
    let non_task_blockers = completion_non_task_blockers(quiescence, guaranteed);
    if !non_task_blockers.is_empty() {
        return Ok(RunCompletionCandidateAssessment::new(
            RunCompletionCandidateState::Blocked,
            Some(generation),
            Some(work_revision),
            non_task_blockers,
        ));
    }

    if open_task_count > 0 {
        let mut statement = conn
            .prepare(
                "SELECT id FROM agent_org_runtime_tasks
                 WHERE org_run_id=?1 AND activation_generation=?2
                   AND status IN ('pending','in_progress')
                 ORDER BY created_at,id LIMIT ?3",
            )
            .map_err(|error| error.to_string())?;
        let task_ids = statement
            .query_map(
                params![
                    org_run_id,
                    generation,
                    COMPLETION_BLOCKER_ID_PREVIEW_LIMIT as i64
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        return Ok(RunCompletionCandidateAssessment::new(
            RunCompletionCandidateState::Blocked,
            Some(generation),
            Some(work_revision),
            vec![RunCompletionCandidateBlocker::OpenTasks {
                count: open_task_count,
                task_ids,
            }],
        ));
    }

    let tasks = AgentOrgTaskStore::list_with_connection(conn, org_run_id)?
        .into_iter()
        .filter(|task| task.activation_generation == generation)
        .collect::<Vec<_>>();
    if quiescence.facts.unresolved_handoff_count > 0 {
        return Ok(RunCompletionCandidateAssessment::new(
            RunCompletionCandidateState::Blocked,
            Some(generation),
            Some(work_revision),
            vec![RunCompletionCandidateBlocker::UnresolvedTaskHandoffs {
                count: quiescence.facts.unresolved_handoff_count,
            }],
        ));
    }
    let blockers = match validate_outcome_closure(
        conn,
        org_run_id,
        RunCompletionOutcome::Delivered,
        &tasks,
        0,
    ) {
        Ok(_) => Vec::new(),
        Err(error) => candidate_blockers_from_closure_error(&error),
    };
    Ok(RunCompletionCandidateAssessment::new(
        if blockers.is_empty() {
            RunCompletionCandidateState::Ready
        } else {
            RunCompletionCandidateState::Blocked
        },
        Some(generation),
        Some(work_revision),
        blockers,
    ))
}

fn candidate_blockers_from_closure_error(error: &str) -> Vec<RunCompletionCandidateBlocker> {
    fn bounded_ids(raw: &str) -> (usize, Vec<String>) {
        let values = || {
            raw.split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
        };
        let count = values().count();
        let preview = values()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .take(COMPLETION_BLOCKER_ID_PREVIEW_LIMIT)
            .map(str::to_string)
            .collect();
        (count, preview)
    }

    if let Some(raw_ids) = error.strip_prefix("run_completion_delivery_closure_incomplete:") {
        let (count, task_ids) = bounded_ids(raw_ids);
        return vec![RunCompletionCandidateBlocker::TaskClosureIncomplete { count, task_ids }];
    }
    if let Some(task_id) = error
        .strip_prefix("run_completion_scope_removal_missing_source:")
        .or_else(|| error.strip_prefix("run_completion_scope_removal_source_invalid:"))
    {
        let (_, task_ids) = bounded_ids(task_id);
        return vec![RunCompletionCandidateBlocker::InvalidScopeRemoval { task_ids }];
    }
    if let Some(task_id) = error
        .strip_prefix("run_completion_replacement_chain_ambiguous:")
        .or_else(|| error.strip_prefix("run_completion_replacement_cycle:"))
    {
        let (_, task_ids) = bounded_ids(task_id);
        return vec![RunCompletionCandidateBlocker::InvalidReplacementChain { task_ids }];
    }
    if error == "run_completion_has_open_tasks" {
        return vec![RunCompletionCandidateBlocker::OpenTasks {
            count: 1,
            task_ids: Vec::new(),
        }];
    }
    vec![RunCompletionCandidateBlocker::ValidationError]
}

pub fn certify_in_tx(
    conn: &Connection,
    org_run_id: &str,
    candidate: RunCompletionCandidate<'_>,
) -> Result<RunCompletionCertificate, String> {
    validate_candidate_shape(&candidate)?;
    let run: Option<(String, i64, Option<String>)> = conn
        .query_row(
            "SELECT status,activation_generation,root_session_id
             FROM agent_org_runtime_runs WHERE id=?1",
            [org_run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((status, generation, root_session_id)) = run else {
        return Err(format!("agent_org_run_not_found:{org_run_id}"));
    };

    if let Some(existing) = load_current_with_connection(conn, org_run_id, generation)? {
        if existing.request_id == candidate.request_id
            && existing.request_digest == candidate.request_digest
        {
            crate::coordination::agent_org_final_summary::create_initial_for_certificate_in_tx(
                conn, &existing,
            )?;
            return Ok(existing);
        }
        return Err("run_completion_certificate_conflict".to_string());
    }
    if status != AgentOrgRunStatus::Running.as_str() {
        return Err(crate::coordination::agent_org_runs::mutation_blocked_error(
            org_run_id, &status,
        ));
    }
    if root_session_id.as_deref() != Some(candidate.coordinator_session_id) {
        return Err("run_completion_coordinator_not_canonical_root".to_string());
    }

    let work_revision: i64 = conn
        .query_row(
            "SELECT work_revision FROM agent_org_runtime_run_progress WHERE org_run_id=?1",
            [org_run_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("run_completion_progress_missing:{error}"))?;
    let context = crate::coordination::agent_org_turn_contexts::require_context_with_connection(
        conn,
        candidate.coordinator_session_id,
        candidate.coordinator_turn_intent_id,
    )?;
    if context.org_run_id != org_run_id
        || context.participant_id != COORDINATOR_MEMBER_ID
        || context.turn_kind
            != crate::coordination::agent_org_turn_contexts::AgentOrgTurnKind::Coordinator
        || context.activation_generation != Some(generation)
        || context.coordinator_work_revision != Some(work_revision)
    {
        return Err("run_completion_stale_coordinator_snapshot".to_string());
    }

    validate_non_task_blockers(
        conn,
        org_run_id,
        candidate.coordinator_session_id,
        candidate.coordinator_turn_intent_id,
        candidate.projected_inbox_ids,
    )?;

    let tasks = AgentOrgTaskStore::list_with_connection(conn, org_run_id)?
        .into_iter()
        .filter(|task| task.activation_generation == generation)
        .collect::<Vec<_>>();
    if tasks.is_empty() {
        return Err("run_completion_no_formal_tasks".to_string());
    }
    let task_ids = tasks
        .iter()
        .map(|task| task.id.as_str())
        .collect::<HashSet<_>>();
    if let Some(unknown) = candidate
        .evidence_task_ids
        .iter()
        .find(|task_id| !task_ids.contains(task_id.as_str()))
    {
        return Err(format!("run_completion_unknown_evidence_task:{unknown}"));
    }

    let handoff_blockers: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM agent_org_runtime_task_execution_handoffs
             WHERE org_run_id=?1 AND activation_generation=?2
               AND state IN ('requested','yielding','timeout','unknown','failed')
               AND resolution IS NULL",
            params![org_run_id, generation],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;

    let proof = validate_outcome_closure(
        conn,
        org_run_id,
        candidate.outcome,
        &tasks,
        handoff_blockers,
    )?;
    let evidence_json =
        serde_json::to_string(candidate.evidence_task_ids).map_err(|error| error.to_string())?;
    let closure_json =
        serde_json::to_string(&proof.closure_task_ids).map_err(|error| error.to_string())?;
    let task_output_refs_json =
        serde_json::to_string(&proof.task_output_refs).map_err(|error| error.to_string())?;
    let resolution_links_json =
        serde_json::to_string(&proof.resolution_links).map_err(|error| error.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_run_completion_certificates (
            id,org_run_id,activation_generation,work_revision,request_id,request_digest,
            outcome,summary,coordinator_session_id,coordinator_turn_intent_id,
            evidence_task_ids_json,closure_task_ids_json,task_output_refs_json,
            resolution_links_json,validator_version,created_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
        params![
            &id,
            org_run_id,
            generation,
            work_revision,
            candidate.request_id,
            candidate.request_digest,
            candidate.outcome.as_wire(),
            candidate.summary.trim(),
            candidate.coordinator_session_id,
            candidate.coordinator_turn_intent_id,
            &evidence_json,
            &closure_json,
            &task_output_refs_json,
            &resolution_links_json,
            RUN_COMPLETION_VALIDATOR_VERSION,
            &now,
        ],
    )
    .map_err(|error| error.to_string())?;
    persist_validated_outcome_in_tx(conn, org_run_id, generation, candidate.outcome, &now)?;
    let certificate = load_with_connection(conn, &id)?
        .ok_or_else(|| "run completion certificate disappeared".to_string())?;
    crate::coordination::agent_org_final_summary::create_initial_for_certificate_in_tx(
        conn,
        &certificate,
    )?;
    Ok(certificate)
}

/// Explicit user abandonment is itself a durable backend fact, so it can
/// produce a cancelled certificate without inventing a Coordinator message.
/// The caller must have atomically resolved the handoff and cancelled every
/// open Task in the current generation before invoking this owner.
pub(crate) fn certify_user_abandon_in_tx(
    conn: &Connection,
    org_run_id: &str,
    root_session_id: &str,
    handoff_receipt_id: &str,
) -> Result<RunCompletionCertificate, String> {
    let run: Option<(String, i64, Option<String>)> = conn
        .query_row(
            "SELECT status,activation_generation,root_session_id
             FROM agent_org_runtime_runs WHERE id=?1",
            [org_run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((status, generation, persisted_root)) = run else {
        return Err(format!("agent_org_run_not_found:{org_run_id}"));
    };
    if status != AgentOrgRunStatus::Running.as_str()
        || persisted_root.as_deref() != Some(root_session_id)
    {
        return Err("run_completion_user_abandon_authority_invalid".to_string());
    }
    if let Some(existing) = load_current_with_connection(conn, org_run_id, generation)? {
        if existing.outcome == RunCompletionOutcome::Cancelled
            && existing.request_id == format!("user_handoff:{handoff_receipt_id}")
        {
            crate::coordination::agent_org_final_summary::create_initial_for_certificate_in_tx(
                conn, &existing,
            )?;
            return Ok(existing);
        }
        return Err("run_completion_certificate_conflict".to_string());
    }
    let receipt: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT state,resolution
             FROM agent_org_runtime_task_execution_handoffs
             WHERE id=?1 AND org_run_id=?2 AND activation_generation=?3",
            params![handoff_receipt_id, org_run_id, generation],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if receipt.is_none_or(|(_, resolution)| resolution.as_deref() != Some("abandon_episode")) {
        return Err("run_completion_user_abandon_receipt_invalid".to_string());
    }
    let tasks = AgentOrgTaskStore::list_with_connection(conn, org_run_id)?
        .into_iter()
        .filter(|task| task.activation_generation == generation)
        .collect::<Vec<_>>();
    if tasks.is_empty() || tasks.iter().any(|task| task.status.is_open()) {
        return Err("run_completion_user_abandon_has_open_tasks".to_string());
    }
    let unresolved_handoffs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_task_execution_handoffs
             WHERE org_run_id=?1 AND activation_generation=?2
               AND state IN ('requested','yielding','timeout','unknown','failed')
               AND resolution IS NULL",
            params![org_run_id, generation],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if unresolved_handoffs != 0 {
        return Err("run_completion_user_abandon_has_unresolved_handoffs".to_string());
    }
    let work_revision: i64 = conn
        .query_row(
            "SELECT work_revision FROM agent_org_runtime_run_progress WHERE org_run_id=?1",
            [org_run_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let mut proof = RunCompletionProof::default();
    for task in &tasks {
        let (kind, resolved_by_task_id) = match task.status {
            TaskStatus::Completed => {
                proof.closure_task_ids.push(task.id.clone());
                proof.task_output_refs.push(task_output_ref(task)?);
                (
                    RunCompletionResolutionKind::CompletedOutput,
                    Some(task.id.clone()),
                )
            }
            TaskStatus::Cancelled => (RunCompletionResolutionKind::Cancelled, None),
            TaskStatus::Failed => (RunCompletionResolutionKind::Failed, None),
            TaskStatus::Pending | TaskStatus::InProgress => {
                unreachable!("open user-abandon Tasks were rejected")
            }
        };
        proof.resolution_links.push(RunCompletionResolutionLink {
            task_id: task.id.clone(),
            kind,
            resolved_by_task_id,
            source_event_id: None,
        });
    }
    let proof = normalize_proof(proof);
    let request_id = format!("user_handoff:{handoff_receipt_id}");
    let digest = format!("{:x}", sha2::Sha256::digest(request_id.as_bytes()));
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_run_completion_certificates (
            id,org_run_id,activation_generation,work_revision,request_id,request_digest,
            outcome,summary,coordinator_session_id,coordinator_turn_intent_id,
            evidence_task_ids_json,closure_task_ids_json,task_output_refs_json,
            resolution_links_json,validator_version,created_at
         ) VALUES (?1,?2,?3,?4,?5,?6,'cancelled',?7,?8,?9,'[]',?10,?11,?12,
                   ?13,?14)",
        params![
            &id,
            org_run_id,
            generation,
            work_revision,
            &request_id,
            &digest,
            "User abandoned the current Task episode",
            root_session_id,
            format!("user_handoff:{handoff_receipt_id}"),
            serde_json::to_string(&proof.closure_task_ids).map_err(|error| error.to_string())?,
            serde_json::to_string(&proof.task_output_refs).map_err(|error| error.to_string())?,
            serde_json::to_string(&proof.resolution_links).map_err(|error| error.to_string())?,
            RUN_COMPLETION_VALIDATOR_VERSION,
            &now,
        ],
    )
    .map_err(|error| error.to_string())?;
    persist_validated_outcome_in_tx(
        conn,
        org_run_id,
        generation,
        RunCompletionOutcome::Cancelled,
        &now,
    )?;
    let certificate = load_with_connection(conn, &id)?
        .ok_or_else(|| "run completion certificate disappeared".to_string())?;
    crate::coordination::agent_org_final_summary::create_initial_for_certificate_in_tx(
        conn,
        &certificate,
    )?;
    Ok(certificate)
}

fn persist_validated_outcome_in_tx(
    conn: &Connection,
    org_run_id: &str,
    activation_generation: i64,
    outcome: RunCompletionOutcome,
    now: &str,
) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE agent_org_runtime_runs
             SET last_activity_outcome=?1,updated_at=?2
             WHERE id=?3 AND status='running' AND activation_generation=?4",
            params![
                outcome.last_activity_outcome(),
                now,
                org_run_id,
                activation_generation,
            ],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 {
        return Err("run_completion_outcome_commit_stale".to_string());
    }
    Ok(())
}

fn validate_candidate_shape(candidate: &RunCompletionCandidate<'_>) -> Result<(), String> {
    let summary = candidate.summary.trim();
    if candidate.request_id.trim().is_empty()
        || candidate.request_digest.len() != 64
        || !candidate
            .request_digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        || summary.is_empty()
        || summary.chars().count()
            > crate::coordination::agent_org_payload_limits::TASK_OUTPUT_SUMMARY_MAX_CHARS
        || summary.len()
            > crate::coordination::agent_org_payload_limits::TASK_OUTPUT_SUMMARY_MAX_BYTES
    {
        return Err("run_completion_candidate_invalid".to_string());
    }
    if candidate.evidence_task_ids.len() > 32 {
        return Err("run_completion_evidence_task_limit_exceeded".to_string());
    }
    let mut unique = HashSet::new();
    if candidate
        .evidence_task_ids
        .iter()
        .any(|task_id| task_id.trim().is_empty() || !unique.insert(task_id.as_str()))
    {
        return Err("run_completion_evidence_task_ids_invalid".to_string());
    }
    Ok(())
}

fn validate_non_task_blockers(
    conn: &Connection,
    org_run_id: &str,
    coordinator_session_id: &str,
    coordinator_turn_intent_id: &str,
    projected_inbox_ids: &[i64],
) -> Result<(), String> {
    let assessment = AgentOrgRunStore::quiescence_assessment_with_connection(conn, org_run_id)?;
    let guaranteed = guaranteed_current_turn_effects_with_connection(
        conn,
        org_run_id,
        assessment.facts.root_session_id.as_deref(),
        coordinator_session_id,
        coordinator_turn_intent_id,
        projected_inbox_ids,
    )?;
    if !completion_non_task_blockers(&assessment, guaranteed).is_empty() {
        return Err("run_completion_has_durable_blockers".to_string());
    }
    Ok(())
}

fn completion_non_task_blockers(
    assessment: &crate::coordination::agent_org_runs::AgentOrgQuiescenceAssessment,
    guaranteed: crate::coordination::agent_org_runs::AgentOrgGuaranteedTurnEffects,
) -> Vec<RunCompletionCandidateBlocker> {
    let mut blockers = Vec::new();
    let terminal_member_ids = guaranteed
        .terminal_member_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let active_non_root = assessment
        .facts
        .worker_sessions
        .iter()
        .filter(|session| {
            !matches!(
                session.status,
                crate::session::SessionStatus::Idle
                    | crate::session::SessionStatus::Completed
                    | crate::session::SessionStatus::Failed
                    | crate::session::SessionStatus::Cancelled
            ) && session
                .member_id
                .as_deref()
                .is_none_or(|member_id| !terminal_member_ids.contains(member_id))
        })
        .count();
    if active_non_root > 0 {
        blockers.push(RunCompletionCandidateBlocker::SessionsActive {
            count: active_non_root,
            member_ids: assessment
                .facts
                .active_member_ids()
                .into_iter()
                .filter(|member_id| !terminal_member_ids.contains(member_id.as_str()))
                .take(COMPLETION_BLOCKER_ID_PREVIEW_LIMIT)
                .collect(),
        });
    }
    if assessment.facts.corrupt_task_count > 0 {
        blockers.push(RunCompletionCandidateBlocker::CorruptTaskData {
            count: assessment.facts.corrupt_task_count,
        });
    }
    if assessment.facts.unknown_turn_intent_count > 0 {
        blockers.push(RunCompletionCandidateBlocker::UnknownTurnIntents {
            count: assessment.facts.unknown_turn_intent_count,
        });
    }
    if assessment.facts.pending_formal_materialization_count > 0 {
        blockers.push(
            RunCompletionCandidateBlocker::PendingFormalMaterializations {
                count: assessment.facts.pending_formal_materialization_count,
            },
        );
    }
    if assessment.facts.active_recovery_reservation_count > 0 {
        blockers.push(RunCompletionCandidateBlocker::ActiveRecoveryReservations {
            count: assessment.facts.active_recovery_reservation_count,
        });
    }
    if assessment.facts.pending_plan_approval_count > 0 {
        blockers.push(RunCompletionCandidateBlocker::PendingPlanApprovals {
            count: assessment.facts.pending_plan_approval_count,
        });
    }
    let unread_inbox_count = assessment
        .facts
        .blocking_unread_inbox_count
        .saturating_sub(guaranteed.unread_inbox_rows);
    if unread_inbox_count > 0 {
        blockers.push(RunCompletionCandidateBlocker::UnreadInbox {
            count: unread_inbox_count,
        });
    }
    let in_flight_turn_intent_count = assessment.facts.in_flight_turn_intent_count.saturating_sub(
        guaranteed
            .in_flight_turn_intents
            .saturating_add(guaranteed.terminal_worker_turn_intents),
    );
    if in_flight_turn_intent_count > 0 {
        blockers.push(RunCompletionCandidateBlocker::InFlightTurnIntents {
            count: in_flight_turn_intent_count,
        });
    }
    blockers
}

fn validate_outcome_closure(
    conn: &Connection,
    org_run_id: &str,
    outcome: RunCompletionOutcome,
    tasks: &[Task],
    handoff_blockers: i64,
) -> Result<RunCompletionProof, String> {
    if tasks.iter().any(|task| task.status.is_open()) {
        return Err("run_completion_has_open_tasks".to_string());
    }
    let mut children: HashMap<&str, Vec<&Task>> = HashMap::new();
    for task in tasks {
        if let Some(parent) = task.replaces_task_id.as_deref() {
            children.entry(parent).or_default().push(task);
        }
    }
    let mut proof = RunCompletionProof::default();
    let mut unresolved_terminal = Vec::new();
    for task in tasks {
        match task.status {
            TaskStatus::Completed if task.output.is_some() => {
                proof.closure_task_ids.push(task.id.clone());
                proof.task_output_refs.push(task_output_ref(task)?);
                proof.resolution_links.push(RunCompletionResolutionLink {
                    task_id: task.id.clone(),
                    kind: RunCompletionResolutionKind::CompletedOutput,
                    resolved_by_task_id: Some(task.id.clone()),
                    source_event_id: None,
                });
            }
            TaskStatus::Completed => {
                unresolved_terminal.push(task.id.clone());
                proof.resolution_links.push(RunCompletionResolutionLink {
                    task_id: task.id.clone(),
                    kind: RunCompletionResolutionKind::MissingOutput,
                    resolved_by_task_id: None,
                    source_event_id: None,
                });
            }
            TaskStatus::Cancelled | TaskStatus::Failed => {
                let reason = task.cancel_reason.as_ref().or(task.failure_reason.as_ref());
                if reason.is_some_and(|reason| reason.code == "user_scope_removed") {
                    let source_event_id = reason
                        .and_then(|reason| reason.source_event_id.as_deref())
                        .ok_or_else(|| {
                            format!("run_completion_scope_removal_missing_source:{}", task.id)
                        })?;
                    if !valid_team_user_event(conn, org_run_id, source_event_id)? {
                        return Err(format!(
                            "run_completion_scope_removal_source_invalid:{}",
                            task.id
                        ));
                    }
                    proof.resolution_links.push(RunCompletionResolutionLink {
                        task_id: task.id.clone(),
                        kind: RunCompletionResolutionKind::UserScopeRemoved,
                        resolved_by_task_id: None,
                        source_event_id: Some(source_event_id.to_string()),
                    });
                    continue;
                }
                if let Some(completed) = replacement_chain_completed(task.id.as_str(), &children)? {
                    proof.closure_task_ids.push(completed.id.clone());
                    proof.task_output_refs.push(task_output_ref(completed)?);
                    proof.resolution_links.push(RunCompletionResolutionLink {
                        task_id: task.id.clone(),
                        kind: RunCompletionResolutionKind::Replacement,
                        resolved_by_task_id: Some(completed.id.clone()),
                        source_event_id: None,
                    });
                } else {
                    unresolved_terminal.push(task.id.clone());
                    proof.resolution_links.push(RunCompletionResolutionLink {
                        task_id: task.id.clone(),
                        kind: if task.status == TaskStatus::Cancelled {
                            RunCompletionResolutionKind::Cancelled
                        } else {
                            RunCompletionResolutionKind::Failed
                        },
                        resolved_by_task_id: None,
                        source_event_id: None,
                    });
                }
            }
            TaskStatus::Pending | TaskStatus::InProgress => unreachable!("checked above"),
        }
    }

    match outcome {
        RunCompletionOutcome::Delivered => {
            if handoff_blockers > 0 || !unresolved_terminal.is_empty() {
                return Err(format!(
                    "run_completion_delivery_closure_incomplete:{}",
                    unresolved_terminal.join(",")
                ));
            }
        }
        RunCompletionOutcome::Cancelled => {
            let has_cancelled = tasks
                .iter()
                .any(|task| task.status == TaskStatus::Cancelled);
            let has_failed = tasks.iter().any(|task| task.status == TaskStatus::Failed);
            if !has_cancelled || has_failed || handoff_blockers > 0 {
                return Err("run_completion_cancelled_outcome_invalid".to_string());
            }
        }
        RunCompletionOutcome::Failed => {
            if handoff_blockers > 0 {
                return Err("run_completion_failed_outcome_has_open_handoff".to_string());
            }
            let has_failed = tasks.iter().any(|task| task.status == TaskStatus::Failed);
            if !has_failed {
                return Err("run_completion_failed_outcome_has_no_failure".to_string());
            }
        }
    }
    Ok(normalize_proof(proof))
}

fn normalize_proof(mut proof: RunCompletionProof) -> RunCompletionProof {
    proof.closure_task_ids.sort();
    proof.closure_task_ids.dedup();
    proof.task_output_refs.sort_by(|left, right| {
        left.task_id
            .cmp(&right.task_id)
            .then_with(|| left.output_digest.cmp(&right.output_digest))
    });
    proof.task_output_refs.dedup();
    proof
        .resolution_links
        .sort_by(|left, right| left.task_id.cmp(&right.task_id));
    proof
}

fn task_output_ref(task: &Task) -> Result<RunCompletionTaskOutputRef, String> {
    let output = task
        .output
        .as_ref()
        .ok_or_else(|| format!("run_completion_task_output_missing:{}", task.id))?;
    let canonical = serde_json::to_vec(output).map_err(|error| error.to_string())?;
    Ok(RunCompletionTaskOutputRef {
        task_id: task.id.clone(),
        output_digest: format!("{:x}", sha2::Sha256::digest(canonical)),
    })
}

fn replacement_chain_completed<'a>(
    task_id: &str,
    children: &HashMap<&str, Vec<&'a Task>>,
) -> Result<Option<&'a Task>, String> {
    let mut current = task_id;
    let mut visited = HashSet::new();
    while visited.insert(current) {
        let Some(next) = children.get(current) else {
            return Ok(None);
        };
        if next.len() != 1 {
            return Err(format!(
                "run_completion_replacement_chain_ambiguous:{current}"
            ));
        }
        let next = next[0];
        match next.status {
            TaskStatus::Completed if next.output.is_some() => return Ok(Some(next)),
            TaskStatus::Completed => return Ok(None),
            TaskStatus::Cancelled | TaskStatus::Failed => current = next.id.as_str(),
            TaskStatus::Pending | TaskStatus::InProgress => return Ok(None),
        }
    }
    Err(format!("run_completion_replacement_cycle:{task_id}"))
}

pub(crate) fn valid_team_user_event(
    conn: &Connection,
    org_run_id: &str,
    event_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "WITH RECURSIVE team_sessions(session_id) AS (
             SELECT root_session_id FROM agent_org_runtime_runs WHERE id=?1
             UNION ALL
             SELECT child.session_id
             FROM agent_sessions child
             JOIN team_sessions parent ON child.parent_session_id=parent.session_id
         )
         SELECT EXISTS(
             SELECT 1 FROM events event
             JOIN team_sessions team ON team.session_id=event.session_id
             WHERE event.id=?2 AND event.function_name='user_message'
               AND event.event_type='raw'
               AND json_extract(event.meta_json,'$.source')='user'
         )",
        params![org_run_id, event_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

pub fn load_current_with_connection(
    conn: &Connection,
    org_run_id: &str,
    generation: i64,
) -> Result<Option<RunCompletionCertificate>, String> {
    conn.query_row(
        &format!(
            "SELECT {CERTIFICATE_COLUMNS}
             FROM agent_org_runtime_run_completion_certificates
             WHERE org_run_id=?1 AND activation_generation=?2"
        ),
        params![org_run_id, generation],
        decode_certificate,
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub fn load_with_connection(
    conn: &Connection,
    certificate_id: &str,
) -> Result<Option<RunCompletionCertificate>, String> {
    conn.query_row(
        &format!(
            "SELECT {CERTIFICATE_COLUMNS}
             FROM agent_org_runtime_run_completion_certificates WHERE id=?1"
        ),
        [certificate_id],
        decode_certificate,
    )
    .optional()
    .map_err(|error| error.to_string())
}

const CERTIFICATE_COLUMNS: &str = "id,org_run_id,activation_generation,work_revision,
    request_id,request_digest,outcome,summary,coordinator_session_id,
    coordinator_turn_intent_id,evidence_task_ids_json,closure_task_ids_json,
    task_output_refs_json,resolution_links_json,validator_version,created_at";

fn decode_certificate(row: &rusqlite::Row<'_>) -> rusqlite::Result<RunCompletionCertificate> {
    let outcome_raw: String = row.get(6)?;
    let evidence_raw: String = row.get(10)?;
    let closure_raw: String = row.get(11)?;
    let task_output_refs_raw: String = row.get(12)?;
    let resolution_links_raw: String = row.get(13)?;
    Ok(RunCompletionCertificate {
        id: row.get(0)?,
        org_run_id: row.get(1)?,
        activation_generation: row.get(2)?,
        work_revision: row.get(3)?,
        request_id: row.get(4)?,
        request_digest: row.get(5)?,
        outcome: RunCompletionOutcome::parse(&outcome_raw).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, error.into())
        })?,
        summary: row.get(7)?,
        coordinator_session_id: row.get(8)?,
        coordinator_turn_intent_id: row.get(9)?,
        evidence_task_ids: serde_json::from_str(&evidence_raw).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(10, rusqlite::types::Type::Text, error.into())
        })?,
        closure_task_ids: serde_json::from_str(&closure_raw).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(11, rusqlite::types::Type::Text, error.into())
        })?,
        task_output_refs: serde_json::from_str(&task_output_refs_raw).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(12, rusqlite::types::Type::Text, error.into())
        })?,
        resolution_links: serde_json::from_str(&resolution_links_raw).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(13, rusqlite::types::Type::Text, error.into())
        })?,
        validator_version: row.get(14)?,
        created_at: row.get(15)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coordination::agent_org_tasks::{TaskExecutionMode, TaskOutput, TaskTerminalReason};

    fn task(id: &str, status: TaskStatus) -> Task {
        let terminal_reason = TaskTerminalReason {
            code: "execution.failed".to_string(),
            message: "fixture terminal reason".to_string(),
            source_event_id: None,
        };
        Task {
            id: id.to_string(),
            org_run_id: "run".to_string(),
            activation_generation: 1,
            subject: id.to_string(),
            description: String::new(),
            active_form: None,
            owner: Some("member".to_string()),
            status,
            execution_mode: TaskExecutionMode::Build,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: None,
            output: (status == TaskStatus::Completed).then(|| TaskOutput {
                summary: "done".to_string(),
                content: None,
                artifact_ids: Vec::new(),
                plan_revision_id: None,
                produced_by_member_id: "member".to_string(),
                produced_at: "2026-08-27T00:00:00Z".to_string(),
            }),
            failure_reason: (status == TaskStatus::Failed).then(|| terminal_reason.clone()),
            cancel_reason: (status == TaskStatus::Cancelled).then_some(terminal_reason),
            created_by_participant_id: "coordinator".to_string(),
            source_turn_intent_id: "turn".to_string(),
            originating_message_id: None,
            replaces_task_id: None,
            created_at: "2026-08-27T00:00:00Z".to_string(),
            updated_at: "2026-08-27T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn delivered_requires_output_backed_terminal_closure() {
        let conn = Connection::open_in_memory().unwrap();
        let completed = task("completed", TaskStatus::Completed);
        assert_eq!(
            validate_outcome_closure(
                &conn,
                "run",
                RunCompletionOutcome::Delivered,
                std::slice::from_ref(&completed),
                0,
            )
            .unwrap()
            .closure_task_ids,
            vec!["completed"]
        );

        let mut missing_output = completed;
        missing_output.output = None;
        assert_eq!(
            validate_outcome_closure(
                &conn,
                "run",
                RunCompletionOutcome::Delivered,
                &[missing_output],
                0,
            )
            .unwrap_err(),
            "run_completion_delivery_closure_incomplete:completed"
        );

        let cancelled = task("cancelled", TaskStatus::Cancelled);
        assert_eq!(
            validate_outcome_closure(
                &conn,
                "run",
                RunCompletionOutcome::Delivered,
                &[cancelled],
                0,
            )
            .unwrap_err(),
            "run_completion_delivery_closure_incomplete:cancelled"
        );
    }

    #[test]
    fn replacement_chain_absorbs_old_terminal_work_only_when_final_output_exists() {
        let conn = Connection::open_in_memory().unwrap();
        let old = task("old", TaskStatus::Cancelled);
        let mut replacement = task("replacement", TaskStatus::Completed);
        replacement.replaces_task_id = Some("old".to_string());
        assert_eq!(
            validate_outcome_closure(
                &conn,
                "run",
                RunCompletionOutcome::Delivered,
                &[old.clone(), replacement.clone()],
                0,
            )
            .unwrap()
            .closure_task_ids,
            vec!["replacement"]
        );

        replacement.output = None;
        assert_eq!(
            validate_outcome_closure(
                &conn,
                "run",
                RunCompletionOutcome::Delivered,
                &[old, replacement],
                0,
            )
            .unwrap_err(),
            "run_completion_delivery_closure_incomplete:old,replacement"
        );
    }

    #[test]
    fn outcome_kind_cannot_relabel_terminal_facts() {
        let conn = Connection::open_in_memory().unwrap();
        assert_eq!(
            validate_outcome_closure(
                &conn,
                "run",
                RunCompletionOutcome::Cancelled,
                &[task("failed", TaskStatus::Failed)],
                0,
            )
            .unwrap_err(),
            "run_completion_cancelled_outcome_invalid"
        );
        assert_eq!(
            validate_outcome_closure(
                &conn,
                "run",
                RunCompletionOutcome::Failed,
                &[task("completed", TaskStatus::Completed)],
                0,
            )
            .unwrap_err(),
            "run_completion_failed_outcome_has_no_failure"
        );
        assert_eq!(
            validate_outcome_closure(
                &conn,
                "run",
                RunCompletionOutcome::Failed,
                &[task("failed", TaskStatus::Failed)],
                1,
            )
            .unwrap_err(),
            "run_completion_failed_outcome_has_open_handoff"
        );
    }

    #[test]
    fn user_scope_removal_requires_exact_team_user_event() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE agent_org_runtime_runs(id TEXT PRIMARY KEY,root_session_id TEXT);
             CREATE TABLE agent_sessions(session_id TEXT PRIMARY KEY,parent_session_id TEXT);
             CREATE TABLE events(
                 id TEXT PRIMARY KEY,session_id TEXT,event_type TEXT,
                 function_name TEXT,meta_json TEXT
             );
             INSERT INTO agent_org_runtime_runs(id,root_session_id) VALUES ('run','root');
             INSERT INTO agent_sessions(session_id,parent_session_id) VALUES ('root',NULL);
             INSERT INTO events(id,session_id,event_type,function_name,meta_json)
             VALUES ('user-event','root','raw','user_message','{\"source\":\"user\"}'),
                    ('assistant-event','root','raw','assistant_message','{\"source\":\"assistant\"}');",
        )
        .unwrap();

        let mut removed = task("removed", TaskStatus::Cancelled);
        removed.cancel_reason = Some(TaskTerminalReason {
            code: "user_scope_removed".to_string(),
            message: "user removed this item".to_string(),
            source_event_id: Some("assistant-event".to_string()),
        });
        assert_eq!(
            validate_outcome_closure(
                &conn,
                "run",
                RunCompletionOutcome::Delivered,
                &[removed.clone()],
                0,
            )
            .unwrap_err(),
            "run_completion_scope_removal_source_invalid:removed"
        );

        removed.cancel_reason.as_mut().unwrap().source_event_id = Some("user-event".to_string());
        assert!(validate_outcome_closure(
            &conn,
            "run",
            RunCompletionOutcome::Delivered,
            &[removed],
            0,
        )
        .unwrap()
        .closure_task_ids
        .is_empty());
    }

    #[test]
    fn candidate_digest_and_evidence_are_canonical() {
        let evidence = vec!["task".to_string()];
        let candidate = RunCompletionCandidate {
            request_id: "call",
            request_digest: &"A".repeat(64),
            outcome: RunCompletionOutcome::Delivered,
            summary: "done",
            evidence_task_ids: &evidence,
            coordinator_session_id: "root",
            coordinator_turn_intent_id: "turn",
            projected_inbox_ids: &[],
        };
        assert_eq!(
            validate_candidate_shape(&candidate).unwrap_err(),
            "run_completion_candidate_invalid"
        );

        let duplicates = vec!["task".to_string(), "task".to_string()];
        let candidate = RunCompletionCandidate {
            request_digest: &"a".repeat(64),
            evidence_task_ids: &duplicates,
            ..candidate
        };
        assert_eq!(
            validate_candidate_shape(&candidate).unwrap_err(),
            "run_completion_evidence_task_ids_invalid"
        );
    }

    #[test]
    fn validated_outcome_is_owned_by_the_certificate_transaction() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE agent_org_runtime_runs(
                 id TEXT PRIMARY KEY,status TEXT,activation_generation INTEGER,
                 last_activity_outcome TEXT,updated_at TEXT
             );
             INSERT INTO agent_org_runtime_runs
                 VALUES ('run','running',1,NULL,'before');",
        )
        .unwrap();

        let tx = conn.transaction().unwrap();
        persist_validated_outcome_in_tx(&tx, "run", 1, RunCompletionOutcome::Cancelled, "during")
            .unwrap();
        assert_eq!(
            tx.query_row(
                "SELECT last_activity_outcome FROM agent_org_runtime_runs WHERE id='run'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "cancelled"
        );
        tx.rollback().unwrap();
        assert!(conn
            .query_row(
                "SELECT last_activity_outcome FROM agent_org_runtime_runs WHERE id='run'",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
            .unwrap()
            .is_none());

        persist_validated_outcome_in_tx(
            &conn,
            "run",
            1,
            RunCompletionOutcome::Delivered,
            "committed",
        )
        .unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT last_activity_outcome FROM agent_org_runtime_runs WHERE id='run'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "completed"
        );
        assert_eq!(
            persist_validated_outcome_in_tx(
                &conn,
                "run",
                2,
                RunCompletionOutcome::Failed,
                "stale",
            )
            .unwrap_err(),
            "run_completion_outcome_commit_stale"
        );
    }

    #[test]
    fn certificate_request_replay_is_read_only_and_digest_conflict_fails_closed() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE agent_org_runtime_runs(
                 id TEXT PRIMARY KEY,status TEXT,activation_generation INTEGER,
                 root_session_id TEXT
             );
             INSERT INTO agent_org_runtime_runs
                 VALUES ('run','running',1,'root');",
        )
        .unwrap();
        create_schema(&conn).unwrap();
        crate::coordination::agent_inbox::create_schema(&conn).unwrap();
        crate::coordination::agent_org_tasks::create_schema(&conn).unwrap();
        crate::coordination::agent_org_formal_triggers::create_schema(&conn).unwrap();
        crate::coordination::agent_org_final_summary::create_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO agent_org_runtime_run_completion_certificates(
                 id,org_run_id,activation_generation,work_revision,request_id,request_digest,
                 outcome,summary,coordinator_session_id,coordinator_turn_intent_id,
                 evidence_task_ids_json,closure_task_ids_json,task_output_refs_json,
                 resolution_links_json,validator_version,created_at
             ) VALUES ('certificate','run',1,7,'call',?1,'delivered','done',
                       'root','turn','[\"task\"]','[\"task\"]',
                       '[]',
                       '[{\"taskId\":\"task\",\"kind\":\"completed_output\",\"resolvedByTaskId\":\"task\"}]',
                       1,'2026-08-27T00:00:00Z')",
            [&"a".repeat(64)],
        )
        .unwrap();
        let evidence = vec!["task".to_string()];
        let replay = certify_in_tx(
            &conn,
            "run",
            RunCompletionCandidate {
                request_id: "call",
                request_digest: &"a".repeat(64),
                outcome: RunCompletionOutcome::Delivered,
                summary: "done",
                evidence_task_ids: &evidence,
                coordinator_session_id: "root",
                coordinator_turn_intent_id: "turn",
                projected_inbox_ids: &[],
            },
        )
        .unwrap();
        assert_eq!(replay.id, "certificate");
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_org_runtime_run_completion_certificates",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);

        let conflict = certify_in_tx(
            &conn,
            "run",
            RunCompletionCandidate {
                request_digest: &"b".repeat(64),
                request_id: "call",
                outcome: RunCompletionOutcome::Delivered,
                summary: "different",
                evidence_task_ids: &evidence,
                coordinator_session_id: "root",
                coordinator_turn_intent_id: "turn",
                projected_inbox_ids: &[],
            },
        )
        .unwrap_err();
        assert_eq!(conflict, "run_completion_certificate_conflict");
    }
}
