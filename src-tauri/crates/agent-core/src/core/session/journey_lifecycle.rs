//! Durable domain model for Session Journey tasks and forks.
//!
//! This module intentionally has no dependency on todos, work items, Agent
//! Org tasks, git branches, clocks, or an LLM.  Persistence adapters store the
//! serialized [`SessionJourney`] atomically using `revision` as their CAS
//! coordinate.  The desktop and Gateway command adapters call this same
//! application service; their parsing must never invoke a provider.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    PendingNextUser,
    Active,
    Finished,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskOutcome {
    Completed,
    PartiallyCompleted,
    Paused,
    Abandoned,
    Redirected,
}

impl TaskOutcome {
    pub fn chinese_label(&self) -> &'static str {
        match self {
            Self::Completed => "完成",
            Self::PartiallyCompleted => "部分完成",
            Self::Paused => "暂停",
            Self::Abandoned => "放弃",
            Self::Redirected => "转向",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForkState {
    Active,
    Closing,
    CloseFailed,
    Closed,
    Discarded,
}

impl ForkState {
    pub fn chinese_label(&self) -> &'static str {
        match self {
            Self::Active => "进行中",
            Self::Closing => "关闭中",
            Self::CloseFailed => "关闭失败",
            Self::Closed => "已关闭",
            Self::Discarded => "已丢弃",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewState {
    Queued,
    Ready,
    Confirmed,
    Discarded,
    Failed,
}

impl ReviewState {
    fn chinese_label(&self) -> &'static str {
        match self {
            Self::Queued => "待审核",
            Self::Ready => "可审核",
            Self::Confirmed => "已确认",
            Self::Discarded => "已丢弃",
            Self::Failed => "失败",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeProvenance {
    pub model_id: String,
    pub account_id: String,
    pub protocol: String,
}

impl RuntimeProvenance {
    fn validate(&self) -> Result<(), JourneyError> {
        if self.model_id.trim().is_empty()
            || self.account_id.trim().is_empty()
            || self.protocol.trim().is_empty()
        {
            return Err(JourneyError::MissingRuntimeProvenance);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JourneyTask {
    pub id: String,
    pub name: String,
    pub branch_id: String,
    pub state: TaskState,
    pub start_sequence: Option<u64>,
    pub finish_sequence: Option<u64>,
    pub outcome: Option<TaskOutcome>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JourneyCheckpoint {
    pub id: String,
    pub task_id: String,
    pub message_id: String,
    pub sequence: u64,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JourneyFork {
    pub id: String,
    pub parent_branch_id: String,
    /// Durable message identity for the parent prefix boundary. Sequences are
    /// ordering coordinates only; a return-to-parent action must name this ID.
    #[serde(default)]
    pub parent_anchor_message_id: Option<String>,
    pub anchor_sequence: u64,
    pub source_start_sequence: u64,
    pub state: ForkState,
    pub frozen_end_sequence: Option<u64>,
    pub close_work_id: Option<String>,
    pub handoff_capsule: Option<HandoffCapsule>,
}

/// Immutable, reviewed result of a closed fork. This is deliberately a small
/// domain value, not a transcript slice: it is the only fork-derived content
/// eligible for the parent prompt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandoffCapsule {
    pub fork_id: String,
    pub review_id: String,
    pub parent_branch_id: String,
    pub parent_anchor_message_id: String,
    pub source_start_sequence: u64,
    pub source_end_sequence: u64,
    pub objective: String,
    pub conclusion: String,
    pub open_questions: Vec<String>,
    pub confirmed_items: Vec<String>,
    pub evidence_references: Vec<String>,
    /// Metadata only. It is never used to select an anchor or order prompt
    /// content, preserving cache identity across process restarts.
    pub generated_at: Option<String>,
    pub provenance: RuntimeProvenance,
}

impl HandoffCapsule {
    pub fn synthetic_prompt_message(&self) -> serde_json::Value {
        let lines = [
            "【分叉交接】以下是已审核的压缩结论，请从主干锚点继续，不要重放分叉记录。".to_string(),
            format!("分叉ID：{}", self.fork_id),
            format!("审阅ID：{}", self.review_id),
            format!("源锚点：{}", self.parent_anchor_message_id),
            format!("父分支：{}", self.parent_branch_id),
            format!(
                "来源区间：{}-{}",
                self.source_start_sequence, self.source_end_sequence
            ),
            format!("模型：{}", self.provenance.model_id),
            format!("账户：{}", self.provenance.account_id),
            format!("协议：{}", self.provenance.protocol),
            format!("目标：{}", self.objective),
            format!("结论：{}", self.conclusion),
            format!("未决项：{}", self.open_questions.join("；")),
            format!("确认项：{}", self.confirmed_items.join("；")),
            format!("证据引用：{}", self.evidence_references.join("；")),
            match &self.generated_at {
                Some(value) => format!("生成时间：{}", value),
                None => "生成时间：未记录".to_string(),
            },
        ];
        serde_json::json!({ "role": "user", "content": lines.join("\n") })
    }

    fn validate(&self) -> Result<(), JourneyError> {
        if self.fork_id.trim().is_empty()
            || self.review_id.trim().is_empty()
            || self.parent_branch_id.trim().is_empty()
            || self.parent_anchor_message_id.trim().is_empty()
            || self.objective.trim().is_empty()
            || self.conclusion.trim().is_empty()
            || self.source_start_sequence > self.source_end_sequence
        {
            return Err(JourneyError::MissingHandoff);
        }
        self.provenance.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewItem {
    pub id: String,
    pub fork_id: String,
    pub state: ReviewState,
    /// Empty while a close is waiting for an annotation producer. Provenance
    /// belongs to that producer, not to the user's close command.
    pub provenance: Option<RuntimeProvenance>,
    pub source_start_sequence: u64,
    pub source_end_sequence: u64,
    /// AI output is never a fact until the user promotes an item from it.
    pub annotation: Option<String>,
    pub promoted_fact_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfirmedFact {
    pub id: String,
    pub review_id: String,
    pub evidence_start_message_id: String,
    pub evidence_start_sequence: u64,
    pub evidence_end_message_id: String,
    pub evidence_end_sequence: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionJourney {
    pub session_id: String,
    pub revision: u64,
    pub active_branch_id: String,
    pub active_task_id: Option<String>,
    pub branches: BTreeMap<String, JourneyFork>,
    pub tasks: BTreeMap<String, JourneyTask>,
    pub checkpoints: BTreeMap<String, JourneyCheckpoint>,
    pub reviews: BTreeMap<String, ReviewItem>,
    pub facts: BTreeMap<String, ConfirmedFact>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FinishDisposition {
    StayInFork,
    CloseFork,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JourneyError {
    RevisionConflict { expected: u64, actual: u64 },
    DuplicateId(String),
    UnknownBranch(String),
    UnknownTask(String),
    UnknownReview(String),
    NoActiveTask,
    ActiveTaskExists,
    InvalidState(&'static str),
    InvalidSequence,
    MissingRuntimeProvenance,
    AccessDenied,
    MissingHandoff,
}

impl std::fmt::Display for JourneyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for JourneyError {}

impl SessionJourney {
    pub fn new(session_id: impl Into<String>, main_branch_id: impl Into<String>) -> Self {
        let main_branch_id = main_branch_id.into();
        let branch = JourneyFork {
            id: main_branch_id.clone(),
            parent_branch_id: main_branch_id.clone(),
            parent_anchor_message_id: None,
            anchor_sequence: 0,
            source_start_sequence: 1,
            state: ForkState::Active,
            frozen_end_sequence: None,
            close_work_id: None,
            handoff_capsule: None,
        };
        Self {
            session_id: session_id.into(),
            revision: 0,
            active_branch_id: main_branch_id.clone(),
            active_task_id: None,
            branches: BTreeMap::from([(main_branch_id, branch)]),
            tasks: BTreeMap::new(),
            checkpoints: BTreeMap::new(),
            reviews: BTreeMap::new(),
            facts: BTreeMap::new(),
        }
    }

    fn mutate(
        &mut self,
        expected_revision: u64,
        f: impl FnOnce(&mut Self) -> Result<(), JourneyError>,
    ) -> Result<(), JourneyError> {
        if self.revision != expected_revision {
            return Err(JourneyError::RevisionConflict {
                expected: expected_revision,
                actual: self.revision,
            });
        }
        f(self)?;
        self.revision += 1;
        Ok(())
    }

    pub fn start_task(
        &mut self,
        expected_revision: u64,
        id: String,
        name: String,
        next_user_message: bool,
        latest_user_sequence: Option<u64>,
    ) -> Result<(), JourneyError> {
        self.mutate(expected_revision, |s| {
            if s.active_task_id.is_some() {
                return Err(JourneyError::ActiveTaskExists);
            }
            if id.trim().is_empty() || name.trim().is_empty() {
                return Err(JourneyError::InvalidState("任务名称和 ID 不能为空"));
            }
            if s.tasks.contains_key(&id) {
                return Err(JourneyError::DuplicateId(id));
            }
            let (state, start_sequence) = if next_user_message {
                (TaskState::PendingNextUser, None)
            } else {
                (
                    TaskState::Active,
                    Some(latest_user_sequence.ok_or(JourneyError::InvalidSequence)?),
                )
            };
            s.tasks.insert(
                id.clone(),
                JourneyTask {
                    id: id.clone(),
                    name,
                    branch_id: s.active_branch_id.clone(),
                    state,
                    start_sequence,
                    finish_sequence: None,
                    outcome: None,
                },
            );
            s.active_task_id = Some(id);
            Ok(())
        })
    }

    /// Must be called in the same successful message-persistence transaction.
    pub fn on_user_message_persisted(
        &mut self,
        expected_revision: u64,
        sequence: u64,
    ) -> Result<(), JourneyError> {
        let Some(task_id) = self.active_task_id.as_deref() else {
            return Ok(());
        };
        if self.tasks.get(task_id).map(|task| &task.state) != Some(&TaskState::PendingNextUser) {
            return Ok(());
        }
        self.mutate(expected_revision, |s| {
            let task_id = s
                .active_task_id
                .as_deref()
                .ok_or(JourneyError::NoActiveTask)?;
            let task = s
                .tasks
                .get_mut(task_id)
                .ok_or_else(|| JourneyError::UnknownTask(task_id.into()))?;
            if task.state == TaskState::PendingNextUser {
                task.state = TaskState::Active;
                task.start_sequence = Some(sequence);
            }
            Ok(())
        })
    }

    pub fn start_fork(
        &mut self,
        expected_revision: u64,
        fork_id: String,
        task_id: String,
        task_name: String,
        parent_anchor_message_id: String,
        anchor_sequence: u64,
    ) -> Result<(), JourneyError> {
        self.mutate(expected_revision, |s| {
            if s.branches.contains_key(&fork_id) || s.tasks.contains_key(&task_id) {
                return Err(JourneyError::DuplicateId(fork_id));
            }
            if s.active_task_id.is_some() {
                return Err(JourneyError::ActiveTaskExists);
            }
            let parent = s.active_branch_id.clone();
            s.branches.insert(
                fork_id.clone(),
                JourneyFork {
                    id: fork_id.clone(),
                    parent_branch_id: parent,
                    parent_anchor_message_id: Some(parent_anchor_message_id),
                    anchor_sequence,
                    source_start_sequence: anchor_sequence.saturating_add(1),
                    state: ForkState::Active,
                    frozen_end_sequence: None,
                    close_work_id: None,
                    handoff_capsule: None,
                },
            );
            s.active_branch_id = fork_id.clone();
            s.tasks.insert(
                task_id.clone(),
                JourneyTask {
                    id: task_id.clone(),
                    name: task_name,
                    branch_id: fork_id,
                    state: TaskState::Active,
                    start_sequence: Some(anchor_sequence),
                    finish_sequence: None,
                    outcome: None,
                },
            );
            s.active_task_id = Some(task_id);
            Ok(())
        })
    }

    pub fn checkpoint(
        &mut self,
        expected_revision: u64,
        id: String,
        name: String,
        message_id: String,
        sequence: u64,
    ) -> Result<(), JourneyError> {
        self.mutate(expected_revision, |s| {
            let task_id = s.active_task_id.clone().ok_or(JourneyError::NoActiveTask)?;
            if s.checkpoints.contains_key(&id) {
                return Err(JourneyError::DuplicateId(id));
            }
            if s.tasks[&task_id].state != TaskState::Active {
                return Err(JourneyError::InvalidState("任务尚未激活"));
            }
            s.checkpoints.insert(
                id.clone(),
                JourneyCheckpoint {
                    id,
                    task_id,
                    message_id,
                    sequence,
                    name,
                },
            );
            Ok(())
        })
    }

    pub fn finish_task(
        &mut self,
        expected_revision: u64,
        outcome: TaskOutcome,
        finish_sequence: u64,
        disposition: FinishDisposition,
        close_work_id: Option<String>,
        provenance: Option<RuntimeProvenance>,
    ) -> Result<(), JourneyError> {
        self.mutate(expected_revision, |s| {
            let task_id = s.active_task_id.clone().ok_or(JourneyError::NoActiveTask)?;
            let branch_id = s.active_branch_id.clone();
            let task = s
                .tasks
                .get_mut(&task_id)
                .ok_or_else(|| JourneyError::UnknownTask(task_id.clone()))?;
            if task.state != TaskState::Active {
                return Err(JourneyError::InvalidState("任务尚未激活"));
            }
            task.state = TaskState::Finished;
            task.outcome = Some(outcome);
            task.finish_sequence = Some(finish_sequence);
            s.active_task_id = None;
            if disposition == FinishDisposition::CloseFork {
                let branch = s
                    .branches
                    .get_mut(&branch_id)
                    .ok_or_else(|| JourneyError::UnknownBranch(branch_id.clone()))?;
                if branch.parent_branch_id == branch.id {
                    return Err(JourneyError::InvalidState("主分支不可关闭"));
                }
                let work = close_work_id.ok_or(JourneyError::InvalidState("缺少关闭工作 ID"))?;
                provenance
                    .ok_or(JourneyError::MissingRuntimeProvenance)?
                    .validate()?;
                branch.state = ForkState::Closing;
                branch.frozen_end_sequence = Some(finish_sequence);
                branch.close_work_id = Some(work);
            }
            Ok(())
        })
    }

    /// Records a user-requested close without claiming that a background
    /// annotation or summary has run. The review remains queued until a
    /// separate producer supplies an explicitly sourced result.
    pub fn request_fork_close(
        &mut self,
        expected_revision: u64,
        fork_id: &str,
        review_id: String,
        outcome: TaskOutcome,
        finish_sequence: u64,
    ) -> Result<(), JourneyError> {
        self.mutate(expected_revision, |s| {
            if s.active_branch_id != fork_id {
                return Err(JourneyError::InvalidState("只能关闭当前活动分叉"));
            }
            let task_id = s.active_task_id.clone().ok_or(JourneyError::NoActiveTask)?;
            let task = s
                .tasks
                .get_mut(&task_id)
                .ok_or_else(|| JourneyError::UnknownTask(task_id.clone()))?;
            if task.state != TaskState::Active {
                return Err(JourneyError::InvalidState("任务尚未激活"));
            }
            let branch = s
                .branches
                .get_mut(fork_id)
                .ok_or_else(|| JourneyError::UnknownBranch(fork_id.into()))?;
            if branch.id == branch.parent_branch_id {
                return Err(JourneyError::InvalidState("主分支不可关闭"));
            }
            if s.reviews.contains_key(&review_id) {
                return Err(JourneyError::DuplicateId(review_id));
            }
            task.state = TaskState::Finished;
            task.outcome = Some(outcome);
            task.finish_sequence = Some(finish_sequence);
            s.active_task_id = None;
            branch.state = ForkState::Closing;
            branch.frozen_end_sequence = Some(finish_sequence);
            branch.close_work_id = None;
            s.reviews.insert(
                review_id.clone(),
                ReviewItem {
                    id: review_id,
                    fork_id: fork_id.into(),
                    state: ReviewState::Queued,
                    provenance: None,
                    source_start_sequence: branch.source_start_sequence,
                    source_end_sequence: finish_sequence,
                    annotation: None,
                    promoted_fact_ids: Vec::new(),
                },
            );
            Ok(())
        })
    }

    /// The sole authoritative close completion: it marks the fork closed and
    /// creates one review item. A failed extractor must use `close_failed`.
    pub fn complete_close(
        &mut self,
        expected_revision: u64,
        fork_id: &str,
        review_id: String,
        provenance: Option<RuntimeProvenance>,
        annotation: Option<String>,
    ) -> Result<(), JourneyError> {
        self.mutate(expected_revision, |s| {
            if let Some(provenance) = provenance.as_ref() {
                provenance.validate()?;
            }
            let branch = s
                .branches
                .get_mut(fork_id)
                .ok_or_else(|| JourneyError::UnknownBranch(fork_id.into()))?;
            if !matches!(branch.state, ForkState::Closing | ForkState::Closed) {
                return Err(JourneyError::InvalidState("分叉未处于关闭中"));
            }
            if s.reviews.contains_key(&review_id) {
                return Err(JourneyError::DuplicateId(review_id));
            }
            let end = branch
                .frozen_end_sequence
                .ok_or(JourneyError::InvalidSequence)?;
            branch.state = ForkState::Closed;
            s.reviews.insert(
                review_id.clone(),
                ReviewItem {
                    id: review_id,
                    fork_id: fork_id.into(),
                    state: ReviewState::Queued,
                    provenance,
                    source_start_sequence: branch.source_start_sequence,
                    source_end_sequence: end,
                    annotation,
                    promoted_fact_ids: Vec::new(),
                },
            );
            Ok(())
        })
    }

    /// The annotation producer may mark a queued review ready, but it may
    /// never promote a fact. Promotion remains an explicit user action.
    pub fn mark_review_ready(
        &mut self,
        expected_revision: u64,
        review_id: &str,
        provenance: RuntimeProvenance,
        annotation: String,
    ) -> Result<(), JourneyError> {
        self.mutate(expected_revision, |s| {
            provenance.validate()?;
            let fork_id = {
                let review = s
                    .reviews
                    .get(review_id)
                    .ok_or_else(|| JourneyError::UnknownReview(review_id.into()))?;
                review.fork_id.clone()
            };
            let branch_state = s
                .branches
                .get(&fork_id)
                .ok_or_else(|| JourneyError::UnknownBranch(fork_id.clone()))?
                .state
                .clone();
            if !matches!(branch_state, ForkState::Closing | ForkState::Closed) {
                return Err(JourneyError::InvalidState("分叉未处于关闭中"));
            }
            let review = s
                .reviews
                .get_mut(review_id)
                .ok_or_else(|| JourneyError::UnknownReview(review_id.into()))?;
            if review.state != ReviewState::Queued || annotation.trim().is_empty() {
                return Err(JourneyError::InvalidState("审阅项不可就绪"));
            }
            review.provenance = Some(provenance);
            review.annotation = Some(annotation);
            review.state = ReviewState::Ready;
            if let Some(branch) = s.branches.get_mut(&fork_id) {
                branch.state = ForkState::Closed;
            }
            Ok(())
        })
    }

    pub fn fail_close(
        &mut self,
        expected_revision: u64,
        fork_id: &str,
    ) -> Result<(), JourneyError> {
        self.mutate(expected_revision, |s| {
            let b = s
                .branches
                .get_mut(fork_id)
                .ok_or_else(|| JourneyError::UnknownBranch(fork_id.into()))?;
            if b.state != ForkState::Closing {
                return Err(JourneyError::InvalidState("分叉未处于关闭中"));
            }
            b.state = ForkState::CloseFailed;
            Ok(())
        })
    }

    /// A background annotation failure never publishes a capsule or fact. It
    /// leaves the frozen fork intact and exposes a retryable typed review
    /// state to adapters.
    pub fn fail_review(
        &mut self,
        expected_revision: u64,
        review_id: &str,
    ) -> Result<(), JourneyError> {
        self.mutate(expected_revision, |s| {
            let review = s
                .reviews
                .get_mut(review_id)
                .ok_or_else(|| JourneyError::UnknownReview(review_id.into()))?;
            if !matches!(review.state, ReviewState::Queued | ReviewState::Failed) {
                return Err(JourneyError::InvalidState("审阅项不可标记为失败"));
            }
            review.state = ReviewState::Failed;
            Ok(())
        })
    }

    pub fn retry_review(
        &mut self,
        expected_revision: u64,
        review_id: &str,
    ) -> Result<(), JourneyError> {
        self.mutate(expected_revision, |s| {
            let review = s
                .reviews
                .get_mut(review_id)
                .ok_or_else(|| JourneyError::UnknownReview(review_id.into()))?;
            if review.state != ReviewState::Failed {
                return Err(JourneyError::InvalidState("仅失败的审阅项可重试"));
            }
            review.state = ReviewState::Queued;
            Ok(())
        })
    }

    pub fn promote_fact(
        &mut self,
        expected_revision: u64,
        review_id: &str,
        fact_id: String,
        text: String,
        start_message_id: String,
        start: u64,
        end_message_id: String,
        end: u64,
    ) -> Result<(), JourneyError> {
        self.mutate(expected_revision, |s| {
            if start > end || text.trim().is_empty() {
                return Err(JourneyError::InvalidSequence);
            }
            let review = s
                .reviews
                .get_mut(review_id)
                .ok_or_else(|| JourneyError::UnknownReview(review_id.into()))?;
            if review.state != ReviewState::Ready {
                return Err(JourneyError::InvalidState("审阅项不可确认"));
            }
            if start < review.source_start_sequence || end > review.source_end_sequence {
                return Err(JourneyError::AccessDenied);
            }
            if s.facts.contains_key(&fact_id) {
                return Err(JourneyError::DuplicateId(fact_id));
            }
            review.promoted_fact_ids.push(fact_id.clone());
            review.state = ReviewState::Confirmed;
            s.facts.insert(
                fact_id.clone(),
                ConfirmedFact {
                    id: fact_id,
                    review_id: review_id.into(),
                    evidence_start_message_id: start_message_id,
                    evidence_start_sequence: start,
                    evidence_end_message_id: end_message_id,
                    evidence_end_sequence: end,
                    text,
                },
            );
            Ok(())
        })
    }

    pub fn discard_fork(
        &mut self,
        expected_revision: u64,
        review_id: &str,
    ) -> Result<u64, JourneyError> {
        let mut parent_anchor = 0;
        self.mutate(expected_revision, |s| {
            let review = s
                .reviews
                .get_mut(review_id)
                .ok_or_else(|| JourneyError::UnknownReview(review_id.into()))?;
            let branch = s
                .branches
                .get_mut(&review.fork_id)
                .ok_or_else(|| JourneyError::UnknownBranch(review.fork_id.clone()))?;
            if !matches!(branch.state, ForkState::Closing | ForkState::Closed) {
                return Err(JourneyError::InvalidState("仅关闭中的或已关闭分叉可丢弃"));
            }
            parent_anchor = branch.anchor_sequence;
            branch.state = ForkState::Discarded;
            review.state = ReviewState::Discarded;
            for fact_id in &review.promoted_fact_ids {
                s.facts.remove(fact_id);
            }
            Ok(())
        })?;
        Ok(parent_anchor)
    }

    /// Writes no transcript. The caller appends this capsule at the preserved
    /// parent continuation boundary, leaving its prompt-cache prefix bytewise
    /// untouched and never injecting the fork transcript.
    pub fn publish_handoff_capsule(
        &mut self,
        expected_revision: u64,
        fork_id: &str,
        capsule: HandoffCapsule,
    ) -> Result<(), JourneyError> {
        self.mutate(expected_revision, |s| {
            capsule.validate()?;
            let review_snapshot = {
                let review = s
                    .reviews
                    .get(&capsule.review_id)
                    .ok_or_else(|| JourneyError::UnknownReview(capsule.review_id.clone()))?;
                (
                    review.state.clone(),
                    review.fork_id.clone(),
                    review.source_start_sequence,
                    review.source_end_sequence,
                    review.provenance.clone(),
                )
            };
            let branch = s
                .branches
                .get_mut(fork_id)
                .ok_or_else(|| JourneyError::UnknownBranch(fork_id.into()))?;
            if branch.state != ForkState::Closed
                || !matches!(
                    review_snapshot.0,
                    ReviewState::Ready | ReviewState::Confirmed
                )
                || review_snapshot.1 != fork_id
                || capsule.fork_id != fork_id
                || capsule.parent_branch_id != branch.parent_branch_id
                || branch.parent_anchor_message_id.as_deref()
                    != Some(capsule.parent_anchor_message_id.as_str())
                || capsule.source_start_sequence != review_snapshot.2
                || capsule.source_end_sequence != review_snapshot.3
                || review_snapshot.4.as_ref() != Some(&capsule.provenance)
                || branch.handoff_capsule.is_some()
            {
                return Err(JourneyError::MissingHandoff);
            }
            branch.handoff_capsule = Some(capsule);
            Ok(())
        })
    }

    /// Switch to the exact recorded parent branch only after a usable capsule
    /// was published. No transcript rows are deleted or moved.
    pub fn return_to_parent(
        &mut self,
        expected_revision: u64,
        review_id: &str,
    ) -> Result<(String, String, u64), JourneyError> {
        let mut parent = None;
        self.mutate(expected_revision, |s| {
            let fork_id = {
                let review = s
                    .reviews
                    .get(review_id)
                    .ok_or_else(|| JourneyError::UnknownReview(review_id.into()))?;
                review.fork_id.clone()
            };
            let branch_snapshot = {
                let branch = s
                    .branches
                    .get(&fork_id)
                    .ok_or_else(|| JourneyError::UnknownBranch(fork_id.clone()))?;
                (
                    branch.id.clone(),
                    branch.state.clone(),
                    branch.parent_branch_id.clone(),
                    branch.parent_anchor_message_id.clone(),
                    branch.anchor_sequence,
                    branch
                        .handoff_capsule
                        .as_ref()
                        .map(|capsule| capsule.review_id.clone()),
                )
            };
            let review_state = s
                .reviews
                .get(review_id)
                .ok_or_else(|| JourneyError::UnknownReview(review_id.into()))?
                .state
                .clone();
            if s.active_branch_id != branch_snapshot.0
                || branch_snapshot.1 != ForkState::Closed
                || !matches!(review_state, ReviewState::Ready | ReviewState::Confirmed)
                || branch_snapshot.5.as_deref() != Some(review_id)
            {
                return Err(JourneyError::MissingHandoff);
            }
            let anchor = branch_snapshot.3.ok_or(JourneyError::MissingHandoff)?;
            parent = Some((branch_snapshot.2.clone(), anchor, branch_snapshot.4));
            s.active_branch_id = branch_snapshot.2;
            s.active_task_id = None;
            Ok(())
        })?;
        Ok(parent.expect("successful parent return supplies its exact anchor"))
    }

    pub fn parent_handoff_capsules(&self, parent_branch_id: &str) -> Vec<&HandoffCapsule> {
        self.branches
            .values()
            .filter(|branch| {
                branch.parent_branch_id == parent_branch_id && branch.state == ForkState::Closed
            })
            .filter_map(|branch| branch.handoff_capsule.as_ref())
            .collect()
    }

    /// A branch sees itself, every descendant, and sibling forks with the
    /// exact same anchor. It never sees parent continuation after its anchor.
    pub fn can_browse_sequence(
        &self,
        viewer_branch_id: &str,
        target_branch_id: &str,
        sequence: u64,
    ) -> Result<bool, JourneyError> {
        let viewer = self
            .branches
            .get(viewer_branch_id)
            .ok_or_else(|| JourneyError::UnknownBranch(viewer_branch_id.into()))?;
        let target = self
            .branches
            .get(target_branch_id)
            .ok_or_else(|| JourneyError::UnknownBranch(target_branch_id.into()))?;
        if viewer_branch_id == target_branch_id {
            return Ok(true);
        }
        if self.is_descendant(target_branch_id, viewer_branch_id) {
            return Ok(true);
        }
        if viewer.parent_branch_id == target.parent_branch_id
            && viewer.anchor_sequence == target.anchor_sequence
        {
            return Ok(true);
        }
        if target_branch_id == &viewer.parent_branch_id {
            return Ok(sequence <= viewer.anchor_sequence);
        }
        Ok(false)
    }

    fn is_descendant(&self, candidate: &str, ancestor: &str) -> bool {
        let mut seen = BTreeSet::new();
        let mut cursor = candidate;
        while seen.insert(cursor) {
            let Some(branch) = self.branches.get(cursor) else {
                return false;
            };
            if branch.parent_branch_id == branch.id {
                return false;
            }
            if branch.parent_branch_id == ancestor {
                return true;
            }
            cursor = &branch.parent_branch_id;
        }
        false
    }
}

/// Parsed command intent shared by Desktop/Tauri and Gateway adapters. Parsing
/// and execution are local-only; neither layer may ask an LLM to interpret a
/// lifecycle mutation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JourneyCommand {
    TaskStart {
        task_id: String,
        name: String,
        start_from_recent: bool,
    },
    TaskCheckpoint {
        checkpoint_id: String,
        message_id: String,
        name: String,
    },
    TaskFinish {
        outcome: TaskOutcome,
        message_id: String,
    },
    ForkStart {
        fork_id: String,
        task_id: String,
        anchor_message_id: String,
        task_name: String,
    },
    ForkClose {
        fork_id: String,
        review_id: String,
        message_id: String,
        outcome: TaskOutcome,
    },
    Status,
    ForkCompare,
    ReviewList,
    ReviewDiscard {
        review_id: String,
    },
    ReviewPromote {
        review_id: String,
        fact_id: String,
        evidence_start_message_id: String,
        evidence_end_message_id: String,
        text: String,
    },
}

/// One application boundary for every Journey mutation. Callers supply an
/// optional observed revision; commands without one read the current revision
/// under the sessions writer and still commit through repository CAS.
pub struct JourneyApplicationService;

impl JourneyApplicationService {
    fn execute_pre_application_service(
        conn: &mut Connection,
        session_id: &str,
        expected_revision: Option<u64>,
        command: JourneyCommand,
    ) -> Result<String, String> {
        SqliteJourneyRepository::ensure_schema(conn).map_err(|error| error.to_string())?;
        let mut journey = SqliteJourneyRepository::load(conn, session_id)
            .map_err(journey_error_text)?
            .unwrap_or_else(|| SessionJourney::new(session_id, "main"));
        let previous_revision = journey.revision;
        if let Some(expected_revision) = expected_revision {
            if expected_revision != previous_revision {
                return Err(journey_error_text(JourneyError::RevisionConflict {
                    expected: expected_revision,
                    actual: previous_revision,
                }));
            }
        }

        let response = match command {
            JourneyCommand::TaskStart { task_id, name, .. } => {
                journey
                    .start_task(previous_revision, task_id.clone(), name, true, None)
                    .map_err(journey_error_text)?;
                format!("任务已创建：{task_id}；将在下一条用户消息持久化后精确激活。")
            }
            JourneyCommand::TaskCheckpoint {
                checkpoint_id,
                message_id,
                name,
            } => {
                let sequence = message_sequence(conn, session_id, &message_id)?;
                journey
                    .checkpoint(
                        previous_revision,
                        checkpoint_id.clone(),
                        name,
                        message_id,
                        sequence,
                    )
                    .map_err(journey_error_text)?;
                format!("检查点已记录：{checkpoint_id}。")
            }
            JourneyCommand::TaskFinish {
                outcome,
                message_id,
            } => {
                let sequence = message_sequence(conn, session_id, &message_id)?;
                let label = outcome.chinese_label();
                journey
                    .finish_task(
                        previous_revision,
                        outcome,
                        sequence,
                        FinishDisposition::StayInFork,
                        None,
                        None,
                    )
                    .map_err(journey_error_text)?;
                format!("任务已结束，结果：{label}。")
            }
            JourneyCommand::ForkStart {
                fork_id,
                task_id,
                anchor_message_id,
                task_name,
            } => {
                let anchor_sequence = message_sequence(conn, session_id, &anchor_message_id)?;
                journey
                    .start_fork(
                        previous_revision,
                        fork_id.clone(),
                        task_id.clone(),
                        task_name,
                        anchor_message_id,
                        anchor_sequence,
                    )
                    .map_err(journey_error_text)?;
                format!("分叉已启动：{fork_id}；任务 {task_id} 已原子绑定到精确锚点。")
            }
            JourneyCommand::ForkClose {
                fork_id,
                review_id,
                message_id,
                outcome: _,
            } => {
                let sequence = message_sequence(conn, session_id, &message_id)?;
                journey
                    .request_fork_close(
                        previous_revision,
                        &fork_id,
                        review_id.clone(),
                        TaskOutcome::Completed,
                        sequence,
                    )
                    .map_err(journey_error_text)?;
                format!("分叉已进入关闭中：{fork_id}；审阅项 {review_id} 已进入待审核队列。")
            }
            JourneyCommand::Status => return Ok(journey_status_text(&journey)),
            JourneyCommand::ForkCompare => return Ok(fork_compare_text(&journey)),
            JourneyCommand::ReviewList => return Ok(review_list_text(&journey)),
            JourneyCommand::ReviewDiscard { review_id } => {
                let anchor = journey
                    .discard_fork(previous_revision, &review_id)
                    .map_err(journey_error_text)?;
                format!("审阅项已丢弃，已回到精确锚点 sequence={anchor}。")
            }
            JourneyCommand::ReviewPromote {
                review_id,
                fact_id,
                evidence_start_message_id,
                evidence_end_message_id,
                text,
            } => {
                let start = message_sequence(conn, session_id, &evidence_start_message_id)?;
                let end = message_sequence(conn, session_id, &evidence_end_message_id)?;
                journey
                    .promote_fact(
                        previous_revision,
                        &review_id,
                        fact_id.clone(),
                        text,
                        evidence_start_message_id,
                        start,
                        evidence_end_message_id,
                        end,
                    )
                    .map_err(journey_error_text)?;
                format!("已在显式审核后确认事实：{fact_id}。")
            }
        };

        SqliteJourneyRepository::compare_and_store(conn, &journey, previous_revision)
            .map_err(journey_error_text)?;
        Ok(response)
    }
}

impl JourneyApplicationService {
    /// Compatibility adapter for the existing explicit Gateway command parser.
    /// New Desktop/Tauri/Gateway integrations should call the typed Session
    /// application service directly.
    pub fn execute(
        conn: &mut Connection,
        session_id: &str,
        expected_revision: Option<u64>,
        command: JourneyCommand,
    ) -> Result<String, String> {
        Self::execute_with_provenance(conn, session_id, expected_revision, command, None)
    }

    /// Execute a deterministic adapter command. Gateway callers must provide
    /// the exact runtime route when closing a fork; domain code never resolves
    /// credentials or session persistence by itself.
    pub fn execute_with_provenance(
        conn: &mut Connection,
        session_id: &str,
        expected_revision: Option<u64>,
        command: JourneyCommand,
        runtime_provenance: Option<RuntimeProvenance>,
    ) -> Result<String, String> {
        use crate::core::session::journey_application_service as service;

        let revision = match expected_revision {
            Some(revision) => revision,
            None => {
                service::SessionJourneyApplicationService::snapshot(conn, session_id)
                    .map_err(|error| error.to_string())?
                    .revision
            }
        };
        let result = match command {
            JourneyCommand::TaskStart {
                task_id,
                name,
                start_from_recent,
            } => {
                let position = if start_from_recent {
                    service::TaskStartPosition::最近用户消息
                } else {
                    service::TaskStartPosition::下一条用户消息
                };
                service::SessionJourneyApplicationService::create_task(
                    conn,
                    service::CreateTaskRequest {
                        session_id: session_id.into(),
                        expected_revision: revision,
                        task_id,
                        name,
                        position,
                    },
                )
                .map(|response| {
                    if start_from_recent {
                        format!(
                            "任务已从最近一条用户消息开始（修订 {}）。",
                            response.revision
                        )
                    } else {
                        format!(
                            "任务已创建，将在下一条用户消息持久化后激活（修订 {}）。",
                            response.revision
                        )
                    }
                })
            }
            JourneyCommand::TaskCheckpoint {
                checkpoint_id,
                message_id,
                name,
            } => service::SessionJourneyApplicationService::create_checkpoint(
                conn,
                service::CreateCheckpointRequest {
                    session_id: session_id.into(),
                    expected_revision: revision,
                    checkpoint_id,
                    name,
                    message_id,
                },
            )
            .map(|response| format!("检查点已记录（修订 {}）。", response.revision)),
            JourneyCommand::TaskFinish {
                outcome,
                message_id,
            } => {
                let label = outcome.chinese_label();
                let message_id = resolve_latest_message_id(conn, session_id, &message_id)?;
                service::SessionJourneyApplicationService::finish_task(
                    conn,
                    service::FinishTaskRequest {
                        session_id: session_id.into(),
                        expected_revision: revision,
                        outcome,
                        message_id,
                    },
                )
                .map(|response| {
                    format!("任务已结束，结果：{label}（修订 {}）。", response.revision)
                })
            }
            JourneyCommand::ForkStart {
                fork_id,
                task_id,
                anchor_message_id,
                task_name,
            } => service::SessionJourneyApplicationService::create_fork(
                conn,
                service::CreateForkRequest {
                    session_id: session_id.into(),
                    expected_revision: revision,
                    fork_id,
                    task_id,
                    task_name,
                    anchor_message_id,
                },
            )
            .map(|response| format!("分叉与活动任务已原子创建（修订 {}）。", response.revision)),
            JourneyCommand::ForkClose {
                fork_id,
                review_id,
                message_id,
                outcome,
            } => {
                let fork_id = resolve_active_fork_id(conn, session_id, &fork_id)?;
                let review_id = resolve_active_review_id(conn, session_id, &review_id)?;
                let message_id = resolve_latest_message_id(conn, session_id, &message_id)?;
                let request = service::RequestForkCloseRequest {
                    session_id: session_id.into(),
                    expected_revision: revision,
                    fork_id,
                    review_id,
                    outcome,
                    message_id,
                };
                let job_id = format!("journey-review-{}", request.review_id);
                let provenance = runtime_provenance.ok_or_else(|| {
                    "关闭分叉需要当前会话的精确模型、账户和协议，未解析时禁止排队。".to_string()
                })?;
                service::SessionJourneyApplicationService::request_fork_close_and_enqueue(
                    conn, request, job_id, provenance,
                )
                .map(|job| {
                    format!(
                        "分叉已进入关闭中，审阅项已进入待审核队列（任务 {}）；尚未生成总结。",
                        job.job_id
                    )
                })
            }
            JourneyCommand::Status => {
                service::SessionJourneyApplicationService::snapshot(conn, session_id)
                    .map(|response| journey_status_text(&response.snapshot))
            }
            JourneyCommand::ForkCompare => {
                service::SessionJourneyApplicationService::fork_compare(conn, session_id)
                    .map(|response| fork_compare_response_text(&response))
            }
            JourneyCommand::ReviewList => service::SessionJourneyApplicationService::review_queue(
                conn, session_id,
            )
            .map(|reviews| {
                if reviews.is_empty() {
                    "当前没有待审核项。".into()
                } else {
                    format!(
                        "待审核项：{}",
                        reviews
                            .iter()
                            .map(|review| review.id.as_str())
                            .collect::<Vec<_>>()
                            .join("、")
                    )
                }
            }),
            JourneyCommand::ReviewDiscard { review_id } => {
                service::SessionJourneyApplicationService::discard_fork(
                    conn,
                    service::DiscardForkRequest {
                        session_id: session_id.into(),
                        expected_revision: revision,
                        review_id,
                    },
                )
                .map(|response| {
                    format!(
                        "分叉已丢弃，父分叉 {} 的精确锚点为消息 {}（sequence={}，修订 {}）。",
                        response.parent_branch_id,
                        response.parent_anchor_message_id,
                        response.parent_anchor_sequence,
                        response.revision
                    )
                })
            }
            JourneyCommand::ReviewPromote {
                review_id,
                fact_id,
                evidence_start_message_id,
                evidence_end_message_id,
                text,
            } => service::SessionJourneyApplicationService::promote_confirmed_fact(
                conn,
                service::PromoteFactRequest {
                    session_id: session_id.into(),
                    expected_revision: revision,
                    review_id,
                    fact_id,
                    evidence_start_message_id,
                    evidence_end_message_id,
                    text,
                },
            )
            .map(|response| format!("已确认事实（修订 {}）。", response.revision)),
        };
        result.map_err(|error| error.to_string())
    }
}

fn fork_compare_response_text(
    comparison: &crate::core::session::journey_application_service::ForkCompareResponse,
) -> String {
    if comparison.groups.is_empty() {
        return "当前没有可比较的同锚点分叉。".to_string();
    }
    comparison
        .groups
        .iter()
        .map(|group| {
            let forks = group
                .forks
                .iter()
                .map(|fork| {
                    format!(
                        "{}（状态：{}；结果：{}；结论：{}；未决：{}；证据：{}）",
                        fork.branch_name,
                        fork.state.chinese_label(),
                        fork.task_outcome
                            .as_ref()
                            .map(TaskOutcome::chinese_label)
                            .unwrap_or("未结束"),
                        fork.conclusion.as_deref().unwrap_or("尚无结构化结论"),
                        if fork.unresolved.is_empty() {
                            "无".to_string()
                        } else {
                            fork.unresolved.join("、")
                        },
                        if fork.evidence.is_empty() {
                            "无".to_string()
                        } else {
                            fork.evidence.join("、")
                        }
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!("锚点 {}：\n{}", group.anchor_sequence, forks)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn resolve_latest_message_id(
    conn: &Connection,
    session_id: &str,
    requested: &str,
) -> Result<String, String> {
    if requested != "@latest" {
        return Ok(requested.to_string());
    }
    conn.query_row(
        "SELECT id FROM agent_messages WHERE session_id=?1 ORDER BY sequence DESC LIMIT 1",
        [session_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "当前会话没有可用的精确消息锚点。".to_string())
}

fn resolve_active_fork_id(
    conn: &Connection,
    session_id: &str,
    requested: &str,
) -> Result<String, String> {
    if requested != "@active" {
        return Ok(requested.to_string());
    }
    let snapshot = service_snapshot(conn, session_id)?;
    (snapshot.active_branch_id != "main")
        .then_some(snapshot.active_branch_id)
        .ok_or_else(|| "当前不在活动分叉中，无法关闭。".to_string())
}

fn resolve_active_review_id(
    conn: &Connection,
    session_id: &str,
    requested: &str,
) -> Result<String, String> {
    if requested != "@active" {
        return Ok(requested.to_string());
    }
    let snapshot = service_snapshot(conn, session_id)?;
    Ok(format!("review-{}", snapshot.active_branch_id))
}

fn service_snapshot(conn: &Connection, session_id: &str) -> Result<SessionJourney, String> {
    crate::core::session::journey_application_service::SessionJourneyApplicationService::snapshot(
        conn, session_id,
    )
    .map(|response| response.snapshot)
    .map_err(|error| error.to_string())
}

fn journey_status_text(journey: &SessionJourney) -> String {
    let task = journey.active_task_id.as_deref().unwrap_or("无");
    format!(
        "Journey：修订 {}；活动分支 `{}`；活动任务 `{task}`；审阅项 {} 个。",
        journey.revision,
        journey.active_branch_id,
        journey.reviews.len()
    )
}

fn fork_compare_text(journey: &SessionJourney) -> String {
    let mut groups: std::collections::BTreeMap<u64, Vec<&JourneyFork>> =
        std::collections::BTreeMap::new();
    for fork in journey
        .branches
        .values()
        .filter(|fork| fork.id != fork.parent_branch_id)
    {
        groups.entry(fork.anchor_sequence).or_default().push(fork);
    }
    let lines: Vec<_> = groups
        .into_iter()
        .filter(|(_, forks)| forks.len() > 1)
        .map(|(anchor, forks)| {
            format!(
                "锚点 {anchor}：{}",
                forks
                    .into_iter()
                    .map(|fork| fork.id.as_str())
                    .collect::<Vec<_>>()
                    .join("、")
            )
        })
        .collect();
    if lines.is_empty() {
        "当前没有同锚点分叉可对比。".into()
    } else {
        format!("同锚点分叉对比：\n{}", lines.join("\n"))
    }
}

fn message_sequence(conn: &Connection, session_id: &str, message_id: &str) -> Result<u64, String> {
    conn.query_row(
        "SELECT sequence FROM agent_messages WHERE session_id = ?1 AND id = ?2",
        params![session_id, message_id],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map_err(|error| error.to_string())?
    .filter(|sequence| *sequence >= 0)
    .map(|sequence| sequence as u64)
    .ok_or_else(|| "未找到该会话中的精确消息锚点。".to_string())
}

fn review_list_text(journey: &SessionJourney) -> String {
    if journey.reviews.is_empty() {
        return "当前没有审阅项。".to_string();
    }
    let items = journey
        .reviews
        .values()
        .map(|review| format!("{}：{}", review.id, review.state.chinese_label()))
        .collect::<Vec<_>>()
        .join("\n");
    format!("审阅项：\n{items}")
}

fn journey_error_text(error: JourneyError) -> String {
    match error {
        JourneyError::RevisionConflict { expected, actual } => {
            format!("Journey 修订冲突：期望 {expected}，当前 {actual}。")
        }
        JourneyError::DuplicateId(id) => format!("Journey ID 已存在：{id}。"),
        JourneyError::UnknownBranch(id) => format!("未知分叉：{id}。"),
        JourneyError::UnknownTask(id) => format!("未知任务：{id}。"),
        JourneyError::UnknownReview(id) => format!("未知审阅项：{id}。"),
        JourneyError::NoActiveTask => "当前没有活动任务。".to_string(),
        JourneyError::ActiveTaskExists => "当前已有活动任务。".to_string(),
        JourneyError::InvalidState(message) => message.to_string(),
        JourneyError::InvalidSequence => "无效的精确 sequence。".to_string(),
        JourneyError::MissingRuntimeProvenance => "缺少运行来源信息。".to_string(),
        JourneyError::AccessDenied => "该精确锚点不在审阅范围内。".to_string(),
        JourneyError::MissingHandoff => "缺少有效的中文交接胶囊。".to_string(),
    }
}

/// SQLite persistence boundary for the lifecycle aggregate.  The aggregate is
/// deliberately one JSON document: a lifecycle change updates the active
/// branch, active task and revision in one transaction, so no reader can see
/// an impossible intermediate combination.
pub struct SqliteJourneyRepository;

impl SqliteJourneyRepository {
    pub fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS session_journeys (
                session_id TEXT PRIMARY KEY NOT NULL,
                revision INTEGER NOT NULL,
                state_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS session_journey_memberships (
                session_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                branch_id TEXT NOT NULL,
                task_id TEXT,
                PRIMARY KEY (session_id, message_id)
            );
            CREATE TABLE IF NOT EXISTS session_journey_turn_memberships (
                session_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                completed_sequence INTEGER NOT NULL,
                branch_id TEXT NOT NULL,
                task_id TEXT,
                PRIMARY KEY (session_id, turn_id)
            );
            CREATE INDEX IF NOT EXISTS idx_session_journey_memberships_sequence
                ON session_journey_memberships (session_id, sequence)",
        )
    }

    pub fn load(
        conn: &Connection,
        session_id: &str,
    ) -> Result<Option<SessionJourney>, JourneyError> {
        Self::ensure_schema(conn)
            .map_err(|_| JourneyError::InvalidState("无法初始化 Journey 存储"))?;
        Self::load_existing(conn, session_id)
    }

    /// Read a durable Journey aggregate without initializing schema.
    ///
    /// Read-only consumers (for example the canonical graph query) must not
    /// turn a lookup into a database mutation. An older database with no
    /// Journey table simply has no Journey aggregate yet; a present but
    /// unreadable/corrupt record still fails closed.
    pub fn load_existing(
        conn: &Connection,
        session_id: &str,
    ) -> Result<Option<SessionJourney>, JourneyError> {
        let has_table: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_journeys'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| JourneyError::InvalidState("无法读取 Journey 存储"))?;
        if has_table.is_none() {
            return Ok(None);
        }
        let json: Option<String> = conn
            .query_row(
                "SELECT state_json FROM session_journeys WHERE session_id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| JourneyError::InvalidState("无法读取 Journey 存储"))?;
        json.map(|value| {
            serde_json::from_str(&value)
                .map_err(|_| JourneyError::InvalidState("Journey 存储已损坏"))
        })
        .transpose()
    }

    pub fn compare_and_store(
        conn: &mut Connection,
        journey: &SessionJourney,
        expected_previous_revision: u64,
    ) -> Result<(), JourneyError> {
        Self::ensure_schema(conn)
            .map_err(|_| JourneyError::InvalidState("无法初始化 Journey 存储"))?;
        if journey.revision != expected_previous_revision.saturating_add(1) {
            return Err(JourneyError::RevisionConflict {
                expected: expected_previous_revision.saturating_add(1),
                actual: journey.revision,
            });
        }
        let tx = conn
            .transaction()
            .map_err(|_| JourneyError::InvalidState("无法开启 Journey 事务"))?;
        let current: Option<u64> = tx
            .query_row(
                "SELECT revision FROM session_journeys WHERE session_id = ?1",
                [&journey.session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| JourneyError::InvalidState("无法读取 Journey 修订"))?;
        let actual = current.unwrap_or(0);
        if current.is_some() && actual != expected_previous_revision {
            return Err(JourneyError::RevisionConflict {
                expected: expected_previous_revision,
                actual,
            });
        }
        if current.is_none() && expected_previous_revision != 0 {
            return Err(JourneyError::RevisionConflict {
                expected: expected_previous_revision,
                actual: 0,
            });
        }
        let state_json = serde_json::to_string(journey)
            .map_err(|_| JourneyError::InvalidState("无法序列化 Journey"))?;
        tx.execute(
            "INSERT INTO session_journeys (session_id, revision, state_json) VALUES (?1, ?2, ?3)
             ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision, state_json = excluded.state_json",
            params![journey.session_id, journey.revision, state_json],
        ).map_err(|_| JourneyError::InvalidState("无法写入 Journey"))?;
        tx.commit()
            .map_err(|_| JourneyError::InvalidState("无法提交 Journey"))?;
        Ok(())
    }

    /// Store inside a caller-owned transaction. This is used when a durable
    /// transcript write must activate a pending task atomically.
    pub fn compare_and_store_in_transaction(
        tx: &Transaction<'_>,
        journey: &SessionJourney,
        expected_previous_revision: u64,
    ) -> Result<(), JourneyError> {
        let current: Option<u64> = tx
            .query_row(
                "SELECT revision FROM session_journeys WHERE session_id = ?1",
                [&journey.session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| JourneyError::InvalidState("无法读取 Journey 修订"))?;
        let actual = current.unwrap_or(0);
        if current.is_some() && actual != expected_previous_revision {
            return Err(JourneyError::RevisionConflict {
                expected: expected_previous_revision,
                actual,
            });
        }
        if current.is_none() && expected_previous_revision != 0 {
            return Err(JourneyError::RevisionConflict {
                expected: expected_previous_revision,
                actual: 0,
            });
        }
        let state_json = serde_json::to_string(journey)
            .map_err(|_| JourneyError::InvalidState("无法序列化 Journey"))?;
        tx.execute(
            "INSERT INTO session_journeys (session_id, revision, state_json) VALUES (?1, ?2, ?3)
             ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision, state_json = excluded.state_json",
            params![journey.session_id, journey.revision, state_json],
        )
        .map_err(|_| JourneyError::InvalidState("无法写入 Journey"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn provenance() -> RuntimeProvenance {
        RuntimeProvenance {
            model_id: "m".into(),
            account_id: "a".into(),
            protocol: "openai".into(),
        }
    }
    fn capsule() -> HandoffCapsule {
        HandoffCapsule {
            fork_id: "f1".into(),
            review_id: "r".into(),
            parent_branch_id: "main".into(),
            parent_anchor_message_id: "anchor-10".into(),
            source_start_sequence: 11,
            source_end_sequence: 15,
            objective: "核对分叉结论".into(),
            conclusion: "可以从主干继续".into(),
            open_questions: vec!["是否补充回归验证".into()],
            confirmed_items: vec!["锚点保持不变".into()],
            evidence_references: vec!["检查点 anchor-10".into()],
            generated_at: Some("仅元数据".into()),
            provenance: provenance(),
        }
    }
    fn forked() -> SessionJourney {
        let mut j = SessionJourney::new("s", "main");
        j.start_fork(
            0,
            "f1".into(),
            "t1".into(),
            "调查".into(),
            "anchor-10".into(),
            10,
        )
        .unwrap();
        j
    }

    #[test]
    fn latest_and_next_task_activation_are_sequence_based() {
        let mut j = SessionJourney::new("s", "main");
        j.start_task(0, "a".into(), "最新任务".into(), false, Some(7))
            .unwrap();
        assert_eq!(j.tasks["a"].start_sequence, Some(7));
        j.finish_task(
            1,
            TaskOutcome::Completed,
            8,
            FinishDisposition::StayInFork,
            None,
            None,
        )
        .unwrap();
        j.start_task(2, "b".into(), "下一条".into(), true, None)
            .unwrap();
        j.on_user_message_persisted(3, 9).unwrap();
        assert_eq!(j.tasks["b"].start_sequence, Some(9));
    }
    #[test]
    fn checkpoint_is_attached_to_exact_message() {
        let mut j = forked();
        j.checkpoint(1, "c".into(), "结论".into(), "msg-12".into(), 12)
            .unwrap();
        assert_eq!(j.checkpoints["c"].message_id, "msg-12");
    }
    #[test]
    fn fork_always_creates_active_task() {
        let j = forked();
        assert_eq!(j.active_branch_id, "f1");
        assert_eq!(j.active_task_id.as_deref(), Some("t1"));
    }
    #[test]
    fn sibling_is_visible_but_parent_future_is_denied() {
        let mut j = forked();
        j.finish_task(
            1,
            TaskOutcome::Completed,
            12,
            FinishDisposition::StayInFork,
            None,
            None,
        )
        .unwrap();
        j.active_branch_id = "main".into();
        j.start_fork(
            2,
            "f2".into(),
            "t2".into(),
            "同锚点".into(),
            "anchor-10".into(),
            10,
        )
        .unwrap();
        assert!(j.can_browse_sequence("f1", "f2", 11).unwrap());
        assert!(!j.can_browse_sequence("f1", "main", 11).unwrap());
        assert!(j.can_browse_sequence("f1", "main", 10).unwrap());
    }
    #[test]
    fn close_freezes_range_and_queues_review() {
        let mut j = forked();
        j.finish_task(
            1,
            TaskOutcome::PartiallyCompleted,
            15,
            FinishDisposition::CloseFork,
            Some("work".into()),
            Some(provenance()),
        )
        .unwrap();
        assert_eq!(j.branches["f1"].frozen_end_sequence, Some(15));
        j.complete_close(
            2,
            "f1",
            "r".into(),
            Some(provenance()),
            Some("AI 标注".into()),
        )
        .unwrap();
        assert_eq!(j.reviews["r"].state, ReviewState::Queued);
    }
    #[test]
    fn discard_returns_exact_anchor_and_removes_promotions() {
        let mut j = forked();
        j.finish_task(
            1,
            TaskOutcome::Completed,
            15,
            FinishDisposition::CloseFork,
            Some("w".into()),
            Some(provenance()),
        )
        .unwrap();
        j.complete_close(2, "f1", "r".into(), Some(provenance()), None)
            .unwrap();
        j.mark_review_ready(3, "r", provenance(), "待审核标注".into())
            .unwrap();
        j.promote_fact(
            4,
            "r",
            "fact".into(),
            "确认".into(),
            "m11".into(),
            11,
            "m15".into(),
            15,
        )
        .unwrap();
        assert_eq!(j.discard_fork(5, "r").unwrap(), 10);
        assert!(j.facts.is_empty());
    }
    #[test]
    fn ready_closed_review_publishes_immutable_handoff_and_returns_exact_parent() {
        let mut j = forked();
        j.finish_task(
            1,
            TaskOutcome::Completed,
            15,
            FinishDisposition::CloseFork,
            Some("w".into()),
            Some(provenance()),
        )
        .unwrap();
        j.complete_close(
            2,
            "f1",
            "r".into(),
            Some(provenance()),
            Some("原始分叉记录不得进入主干".into()),
        )
        .unwrap();
        j.mark_review_ready(3, "r", provenance(), "审核结论".into())
            .unwrap();
        j.publish_handoff_capsule(4, "f1", capsule()).unwrap();
        assert_eq!(
            j.branches["f1"]
                .handoff_capsule
                .as_ref()
                .map(|capsule| capsule.conclusion.as_str()),
            Some("可以从主干继续")
        );
        assert_ne!(
            j.branches["f1"]
                .handoff_capsule
                .as_ref()
                .map(HandoffCapsule::synthetic_prompt_message),
            j.reviews["r"]
                .annotation
                .as_ref()
                .map(|text| serde_json::json!({ "role": "user", "content": text }))
        );
        assert_eq!(
            j.return_to_parent(5, "r").unwrap(),
            ("main".into(), "anchor-10".into(), 10)
        );
        assert_eq!(j.active_branch_id, "main");
    }

    #[test]
    fn queued_or_discarded_review_never_publishes_handoff() {
        let mut j = forked();
        j.finish_task(
            1,
            TaskOutcome::Completed,
            15,
            FinishDisposition::CloseFork,
            Some("w".into()),
            Some(provenance()),
        )
        .unwrap();
        j.complete_close(2, "f1", "r".into(), Some(provenance()), None)
            .unwrap();
        assert!(matches!(
            j.publish_handoff_capsule(3, "f1", capsule()),
            Err(JourneyError::MissingHandoff)
        ));
        j.mark_review_ready(3, "r", provenance(), "审核结论".into())
            .unwrap();
        j.discard_fork(4, "r").unwrap();
        assert!(matches!(
            j.publish_handoff_capsule(5, "f1", capsule()),
            Err(JourneyError::MissingHandoff)
        ));
    }
    #[test]
    fn lifecycle_is_cas_and_never_needs_llm() {
        let mut j = SessionJourney::new("s", "main");
        assert!(matches!(
            j.start_task(1, "t".into(), "任务".into(), false, Some(1)),
            Err(JourneyError::RevisionConflict { .. })
        ));
        j.start_task(0, "t".into(), "任务".into(), false, Some(1))
            .unwrap();
        assert_eq!(TaskOutcome::Redirected.chinese_label(), "转向");
    }
    #[test]
    fn repository_preserves_revision_cas_across_reopen() {
        let mut conn = Connection::open_in_memory().unwrap();
        let mut j = SessionJourney::new("s", "main");
        j.start_task(0, "t".into(), "持久任务".into(), false, Some(3))
            .unwrap();
        SqliteJourneyRepository::compare_and_store(&mut conn, &j, 0).unwrap();
        assert_eq!(
            SqliteJourneyRepository::load(&conn, "s")
                .unwrap()
                .unwrap()
                .active_task_id
                .as_deref(),
            Some("t")
        );
        assert!(matches!(
            SqliteJourneyRepository::compare_and_store(&mut conn, &j, 0),
            Err(JourneyError::RevisionConflict { .. })
        ));
    }

    #[test]
    fn read_only_load_does_not_create_journey_schema() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(SqliteJourneyRepository::load_existing(&conn, "s")
            .unwrap()
            .is_none());
        let table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'session_journeys'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_count, 0);
    }

    #[test]
    fn read_only_load_rejects_corrupt_existing_state() {
        let conn = Connection::open_in_memory().unwrap();
        SqliteJourneyRepository::ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO session_journeys (session_id, revision, state_json) VALUES (?1, ?2, ?3)",
            params!["s", 1_u64, "not-json"],
        )
        .unwrap();
        assert!(matches!(
            SqliteJourneyRepository::load_existing(&conn, "s"),
            Err(JourneyError::InvalidState("Journey 存储已损坏"))
        ));
    }

    #[test]
    fn persisted_user_membership_activates_pending_task_in_the_same_transaction() {
        let mut conn = Connection::open_in_memory().unwrap();
        SqliteJourneyRepository::ensure_schema(&conn).unwrap();
        let mut journey = SessionJourney::new("s", "main");
        journey
            .start_task(0, "t".into(), "下一条任务".into(), true, None)
            .unwrap();
        SqliteJourneyRepository::compare_and_store(&mut conn, &journey, 0).unwrap();

        let tx = conn.transaction().unwrap();
        let mut loaded = SqliteJourneyRepository::load(&tx, "s").unwrap().unwrap();
        loaded.on_user_message_persisted(1, 42).unwrap();
        SqliteJourneyRepository::compare_and_store_in_transaction(&tx, &loaded, 1).unwrap();
        tx.execute(
            "INSERT INTO session_journey_memberships
             (session_id, message_id, sequence, branch_id, task_id)
             VALUES ('s', 'msg-42', 42, 'main', 't')",
            [],
        )
        .unwrap();
        tx.commit().unwrap();

        let reopened = SqliteJourneyRepository::load(&conn, "s").unwrap().unwrap();
        assert_eq!(reopened.tasks["t"].start_sequence, Some(42));
        let membership: (String, i64, String, Option<String>) = conn
            .query_row(
                "SELECT message_id, sequence, branch_id, task_id
                 FROM session_journey_memberships WHERE session_id = 's'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            membership,
            ("msg-42".into(), 42, "main".into(), Some("t".into()))
        );
    }

    fn application_test_schema(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE agent_sessions (session_id TEXT PRIMARY KEY);
             CREATE TABLE agent_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                role TEXT NOT NULL DEFAULT 'user'
            );
             INSERT INTO agent_sessions (session_id) VALUES ('s');",
        )
        .unwrap();
    }

    #[test]
    fn application_service_uses_exact_message_ids_and_cas() {
        let mut conn = Connection::open_in_memory().unwrap();
        application_test_schema(&conn);
        conn.execute(
            "INSERT INTO agent_messages (id, session_id, sequence) VALUES ('anchor', 's', 7)",
            [],
        )
        .unwrap();

        let reply = JourneyApplicationService::execute(
            &mut conn,
            "s",
            Some(0),
            JourneyCommand::TaskStart {
                task_id: "task-a".into(),
                name: "中文任务".into(),
                start_from_recent: false,
            },
        )
        .unwrap();
        assert_eq!(
            reply,
            "任务已创建，将在下一条用户消息持久化后激活（修订 1）。"
        );
        assert_eq!(
            JourneyApplicationService::execute(
                &mut conn,
                "s",
                Some(0),
                JourneyCommand::ReviewList,
            )
            .unwrap(),
            "当前没有待审核项。"
        );
    }

    #[test]
    fn fork_close_without_exact_runtime_provenance_fails_closed() {
        let mut conn = Connection::open_in_memory().unwrap();
        application_test_schema(&conn);
        conn.execute(
            "INSERT INTO agent_messages (id, session_id, sequence) VALUES ('anchor', 's', 9)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO agent_messages (id, session_id, sequence) VALUES ('fork-end', 's', 10)",
            [],
        )
        .unwrap();
        JourneyApplicationService::execute(
            &mut conn,
            "s",
            None,
            JourneyCommand::ForkStart {
                fork_id: "fork-a".into(),
                task_id: "task-a".into(),
                anchor_message_id: "anchor".into(),
                task_name: "调查".into(),
            },
        )
        .unwrap();
        let error = JourneyApplicationService::execute(
            &mut conn,
            "s",
            None,
            JourneyCommand::ForkClose {
                fork_id: "fork-a".into(),
                review_id: "review-a".into(),
                message_id: "fork-end".into(),
                outcome: TaskOutcome::Completed,
            },
        )
        .unwrap_err();
        assert!(error.contains("精确模型、账户和协议"));
        assert!(SqliteJourneyRepository::load(&conn, "s")
            .unwrap()
            .unwrap()
            .reviews
            .is_empty());
    }

    #[test]
    fn application_service_fork_close_queues_review_at_exact_anchor() {
        let mut conn = Connection::open_in_memory().unwrap();
        application_test_schema(&conn);
        conn.execute(
            "INSERT INTO agent_messages (id, session_id, sequence) VALUES ('anchor', 's', 9)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO agent_messages (id, session_id, sequence) VALUES ('fork-end', 's', 10)",
            [],
        )
        .unwrap();
        let reply = JourneyApplicationService::execute(
            &mut conn,
            "s",
            None,
            JourneyCommand::ForkStart {
                fork_id: "fork-a".into(),
                task_id: "task-a".into(),
                anchor_message_id: "anchor".into(),
                task_name: "调查".into(),
            },
        )
        .unwrap();
        assert_eq!(reply, "分叉与活动任务已原子创建（修订 1）。");
        let reply = JourneyApplicationService::execute_with_provenance(
            &mut conn,
            "s",
            None,
            JourneyCommand::ForkClose {
                fork_id: "fork-a".into(),
                review_id: "review-a".into(),
                message_id: "fork-end".into(),
                outcome: TaskOutcome::Completed,
            },
            Some(provenance()),
        )
        .unwrap();
        assert_eq!(
            reply,
            "分叉已进入关闭中，审阅项已进入待审核队列（任务 journey-review-review-a）；尚未生成总结。"
        );
        assert_eq!(
            JourneyApplicationService::execute(&mut conn, "s", None, JourneyCommand::ReviewList)
                .unwrap(),
            "待审核项：review-a"
        );
    }
}
