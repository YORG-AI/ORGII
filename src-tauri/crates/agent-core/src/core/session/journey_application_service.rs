//! Deterministic application boundary for Session Journey lifecycle actions.
//!
//! Desktop, Tauri, and Gateway adapters construct these requests themselves.
//! This module only validates durable coordinates and drives the aggregate;
//! it never asks a provider to interpret a command or manufacture a review.

use std::fmt;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::core::journey_lifecycle::{
    HandoffCapsule, JourneyError, ReviewItem, RuntimeProvenance, SessionJourney,
    SqliteJourneyRepository, TaskOutcome,
};
use crate::core::session::journey_review_queue::{ReviewJob, ReviewJobRepository};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskStartPosition {
    最近用户消息,
    下一条用户消息,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskRequest {
    pub session_id: String,
    pub expected_revision: u64,
    pub task_id: String,
    pub name: String,
    pub position: TaskStartPosition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateForkRequest {
    pub session_id: String,
    pub expected_revision: u64,
    pub fork_id: String,
    pub task_id: String,
    pub task_name: String,
    pub anchor_message_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCheckpointRequest {
    pub session_id: String,
    pub expected_revision: u64,
    pub checkpoint_id: String,
    pub name: String,
    pub message_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishTaskRequest {
    pub session_id: String,
    pub expected_revision: u64,
    pub outcome: TaskOutcome,
    pub message_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestForkCloseRequest {
    pub session_id: String,
    pub expected_revision: u64,
    pub fork_id: String,
    pub review_id: String,
    pub outcome: TaskOutcome,
    pub message_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoteFactRequest {
    pub session_id: String,
    pub expected_revision: u64,
    pub review_id: String,
    pub fact_id: String,
    pub text: String,
    pub evidence_start_message_id: String,
    pub evidence_end_message_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardForkRequest {
    pub session_id: String,
    pub expected_revision: u64,
    pub review_id: String,
}

/// Worker-output write contract. Calling this does not run a worker and does
/// not synthesize a result; it only CAS-publishes a reviewed capsule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishHandoffCapsuleRequest {
    pub session_id: String,
    pub expected_revision: u64,
    pub fork_id: String,
    pub capsule: HandoffCapsule,
}

/// Explicit producer output contract. No provider is called here: a real
/// worker must provide its already-generated Chinese annotation and resolved
/// runtime provenance, or leave the review queued.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkReviewReadyRequest {
    pub session_id: String,
    pub expected_revision: u64,
    pub review_id: String,
    pub provenance: RuntimeProvenance,
    pub annotation: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailReviewRequest {
    pub session_id: String,
    pub expected_revision: u64,
    pub review_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryReviewRequest {
    pub session_id: String,
    pub expected_revision: u64,
    pub review_id: String,
    pub job_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnToParentRequest {
    pub session_id: String,
    pub expected_revision: u64,
    pub review_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReturnToParentResponse {
    pub revision: u64,
    pub parent_branch_id: String,
    pub parent_anchor_message_id: String,
    pub parent_anchor_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JourneySnapshotResponse {
    pub snapshot: SessionJourney,
    pub revision: u64,
}

/// Provider-neutral fork comparison.  Every adapter receives the same durable
/// fields; presentation layers only translate/render this response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForkCompareResponse {
    pub groups: Vec<ForkCompareGroup>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForkCompareGroup {
    pub parent_branch_id: String,
    pub parent_anchor_message_id: Option<String>,
    pub anchor_sequence: u64,
    pub forks: Vec<ForkCompareItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForkCompareItem {
    pub branch_id: String,
    pub branch_name: String,
    pub state: crate::core::journey_lifecycle::ForkState,
    /// Every task on this branch, retained in durable creation order by id.
    /// Consumers must not infer task names/outcomes from a rendered transcript.
    pub tasks: Vec<ForkCompareTask>,
    /// Compatibility summary for compact clients. The complete source is
    /// `tasks`; this is the final task outcome when one exists.
    pub task_outcome: Option<TaskOutcome>,
    pub conclusion: Option<String>,
    pub unresolved: Vec<String>,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForkCompareTask {
    pub task_id: String,
    pub name: String,
    pub state: crate::core::journey_lifecycle::TaskState,
    pub outcome: Option<TaskOutcome>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JourneyWriteResponse {
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscardForkResponse {
    pub revision: u64,
    pub parent_branch_id: String,
    pub parent_anchor_message_id: String,
    pub parent_anchor_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum JourneyApplicationError {
    修订冲突 { expected: u64, actual: u64 },
    校验失败(String),
    存储失败(String),
}

impl fmt::Display for JourneyApplicationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::修订冲突 { expected, actual } => {
                write!(f, "会话旅程修订冲突：期望 {expected}，当前 {actual}。")
            }
            Self::校验失败(message) | Self::存储失败(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for JourneyApplicationError {}

pub type JourneyApplicationResult<T> = Result<T, JourneyApplicationError>;

/// Shared application service. All mutations load a durable snapshot, validate
/// the caller's observed revision, execute a lifecycle transition, then use
/// the repository CAS. No request has an implicit revision.
pub struct SessionJourneyApplicationService;

impl SessionJourneyApplicationService {
    /// Durable enqueue boundary used after a successful fork close.  This is
    /// intentionally provider-free; the caller must pass the already resolved
    /// runtime provenance captured by the foreground fork.
    pub fn enqueue_review_job(
        conn: &Connection,
        session_id: &str,
        job_id: String,
        review_id: &str,
        provenance: RuntimeProvenance,
    ) -> JourneyApplicationResult<ReviewJob> {
        let snapshot = Self::snapshot(conn, session_id)?.snapshot;
        ReviewJobRepository::enqueue(conn, &snapshot, job_id, review_id, &provenance)
            .map_err(|error| JourneyApplicationError::存储失败(error.to_string()))
    }

    pub fn get_review_job(
        conn: &Connection,
        review_id: &str,
    ) -> JourneyApplicationResult<Option<ReviewJob>> {
        ReviewJobRepository::get(conn, review_id)
            .map_err(|error| JourneyApplicationError::存储失败(error.to_string()))
    }

    pub fn list_review_jobs(conn: &Connection) -> JourneyApplicationResult<Vec<ReviewJob>> {
        ReviewJobRepository::list(conn)
            .map_err(|error| JourneyApplicationError::存储失败(error.to_string()))
    }

    pub fn get_review_draft(
        conn: &Connection,
        session_id: &str,
        review_id: &str,
    ) -> JourneyApplicationResult<Option<String>> {
        let snapshot = Self::snapshot(conn, session_id)?.snapshot;
        Ok(snapshot
            .reviews
            .get(review_id)
            .and_then(|review| review.annotation.clone()))
    }

    pub fn claim_review_job(
        conn: &mut Connection,
        worker_id: &str,
        stale_after_secs: u64,
    ) -> JourneyApplicationResult<Option<ReviewJob>> {
        ReviewJobRepository::claim(conn, worker_id, stale_after_secs)
            .map_err(|error| JourneyApplicationError::存储失败(error.to_string()))
    }

    pub fn complete_review_job(conn: &Connection, job_id: &str) -> JourneyApplicationResult<()> {
        ReviewJobRepository::complete(conn, job_id)
            .map_err(|error| JourneyApplicationError::存储失败(error.to_string()))
    }

    pub fn fail_review_job(
        conn: &Connection,
        job_id: &str,
        error: &str,
    ) -> JourneyApplicationResult<()> {
        ReviewJobRepository::fail(conn, job_id, error)
            .map_err(|error| JourneyApplicationError::存储失败(error.to_string()))
    }

    pub fn retry_review_job(conn: &Connection, job_id: &str) -> JourneyApplicationResult<()> {
        ReviewJobRepository::retry(conn, job_id)
            .map_err(|error| JourneyApplicationError::存储失败(error.to_string()))
    }

    pub fn fail_review(
        conn: &mut Connection,
        request: FailReviewRequest,
    ) -> JourneyApplicationResult<JourneyWriteResponse> {
        Self::write(
            conn,
            &request.session_id,
            request.expected_revision,
            |_conn, journey, revision| {
                journey
                    .fail_review(revision, &request.review_id)
                    .map_err(Self::domain_error)
            },
        )
    }

    pub fn retry_review(
        conn: &mut Connection,
        request: RetryReviewRequest,
    ) -> JourneyApplicationResult<JourneyWriteResponse> {
        Self::ensure_session(conn, &request.session_id)?;
        SqliteJourneyRepository::ensure_schema(conn).map_err(Self::domain_error)?;
        ReviewJobRepository::ensure_schema(conn)
            .map_err(|error| JourneyApplicationError::存储失败(error.to_string()))?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| JourneyApplicationError::存储失败(error.to_string()))?;
        let mut snapshot = Self::load_snapshot(&tx, &request.session_id)?;
        if snapshot.revision != request.expected_revision {
            return Err(JourneyApplicationError::修订冲突 {
                expected: request.expected_revision,
                actual: snapshot.revision,
            });
        }
        snapshot
            .retry_review(snapshot.revision, &request.review_id)
            .map_err(Self::domain_error)?;
        SqliteJourneyRepository::compare_and_store_in_transaction(
            &tx,
            &snapshot,
            request.expected_revision,
        )
        .map_err(Self::domain_error)?;
        ReviewJobRepository::retry(&tx, &request.job_id)
            .map_err(|error| JourneyApplicationError::存储失败(error.to_string()))?;
        tx.commit()
            .map_err(|error| JourneyApplicationError::存储失败(error.to_string()))?;
        crate::core::session::journey_review_queue::notify_review_queue();
        Ok(JourneyWriteResponse {
            revision: snapshot.revision,
        })
    }
    pub fn snapshot(
        conn: &Connection,
        session_id: &str,
    ) -> JourneyApplicationResult<JourneySnapshotResponse> {
        Self::ensure_session(conn, session_id)?;
        let snapshot = Self::load_snapshot(conn, session_id)?;
        Ok(JourneySnapshotResponse {
            revision: snapshot.revision,
            snapshot,
        })
    }

    pub fn create_task(
        conn: &mut Connection,
        request: CreateTaskRequest,
    ) -> JourneyApplicationResult<JourneyWriteResponse> {
        let next_user_message = matches!(request.position, TaskStartPosition::下一条用户消息);
        let latest_user_sequence = match &request.position {
            TaskStartPosition::最近用户消息 => {
                Some(Self::latest_user_sequence(conn, &request.session_id)?)
            }
            TaskStartPosition::下一条用户消息 => None,
        };
        Self::write(
            conn,
            &request.session_id,
            request.expected_revision,
            |_conn, journey, revision| {
                journey
                    .start_task(
                        revision,
                        request.task_id,
                        request.name,
                        next_user_message,
                        latest_user_sequence,
                    )
                    .map_err(Self::domain_error)
            },
        )
    }

    pub fn create_fork(
        conn: &mut Connection,
        request: CreateForkRequest,
    ) -> JourneyApplicationResult<JourneyWriteResponse> {
        let anchor = Self::message_anchor(conn, &request.session_id, &request.anchor_message_id)?;
        Self::write(
            conn,
            &request.session_id,
            request.expected_revision,
            |conn, journey, revision| {
                Self::validate_branch_anchor(
                    conn,
                    &request.session_id,
                    &anchor,
                    &journey.active_branch_id,
                )?;
                journey
                    .start_fork(
                        revision,
                        request.fork_id,
                        request.task_id,
                        request.task_name,
                        anchor.message_id.clone(),
                        anchor.sequence,
                    )
                    .map_err(Self::domain_error)
            },
        )
    }

    pub fn create_checkpoint(
        conn: &mut Connection,
        request: CreateCheckpointRequest,
    ) -> JourneyApplicationResult<JourneyWriteResponse> {
        let anchor = Self::message_anchor(conn, &request.session_id, &request.message_id)?;
        Self::write(
            conn,
            &request.session_id,
            request.expected_revision,
            |conn, journey, revision| {
                let task_id = journey.active_task_id.as_deref().ok_or_else(|| {
                    JourneyApplicationError::校验失败("当前没有活动任务。".into())
                })?;
                Self::validate_task_anchor(
                    conn,
                    &request.session_id,
                    &anchor,
                    &journey.active_branch_id,
                    task_id,
                )?;
                journey
                    .checkpoint(
                        revision,
                        request.checkpoint_id,
                        request.name,
                        anchor.message_id,
                        anchor.sequence,
                    )
                    .map_err(Self::domain_error)
            },
        )
    }

    pub fn finish_task(
        conn: &mut Connection,
        request: FinishTaskRequest,
    ) -> JourneyApplicationResult<JourneyWriteResponse> {
        let anchor = Self::message_anchor(conn, &request.session_id, &request.message_id)?;
        Self::write(
            conn,
            &request.session_id,
            request.expected_revision,
            |conn, journey, revision| {
                Self::validate_active_task_anchor(conn, &request.session_id, &anchor, journey)?;
                journey
                    .finish_task(
                        revision,
                        request.outcome,
                        anchor.sequence,
                        crate::core::journey_lifecycle::FinishDisposition::StayInFork,
                        None,
                        None,
                    )
                    .map_err(Self::domain_error)
            },
        )
    }

    pub fn request_fork_close(
        conn: &mut Connection,
        request: RequestForkCloseRequest,
    ) -> JourneyApplicationResult<JourneyWriteResponse> {
        let anchor = Self::message_anchor(conn, &request.session_id, &request.message_id)?;
        Self::write(
            conn,
            &request.session_id,
            request.expected_revision,
            |conn, journey, revision| {
                Self::validate_active_task_anchor(conn, &request.session_id, &anchor, journey)?;
                journey
                    .request_fork_close(
                        revision,
                        &request.fork_id,
                        request.review_id,
                        request.outcome,
                        anchor.sequence,
                    )
                    .map_err(Self::domain_error)
            },
        )
    }

    /// Close plus durable enqueue for callers that already resolved the
    /// foreground RuntimeProvenance.  The operation performs no provider
    /// call and returns as soon as the local writes finish.
    pub fn request_fork_close_and_enqueue(
        conn: &mut Connection,
        request: RequestForkCloseRequest,
        job_id: String,
        provenance: RuntimeProvenance,
    ) -> JourneyApplicationResult<ReviewJob> {
        Self::ensure_session(conn, &request.session_id)?;
        SqliteJourneyRepository::ensure_schema(conn).map_err(Self::domain_error)?;
        ReviewJobRepository::ensure_schema(conn)
            .map_err(|error| JourneyApplicationError::存储失败(error.to_string()))?;
        let anchor = Self::message_anchor(conn, &request.session_id, &request.message_id)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| JourneyApplicationError::存储失败(error.to_string()))?;
        let mut snapshot = Self::load_snapshot(&tx, &request.session_id)?;
        if snapshot.revision != request.expected_revision {
            return Err(JourneyApplicationError::修订冲突 {
                expected: request.expected_revision,
                actual: snapshot.revision,
            });
        }
        Self::validate_active_task_anchor(&tx, &request.session_id, &anchor, &snapshot)?;
        snapshot
            .request_fork_close(
                snapshot.revision,
                &request.fork_id,
                request.review_id.clone(),
                request.outcome,
                anchor.sequence,
            )
            .map_err(Self::domain_error)?;
        SqliteJourneyRepository::compare_and_store_in_transaction(
            &tx,
            &snapshot,
            request.expected_revision,
        )
        .map_err(Self::domain_error)?;
        let job =
            ReviewJobRepository::enqueue(&tx, &snapshot, job_id, &request.review_id, &provenance)
                .map_err(|error| JourneyApplicationError::存储失败(error.to_string()))?;
        tx.commit()
            .map_err(|error| JourneyApplicationError::存储失败(error.to_string()))?;
        crate::core::session::journey_review_queue::notify_review_queue();
        Ok(job)
    }

    pub fn review_queue(
        conn: &Connection,
        session_id: &str,
    ) -> JourneyApplicationResult<Vec<ReviewItem>> {
        let snapshot = Self::snapshot(conn, session_id)?;
        Ok(snapshot.snapshot.reviews.into_values().collect())
    }

    pub fn fork_compare(
        conn: &Connection,
        session_id: &str,
    ) -> JourneyApplicationResult<ForkCompareResponse> {
        let snapshot = Self::snapshot(conn, session_id)?.snapshot;
        let mut grouped: std::collections::BTreeMap<
            (String, Option<String>, u64),
            Vec<ForkCompareItem>,
        > = std::collections::BTreeMap::new();
        for fork in snapshot
            .branches
            .values()
            .filter(|fork| fork.id != fork.parent_branch_id)
        {
            let tasks: Vec<ForkCompareTask> = snapshot
                .tasks
                .values()
                .filter(|task| task.branch_id == fork.id)
                .map(|task| ForkCompareTask {
                    task_id: task.id.clone(),
                    name: task.name.clone(),
                    state: task.state.clone(),
                    outcome: task.outcome.clone(),
                })
                .collect();
            let task_outcome = tasks.iter().rev().find_map(|task| task.outcome.clone());
            let (conclusion, unresolved, evidence) = fork
                .handoff_capsule
                .as_ref()
                .map(|capsule| {
                    (
                        Some(capsule.conclusion.clone()),
                        capsule.open_questions.clone(),
                        capsule.evidence_references.clone(),
                    )
                })
                .unwrap_or_else(|| (None, Vec::new(), Vec::new()));
            grouped
                .entry((
                    fork.parent_branch_id.clone(),
                    fork.parent_anchor_message_id.clone(),
                    fork.anchor_sequence,
                ))
                .or_default()
                .push(ForkCompareItem {
                    branch_id: fork.id.clone(),
                    branch_name: fork.id.clone(),
                    state: fork.state.clone(),
                    tasks,
                    task_outcome,
                    conclusion,
                    unresolved,
                    evidence,
                });
        }
        Ok(ForkCompareResponse {
            groups: grouped
                .into_iter()
                .filter_map(
                    |((parent_branch_id, parent_anchor_message_id, anchor_sequence), forks)| {
                        (forks.len() > 1).then_some(ForkCompareGroup {
                            parent_branch_id,
                            parent_anchor_message_id,
                            anchor_sequence,
                            forks,
                        })
                    },
                )
                .collect(),
        })
    }

    pub fn promote_confirmed_fact(
        conn: &mut Connection,
        request: PromoteFactRequest,
    ) -> JourneyApplicationResult<JourneyWriteResponse> {
        let start = Self::message_anchor(
            conn,
            &request.session_id,
            &request.evidence_start_message_id,
        )?;
        let end =
            Self::message_anchor(conn, &request.session_id, &request.evidence_end_message_id)?;
        Self::ensure_session(conn, &request.session_id)?;
        SqliteJourneyRepository::ensure_schema(conn).map_err(Self::domain_error)?;
        crate::core::session::journey_embedding::ensure_schema(conn)
            .map_err(|error| JourneyApplicationError::存储失败(error.to_string()))?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| JourneyApplicationError::存储失败(error.to_string()))?;
        let mut snapshot = Self::load_snapshot(&tx, &request.session_id)?;
        if snapshot.revision != request.expected_revision {
            return Err(JourneyApplicationError::修订冲突 {
                expected: request.expected_revision,
                actual: snapshot.revision,
            });
        }
        Self::validate_review_evidence(
            &tx,
            &request.session_id,
            &snapshot,
            &request.review_id,
            &start,
            &end,
        )?;
        snapshot
            .promote_fact(
                snapshot.revision,
                &request.review_id,
                request.fact_id.clone(),
                request.text.clone(),
                start.message_id.clone(),
                start.sequence,
                end.message_id.clone(),
                end.sequence,
            )
            .map_err(Self::domain_error)?;
        let review = snapshot
            .reviews
            .get(&request.review_id)
            .ok_or_else(|| JourneyApplicationError::校验失败("未知审阅项。".into()))?;
        SqliteJourneyRepository::compare_and_store_in_transaction(
            &tx,
            &snapshot,
            request.expected_revision,
        )
        .map_err(Self::domain_error)?;
        crate::core::session::journey_embedding::enqueue(
            &tx,
            &format!("fact:{}", request.fact_id),
            crate::core::session::journey_embedding::JourneyEmbeddingKind::ConfirmedFact,
            &request.session_id,
            &review.fork_id,
            &request.review_id,
            &request.text,
        )
        .map_err(|error| {
            JourneyApplicationError::存储失败(format!("无法排队事实 embedding：{error}"))
        })?;
        tx.commit()
            .map_err(|error| JourneyApplicationError::存储失败(error.to_string()))?;
        Ok(JourneyWriteResponse {
            revision: snapshot.revision,
        })
    }

    pub fn discard_fork(
        conn: &mut Connection,
        request: DiscardForkRequest,
    ) -> JourneyApplicationResult<DiscardForkResponse> {
        Self::ensure_session(conn, &request.session_id)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| JourneyApplicationError::存储失败(error.to_string()))?;
        let mut snapshot = Self::load_snapshot(&tx, &request.session_id)?;
        if snapshot.revision != request.expected_revision {
            return Err(JourneyApplicationError::修订冲突 {
                expected: request.expected_revision,
                actual: snapshot.revision,
            });
        }
        let review = snapshot.reviews.get(&request.review_id).ok_or_else(|| {
            JourneyApplicationError::校验失败(format!("未知审阅项：{}。", request.review_id))
        })?;
        let branch = snapshot.branches.get(&review.fork_id).ok_or_else(|| {
            JourneyApplicationError::校验失败(format!("未知分叉：{}。", review.fork_id))
        })?;
        let parent_branch_id = branch.parent_branch_id.clone();
        let parent_anchor_message_id =
            branch.parent_anchor_message_id.clone().ok_or_else(|| {
                JourneyApplicationError::校验失败("分叉缺少精确父消息锚点。".into())
            })?;
        let parent_anchor_sequence = snapshot
            .discard_fork(snapshot.revision, &request.review_id)
            .map_err(Self::domain_error)?;
        SqliteJourneyRepository::compare_and_store_in_transaction(
            &tx,
            &snapshot,
            request.expected_revision,
        )
        .map_err(Self::domain_error)?;
        crate::core::session::journey_embedding::discard_review_annotation(&tx, &request.review_id)
            .map_err(|error| {
                JourneyApplicationError::存储失败(format!("无法清理审核 embedding：{error}"))
            })?;
        tx.commit()
            .map_err(|error| JourneyApplicationError::存储失败(error.to_string()))?;
        Ok(DiscardForkResponse {
            revision: snapshot.revision,
            parent_branch_id,
            parent_anchor_message_id,
            parent_anchor_sequence,
        })
    }

    pub fn publish_handoff_capsule(
        conn: &mut Connection,
        request: PublishHandoffCapsuleRequest,
    ) -> JourneyApplicationResult<JourneyWriteResponse> {
        Self::write(
            conn,
            &request.session_id,
            request.expected_revision,
            |_conn, journey, revision| {
                journey
                    .publish_handoff_capsule(revision, &request.fork_id, request.capsule)
                    .map_err(Self::domain_error)
            },
        )
    }

    pub fn mark_review_ready(
        conn: &mut Connection,
        request: MarkReviewReadyRequest,
    ) -> JourneyApplicationResult<JourneyWriteResponse> {
        Self::write(
            conn,
            &request.session_id,
            request.expected_revision,
            |_conn, journey, revision| {
                journey
                    .mark_review_ready(
                        revision,
                        &request.review_id,
                        request.provenance,
                        request.annotation,
                    )
                    .map_err(Self::domain_error)
            },
        )
    }

    pub fn return_to_parent(
        conn: &mut Connection,
        request: ReturnToParentRequest,
    ) -> JourneyApplicationResult<ReturnToParentResponse> {
        Self::ensure_session(conn, &request.session_id)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| JourneyApplicationError::存储失败(error.to_string()))?;
        let mut snapshot = Self::load_snapshot(&tx, &request.session_id)?;
        if snapshot.revision != request.expected_revision {
            return Err(JourneyApplicationError::修订冲突 {
                expected: request.expected_revision,
                actual: snapshot.revision,
            });
        }
        let (parent_branch_id, parent_anchor_message_id, parent_anchor_sequence) = snapshot
            .return_to_parent(snapshot.revision, &request.review_id)
            .map_err(Self::domain_error)?;
        SqliteJourneyRepository::compare_and_store_in_transaction(
            &tx,
            &snapshot,
            request.expected_revision,
        )
        .map_err(Self::domain_error)?;
        tx.commit()
            .map_err(|error| JourneyApplicationError::存储失败(error.to_string()))?;
        Ok(ReturnToParentResponse {
            revision: snapshot.revision,
            parent_branch_id,
            parent_anchor_message_id,
            parent_anchor_sequence,
        })
    }

    fn write(
        conn: &mut Connection,
        session_id: &str,
        expected_revision: u64,
        action: impl FnOnce(&Connection, &mut SessionJourney, u64) -> JourneyApplicationResult<()>,
    ) -> JourneyApplicationResult<JourneyWriteResponse> {
        Self::ensure_session(conn, session_id)?;
        let mut snapshot = Self::load_snapshot(conn, session_id)?;
        if snapshot.revision != expected_revision {
            return Err(JourneyApplicationError::修订冲突 {
                expected: expected_revision,
                actual: snapshot.revision,
            });
        }
        action(conn, &mut snapshot, expected_revision)?;
        SqliteJourneyRepository::compare_and_store(conn, &snapshot, expected_revision)
            .map_err(Self::domain_error)?;
        Ok(JourneyWriteResponse {
            revision: snapshot.revision,
        })
    }

    fn load_snapshot(
        conn: &Connection,
        session_id: &str,
    ) -> JourneyApplicationResult<SessionJourney> {
        SqliteJourneyRepository::ensure_schema(conn).map_err(|_| {
            JourneyApplicationError::存储失败("无法初始化 Journey 存储。".into())
        })?;
        SqliteJourneyRepository::load(conn, session_id)
            .map_err(Self::domain_error)
            .map(|snapshot| snapshot.unwrap_or_else(|| SessionJourney::new(session_id, "main")))
    }

    fn ensure_session(conn: &Connection, session_id: &str) -> JourneyApplicationResult<()> {
        if session_id.trim().is_empty() {
            return Err(JourneyApplicationError::校验失败(
                "会话 ID 不能为空。".into(),
            ));
        }
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM agent_sessions WHERE session_id = ?1 LIMIT 1",
                [session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| JourneyApplicationError::存储失败("无法校验会话。".into()))?;
        exists.is_some().then_some(()).ok_or_else(|| {
            JourneyApplicationError::校验失败(format!("未知会话：{session_id}。"))
        })
    }

    fn latest_user_sequence(conn: &Connection, session_id: &str) -> JourneyApplicationResult<u64> {
        conn.query_row(
            "SELECT sequence FROM agent_messages WHERE session_id = ?1 AND role = 'user' ORDER BY sequence DESC LIMIT 1",
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|_| JourneyApplicationError::存储失败("无法读取最近用户消息。".into()))?
        .filter(|sequence| *sequence >= 0)
        .map(|sequence| sequence as u64)
        .ok_or_else(|| JourneyApplicationError::校验失败("该会话没有可用的最近用户消息。".into()))
    }

    fn message_anchor(
        conn: &Connection,
        session_id: &str,
        message_id: &str,
    ) -> JourneyApplicationResult<MessageAnchor> {
        let anchor = conn
            .query_row(
                "SELECT id, sequence FROM agent_messages WHERE session_id = ?1 AND id = ?2",
                params![session_id, message_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(|_| JourneyApplicationError::存储失败("无法读取精确消息锚点。".into()))?
            .filter(|(_, sequence)| *sequence >= 0)
            .ok_or_else(|| {
                JourneyApplicationError::校验失败("未找到该会话中的精确消息锚点。".into())
            })?;
        Ok(MessageAnchor {
            message_id: anchor.0,
            sequence: anchor.1 as u64,
        })
    }

    fn validate_branch_anchor(
        conn: &Connection,
        session_id: &str,
        anchor: &MessageAnchor,
        branch_id: &str,
    ) -> JourneyApplicationResult<()> {
        let membership: Option<String> = conn.query_row(
            "SELECT branch_id FROM session_journey_memberships WHERE session_id = ?1 AND message_id = ?2",
            params![session_id, anchor.message_id], |row| row.get(0),
        ).optional().map_err(|_| JourneyApplicationError::存储失败("无法校验分叉锚点。".into()))?;
        if membership.as_deref() != Some(branch_id) {
            return Err(JourneyApplicationError::校验失败(
                "精确消息锚点不属于当前分叉。".into(),
            ));
        }
        Ok(())
    }

    fn validate_task_anchor(
        conn: &Connection,
        session_id: &str,
        anchor: &MessageAnchor,
        branch_id: &str,
        task_id: &str,
    ) -> JourneyApplicationResult<()> {
        let membership: Option<(String, Option<String>)> = conn.query_row(
            "SELECT branch_id, task_id FROM session_journey_memberships WHERE session_id = ?1 AND message_id = ?2",
            params![session_id, anchor.message_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(|_| JourneyApplicationError::存储失败("无法校验任务锚点。".into()))?;
        let belongs_to_task = matches!(
            membership.as_ref(),
            Some((branch, task)) if branch == branch_id && task.as_deref() == Some(task_id)
        );
        if !belongs_to_task {
            return Err(JourneyApplicationError::校验失败(
                "精确消息锚点不属于当前任务。".into(),
            ));
        }
        Ok(())
    }

    fn validate_active_task_anchor(
        conn: &Connection,
        session_id: &str,
        anchor: &MessageAnchor,
        journey: &SessionJourney,
    ) -> JourneyApplicationResult<()> {
        let task_id = journey
            .active_task_id
            .as_deref()
            .ok_or_else(|| JourneyApplicationError::校验失败("当前没有活动任务。".into()))?;
        Self::validate_task_anchor(conn, session_id, anchor, &journey.active_branch_id, task_id)
    }

    fn validate_review_evidence(
        conn: &Connection,
        session_id: &str,
        journey: &SessionJourney,
        review_id: &str,
        start: &MessageAnchor,
        end: &MessageAnchor,
    ) -> JourneyApplicationResult<()> {
        let review = journey.reviews.get(review_id).ok_or_else(|| {
            JourneyApplicationError::校验失败(format!("未知审阅项：{review_id}。"))
        })?;
        for anchor in [start, end] {
            let membership: Option<(String, u64)> = conn
                .query_row(
                    "SELECT branch_id, sequence FROM session_journey_memberships
                     WHERE session_id = ?1 AND message_id = ?2",
                    params![session_id, anchor.message_id],
                    |row| Ok((row.get(0)?, row.get::<_, i64>(1)? as u64)),
                )
                .optional()
                .map_err(|_| {
                    JourneyApplicationError::存储失败("无法校验事实证据锚点。".into())
                })?;
            let belongs_to_review = matches!(
                membership.as_ref(),
                Some((branch, sequence))
                    if branch == &review.fork_id
                        && *sequence == anchor.sequence
                        && *sequence >= review.source_start_sequence
                        && *sequence <= review.source_end_sequence
            );
            if !belongs_to_review {
                return Err(JourneyApplicationError::校验失败(
                    "事实证据必须是审阅分叉范围内的精确成员消息。".into(),
                ));
            }
        }
        Ok(())
    }

    fn domain_error(error: JourneyError) -> JourneyApplicationError {
        match error {
            JourneyError::RevisionConflict { expected, actual } => {
                JourneyApplicationError::修订冲突 { expected, actual }
            }
            JourneyError::DuplicateId(id) => {
                JourneyApplicationError::校验失败(format!("会话旅程 ID 已存在：{id}。"))
            }
            JourneyError::UnknownBranch(id) => {
                JourneyApplicationError::校验失败(format!("未知分叉：{id}。"))
            }
            JourneyError::UnknownTask(id) => {
                JourneyApplicationError::校验失败(format!("未知任务：{id}。"))
            }
            JourneyError::UnknownReview(id) => {
                JourneyApplicationError::校验失败(format!("未知审阅项：{id}。"))
            }
            JourneyError::NoActiveTask => {
                JourneyApplicationError::校验失败("当前没有活动任务。".into())
            }
            JourneyError::ActiveTaskExists => {
                JourneyApplicationError::校验失败("当前已有活动任务。".into())
            }
            JourneyError::InvalidState(message) => {
                JourneyApplicationError::校验失败(format!("{message}。"))
            }
            JourneyError::InvalidSequence => {
                JourneyApplicationError::校验失败("无效的精确 sequence。".into())
            }
            JourneyError::MissingRuntimeProvenance => {
                JourneyApplicationError::校验失败("缺少运行来源信息。".into())
            }
            JourneyError::AccessDenied => {
                JourneyApplicationError::校验失败("该精确锚点不在审阅范围内。".into())
            }
            JourneyError::MissingHandoff => {
                JourneyApplicationError::校验失败("缺少有效的中文交接胶囊。".into())
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MessageAnchor {
    message_id: String,
    sequence: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::journey_lifecycle::{ReviewState, RuntimeProvenance, TaskState};

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE agent_sessions (session_id TEXT PRIMARY KEY);
             CREATE TABLE agent_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, sequence INTEGER NOT NULL);",
        )
        .unwrap();
        conn.execute("INSERT INTO agent_sessions (session_id) VALUES ('s')", [])
            .unwrap();
        conn.execute("INSERT INTO agent_messages (id, session_id, role, sequence) VALUES ('u1', 's', 'user', 4)", []).unwrap();
        conn.execute("INSERT INTO agent_messages (id, session_id, role, sequence) VALUES ('a1', 's', 'assistant', 5)", []).unwrap();
        SqliteJourneyRepository::ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO session_journey_memberships (session_id, message_id, sequence, branch_id, task_id)
             VALUES ('s', 'u1', 4, 'main', NULL), ('s', 'a1', 5, 'main', NULL)",
            [],
        )
        .unwrap();
        conn
    }

    fn assign_anchor(conn: &Connection, branch_id: &str, task_id: &str) {
        conn.execute(
            "UPDATE session_journey_memberships SET branch_id = ?1, task_id = ?2
             WHERE session_id = 's' AND message_id = 'a1'",
            params![branch_id, task_id],
        )
        .unwrap();
    }

    fn fork_request(revision: u64) -> CreateForkRequest {
        CreateForkRequest {
            session_id: "s".into(),
            expected_revision: revision,
            fork_id: "f1".into(),
            task_id: "t1".into(),
            task_name: "调查".into(),
            anchor_message_id: "u1".into(),
        }
    }

    #[test]
    fn cas_conflict_and_chinese_session_error_are_typed() {
        let mut conn = conn();
        SessionJourneyApplicationService::create_task(
            &mut conn,
            CreateTaskRequest {
                session_id: "s".into(),
                expected_revision: 0,
                task_id: "t".into(),
                name: "最近".into(),
                position: TaskStartPosition::最近用户消息,
            },
        )
        .unwrap();
        assert!(matches!(
            SessionJourneyApplicationService::create_task(
                &mut conn,
                CreateTaskRequest {
                    session_id: "s".into(),
                    expected_revision: 0,
                    task_id: "t2".into(),
                    name: "冲突".into(),
                    position: TaskStartPosition::下一条用户消息,
                }
            ),
            Err(JourneyApplicationError::修订冲突 {
                expected: 0,
                actual: 1
            })
        ));
        assert_eq!(
            SessionJourneyApplicationService::snapshot(&conn, "不存在")
                .unwrap_err()
                .to_string(),
            "未知会话：不存在。"
        );
    }

    #[test]
    fn next_user_task_and_checkpoint_keep_exact_anchor() {
        let mut conn = conn();
        SessionJourneyApplicationService::create_task(
            &mut conn,
            CreateTaskRequest {
                session_id: "s".into(),
                expected_revision: 0,
                task_id: "next".into(),
                name: "下一条".into(),
                position: TaskStartPosition::下一条用户消息,
            },
        )
        .unwrap();
        let snapshot = SessionJourneyApplicationService::snapshot(&conn, "s").unwrap();
        assert_eq!(
            snapshot.snapshot.tasks["next"].state,
            TaskState::PendingNextUser
        );

        let mut current = snapshot.snapshot;
        current
            .on_user_message_persisted(current.revision, 6)
            .unwrap();
        SqliteJourneyRepository::compare_and_store(&mut conn, &current, 1).unwrap();
        assign_anchor(&conn, "main", "next");
        SessionJourneyApplicationService::create_checkpoint(
            &mut conn,
            CreateCheckpointRequest {
                session_id: "s".into(),
                expected_revision: 2,
                checkpoint_id: "c1".into(),
                name: "精确".into(),
                message_id: "a1".into(),
            },
        )
        .unwrap();
        let snapshot = SessionJourneyApplicationService::snapshot(&conn, "s").unwrap();
        assert_eq!(snapshot.snapshot.checkpoints["c1"].message_id, "a1");
        assert_eq!(snapshot.snapshot.checkpoints["c1"].sequence, 5);
    }

    #[test]
    fn fork_creates_active_task_and_close_only_queues_review() {
        let mut conn = conn();
        SessionJourneyApplicationService::create_fork(&mut conn, fork_request(0)).unwrap();
        assign_anchor(&conn, "f1", "t1");
        let snapshot = SessionJourneyApplicationService::snapshot(&conn, "s").unwrap();
        assert_eq!(snapshot.snapshot.active_task_id.as_deref(), Some("t1"));
        SessionJourneyApplicationService::request_fork_close(
            &mut conn,
            RequestForkCloseRequest {
                session_id: "s".into(),
                expected_revision: 1,
                fork_id: "f1".into(),
                review_id: "r1".into(),
                outcome: TaskOutcome::Completed,
                message_id: "a1".into(),
            },
        )
        .unwrap();
        let snapshot = SessionJourneyApplicationService::snapshot(&conn, "s").unwrap();
        assert_eq!(
            snapshot.snapshot.branches["f1"].state,
            crate::core::journey_lifecycle::ForkState::Closing
        );
        assert_eq!(snapshot.snapshot.reviews["r1"].state, ReviewState::Queued);
        assert!(snapshot.snapshot.reviews["r1"].annotation.is_none());
    }

    #[test]
    fn close_and_enqueue_roll_back_together_when_queue_rejects_provenance() {
        let mut conn = conn();
        SessionJourneyApplicationService::create_fork(&mut conn, fork_request(0)).unwrap();
        assign_anchor(&conn, "f1", "t1");

        let error = SessionJourneyApplicationService::request_fork_close_and_enqueue(
            &mut conn,
            RequestForkCloseRequest {
                session_id: "s".into(),
                expected_revision: 1,
                fork_id: "f1".into(),
                review_id: "r1".into(),
                outcome: TaskOutcome::Completed,
                message_id: "a1".into(),
            },
            "job-r1".into(),
            RuntimeProvenance {
                model_id: "".into(),
                account_id: "account".into(),
                protocol: "openai".into(),
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("provenance"));

        let reopened = SessionJourneyApplicationService::snapshot(&conn, "s").unwrap();
        assert_eq!(reopened.revision, 1);
        assert_eq!(reopened.snapshot.active_task_id.as_deref(), Some("t1"));
        assert!(reopened.snapshot.reviews.is_empty());
        assert!(
            SessionJourneyApplicationService::get_review_job(&conn, "r1")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn fork_anchor_without_durable_membership_fails_closed() {
        let mut conn = conn();
        conn.execute(
            "DELETE FROM session_journey_memberships WHERE session_id = 's' AND message_id = 'u1'",
            [],
        )
        .unwrap();
        assert!(matches!(
            SessionJourneyApplicationService::create_fork(&mut conn, fork_request(0)),
            Err(JourneyApplicationError::校验失败(_))
        ));
    }

    #[test]
    fn discard_returns_parent_anchor_and_promotion_requires_confirmable_review() {
        let mut conn = conn();
        SessionJourneyApplicationService::create_fork(&mut conn, fork_request(0)).unwrap();
        assign_anchor(&conn, "f1", "t1");
        SessionJourneyApplicationService::request_fork_close(
            &mut conn,
            RequestForkCloseRequest {
                session_id: "s".into(),
                expected_revision: 1,
                fork_id: "f1".into(),
                review_id: "r1".into(),
                outcome: TaskOutcome::Completed,
                message_id: "a1".into(),
            },
        )
        .unwrap();
        assert!(matches!(
            SessionJourneyApplicationService::promote_confirmed_fact(
                &mut conn,
                PromoteFactRequest {
                    session_id: "s".into(),
                    expected_revision: 2,
                    review_id: "r1".into(),
                    fact_id: "fact".into(),
                    text: "结论".into(),
                    evidence_start_message_id: "u1".into(),
                    evidence_end_message_id: "a1".into(),
                }
            ),
            Err(JourneyApplicationError::校验失败(_))
        ));
        let discard = SessionJourneyApplicationService::discard_fork(
            &mut conn,
            DiscardForkRequest {
                session_id: "s".into(),
                expected_revision: 2,
                review_id: "r1".into(),
            },
        )
        .unwrap();
        assert_eq!(
            (
                discard.parent_branch_id.as_str(),
                discard.parent_anchor_message_id.as_str(),
                discard.parent_anchor_sequence
            ),
            ("main", "u1", 4)
        );
    }

    #[test]
    fn ready_review_can_be_explicitly_promoted_after_confirmation() {
        let mut conn = conn();
        SessionJourneyApplicationService::create_fork(&mut conn, fork_request(0)).unwrap();
        assign_anchor(&conn, "f1", "t1");
        SessionJourneyApplicationService::request_fork_close(
            &mut conn,
            RequestForkCloseRequest {
                session_id: "s".into(),
                expected_revision: 1,
                fork_id: "f1".into(),
                review_id: "r1".into(),
                outcome: TaskOutcome::Completed,
                message_id: "a1".into(),
            },
        )
        .unwrap();
        let mut journey = SessionJourneyApplicationService::snapshot(&conn, "s")
            .unwrap()
            .snapshot;
        journey
            .mark_review_ready(
                journey.revision,
                "r1",
                RuntimeProvenance {
                    model_id: "模型".into(),
                    account_id: "账户".into(),
                    protocol: "测试".into(),
                },
                "候选结论".into(),
            )
            .unwrap();
        SqliteJourneyRepository::compare_and_store(&mut conn, &journey, 2).unwrap();
        SessionJourneyApplicationService::promote_confirmed_fact(
            &mut conn,
            PromoteFactRequest {
                session_id: "s".into(),
                expected_revision: 3,
                review_id: "r1".into(),
                fact_id: "fact".into(),
                text: "已确认结论".into(),
                evidence_start_message_id: "a1".into(),
                evidence_end_message_id: "a1".into(),
            },
        )
        .unwrap();
        assert_eq!(
            SessionJourneyApplicationService::snapshot(&conn, "s")
                .unwrap()
                .snapshot
                .reviews["r1"]
                .state,
            ReviewState::Confirmed
        );
    }

    #[test]
    fn reviewed_capsule_preserves_provenance_and_returns_to_exact_parent_with_cas() {
        let mut conn = conn();
        SessionJourneyApplicationService::create_fork(&mut conn, fork_request(0)).unwrap();
        assign_anchor(&conn, "f1", "t1");
        SessionJourneyApplicationService::request_fork_close(
            &mut conn,
            RequestForkCloseRequest {
                session_id: "s".into(),
                expected_revision: 1,
                fork_id: "f1".into(),
                review_id: "r1".into(),
                outcome: TaskOutcome::Completed,
                message_id: "a1".into(),
            },
        )
        .unwrap();
        let provenance = RuntimeProvenance {
            model_id: "模型甲".into(),
            account_id: "账户甲".into(),
            protocol: "协议甲".into(),
        };
        SessionJourneyApplicationService::mark_review_ready(
            &mut conn,
            MarkReviewReadyRequest {
                session_id: "s".into(),
                expected_revision: 2,
                review_id: "r1".into(),
                provenance: provenance.clone(),
                annotation: "可用审核产物".into(),
            },
        )
        .unwrap();
        let capsule = HandoffCapsule {
            fork_id: "f1".into(),
            review_id: "r1".into(),
            parent_branch_id: "main".into(),
            parent_anchor_message_id: "u1".into(),
            source_start_sequence: 5,
            source_end_sequence: 5,
            objective: "审阅分叉结果".into(),
            conclusion: "继续主干".into(),
            open_questions: vec!["补充验证".into()],
            confirmed_items: vec!["锚点准确".into()],
            evidence_references: vec!["消息 a1".into()],
            generated_at: Some("元数据".into()),
            provenance: provenance.clone(),
        };
        assert!(matches!(
            SessionJourneyApplicationService::publish_handoff_capsule(
                &mut conn,
                PublishHandoffCapsuleRequest {
                    session_id: "s".into(),
                    expected_revision: 2,
                    fork_id: "f1".into(),
                    capsule: capsule.clone(),
                },
            ),
            Err(JourneyApplicationError::修订冲突 {
                expected: 2,
                actual: 3
            })
        ));
        SessionJourneyApplicationService::publish_handoff_capsule(
            &mut conn,
            PublishHandoffCapsuleRequest {
                session_id: "s".into(),
                expected_revision: 3,
                fork_id: "f1".into(),
                capsule,
            },
        )
        .unwrap();
        let returned = SessionJourneyApplicationService::return_to_parent(
            &mut conn,
            ReturnToParentRequest {
                session_id: "s".into(),
                expected_revision: 4,
                review_id: "r1".into(),
            },
        )
        .unwrap();
        assert_eq!(
            (
                returned.parent_branch_id.as_str(),
                returned.parent_anchor_message_id.as_str(),
                returned.parent_anchor_sequence,
            ),
            ("main", "u1", 4)
        );
        let snapshot = SessionJourneyApplicationService::snapshot(&conn, "s").unwrap();
        assert_eq!(snapshot.snapshot.active_branch_id, "main");
        assert_eq!(
            snapshot.snapshot.branches["f1"]
                .handoff_capsule
                .as_ref()
                .unwrap()
                .provenance,
            provenance
        );
    }
}
