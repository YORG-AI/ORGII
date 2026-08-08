use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use tokio::sync::{watch, OwnedSemaphorePermit, Semaphore};

const EXTERNAL_HISTORY_SCAN_CONCURRENCY: usize = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ExternalHistoryScanMode {
    Incremental,
    Rebuild,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ExternalHistorySourceScanResult {
    pub changed: bool,
    pub signature: String,
}

pub(super) type ExternalHistorySourceScanOutcome = Result<ExternalHistorySourceScanResult, String>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ExternalHistoryScanJob {
    pub source: String,
    generation: u64,
    pub mode: ExternalHistoryScanMode,
}

#[derive(Debug, Clone)]
struct SourceSnapshot {
    generation: u64,
    mode: Option<ExternalHistoryScanMode>,
    phase: ScanPhase,
    outcome: Option<ExternalHistorySourceScanOutcome>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScanPhase {
    Queued,
    Running,
    Completed,
}

#[derive(Debug)]
struct SourceState {
    snapshot: SourceSnapshot,
    sender: watch::Sender<SourceSnapshot>,
}

#[derive(Debug)]
pub(super) struct ExternalHistoryScanWaiter {
    sources: Vec<(String, watch::Receiver<SourceSnapshot>)>,
}

#[derive(Debug)]
pub(super) struct ExternalHistoryScanSchedule {
    pub jobs: Vec<ExternalHistoryScanJob>,
    pub waiter: ExternalHistoryScanWaiter,
}

#[derive(Debug)]
pub(super) struct ExternalHistoryScanCoordinator {
    // Callers validate against the compile-time imported-source registry
    // before scheduling, so this app-lifetime map is bounded by that registry.
    sources: Mutex<HashMap<String, SourceState>>,
    permits: Arc<Semaphore>,
}

impl Default for ExternalHistoryScanCoordinator {
    fn default() -> Self {
        Self::new(EXTERNAL_HISTORY_SCAN_CONCURRENCY)
    }
}

impl ExternalHistoryScanCoordinator {
    fn new(concurrency: usize) -> Self {
        assert!(concurrency > 0, "scan concurrency must be positive");
        Self {
            sources: Mutex::new(HashMap::new()),
            permits: Arc::new(Semaphore::new(concurrency)),
        }
    }

    /// Registers one IPC request. Concurrent requests for a source share its
    /// current flight. A rebuild supersedes an incremental generation, while
    /// incrementals arriving during a rebuild join that rebuild.
    pub fn schedule(
        &self,
        sources: Vec<String>,
        mode: ExternalHistoryScanMode,
    ) -> ExternalHistoryScanSchedule {
        let mut states = self
            .sources
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut jobs = Vec::new();
        let mut wait_sources = Vec::with_capacity(sources.len());

        for source in sources {
            let state = states.entry(source.clone()).or_insert_with(|| {
                let snapshot = SourceSnapshot {
                    generation: 0,
                    mode: None,
                    phase: ScanPhase::Completed,
                    outcome: None,
                };
                let (sender, _) = watch::channel(snapshot.clone());
                SourceState { snapshot, sender }
            });

            let should_start = match state.snapshot.phase {
                ScanPhase::Completed => true,
                ScanPhase::Queued | ScanPhase::Running => {
                    mode == ExternalHistoryScanMode::Rebuild
                        && state.snapshot.mode == Some(ExternalHistoryScanMode::Incremental)
                }
            };

            if should_start {
                let generation = state
                    .snapshot
                    .generation
                    .checked_add(1)
                    .expect("external history scan generation exhausted");
                state.snapshot = SourceSnapshot {
                    generation,
                    mode: Some(mode),
                    phase: ScanPhase::Queued,
                    outcome: None,
                };
                state.sender.send_replace(state.snapshot.clone());
                jobs.push(ExternalHistoryScanJob {
                    source: source.clone(),
                    generation: state.snapshot.generation,
                    mode,
                });
            }

            wait_sources.push((source, state.sender.subscribe()));
        }

        ExternalHistoryScanSchedule {
            jobs,
            waiter: ExternalHistoryScanWaiter {
                sources: wait_sources,
            },
        }
    }

    pub async fn acquire_permit(&self) -> Result<OwnedSemaphorePermit, String> {
        self.permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "External history scan queue closed".to_string())
    }

    /// Claims only jobs that are still current after waiting for the bounded
    /// scan permit. Superseded queued incrementals therefore perform no I/O.
    pub fn begin_current_jobs(
        &self,
        jobs: Vec<ExternalHistoryScanJob>,
    ) -> Vec<ExternalHistoryScanJob> {
        let mut states = self
            .sources
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        jobs.into_iter()
            .filter_map(|job| {
                let state = states.get_mut(&job.source)?;
                if state.snapshot.generation != job.generation
                    || state.snapshot.phase != ScanPhase::Queued
                {
                    return None;
                }
                state.snapshot.phase = ScanPhase::Running;
                state.sender.send_replace(state.snapshot.clone());
                Some(job)
            })
            .collect()
    }

    pub fn is_current_running_job(&self, job: &ExternalHistoryScanJob) -> bool {
        let states = self
            .sources
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        states.get(&job.source).is_some_and(|state| {
            state.snapshot.generation == job.generation
                && state.snapshot.phase == ScanPhase::Running
        })
    }

    /// Publishes only the matching generation. A late incremental completion
    /// cannot satisfy waiters after a clear/rebuild has advanced the source.
    pub fn complete_jobs(
        &self,
        outcomes: Vec<(ExternalHistoryScanJob, ExternalHistorySourceScanOutcome)>,
    ) {
        let mut states = self
            .sources
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for (job, outcome) in outcomes {
            let Some(state) = states.get_mut(&job.source) else {
                continue;
            };
            if state.snapshot.generation != job.generation
                || state.snapshot.phase != ScanPhase::Running
            {
                continue;
            }
            state.snapshot.phase = ScanPhase::Completed;
            state.snapshot.outcome = Some(outcome);
            state.sender.send_replace(state.snapshot.clone());
        }
    }

    pub fn fail_current_jobs(&self, jobs: Vec<ExternalHistoryScanJob>, error: String) {
        let mut states = self
            .sources
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for job in jobs {
            let Some(state) = states.get_mut(&job.source) else {
                continue;
            };
            if state.snapshot.generation != job.generation {
                continue;
            }
            state.snapshot.phase = ScanPhase::Completed;
            state.snapshot.outcome = Some(Err(error.clone()));
            state.sender.send_replace(state.snapshot.clone());
        }
    }
}

impl ExternalHistoryScanWaiter {
    pub async fn wait(
        mut self,
    ) -> Result<HashMap<String, ExternalHistorySourceScanResult>, String> {
        let mut results = HashMap::with_capacity(self.sources.len());
        for (source, receiver) in &mut self.sources {
            loop {
                let snapshot = receiver.borrow_and_update().clone();
                if snapshot.phase == ScanPhase::Completed {
                    if let Some(outcome) = snapshot.outcome {
                        results.insert(source.clone(), outcome?);
                        break;
                    }
                }
                receiver.changed().await.map_err(|_| {
                    format!("External history scan coordinator closed for {source}")
                })?;
            }
        }
        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finish(
        coordinator: &ExternalHistoryScanCoordinator,
        job: ExternalHistoryScanJob,
        signature: &str,
    ) {
        coordinator.complete_jobs(vec![(
            job,
            Ok(ExternalHistorySourceScanResult {
                changed: true,
                signature: signature.to_string(),
            }),
        )]);
    }

    #[tokio::test]
    async fn concurrent_incremental_requests_share_one_source_flight() {
        let coordinator = ExternalHistoryScanCoordinator::new(1);
        let first = coordinator.schedule(
            vec!["cursor_ide".to_string()],
            ExternalHistoryScanMode::Incremental,
        );
        let second = coordinator.schedule(
            vec!["cursor_ide".to_string()],
            ExternalHistoryScanMode::Incremental,
        );

        assert_eq!(first.jobs.len(), 1);
        assert!(second.jobs.is_empty());
        let mut jobs = coordinator.begin_current_jobs(first.jobs);
        let job = jobs.pop().expect("one shared job");
        finish(&coordinator, job, "shared");

        assert_eq!(
            first.waiter.wait().await.expect("first result")["cursor_ide"].signature,
            "shared"
        );
        assert_eq!(
            second.waiter.wait().await.expect("second result")["cursor_ide"].signature,
            "shared"
        );
    }

    #[test]
    fn overlapping_scan_all_requests_only_schedule_new_sources() {
        let coordinator = ExternalHistoryScanCoordinator::new(1);
        let first = coordinator.schedule(
            vec!["cursor_ide".to_string(), "codex".to_string()],
            ExternalHistoryScanMode::Incremental,
        );
        let second = coordinator.schedule(
            vec!["codex".to_string(), "claude".to_string()],
            ExternalHistoryScanMode::Incremental,
        );

        assert_eq!(
            first
                .jobs
                .iter()
                .map(|job| job.source.as_str())
                .collect::<Vec<_>>(),
            vec!["cursor_ide", "codex"]
        );
        assert_eq!(
            second
                .jobs
                .iter()
                .map(|job| job.source.as_str())
                .collect::<Vec<_>>(),
            vec!["claude"]
        );
    }

    #[tokio::test]
    async fn incrementals_and_repeated_rebuilds_join_one_explicit_rebuild() {
        let coordinator = ExternalHistoryScanCoordinator::new(1);
        let rebuild = coordinator.schedule(
            vec!["cursor_ide".to_string()],
            ExternalHistoryScanMode::Rebuild,
        );
        let incremental = coordinator.schedule(
            vec!["cursor_ide".to_string()],
            ExternalHistoryScanMode::Incremental,
        );
        let repeated_rebuild = coordinator.schedule(
            vec!["cursor_ide".to_string()],
            ExternalHistoryScanMode::Rebuild,
        );

        assert_eq!(rebuild.jobs.len(), 1);
        assert!(incremental.jobs.is_empty());
        assert!(repeated_rebuild.jobs.is_empty());
        let rebuild_job = coordinator
            .begin_current_jobs(rebuild.jobs)
            .pop()
            .expect("one rebuild job");
        finish(&coordinator, rebuild_job, "rebuilt");

        assert_eq!(
            incremental.waiter.wait().await.expect("incremental join")["cursor_ide"].signature,
            "rebuilt"
        );
        assert_eq!(
            repeated_rebuild.waiter.wait().await.expect("rebuild join")["cursor_ide"].signature,
            "rebuilt"
        );
    }

    #[tokio::test]
    async fn rebuild_supersedes_incremental_and_rejects_its_late_completion() {
        let coordinator = ExternalHistoryScanCoordinator::new(1);
        let incremental = coordinator.schedule(
            vec!["cursor_ide".to_string()],
            ExternalHistoryScanMode::Incremental,
        );
        let incremental_job = coordinator
            .begin_current_jobs(incremental.jobs)
            .pop()
            .expect("incremental job");

        let rebuild = coordinator.schedule(
            vec!["cursor_ide".to_string()],
            ExternalHistoryScanMode::Rebuild,
        );
        assert_eq!(rebuild.jobs.len(), 1);

        assert!(!coordinator.is_current_running_job(&incremental_job));
        finish(&coordinator, incremental_job, "stale");
        let rebuild_job = coordinator
            .begin_current_jobs(rebuild.jobs)
            .pop()
            .expect("rebuild job");
        finish(&coordinator, rebuild_job, "rebuilt");

        assert_eq!(
            incremental
                .waiter
                .wait()
                .await
                .expect("incremental follows rebuild")["cursor_ide"]
                .signature,
            "rebuilt"
        );
        assert_eq!(
            rebuild.waiter.wait().await.expect("rebuild result")["cursor_ide"].signature,
            "rebuilt"
        );
    }

    #[tokio::test]
    async fn scan_permits_are_bounded() {
        let coordinator = ExternalHistoryScanCoordinator::new(1);
        let permit = coordinator.acquire_permit().await.expect("first permit");
        assert_eq!(coordinator.permits.available_permits(), 0);
        drop(permit);
        assert_eq!(coordinator.permits.available_permits(), 1);
    }
}
