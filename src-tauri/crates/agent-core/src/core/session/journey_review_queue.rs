//! Durable, provider-neutral review queue for closed Session Journey forks.
//!
//! This module owns the durable queue contract and its host-neutral executor.
//! The desktop composition root starts the executor explicitly; closing a
//! fork remains a fast local operation and only emits a coalesced wake.

use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::core::journey_lifecycle::{RuntimeProvenance, SessionJourney};
use crate::core::session::journey_application_service::{
    FailReviewRequest, MarkReviewReadyRequest, SessionJourneyApplicationService,
};
use crate::core::side_query::{side_query_typed, SideQueryConfig, StructuredOutput};
use crate::providers::traits::LLMProvider;

const RECOVERY_TICK: Duration = Duration::from_secs(30);
const STALE_LEASE_SECS: u64 = 5 * 60;
const MAX_JOBS_PER_WAKE: usize = 4;

/// Narrow host boundary: foreground application services can wake a worker
/// without knowing whether the host is Tauri, a test harness, or another UI.
pub trait ReviewQueueNotifier: Send + Sync {
    fn notify_review_queue(&self);
}

static REVIEW_QUEUE_NOTIFIER: OnceLock<RwLock<Option<Arc<dyn ReviewQueueNotifier>>>> =
    OnceLock::new();

fn notifier_slot() -> &'static RwLock<Option<Arc<dyn ReviewQueueNotifier>>> {
    REVIEW_QUEUE_NOTIFIER.get_or_init(|| RwLock::new(None))
}

pub fn install_review_queue_notifier(notifier: Arc<dyn ReviewQueueNotifier>) {
    if let Ok(mut slot) = notifier_slot().write() {
        *slot = Some(notifier);
    }
}

pub fn notify_review_queue() {
    if let Ok(slot) = notifier_slot().read() {
        if let Some(notifier) = slot.as_ref() {
            notifier.notify_review_queue();
        }
    }
}

#[derive(Clone)]
pub struct JourneyReviewExecutorHandle {
    inner: Arc<JourneyReviewExecutorInner>,
}

struct JourneyReviewExecutorInner {
    wake: Notify,
    cancel: CancellationToken,
    join: Mutex<Option<JoinHandle<()>>>,
    runner: Arc<dyn ExecutorJobRunner>,
}

#[async_trait]
trait ExecutorJobRunner: Send + Sync {
    /// `true` means the executor may immediately attempt another job; `false`
    /// means the queue was empty or unavailable and it should wait for a wake.
    async fn run_one(&self) -> bool;
}

struct DurableReviewJobRunner;

#[async_trait]
impl ExecutorJobRunner for DurableReviewJobRunner {
    async fn run_one(&self) -> bool {
        if run_durable_job().await {
            return true;
        }
        run_durable_embedding_job().await
    }
}

impl JourneyReviewExecutorHandle {
    /// Starts one durable queue consumer. Calling this once from the desktop
    /// composition root is intentional; database claims also protect against
    /// a second process or an accidental second handle.
    pub fn spawn() -> Self {
        Self::spawn_with_runner(Arc::new(DurableReviewJobRunner))
    }

    fn spawn_with_runner(runner: Arc<dyn ExecutorJobRunner>) -> Self {
        let inner = Arc::new(JourneyReviewExecutorInner {
            wake: Notify::new(),
            cancel: CancellationToken::new(),
            join: Mutex::new(None),
            runner,
        });
        let task_inner = Arc::clone(&inner);
        let join = tokio::spawn(async move { run_executor(task_inner).await });
        if let Ok(mut slot) = inner.join.lock() {
            *slot = Some(join);
        } else {
            join.abort();
            tracing::warn!("[journey-review] 无法保存 executor handle");
        }
        Self { inner }
    }

    /// Initialize the durable queue and release work claimed by the previous
    /// process before this host starts accepting wakes. A missing database
    /// must not prevent the desktop application from launching; the periodic
    /// worker recovery path will retry later.
    pub fn ensure_schema_at_startup() {
        match crate::foundation::db_bridge::get_connection()
            .map_err(|error| QueueError::Storage(format!("无法打开审核队列数据库：{error}")))
            .and_then(|conn| {
                ReviewJobRepository::ensure_schema(&conn)?;
                ReviewJobRepository::requeue_orphaned_running_jobs(&conn)?;
                Ok(())
            }) {
            Ok(()) => {}
            Err(error) => tracing::error!(error = %error, "[journey-review] 审核队列表初始化失败"),
        }
    }

    pub fn wake(&self) {
        self.inner.wake.notify_one();
    }

    /// Synchronous, non-blocking half of shutdown. Hosts may call this from
    /// event-loop callbacks where awaiting a task would deadlock or hang exit.
    pub fn request_shutdown(&self) {
        self.inner.cancel.cancel();
        self.inner.wake.notify_waiters();
    }

    pub async fn shutdown(&self) {
        self.request_shutdown();
        let join = match self.inner.join.lock() {
            Ok(mut slot) => slot.take(),
            Err(_) => {
                tracing::warn!("[journey-review] executor handle 锁已损坏");
                None
            }
        };
        if let Some(join) = join {
            if let Err(error) = join.await {
                tracing::warn!(error = %error, "[journey-review] executor join failed");
            }
        }
    }
}

impl ReviewQueueNotifier for JourneyReviewExecutorHandle {
    fn notify_review_queue(&self) {
        self.wake();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewJobState {
    Queued,
    Running,
    Ready,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewJob {
    pub job_id: String,
    pub review_id: String,
    pub fork_id: String,
    pub session_id: String,
    pub frozen_start_sequence: u64,
    pub frozen_end_sequence: u64,
    pub exact_anchor_message_id: String,
    pub revision: u64,
    pub state: ReviewJobState,
    pub attempt: u32,
    pub error: Option<String>,
    pub model_id: String,
    pub account_id: String,
    pub protocol: String,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewDraftAnnotation {
    pub objective: String,
    pub conclusion: String,
    pub open_questions: Vec<String>,
    pub confirmation_items: Vec<String>,
    pub evidence_message_ids: Vec<String>,
    pub possibly_no_value: bool,
    pub source_range: (u64, u64),
    pub provenance: RuntimeProvenance,
    pub critic_notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueueError {
    Storage(String),
    Conflict(String),
    Invalid(String),
}

impl std::fmt::Display for QueueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Storage(s) | Self::Conflict(s) | Self::Invalid(s) => f.write_str(s),
        }
    }
}
impl std::error::Error for QueueError {}

fn now() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".into())
}

pub struct ReviewJobRepository;

impl ReviewJobRepository {
    pub fn ensure_schema(conn: &Connection) -> Result<(), QueueError> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS session_journey_review_jobs (
                job_id TEXT PRIMARY KEY NOT NULL,
                review_id TEXT NOT NULL UNIQUE,
                fork_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                frozen_start_sequence INTEGER NOT NULL,
                frozen_end_sequence INTEGER NOT NULL,
                exact_anchor_message_id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                state TEXT NOT NULL,
                attempt INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                model_id TEXT NOT NULL,
                account_id TEXT NOT NULL,
                protocol TEXT NOT NULL,
                created_at TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_journey_review_jobs_state
              ON session_journey_review_jobs(state, created_at);",
        )
        .map_err(|e| QueueError::Storage(format!("无法初始化审核队列：{e}")))
    }

    pub fn enqueue(
        conn: &Connection,
        journey: &SessionJourney,
        job_id: impl Into<String>,
        review_id: &str,
        provenance: &RuntimeProvenance,
    ) -> Result<ReviewJob, QueueError> {
        Self::ensure_schema(conn)?;
        let review = journey
            .reviews
            .get(review_id)
            .ok_or_else(|| QueueError::Invalid("未找到待审核项。".into()))?;
        let fork = journey
            .branches
            .get(&review.fork_id)
            .ok_or_else(|| QueueError::Invalid("未找到分叉。".into()))?;
        if review.source_start_sequence > review.source_end_sequence
            || fork.parent_anchor_message_id.is_none()
        {
            return Err(QueueError::Invalid("审核范围或精确锚点无效。".into()));
        }
        provenance
            .validate_for_queue()
            .map_err(QueueError::Invalid)?;
        if let Some(existing) = Self::get(conn, review_id)? {
            return Ok(existing);
        }
        let job = ReviewJob {
            job_id: job_id.into(),
            review_id: review_id.into(),
            fork_id: review.fork_id.clone(),
            session_id: journey.session_id.clone(),
            frozen_start_sequence: review.source_start_sequence,
            frozen_end_sequence: review.source_end_sequence,
            exact_anchor_message_id: fork.parent_anchor_message_id.clone().unwrap(),
            revision: journey.revision,
            state: ReviewJobState::Queued,
            attempt: 0,
            error: None,
            model_id: provenance.model_id.clone(),
            account_id: provenance.account_id.clone(),
            protocol: provenance.protocol.clone(),
            created_at: now(),
            started_at: None,
            finished_at: None,
        };
        conn.execute(
            "INSERT INTO session_journey_review_jobs
             (job_id,review_id,fork_id,session_id,frozen_start_sequence,frozen_end_sequence,
              exact_anchor_message_id,revision,state,attempt,error,model_id,account_id,protocol,created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'queued',0,NULL,?9,?10,?11,?12)",
            params![job.job_id, job.review_id, job.fork_id, job.session_id,
                job.frozen_start_sequence as i64, job.frozen_end_sequence as i64,
                job.exact_anchor_message_id, job.revision as i64, job.model_id,
                job.account_id, job.protocol, job.created_at],
        )
        .map_err(|e| QueueError::Storage(format!("无法排队审核：{e}")))?;
        Ok(job)
    }

    pub fn get(conn: &Connection, review_id: &str) -> Result<Option<ReviewJob>, QueueError> {
        Self::ensure_schema(conn)?;
        conn.query_row("SELECT job_id,review_id,fork_id,session_id,frozen_start_sequence,frozen_end_sequence,exact_anchor_message_id,revision,state,attempt,error,model_id,account_id,protocol,created_at,started_at,finished_at FROM session_journey_review_jobs WHERE review_id=?1", [review_id], row_job)
            .optional().map_err(|e| QueueError::Storage(format!("无法读取审核队列：{e}")))
    }

    pub fn list(conn: &Connection) -> Result<Vec<ReviewJob>, QueueError> {
        Self::ensure_schema(conn)?;
        let mut stmt = conn
            .prepare("SELECT job_id,review_id,fork_id,session_id,frozen_start_sequence,frozen_end_sequence,exact_anchor_message_id,revision,state,attempt,error,model_id,account_id,protocol,created_at,started_at,finished_at FROM session_journey_review_jobs ORDER BY created_at")
            .map_err(|e| QueueError::Storage(format!("无法列出审核队列：{e}")))?;
        let rows = stmt
            .query_map([], row_job)
            .map_err(|e| QueueError::Storage(format!("无法列出审核队列：{e}")))?;
        rows.map(|row| row.map_err(|e| QueueError::Storage(format!("无法读取审核任务：{e}"))))
            .collect()
    }

    pub fn claim(
        conn: &mut Connection,
        worker_id: &str,
        stale_after_secs: u64,
    ) -> Result<Option<ReviewJob>, QueueError> {
        Self::ensure_schema(conn)?;
        conn.busy_timeout(Duration::from_secs(1))
            .map_err(|e| QueueError::Storage(e.to_string()))?;
        let cutoff = now()
            .parse::<u64>()
            .unwrap_or(0)
            .saturating_sub(stale_after_secs)
            .to_string();
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| QueueError::Storage(e.to_string()))?;
        tx.execute(
            "UPDATE session_journey_review_jobs SET state='queued', started_at=NULL WHERE state='running' AND started_at < ?1",
            [cutoff],
        )
        .map_err(|e| QueueError::Storage(e.to_string()))?;
        let review_id: Option<String> = tx.query_row("SELECT review_id FROM session_journey_review_jobs WHERE state='queued' ORDER BY created_at LIMIT 1", [], |r| r.get(0)).optional().map_err(|e| QueueError::Storage(e.to_string()))?;
        let Some(review_id) = review_id else {
            tx.commit()
                .map_err(|e| QueueError::Storage(e.to_string()))?;
            return Ok(None);
        };
        let changed = tx.execute("UPDATE session_journey_review_jobs SET state='running',started_at=?1,attempt=attempt+1,error=NULL WHERE review_id=?2 AND state='queued'", params![now(), review_id]).map_err(|e| QueueError::Storage(e.to_string()))?;
        tx.commit()
            .map_err(|e| QueueError::Storage(e.to_string()))?;
        if changed != 1 {
            return Ok(None);
        }
        let mut job = Self::get(conn, &review_id)?
            .ok_or_else(|| QueueError::Conflict("审核任务在认领时消失。".into()))?;
        job.error = Some(format!("worker={worker_id}"));
        Ok(Some(job))
    }

    /// Startup recovery releases jobs that were claimed by a process which
    /// exited before it could commit a terminal state. Call this only while
    /// bringing up the single host executor, before it begins processing.
    pub fn requeue_orphaned_running_jobs(conn: &Connection) -> Result<usize, QueueError> {
        Self::ensure_schema(conn)?;
        conn.execute(
            "UPDATE session_journey_review_jobs
             SET state='queued', started_at=NULL, error=NULL, finished_at=NULL
             WHERE state='running'",
            [],
        )
        .map_err(|e| QueueError::Storage(format!("无法恢复遗留审核任务：{e}")))
    }

    pub fn complete(conn: &Connection, job_id: &str) -> Result<(), QueueError> {
        Self::transition(conn, job_id, "running", "ready", None)
    }
    pub fn fail(conn: &Connection, job_id: &str, error: &str) -> Result<(), QueueError> {
        Self::transition(conn, job_id, "running", "failed", Some(error))
    }
    pub fn retry(conn: &Connection, job_id: &str) -> Result<(), QueueError> {
        Self::transition(conn, job_id, "failed", "queued", None)
    }
    fn transition(
        conn: &Connection,
        id: &str,
        from: &str,
        to: &str,
        error: Option<&str>,
    ) -> Result<(), QueueError> {
        let n = conn.execute("UPDATE session_journey_review_jobs SET state=?1,error=?2,finished_at=CASE WHEN ?1 IN ('ready','failed') THEN ?3 ELSE finished_at END WHERE job_id=?4 AND state=?5", params![to,error,now(),id,from]).map_err(|e| QueueError::Storage(e.to_string()))?;
        if n == 1 {
            Ok(())
        } else {
            Err(QueueError::Conflict("审核任务状态已改变。".into()))
        }
    }
}

fn row_job(r: &rusqlite::Row<'_>) -> rusqlite::Result<ReviewJob> {
    let state: String = r.get(8)?;
    Ok(ReviewJob {
        job_id: r.get(0)?,
        review_id: r.get(1)?,
        fork_id: r.get(2)?,
        session_id: r.get(3)?,
        frozen_start_sequence: r.get::<_, i64>(4)? as u64,
        frozen_end_sequence: r.get::<_, i64>(5)? as u64,
        exact_anchor_message_id: r.get(6)?,
        revision: r.get::<_, i64>(7)? as u64,
        state: match state.as_str() {
            "queued" => ReviewJobState::Queued,
            "running" => ReviewJobState::Running,
            "ready" => ReviewJobState::Ready,
            "failed" => ReviewJobState::Failed,
            _ => ReviewJobState::Failed,
        },
        attempt: r.get::<_, i64>(9)? as u32,
        error: r.get(10)?,
        model_id: r.get(11)?,
        account_id: r.get(12)?,
        protocol: r.get(13)?,
        created_at: r.get(14)?,
        started_at: r.get(15)?,
        finished_at: r.get(16)?,
    })
}

impl RuntimeProvenance {
    fn validate_for_queue(&self) -> Result<(), String> {
        if self.model_id.trim().is_empty()
            || self.account_id.trim().is_empty()
            || self.protocol.trim().is_empty()
        {
            Err("模型、账户和协议 provenance 必须完整。".into())
        } else {
            Ok(())
        }
    }
}

pub fn chinese_prompt(stage: &str, transcript: &str, anchor: &str) -> String {
    format!("你是中文审核 worker。阶段：{stage}。只能依据冻结分叉区间消息；精确父锚点为 {anchor}。不得读取锚点之后的父分支续写、其他锚点兄弟分叉或臆造证据。输出严格 JSON，不要 Markdown。\n冻结内容：\n{transcript}")
}

#[async_trait]
pub trait ReviewModel {
    async fn run(&self, prompt: String, provenance: &RuntimeProvenance) -> Result<Value, String>;
}

/// Adapter over the established provider-neutral side-query path.  The host
/// supplies the runtime it resolved for the fork; a mismatch is an error,
/// never an opportunity to select a replacement account, model or protocol.
pub struct SideQueryReviewModel<'a> {
    pub provider: &'a dyn LLMProvider,
    pub resolved: RuntimeProvenance,
}

#[async_trait]
impl ReviewModel for SideQueryReviewModel<'_> {
    async fn run(&self, prompt: String, provenance: &RuntimeProvenance) -> Result<Value, String> {
        if &self.resolved != provenance {
            return Err("已解析的模型、账户或协议与审核任务锁定来源不一致。".into());
        }
        let schema = serde_json::json!({
            "type": "object",
            "required": ["目标", "结论", "未决项", "确认项", "证据 message IDs", "是否可能无价值", "批判"],
            "properties": {
                "目标": {"type": "string"}, "结论": {"type": "string"},
                "未决项": {"type": "array", "items": {"type": "string"}},
                "确认项": {"type": "array", "items": {"type": "string"}},
                "证据 message IDs": {"type": "array", "items": {"type": "string"}},
                "是否可能无价值": {"type": "boolean"},
                "批判": {"type": "array", "items": {"type": "string"}}
            }
        });
        let config = SideQueryConfig {
            model: Some(provenance.model_id.clone()),
            account_id: Some(provenance.account_id.clone()),
            temperature: 0.0,
            max_tokens: 1024,
            structured: Some(StructuredOutput {
                tool_name: "提交分叉审核".into(),
                schema,
            }),
            ..SideQueryConfig::default()
        };
        side_query_typed(
            self.provider,
            &[serde_json::json!({"role": "user", "content": prompt})],
            &config,
            &provenance.model_id,
        )
        .await
        .map_err(|error| format!("side-query 调用失败：{error}"))?
        .structured
        .ok_or_else(|| "side-query 未返回结构化 JSON。".into())
    }
}

struct PreparedReviewJob {
    job: ReviewJob,
    transcript: String,
    provenance: RuntimeProvenance,
}

#[cfg(not(test))]
async fn run_durable_embedding_job() -> bool {
    let job = match tokio::task::spawn_blocking(|| {
        let mut conn = crate::foundation::db_bridge::get_connection()
            .map_err(|_| "无法打开 Journey embedding 数据库。".to_string())?;
        crate::core::session::journey_embedding::claim(&mut conn).map_err(|error| error.to_string())
    })
    .await
    {
        Ok(Ok(Some(job))) => job,
        Ok(Ok(None)) => return false,
        Ok(Err(error)) => {
            tracing::warn!(error=%error, "[journey-review] 无法认领 embedding 任务");
            return false;
        }
        Err(error) => {
            tracing::warn!(error=%error, "[journey-review] embedding 认领任务异常");
            return false;
        }
    };
    use crate::specialization::memory::embeddings::EmbeddingProvider;
    let config = crate::state::integrations_store::integrations_store()
        .snapshot()
        .embedding;
    let provider = crate::specialization::memory::embeddings::AutoEmbeddingProvider::new(
        config.provider,
        config.model,
    );
    let embedding_source = provider.provider_name().to_string();
    let result = provider.embed(&job.content).await;
    let id = job.source_id.clone();
    let commit = tokio::task::spawn_blocking(move || {
        let conn = crate::foundation::db_bridge::get_connection().map_err(|e| e.to_string())?;
        match result {
            Ok(embedding) => crate::core::session::journey_embedding::complete(
                &conn,
                &job,
                &embedding.vector,
                &embedding.model,
                &embedding_source,
            )
            .map_err(|e| e.to_string()),
            Err(error) => crate::core::session::journey_embedding::fail(&conn, &id, &error)
                .map_err(|e| e.to_string()),
        }
    })
    .await;
    if let Err(error) = commit {
        tracing::warn!(error=%error, "[journey-review] embedding 提交任务异常");
    }
    true
}

#[cfg(test)]
async fn run_durable_embedding_job() -> bool {
    false
}

async fn run_executor(inner: Arc<JourneyReviewExecutorInner>) {
    loop {
        if inner.cancel.is_cancelled() {
            return;
        }
        for _ in 0..MAX_JOBS_PER_WAKE {
            if inner.cancel.is_cancelled() || !inner.runner.run_one().await {
                break;
            }
        }
        tokio::select! {
            _ = inner.cancel.cancelled() => return,
            _ = inner.wake.notified() => {},
            _ = tokio::time::sleep(RECOVERY_TICK) => {},
        }
    }
}

/// Returns false only when no job was claimed. Every failure is committed as
/// a job failure and logged without content, so a bad provider cannot kill
/// the executor loop or leak a transcript into diagnostics.
async fn run_durable_job() -> bool {
    let prepared = match tokio::task::spawn_blocking(|| {
        let mut conn = crate::foundation::db_bridge::get_connection()
            .map_err(|_| QueueError::Storage("无法打开审核队列数据库。".into()))?;
        let Some(job) =
            ReviewJobRepository::claim(&mut conn, "journey-review-executor", STALE_LEASE_SECS)?
        else {
            return Ok::<Option<PreparedReviewJob>, QueueError>(None);
        };
        let transcript = frozen_transcript(&conn, &job)?;
        Ok(Some(PreparedReviewJob {
            provenance: RuntimeProvenance {
                model_id: job.model_id.clone(),
                account_id: job.account_id.clone(),
                protocol: job.protocol.clone(),
            },
            job,
            transcript,
        }))
    })
    .await
    {
        Ok(Ok(Some(job))) => job,
        Ok(Ok(None)) => return false,
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "[journey-review] 无法认领审核任务");
            return false;
        }
        Err(error) => {
            tracing::warn!(error = %error, "[journey-review] 审核数据库任务异常");
            return false;
        }
    };

    let result = run_prepared_review(&prepared).await;
    let job_id = prepared.job.job_id.clone();
    let session_id = prepared.job.session_id.clone();
    let review_id = prepared.job.review_id.clone();
    let commit = tokio::task::spawn_blocking(move || {
        let mut conn = crate::foundation::db_bridge::get_connection()
            .map_err(|_| QueueError::Storage("无法打开审核队列数据库。".into()))?;
        match result {
            Ok(draft) => match commit_ready_review(&mut conn, &prepared.job, draft) {
                Ok(()) => Ok(()),
                Err(error) => {
                    tracing::warn!(job_id = %job_id, error = %error, "[journey-review] 审核结果校验或提交失败");
                    commit_failed_review(&mut conn, &job_id, &session_id, &review_id)
                }
            },
            Err(()) => commit_failed_review(&mut conn, &job_id, &session_id, &review_id),
        }
    })
    .await;
    match commit {
        Ok(Ok(())) => {}
        Ok(Err(error)) => tracing::warn!(error = %error, "[journey-review] 无法提交审核结果"),
        Err(error) => tracing::warn!(error = %error, "[journey-review] 审核提交任务异常"),
    }
    true
}

async fn run_prepared_review(prepared: &PreparedReviewJob) -> Result<ReviewDraftAnnotation, ()> {
    let provider = match crate::providers::factory::create_provider_for_protocol(
        &prepared.provenance.model_id,
        &prepared.provenance.account_id,
        &prepared.provenance.protocol,
    ) {
        Ok(provider) => provider,
        Err(error) => {
            tracing::warn!(job_id = %prepared.job.job_id, error = %error, "[journey-review] 严格 provider 解析失败");
            return Err(());
        }
    };
    let model = SideQueryReviewModel {
        provider: provider.as_ref(),
        resolved: prepared.provenance.clone(),
    };
    let extract = model
        .run(
            chinese_prompt("side-query 提取", &prepared.transcript, &prepared.job.exact_anchor_message_id),
            &prepared.provenance,
        )
        .await
        .map_err(|error| tracing::warn!(job_id = %prepared.job.job_id, error = %error, "[journey-review] 提取调用失败"))?;
    let critic = model
        .run(
            chinese_prompt("grill-me 批判遗漏、矛盾和证据不足", &extract.to_string(), &prepared.job.exact_anchor_message_id),
            &prepared.provenance,
        )
        .await
        .map_err(|error| tracing::warn!(job_id = %prepared.job.job_id, error = %error, "[journey-review] 批判调用失败"))?;
    let revised = model
        .run(
            chinese_prompt("根据批判生成短 capsule annotation", &format!("提取：{extract}\n批判：{critic}"), &prepared.job.exact_anchor_message_id),
            &prepared.provenance,
        )
        .await
        .map_err(|error| tracing::warn!(job_id = %prepared.job.job_id, error = %error, "[journey-review] 修订调用失败"))?;
    parse_draft(revised, &prepared.job, prepared.provenance.clone()).map_err(|_| {
        tracing::warn!(job_id = %prepared.job.job_id, "[journey-review] 模型返回无效审核结构");
    })
}

fn commit_ready_review(
    conn: &mut Connection,
    job: &ReviewJob,
    draft: ReviewDraftAnnotation,
) -> Result<(), QueueError> {
    validate_evidence_ids(conn, job, &draft.evidence_message_ids).map_err(QueueError::Invalid)?;
    let revision = SessionJourneyApplicationService::snapshot(conn, &job.session_id)
        .map_err(|e| QueueError::Conflict(e.to_string()))?
        .revision;
    let annotation = serde_json::to_string(&draft)
        .map_err(|_| QueueError::Invalid("无法序列化审核 annotation。".into()))?;
    SessionJourneyApplicationService::mark_review_ready(
        conn,
        MarkReviewReadyRequest {
            session_id: job.session_id.clone(),
            expected_revision: revision,
            review_id: job.review_id.clone(),
            provenance: draft.provenance,
            annotation: annotation.clone(),
        },
    )
    .map_err(|e| QueueError::Conflict(e.to_string()))?;
    crate::core::session::journey_embedding::enqueue(
        conn,
        &format!("review:{}", job.review_id),
        crate::core::session::journey_embedding::JourneyEmbeddingKind::ReviewAnnotation,
        &job.session_id,
        &job.fork_id,
        &job.review_id,
        &annotation,
    )
    .map_err(|e| QueueError::Storage(format!("无法排队审核 embedding：{e}")))?;
    ReviewJobRepository::complete(conn, &job.job_id)
}

fn commit_failed_review(
    conn: &mut Connection,
    job_id: &str,
    session_id: &str,
    review_id: &str,
) -> Result<(), QueueError> {
    let _ = ReviewJobRepository::fail(conn, job_id, "审核模型调用失败，请显式重试。");
    if let Ok(snapshot) = SessionJourneyApplicationService::snapshot(conn, session_id) {
        let _ = SessionJourneyApplicationService::fail_review(
            conn,
            FailReviewRequest {
                session_id: session_id.to_owned(),
                expected_revision: snapshot.revision,
                review_id: review_id.to_owned(),
            },
        );
    }
    Ok(())
}

pub struct ReviewWorker;
impl ReviewWorker {
    pub async fn run_once<M: ReviewModel>(
        conn: &mut Connection,
        model: &M,
        worker_id: &str,
        stale_after_secs: u64,
    ) -> Result<Option<ReviewDraftAnnotation>, QueueError> {
        let Some(job) = ReviewJobRepository::claim(conn, worker_id, stale_after_secs)? else {
            return Ok(None);
        };
        let provenance = RuntimeProvenance {
            model_id: job.model_id.clone(),
            account_id: job.account_id.clone(),
            protocol: job.protocol.clone(),
        };
        let result: Result<ReviewDraftAnnotation, String> = async {
            let transcript = frozen_transcript(conn, &job).map_err(|error| error.to_string())?;
            let extract = model
                .run(
                    chinese_prompt("side-query 提取", &transcript, &job.exact_anchor_message_id),
                    &provenance,
                )
                .await?;
            let critic = model
                .run(
                    chinese_prompt(
                        "grill-me 批判遗漏、矛盾和证据不足",
                        &extract.to_string(),
                        &job.exact_anchor_message_id,
                    ),
                    &provenance,
                )
                .await?;
            let revised = model
                .run(
                    chinese_prompt(
                        "根据批判生成短 capsule annotation",
                        &format!("提取：{extract}\n批判：{critic}"),
                        &job.exact_anchor_message_id,
                    ),
                    &provenance,
                )
                .await?;
            let draft = parse_draft(revised, &job, provenance)?;
            validate_evidence_ids(conn, &job, &draft.evidence_message_ids)?;
            Ok(draft)
        }
        .await;
        match result {
            Ok(draft) => {
                let revision = SessionJourneyApplicationService::snapshot(conn, &job.session_id)
                    .map_err(|e| QueueError::Conflict(e.to_string()))?
                    .revision;
                let annotation = serde_json::to_string(&draft)
                    .map_err(|_| QueueError::Invalid("无法序列化审核 annotation。".into()))?;
                SessionJourneyApplicationService::mark_review_ready(
                    conn,
                    MarkReviewReadyRequest {
                        session_id: job.session_id.clone(),
                        expected_revision: revision,
                        review_id: job.review_id.clone(),
                        provenance: draft.provenance.clone(),
                        annotation: annotation.clone(),
                    },
                )
                .map_err(|e| QueueError::Conflict(e.to_string()))?;
                crate::core::session::journey_embedding::enqueue(
                    conn,
                    &format!("review:{}", job.review_id),
                    crate::core::session::journey_embedding::JourneyEmbeddingKind::ReviewAnnotation,
                    &job.session_id,
                    &job.fork_id,
                    &job.review_id,
                    &annotation,
                )
                .map_err(|e| QueueError::Storage(e.to_string()))?;
                ReviewJobRepository::complete(conn, &job.job_id)?;
                Ok(Some(draft))
            }
            Err(error) => {
                let _ = ReviewJobRepository::fail(conn, &job.job_id, &error);
                if let Ok(snapshot) =
                    SessionJourneyApplicationService::snapshot(conn, &job.session_id)
                {
                    let _ = SessionJourneyApplicationService::fail_review(
                        conn,
                        FailReviewRequest {
                            session_id: job.session_id.clone(),
                            expected_revision: snapshot.revision,
                            review_id: job.review_id.clone(),
                        },
                    );
                }
                Err(QueueError::Invalid(format!("审核 worker 失败：{error}")))
            }
        }
    }
}

fn validate_evidence_ids(conn: &Connection, job: &ReviewJob, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Err("审核产物必须引用冻结范围内的证据 message IDs。".into());
    }
    for id in ids {
        let allowed: Option<i64> = conn.query_row(
            "SELECT 1 FROM session_journey_memberships WHERE session_id=?1 AND branch_id=?2 AND message_id=?3 AND sequence BETWEEN ?4 AND ?5",
            params![job.session_id, job.fork_id, id, job.frozen_start_sequence as i64, job.frozen_end_sequence as i64], |r| r.get(0)
        ).optional().map_err(|e| format!("无法校验证据范围：{e}"))?;
        if allowed.is_none() {
            return Err(format!("证据 message ID 不在冻结分叉范围内：{id}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Mutex, Once};
    use std::time::Duration;

    use crate::core::journey_lifecycle::{
        ForkState, JourneyFork, ReviewItem, ReviewState, SqliteJourneyRepository,
    };

    #[derive(Default)]
    struct FakeReviewModel {
        responses: Mutex<VecDeque<Result<Value, String>>>,
        prompts: Mutex<Vec<String>>,
        provenances: Mutex<Vec<RuntimeProvenance>>,
    }

    impl FakeReviewModel {
        fn with_responses(responses: impl IntoIterator<Item = Result<Value, String>>) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter().collect()),
                ..Self::default()
            }
        }
    }

    #[async_trait]
    impl ReviewModel for FakeReviewModel {
        async fn run(
            &self,
            prompt: String,
            provenance: &RuntimeProvenance,
        ) -> Result<Value, String> {
            self.prompts.lock().unwrap().push(prompt);
            self.provenances.lock().unwrap().push(provenance.clone());
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Err("fake model 响应不足。".into()))
        }
    }

    fn provenance() -> RuntimeProvenance {
        RuntimeProvenance {
            model_id: "模型甲".into(),
            account_id: "账户甲".into(),
            protocol: "协议甲".into(),
        }
    }

    fn valid_annotation() -> Value {
        serde_json::json!({
            "目标": "核对分叉结论",
            "结论": "可以继续主分支",
            "未决项": ["补测边界"],
            "确认项": ["证据已覆盖"],
            "证据 message IDs": ["f3", "f5"],
            "是否可能无价值": false,
            "批判": ["无额外遗漏"]
        })
    }

    fn worker_conn() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE agent_sessions (session_id TEXT PRIMARY KEY);
             CREATE TABLE agent_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                content TEXT NOT NULL
             );
             INSERT INTO agent_sessions (session_id) VALUES ('s');
             INSERT INTO agent_messages VALUES ('anchor', 's', 'user', 2, '父锚点');
             INSERT INTO agent_messages VALUES ('f3', 's', 'assistant', 3, '冻结分叉消息 3');
             INSERT INTO agent_messages VALUES ('f5', 's', 'assistant', 5, '冻结分叉消息 5');
             INSERT INTO agent_messages VALUES ('parent-future', 's', 'assistant', 6, '父分支后续不得泄露');
             INSERT INTO agent_messages VALUES ('sibling', 's', 'assistant', 6, '兄弟分叉不得泄露');",
        )
        .unwrap();
        SqliteJourneyRepository::ensure_schema(&conn).unwrap();
        let mut j = journey();
        j.revision = 1;
        SqliteJourneyRepository::compare_and_store(&mut conn, &j, 0).unwrap();
        for (message_id, sequence, branch_id) in [
            ("anchor", 2_i64, "main"),
            ("f3", 3, "f"),
            ("f5", 5, "f"),
            ("parent-future", 6, "main"),
            ("sibling", 6, "sibling"),
        ] {
            conn.execute(
                "INSERT INTO session_journey_memberships (session_id, message_id, sequence, branch_id, task_id) VALUES ('s', ?1, ?2, ?3, NULL)",
                params![message_id, sequence, branch_id],
            )
            .unwrap();
        }
        conn
    }

    fn enqueue(conn: &Connection) -> ReviewJob {
        ReviewJobRepository::enqueue(conn, &journey(), "job-1", "r", &provenance()).unwrap()
    }
    fn journey() -> SessionJourney {
        let mut j = SessionJourney::new("s", "main");
        j.branches.insert(
            "f".into(),
            JourneyFork {
                id: "f".into(),
                parent_branch_id: "main".into(),
                parent_anchor_message_id: Some("anchor".into()),
                anchor_sequence: 2,
                source_start_sequence: 3,
                state: ForkState::Closing,
                frozen_end_sequence: Some(5),
                close_work_id: None,
                handoff_capsule: None,
            },
        );
        j.reviews.insert(
            "r".into(),
            ReviewItem {
                id: "r".into(),
                fork_id: "f".into(),
                state: ReviewState::Queued,
                provenance: None,
                source_start_sequence: 3,
                source_end_sequence: 5,
                annotation: None,
                promoted_fact_ids: Vec::new(),
            },
        );
        j.revision = 7;
        j
    }

    #[test]
    fn enqueue_is_idempotent_and_claim_is_single_consumer() {
        let conn = Connection::open_in_memory().unwrap();
        let p = RuntimeProvenance {
            model_id: "模型".into(),
            account_id: "账户".into(),
            protocol: "协议".into(),
        };
        let j = journey();
        let first = ReviewJobRepository::enqueue(&conn, &j, "job-1", "r", &p).unwrap();
        let second = ReviewJobRepository::enqueue(&conn, &j, "job-2", "r", &p).unwrap();
        assert_eq!(first.job_id, second.job_id);
        let mut conn = conn;
        assert!(ReviewJobRepository::claim(&mut conn, "w1", 60)
            .unwrap()
            .is_some());
        assert!(ReviewJobRepository::claim(&mut conn, "w2", 60)
            .unwrap()
            .is_none());
    }

    #[test]
    fn prompt_is_chinese_and_anchor_scoped() {
        let prompt = chinese_prompt("side-query 提取", "m3@3: 分叉内容", "anchor");
        assert!(prompt.contains("只能依据冻结分叉区间消息"));
        assert!(prompt.contains("不得读取锚点之后的父分支续写"));
        assert!(prompt.contains("anchor"));
    }

    #[test]
    fn worker_runs_draft_critic_revision_with_exact_provenance_and_frozen_scope() {
        let mut conn = worker_conn();
        enqueue(&conn);
        let model = FakeReviewModel::with_responses([
            Ok(serde_json::json!({"draft": "候选"})),
            Ok(serde_json::json!({"critic": "补充证据"})),
            Ok(valid_annotation()),
        ]);

        let draft =
            futures::executor::block_on(ReviewWorker::run_once(&mut conn, &model, "worker-a", 60))
                .unwrap()
                .unwrap();

        assert_eq!(draft.provenance, provenance());
        assert_eq!(
            model.provenances.lock().unwrap().as_slice(),
            &[provenance(), provenance(), provenance()]
        );
        let prompts = model.prompts.lock().unwrap();
        assert_eq!(prompts.len(), 3);
        assert!(prompts[0].contains("冻结分叉消息 3"));
        assert!(prompts[0].contains("冻结分叉消息 5"));
        assert!(!prompts[0].contains("父分支后续不得泄露"));
        assert!(!prompts[0].contains("兄弟分叉不得泄露"));
        drop(prompts);

        let job = ReviewJobRepository::get(&conn, "r").unwrap().unwrap();
        assert_eq!(job.state, ReviewJobState::Ready);
        let snapshot = SessionJourneyApplicationService::snapshot(&conn, "s")
            .unwrap()
            .snapshot;
        assert_eq!(snapshot.reviews["r"].state, ReviewState::Ready);
        assert!(snapshot.reviews["r"].annotation.is_some());
        assert!(snapshot.branches["f"].handoff_capsule.is_none());
        assert!(snapshot.reviews["r"].promoted_fact_ids.is_empty());
    }

    #[test]
    fn invalid_json_fails_closed_without_capsule_or_fact() {
        let mut conn = worker_conn();
        enqueue(&conn);
        let model = FakeReviewModel::with_responses([
            Ok(serde_json::json!({"draft": "候选"})),
            Ok(serde_json::json!({"critic": "检查"})),
            Ok(serde_json::json!({"目标": "缺少必须字段"})),
        ]);

        let error =
            futures::executor::block_on(ReviewWorker::run_once(&mut conn, &model, "worker-a", 60))
                .unwrap_err();
        assert!(error.to_string().contains("审核 worker 失败"));
        assert_eq!(
            ReviewJobRepository::get(&conn, "r").unwrap().unwrap().state,
            ReviewJobState::Failed
        );
        let snapshot = SessionJourneyApplicationService::snapshot(&conn, "s")
            .unwrap()
            .snapshot;
        assert_eq!(snapshot.reviews["r"].state, ReviewState::Failed);
        assert!(snapshot.reviews["r"].annotation.is_none());
        assert!(snapshot.branches["f"].handoff_capsule.is_none());
        assert!(snapshot.reviews["r"].promoted_fact_ids.is_empty());
    }

    #[test]
    fn stale_running_job_is_recovered_and_claimed_once() {
        let mut conn = worker_conn();
        let job = enqueue(&conn);
        let _ = ReviewJobRepository::claim(&mut conn, "worker-dead", 60)
            .unwrap()
            .unwrap();
        conn.execute(
            "UPDATE session_journey_review_jobs SET started_at='0' WHERE job_id=?1",
            [&job.job_id],
        )
        .unwrap();

        let recovered = ReviewJobRepository::claim(&mut conn, "worker-live", 1)
            .unwrap()
            .unwrap();
        assert_eq!(recovered.job_id, job.job_id);
        assert_eq!(recovered.attempt, 2);
        assert!(ReviewJobRepository::claim(&mut conn, "worker-other", 60)
            .unwrap()
            .is_none());
    }

    #[test]
    fn startup_reconciliation_requeues_orphaned_running_jobs_immediately() {
        let mut conn = worker_conn();
        let job = enqueue(&conn);
        ReviewJobRepository::claim(&mut conn, "worker-before-restart", 60)
            .unwrap()
            .unwrap();

        assert_eq!(
            ReviewJobRepository::requeue_orphaned_running_jobs(&conn).unwrap(),
            1
        );
        let requeued = ReviewJobRepository::get(&conn, "r").unwrap().unwrap();
        assert_eq!(requeued.state, ReviewJobState::Queued);
        assert_eq!(requeued.started_at, None);

        let reclaimed = ReviewJobRepository::claim(&mut conn, "worker-after-restart", 60)
            .unwrap()
            .unwrap();
        assert_eq!(reclaimed.job_id, job.job_id);
        assert_eq!(reclaimed.attempt, 2);
    }

    #[derive(Default)]
    struct CountingRunner {
        calls: AtomicUsize,
        fail_first: bool,
    }

    #[async_trait]
    impl ExecutorJobRunner for CountingRunner {
        async fn run_one(&self) -> bool {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            // This deliberately represents a provider failure. The runner
            // reports no immediately available work and the executor must
            // remain available for the next notification.
            if self.fail_first && call == 0 {
                return false;
            }
            false
        }
    }

    async fn wait_for_calls(runner: &CountingRunner, minimum: usize) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while runner.calls.load(Ordering::SeqCst) < minimum {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("executor did not process the expected wake");
    }

    #[tokio::test]
    async fn executor_spawn_and_notify_runs_injected_runner() {
        let runner = Arc::new(CountingRunner::default());
        let executor = JourneyReviewExecutorHandle::spawn_with_runner(runner.clone());
        wait_for_calls(&runner, 1).await;
        executor.wake();
        wait_for_calls(&runner, 2).await;
        executor.shutdown().await;
    }

    #[tokio::test]
    async fn executor_shutdown_stops_the_task() {
        let runner = Arc::new(CountingRunner::default());
        let executor = JourneyReviewExecutorHandle::spawn_with_runner(runner.clone());
        wait_for_calls(&runner, 1).await;
        executor.shutdown().await;
        let before = runner.calls.load(Ordering::SeqCst);
        executor.wake();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(runner.calls.load(Ordering::SeqCst), before);
    }

    #[tokio::test]
    async fn executor_coalesces_many_notifications() {
        let runner = Arc::new(CountingRunner::default());
        let executor = JourneyReviewExecutorHandle::spawn_with_runner(runner.clone());
        wait_for_calls(&runner, 1).await;
        for _ in 0..32 {
            executor.wake();
        }
        wait_for_calls(&runner, 2).await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(runner.calls.load(Ordering::SeqCst) <= 3);
        executor.shutdown().await;
    }

    #[tokio::test]
    async fn executor_survives_a_provider_failure_and_accepts_next_wake() {
        let runner = Arc::new(CountingRunner {
            fail_first: true,
            ..CountingRunner::default()
        });
        let executor = JourneyReviewExecutorHandle::spawn_with_runner(runner.clone());
        wait_for_calls(&runner, 1).await;
        executor.wake();
        wait_for_calls(&runner, 2).await;
        executor.shutdown().await;
    }

    #[test]
    fn concurrent_connections_cannot_claim_the_same_job() {
        static INIT: Once = Once::new();
        let path = std::env::temp_dir().join(format!(
            "org2-journey-review-claim-{}-{}.sqlite",
            std::process::id(),
            now()
        ));
        INIT.call_once(|| {});
        let setup = Connection::open(&path).unwrap();
        enqueue(&setup);
        drop(setup);

        let mut joins = Vec::new();
        for worker in ["w1", "w2"] {
            let path = path.clone();
            joins.push(std::thread::spawn(move || {
                let mut conn = Connection::open(path).unwrap();
                conn.busy_timeout(Duration::from_secs(1)).unwrap();
                ReviewJobRepository::claim(&mut conn, worker, 60)
                    .unwrap()
                    .map(|job| job.job_id)
            }));
        }
        let claims: Vec<_> = joins.into_iter().map(|join| join.join().unwrap()).collect();
        assert_eq!(claims.iter().flatten().count(), 1);
        let _ = std::fs::remove_file(path);
    }
}

fn frozen_transcript(conn: &Connection, job: &ReviewJob) -> Result<String, QueueError> {
    let mut stmt = conn.prepare("SELECT m.message_id, m.sequence, a.content FROM session_journey_memberships m JOIN agent_messages a ON a.id=m.message_id AND a.session_id=m.session_id WHERE m.session_id=?1 AND m.branch_id=?2 AND m.sequence BETWEEN ?3 AND ?4 ORDER BY m.sequence").map_err(|e| QueueError::Storage(e.to_string()))?;
    let rows = stmt
        .query_map(
            params![
                job.session_id,
                job.fork_id,
                job.frozen_start_sequence as i64,
                job.frozen_end_sequence as i64
            ],
            |r| {
                Ok(format!(
                    "{}@{}: {}",
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?
                ))
            },
        )
        .map_err(|e| QueueError::Storage(e.to_string()))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| QueueError::Storage(e.to_string()))?);
    }
    Ok(out.join("\n"))
}

fn parse_draft(
    value: Value,
    job: &ReviewJob,
    provenance: RuntimeProvenance,
) -> Result<ReviewDraftAnnotation, String> {
    let obj = value.as_object().ok_or("模型输出不是 JSON 对象。")?;
    let text = |key: &str| {
        obj.get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned)
            .ok_or_else(|| format!("缺少字段：{key}"))
    };
    let list = |key: &str| {
        obj.get(key)
            .and_then(Value::as_array)
            .ok_or_else(|| format!("缺少数组字段：{key}"))
            .and_then(|a| {
                a.iter()
                    .map(|v| {
                        v.as_str()
                            .map(str::to_owned)
                            .ok_or_else(|| format!("字段 {key} 必须全为字符串"))
                    })
                    .collect()
            })
    };
    Ok(ReviewDraftAnnotation {
        objective: text("目标")?,
        conclusion: text("结论")?,
        open_questions: list("未决项")?,
        confirmation_items: list("确认项")?,
        evidence_message_ids: list("证据 message IDs")?,
        possibly_no_value: obj
            .get("是否可能无价值")
            .and_then(Value::as_bool)
            .ok_or("缺少字段：是否可能无价值")?,
        source_range: (job.frozen_start_sequence, job.frozen_end_sequence),
        provenance,
        critic_notes: list("批判")?,
    })
}
