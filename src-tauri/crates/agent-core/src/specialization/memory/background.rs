//! Bounded ownership for background memory/evolution work.
//!
//! Memory jobs used to be detached directly from turn/session finalization.
//! That made the spawned future the accidental owner of providers, tool
//! registries and full transcripts, with no global admission control and no
//! lifecycle cancellation. This coordinator is the single ownership boundary:
//!
//! - one active job per `(session_id, job_kind)`;
//! - one latest pending job per key (new submissions replace stale pending work);
//! - a process-wide semaphore for expensive memory LLM work;
//! - hard deadlines and explicit cancellation;
//! - an always-run cleanup hook so subsystem state cannot remain stuck after a
//!   timeout or cancellation.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tokio::sync::{Notify, Semaphore};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

type JobFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'static>>;
type CleanupFuture = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;
type JobRunner = Box<dyn FnOnce(CancellationToken) -> JobFuture + Send + 'static>;
type JobCleanup = Box<dyn FnOnce(MemoryJobOutcome) -> CleanupFuture + Send + 'static>;

const DEFAULT_MAX_CONCURRENT_JOBS: usize = 1;
const MAX_CONFIGURED_CONCURRENT_JOBS: usize = 4;

/// Stable kind used in the coordinator ownership key and metrics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MemoryJobKind {
    SessionMemory,
    WorkspaceExtraction,
    AutoDream,
    Reflection,
    ActiveObservation,
}

impl MemoryJobKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SessionMemory => "session_memory",
            Self::WorkspaceExtraction => "workspace_extraction",
            Self::AutoDream => "auto_dream",
            Self::Reflection => "reflection",
            Self::ActiveObservation => "active_observation",
        }
    }

    /// Session-memory extraction is context-pipeline work: one bounded side
    /// query to the fast sibling model with a 60s deadline, needed promptly
    /// so SM-compact has fresh content. It runs as soon as its turn ends —
    /// still slot-owned (latest-only, cancelled by new turns/teardown) but
    /// never queued behind minutes-long evolution jobs. The heavy forked
    /// agents keep sharing the bounded global permit.
    fn uses_global_permit(self) -> bool {
        !matches!(self, Self::SessionMemory)
    }
}

/// Terminal status passed to the mandatory cleanup hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryJobOutcome {
    Completed,
    Failed,
    Cancelled,
    TimedOut,
}

/// Lightweight coordinator counters. These count jobs, not turns.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MemoryJobMetricsSnapshot {
    pub submitted: u64,
    pub coalesced: u64,
    pub started: u64,
    pub completed: u64,
    pub failed: u64,
    pub cancelled: u64,
    pub timed_out: u64,
}

#[derive(Default)]
struct MemoryJobMetrics {
    submitted: AtomicU64,
    coalesced: AtomicU64,
    started: AtomicU64,
    completed: AtomicU64,
    failed: AtomicU64,
    cancelled: AtomicU64,
    timed_out: AtomicU64,
}

impl MemoryJobMetrics {
    fn snapshot(&self) -> MemoryJobMetricsSnapshot {
        MemoryJobMetricsSnapshot {
            submitted: self.submitted.load(Ordering::Relaxed),
            coalesced: self.coalesced.load(Ordering::Relaxed),
            started: self.started.load(Ordering::Relaxed),
            completed: self.completed.load(Ordering::Relaxed),
            failed: self.failed.load(Ordering::Relaxed),
            cancelled: self.cancelled.load(Ordering::Relaxed),
            timed_out: self.timed_out.load(Ordering::Relaxed),
        }
    }
}

/// One submitted unit of work. Callers should capture only lightweight source
/// identifiers/configuration here; expensive transcripts are loaded by `run`
/// after the coordinator grants a global permit.
pub struct MemoryJob {
    session_id: String,
    agent_id: Option<String>,
    kind: MemoryJobKind,
    timeout: Duration,
    delay: Duration,
    replace_existing: bool,
    run: JobRunner,
    cleanup: Option<JobCleanup>,
}

impl MemoryJob {
    pub fn new<F, Fut>(
        session_id: impl Into<String>,
        agent_id: Option<String>,
        kind: MemoryJobKind,
        timeout: Duration,
        run: F,
    ) -> Self
    where
        F: FnOnce(CancellationToken) -> Fut + Send + 'static,
        Fut: Future<Output = Result<(), String>> + Send + 'static,
    {
        Self {
            session_id: session_id.into(),
            agent_id,
            kind,
            timeout,
            delay: Duration::ZERO,
            replace_existing: false,
            run: Box::new(move |cancel| Box::pin(run(cancel))),
            cleanup: None,
        }
    }

    /// Debounce this job: a later submission for the same key cancels the
    /// current waiting/running generation and replaces it. Used for
    /// session-quiescence reflection, where every new turn rearms the delay.
    pub fn with_debounce(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self.replace_existing = true;
        self
    }

    pub fn with_cleanup<F, Fut>(mut self, cleanup: F) -> Self
    where
        F: FnOnce(MemoryJobOutcome) -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        self.cleanup = Some(Box::new(move |outcome| Box::pin(cleanup(outcome))));
        self
    }

    fn key(&self) -> JobKey {
        JobKey {
            session_id: self.session_id.clone(),
            kind: self.kind,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct JobKey {
    session_id: String,
    kind: MemoryJobKind,
}

struct JobSlot {
    id: u64,
    agent_id: Option<String>,
    cancel: CancellationToken,
    pending: Option<MemoryJob>,
}

#[derive(Default)]
struct CoordinatorState {
    next_slot_id: u64,
    slots: HashMap<JobKey, JobSlot>,
}

/// Result of a non-blocking submission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryJobSubmission {
    Started,
    Coalesced,
}

/// Process-wide coordinator. It owns every detached memory job spawned through
/// [`submit_memory_job`].
struct MemoryJobCoordinator {
    state: Mutex<CoordinatorState>,
    permits: Arc<Semaphore>,
    metrics: MemoryJobMetrics,
    idle_notify: Notify,
}

impl MemoryJobCoordinator {
    fn new(max_concurrent_jobs: usize) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(CoordinatorState::default()),
            permits: Arc::new(Semaphore::new(max_concurrent_jobs.max(1))),
            metrics: MemoryJobMetrics::default(),
            idle_notify: Notify::new(),
        })
    }

    fn submit(self: &Arc<Self>, job: MemoryJob) -> MemoryJobSubmission {
        self.metrics.submitted.fetch_add(1, Ordering::Relaxed);
        let key = job.key();

        let mut replaced_slot = None;
        let (slot_id, cancel) = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            // A cancelled slot is torn down by its own drive loop; coalescing
            // into it would silently drop the new job when the loop exits.
            // Replace it with a fresh generation instead.
            let existing_cancelled = state
                .slots
                .get(&key)
                .is_some_and(|slot| slot.cancel.is_cancelled());
            if (job.replace_existing || existing_cancelled) && state.slots.contains_key(&key) {
                replaced_slot = state.slots.remove(&key);
            } else if let Some(slot) = state.slots.get_mut(&key) {
                slot.agent_id = job.agent_id.clone();
                slot.pending = Some(job);
                self.metrics.coalesced.fetch_add(1, Ordering::Relaxed);
                info!(
                    session_id = %key.session_id,
                    job_kind = key.kind.as_str(),
                    "[memory_background] coalesced latest pending job"
                );
                return MemoryJobSubmission::Coalesced;
            }

            state.next_slot_id = state.next_slot_id.wrapping_add(1).max(1);
            let slot_id = state.next_slot_id;
            let cancel = CancellationToken::new();
            state.slots.insert(
                key.clone(),
                JobSlot {
                    id: slot_id,
                    agent_id: job.agent_id.clone(),
                    cancel: cancel.clone(),
                    pending: None,
                },
            );
            (slot_id, cancel)
        };

        if let Some(replaced) = replaced_slot {
            replaced.cancel.cancel();
            self.metrics.coalesced.fetch_add(1, Ordering::Relaxed);
        }
        let coordinator = Arc::clone(self);
        tokio::spawn(async move {
            coordinator.drive_slot(key, slot_id, cancel, job).await;
        });
        MemoryJobSubmission::Started
    }

    async fn drive_slot(
        self: Arc<Self>,
        key: JobKey,
        slot_id: u64,
        cancel: CancellationToken,
        mut job: MemoryJob,
    ) {
        loop {
            let outcome = self.run_one(&key, &cancel, &mut job).await;
            if let Some(cleanup) = job.cleanup.take() {
                cleanup(outcome).await;
            }

            let next = {
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                match state.slots.get_mut(&key) {
                    None => None,
                    Some(slot) if slot.id != slot_id || cancel.is_cancelled() => {
                        if slot.id == slot_id {
                            state.slots.remove(&key);
                        }
                        None
                    }
                    Some(slot) => {
                        if let Some(next) = slot.pending.take() {
                            Some(next)
                        } else {
                            state.slots.remove(&key);
                            None
                        }
                    }
                }
            };

            match next {
                Some(next) => job = next,
                None => {
                    self.idle_notify.notify_waiters();
                    break;
                }
            }
        }
    }

    /// Terminal accounting for one job generation. Every exit of
    /// [`run_one`] funnels here so the outcome counter and the always-on
    /// metrics log line cannot drift apart; the snapshot is a handful of
    /// relaxed atomic loads, cheap enough for every terminal state.
    fn finish(
        &self,
        key: &JobKey,
        outcome: MemoryJobOutcome,
        elapsed_ms: u128,
    ) -> MemoryJobOutcome {
        let counter = match outcome {
            MemoryJobOutcome::Completed => &self.metrics.completed,
            MemoryJobOutcome::Failed => &self.metrics.failed,
            MemoryJobOutcome::Cancelled => &self.metrics.cancelled,
            MemoryJobOutcome::TimedOut => &self.metrics.timed_out,
        };
        counter.fetch_add(1, Ordering::Relaxed);
        let metrics = self.metrics.snapshot();
        info!(
            session_id = %key.session_id,
            job_kind = key.kind.as_str(),
            outcome = ?outcome,
            elapsed_ms,
            submitted = metrics.submitted,
            coalesced = metrics.coalesced,
            started = metrics.started,
            completed = metrics.completed,
            failed = metrics.failed,
            cancelled = metrics.cancelled,
            timed_out = metrics.timed_out,
            "[memory_background] job finished"
        );
        outcome
    }

    async fn run_one(
        &self,
        key: &JobKey,
        slot_cancel: &CancellationToken,
        job: &mut MemoryJob,
    ) -> MemoryJobOutcome {
        if !job.delay.is_zero() {
            tokio::select! {
                biased;
                _ = slot_cancel.cancelled() => {
                    return self.finish(key, MemoryJobOutcome::Cancelled, 0);
                }
                _ = tokio::time::sleep(job.delay) => {}
            }
        }

        let permit = if key.kind.uses_global_permit() {
            let permit = tokio::select! {
                biased;
                _ = slot_cancel.cancelled() => {
                    return self.finish(key, MemoryJobOutcome::Cancelled, 0);
                }
                permit = Arc::clone(&self.permits).acquire_owned() => match permit {
                    Ok(permit) => permit,
                    Err(_) => {
                        return self.finish(key, MemoryJobOutcome::Cancelled, 0);
                    }
                }
            };
            Some(permit)
        } else {
            None
        };

        if slot_cancel.is_cancelled() {
            drop(permit);
            return self.finish(key, MemoryJobOutcome::Cancelled, 0);
        }

        self.metrics.started.fetch_add(1, Ordering::Relaxed);
        let started_at = std::time::Instant::now();
        let run_cancel = slot_cancel.child_token();
        let run = std::mem::replace(&mut job.run, Box::new(|_| Box::pin(async { Ok(()) })));
        let mut future = Box::pin(run(run_cancel.clone()));

        let outcome = tokio::select! {
            biased;
            _ = slot_cancel.cancelled() => {
                run_cancel.cancel();
                MemoryJobOutcome::Cancelled
            }
            result = tokio::time::timeout(job.timeout, &mut future) => match result {
                Ok(Ok(())) => MemoryJobOutcome::Completed,
                Ok(Err(err)) => {
                    warn!(
                        session_id = %key.session_id,
                        job_kind = key.kind.as_str(),
                        error = %err,
                        "[memory_background] job failed"
                    );
                    MemoryJobOutcome::Failed
                }
                Err(_) => {
                    run_cancel.cancel();
                    warn!(
                        session_id = %key.session_id,
                        job_kind = key.kind.as_str(),
                        timeout_ms = job.timeout.as_millis(),
                        "[memory_background] job timed out"
                    );
                    MemoryJobOutcome::TimedOut
                }
            }
        };
        drop(future);
        drop(permit);

        self.finish(key, outcome, started_at.elapsed().as_millis())
    }

    fn cancel_where(&self, mut predicate: impl FnMut(&JobKey, &JobSlot) -> bool) -> usize {
        let tokens = {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state
                .slots
                .iter()
                .filter_map(|(key, slot)| predicate(key, slot).then_some(slot.cancel.clone()))
                .collect::<Vec<_>>()
        };
        for token in &tokens {
            token.cancel();
        }
        if !tokens.is_empty() {
            self.idle_notify.notify_waiters();
        }
        tokens.len()
    }

    fn cancel_session(&self, session_id: &str) -> usize {
        self.cancel_where(|key, _| key.session_id == session_id)
    }

    fn cancel_agent(&self, agent_id: &str) -> usize {
        self.cancel_where(|_, slot| slot.agent_id.as_deref() == Some(agent_id))
    }

    fn metrics(&self) -> MemoryJobMetricsSnapshot {
        self.metrics.snapshot()
    }

    #[cfg(test)]
    async fn wait_for_idle(&self) {
        loop {
            let notified = self.idle_notify.notified();
            if self
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .slots
                .is_empty()
            {
                return;
            }
            notified.await;
        }
    }
}

fn configured_concurrency() -> usize {
    std::env::var("ORGII_MEMORY_BACKGROUND_CONCURRENCY")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .map(|value| value.clamp(1, MAX_CONFIGURED_CONCURRENT_JOBS))
        .unwrap_or(DEFAULT_MAX_CONCURRENT_JOBS)
}

fn coordinator() -> &'static Arc<MemoryJobCoordinator> {
    static COORDINATOR: OnceLock<Arc<MemoryJobCoordinator>> = OnceLock::new();
    COORDINATOR.get_or_init(|| MemoryJobCoordinator::new(configured_concurrency()))
}

/// Submit a memory job without blocking the caller.
pub fn submit_memory_job(job: MemoryJob) -> MemoryJobSubmission {
    coordinator().submit(job)
}

/// Cancel active and coalesced memory jobs owned by one session.
pub fn cancel_memory_jobs_for_session(session_id: &str) -> usize {
    coordinator().cancel_session(session_id)
}

/// Cancel active and coalesced memory jobs for every live session backed by an
/// agent definition. Used by the hot learnings switch.
pub fn cancel_memory_jobs_for_agent(agent_id: &str) -> usize {
    coordinator().cancel_agent(agent_id)
}

/// Coordinator counter snapshot. Surfaced on every terminal-state
/// `job finished` log line and by the debug-only
/// `/agent/test/memory-metrics` endpoint.
pub fn memory_job_metrics() -> MemoryJobMetricsSnapshot {
    coordinator().metrics()
}

/// Single source of truth for "does this agent's learnings policy allow this
/// job kind". Session memory is context-pipeline state, not long-term
/// memory, so it is never policy-gated here — its own gate is
/// `sm_config.enabled` at post-turn dispatch.
fn kind_enabled(config: &crate::definitions::AgentLearningsConfig, kind: MemoryJobKind) -> bool {
    match kind {
        MemoryJobKind::SessionMemory => true,
        MemoryJobKind::Reflection | MemoryJobKind::ActiveObservation => config.enabled,
        MemoryJobKind::WorkspaceExtraction => config.enabled && config.extract_memories_enabled,
        MemoryJobKind::AutoDream => config.enabled && config.auto_dream_enabled,
    }
}

/// Resolve the current (not session-snapshotted) agent policy immediately
/// before expensive work. This makes the settings switch a real hot gate.
pub fn memory_job_is_enabled(agent_id: &str, kind: MemoryJobKind) -> bool {
    kind_enabled(&crate::definitions::resolve_learnings_for(agent_id), kind)
}

/// Cancel only the kinds that the agent's freshly persisted policy disables.
/// Called after an Agent Definition update so running work observes the switch
/// immediately instead of waiting for the next session launch.
pub fn cancel_disabled_memory_jobs_for_agent(agent_id: &str) -> usize {
    let config = crate::definitions::resolve_learnings_for(agent_id);
    coordinator().cancel_where(|key, slot| {
        slot.agent_id.as_deref() == Some(agent_id) && !kind_enabled(&config, key.kind)
    })
}

/// RAII bridge from a coordinator cancellation token into the atomic flag
/// consumed by `execute_turn` and side-query retries.
pub struct CancelFlagBridge {
    flag: Arc<std::sync::atomic::AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}

impl CancelFlagBridge {
    pub fn flag(&self) -> &Arc<std::sync::atomic::AtomicBool> {
        &self.flag
    }
}

impl Drop for CancelFlagBridge {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub fn bridge_cancel_flag(cancel: CancellationToken) -> CancelFlagBridge {
    let flag = Arc::new(std::sync::atomic::AtomicBool::new(cancel.is_cancelled()));
    let task_flag = Arc::clone(&flag);
    let task = tokio::spawn(async move {
        cancel.cancelled().await;
        task_flag.store(true, Ordering::SeqCst);
    });
    CancelFlagBridge { flag, task }
}

/// Acquire the same global memory budget for an inline owner such as the
/// single consolidation tick. The returned permit releases on drop.
pub async fn acquire_memory_permit() -> Result<tokio::sync::OwnedSemaphorePermit, String> {
    Arc::clone(&coordinator().permits)
        .acquire_owned()
        .await
        .map_err(|_| "memory background coordinator is shutting down".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn test_job<F, Fut>(session: &str, kind: MemoryJobKind, run: F) -> MemoryJob
    where
        F: FnOnce(CancellationToken) -> Fut + Send + 'static,
        Fut: Future<Output = Result<(), String>> + Send + 'static,
    {
        MemoryJob::new(
            session,
            Some("agent:test".to_string()),
            kind,
            Duration::from_secs(2),
            run,
        )
    }

    #[tokio::test]
    async fn global_permit_caps_parallel_jobs() {
        let coordinator = MemoryJobCoordinator::new(1);
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));

        for session in ["a", "b"] {
            let running = Arc::clone(&running);
            let peak = Arc::clone(&peak);
            coordinator.submit(test_job(
                session,
                MemoryJobKind::Reflection,
                move |_| async move {
                    let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(40)).await;
                    running.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                },
            ));
        }

        coordinator.wait_for_idle().await;
        assert_eq!(peak.load(Ordering::SeqCst), 1);
        assert_eq!(coordinator.metrics().completed, 2);
    }

    #[tokio::test]
    async fn same_key_keeps_only_latest_pending_job() {
        let coordinator = MemoryJobCoordinator::new(1);
        let gate = Arc::new(Notify::new());
        let seen = Arc::new(Mutex::new(Vec::new()));

        let gate_first = Arc::clone(&gate);
        let seen_first = Arc::clone(&seen);
        assert_eq!(
            coordinator.submit(test_job(
                "s",
                MemoryJobKind::WorkspaceExtraction,
                move |_| async move {
                    seen_first.lock().unwrap().push(1);
                    gate_first.notified().await;
                    Ok(())
                }
            )),
            MemoryJobSubmission::Started
        );

        tokio::task::yield_now().await;
        for value in [2, 3] {
            let seen = Arc::clone(&seen);
            assert_eq!(
                coordinator.submit(test_job(
                    "s",
                    MemoryJobKind::WorkspaceExtraction,
                    move |_| async move {
                        seen.lock().unwrap().push(value);
                        Ok(())
                    }
                )),
                MemoryJobSubmission::Coalesced
            );
        }
        gate.notify_waiters();

        coordinator.wait_for_idle().await;
        assert_eq!(*seen.lock().unwrap(), vec![1, 3]);
        assert_eq!(coordinator.metrics().coalesced, 2);
    }

    #[tokio::test]
    async fn session_cancel_stops_active_and_drops_pending() {
        let coordinator = MemoryJobCoordinator::new(1);
        let cleanup_outcome = Arc::new(Mutex::new(None));
        let cleanup = Arc::clone(&cleanup_outcome);
        let active = test_job(
            "s",
            MemoryJobKind::SessionMemory,
            move |cancel| async move {
                cancel.cancelled().await;
                Ok(())
            },
        )
        .with_cleanup(move |outcome| async move {
            *cleanup.lock().unwrap() = Some(outcome);
        });
        coordinator.submit(active);
        coordinator.submit(test_job("s", MemoryJobKind::SessionMemory, |_| async {
            Ok(())
        }));

        tokio::task::yield_now().await;
        assert_eq!(coordinator.cancel_session("s"), 1);
        coordinator.wait_for_idle().await;

        assert_eq!(
            *cleanup_outcome.lock().unwrap(),
            Some(MemoryJobOutcome::Cancelled)
        );
        assert_eq!(coordinator.metrics().started, 1);
        assert_eq!(coordinator.metrics().completed, 0);
    }

    #[tokio::test]
    async fn submissions_hold_only_lightweight_captures_until_admitted() {
        let coordinator = MemoryJobCoordinator::new(1);
        let gate = Arc::new(Notify::new());
        let gate_first = Arc::clone(&gate);
        coordinator.submit(test_job(
            "busy",
            MemoryJobKind::SessionMemory,
            move |_| async move {
                gate_first.notified().await;
                Ok(())
            },
        ));
        tokio::task::yield_now().await;

        let transcript_owner = Arc::new(vec![0_u8; 1024 * 1024]);
        let weak = Arc::downgrade(&transcript_owner);
        let lightweight_id = "session-id-only".to_string();
        coordinator.submit(test_job(
            "queued",
            MemoryJobKind::WorkspaceExtraction,
            move |_| async move {
                assert_eq!(lightweight_id, "session-id-only");
                Ok(())
            },
        ));
        drop(transcript_owner);

        assert!(
            weak.upgrade().is_none(),
            "queued job must not retain an in-memory transcript"
        );
        gate.notify_waiters();
        coordinator.wait_for_idle().await;
    }

    #[tokio::test]
    async fn debounce_replaces_waiting_generation() {
        let coordinator = MemoryJobCoordinator::new(1);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let first = Arc::clone(&seen);
        coordinator.submit(
            test_job("s", MemoryJobKind::Reflection, move |_| async move {
                first.lock().unwrap().push(1);
                Ok(())
            })
            .with_debounce(Duration::from_millis(50)),
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
        let second = Arc::clone(&seen);
        coordinator.submit(
            test_job("s", MemoryJobKind::Reflection, move |_| async move {
                second.lock().unwrap().push(2);
                Ok(())
            })
            .with_debounce(Duration::from_millis(20)),
        );

        coordinator.wait_for_idle().await;
        assert_eq!(*seen.lock().unwrap(), vec![2]);
        assert_eq!(coordinator.metrics().completed, 1);
    }

    #[tokio::test]
    async fn session_memory_bypasses_global_permit() {
        let coordinator = MemoryJobCoordinator::new(1);
        let gate = Arc::new(Notify::new());
        let gate_heavy = Arc::clone(&gate);
        coordinator.submit(test_job(
            "heavy",
            MemoryJobKind::WorkspaceExtraction,
            move |_| async move {
                gate_heavy.notified().await;
                Ok(())
            },
        ));
        tokio::task::yield_now().await;

        let sm_done = Arc::new(AtomicUsize::new(0));
        let sm_flag = Arc::clone(&sm_done);
        coordinator.submit(test_job(
            "sm",
            MemoryJobKind::SessionMemory,
            move |_| async move {
                sm_flag.store(1, Ordering::SeqCst);
                Ok(())
            },
        ));

        for _ in 0..100 {
            if sm_done.load(Ordering::SeqCst) == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            sm_done.load(Ordering::SeqCst),
            1,
            "session-memory job must run while the heavy job holds the only permit"
        );

        gate.notify_waiters();
        coordinator.wait_for_idle().await;
        assert_eq!(coordinator.metrics().completed, 2);
    }

    #[tokio::test]
    async fn timeout_runs_cleanup() {
        let coordinator = MemoryJobCoordinator::new(1);
        let cleanup_outcome = Arc::new(Mutex::new(None));
        let cleanup = Arc::clone(&cleanup_outcome);
        let job = MemoryJob::new(
            "s",
            Some("agent:test".to_string()),
            MemoryJobKind::AutoDream,
            Duration::from_millis(20),
            |_| async {
                std::future::pending::<()>().await;
                Ok(())
            },
        )
        .with_cleanup(move |outcome| async move {
            *cleanup.lock().unwrap() = Some(outcome);
        });
        coordinator.submit(job);

        coordinator.wait_for_idle().await;
        assert_eq!(
            *cleanup_outcome.lock().unwrap(),
            Some(MemoryJobOutcome::TimedOut)
        );
        assert_eq!(coordinator.metrics().timed_out, 1);
    }
}
