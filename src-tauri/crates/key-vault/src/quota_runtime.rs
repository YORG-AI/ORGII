//! Process-wide coordination for provider quota refreshes.
//!
//! The runtime keeps provider traffic demand-driven: callers for the same
//! stored account share one refresh, successful and failed attempts have
//! separate freshness windows, and a process-wide semaphore bounds fan-out
//! when several accounts are refreshed together.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use tokio::sync::{Notify, Semaphore};
use tokio::task::AbortHandle;

pub const DEFAULT_QUOTA_SUCCESS_TTL: Duration = Duration::from_secs(5 * 60);
pub const DEFAULT_QUOTA_FAILURE_TTL: Duration = Duration::from_secs(15);
pub const DEFAULT_QUOTA_MAX_ACCOUNTS: usize = 256;
pub const DEFAULT_QUOTA_MAX_CONCURRENCY: usize = 3;
const TRANSIENT_RETRY_DELAY: Duration = Duration::from_millis(250);
const MAX_RETRY_AFTER: Duration = Duration::from_secs(5);

const SUPERSEDED_ERROR: &str = "Quota refresh was superseded by an account credential change";

/// Final state of the most recent refresh attempt for an account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuotaAttemptState {
    Running,
    Succeeded,
    Failed,
    Superseded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuotaFreshness {
    Empty,
    FreshSuccess,
    FreshFailure,
    Expired,
    Refreshing,
}

/// Timing and result metadata for the latest provider attempt.
#[derive(Debug, Clone)]
pub struct QuotaAttempt {
    pub generation: u64,
    pub state: QuotaAttemptState,
    pub started_at: SystemTime,
    pub finished_at: Option<SystemTime>,
    pub error: Option<String>,
}

/// Most recent successful value, retained even when a later refresh fails.
#[derive(Debug, Clone)]
pub struct QuotaLastGood<T> {
    pub value: T,
    pub captured_at: SystemTime,
}

/// Read-only diagnostic snapshot for one account.
#[derive(Debug, Clone)]
pub struct QuotaRefreshStatus<T> {
    pub generation: u64,
    pub freshness: QuotaFreshness,
    pub cache_expires_at: Option<SystemTime>,
    pub last_good: Option<QuotaLastGood<T>>,
    pub last_attempt: Option<QuotaAttempt>,
}

/// Successful operation output.
///
/// OAuth refreshes can replace a token during the same operation. In that
/// case `credential_revision` advances the cache to the refreshed credential
/// without forcing an unnecessary second provider request.
pub struct QuotaRefreshCompletion<T> {
    value: T,
    credential_revision: Option<String>,
}

impl<T> QuotaRefreshCompletion<T> {
    pub fn unchanged(value: T) -> Self {
        Self {
            value,
            credential_revision: None,
        }
    }

    pub fn with_credential_revision(value: T, credential_revision: String) -> Self {
        Self {
            value,
            credential_revision: Some(credential_revision),
        }
    }
}

struct CachedResult<T> {
    result: Result<T, String>,
    expires_at: Instant,
    expires_at_wall: SystemTime,
}

struct InFlight<T> {
    state: Mutex<InFlightState<T>>,
    completed: Notify,
}

struct InFlightState<T> {
    result: Option<Result<T, String>>,
    abort: Vec<AbortHandle>,
}

impl<T> InFlight<T>
where
    T: Clone,
{
    fn finish(&self, result: Result<T, String>) {
        let mut completed = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if completed.result.is_none() {
            completed.result = Some(result);
        }
        drop(completed);
        self.completed.notify_waiters();
    }

    fn cancel(&self, result: Result<T, String>) {
        let aborts = {
            let mut completed = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if completed.result.is_none() {
                completed.result = Some(result);
            }
            std::mem::take(&mut completed.abort)
        };
        for abort in aborts {
            abort.abort();
        }
        self.completed.notify_waiters();
    }

    fn set_abort_handles(&self, aborts: Vec<AbortHandle>) {
        let should_abort = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.result.is_some() {
                true
            } else {
                state.abort = aborts.clone();
                false
            }
        };
        if should_abort {
            for abort in aborts {
                abort.abort();
            }
        }
    }

    async fn wait(&self) -> Result<T, String> {
        loop {
            let notified = self.completed.notified();
            if let Some(result) = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .result
                .clone()
            {
                return result;
            }
            notified.await;
        }
    }
}

struct AccountRefresh<T> {
    credential_revision: String,
    generation: u64,
    last_used: u64,
    cached: Option<CachedResult<T>>,
    last_good: Option<QuotaLastGood<T>>,
    last_attempt: Option<QuotaAttempt>,
    in_flight: Option<Arc<InFlight<T>>>,
}

struct RuntimeState<T> {
    accounts: HashMap<String, AccountRefresh<T>>,
    next_generation: u64,
    next_use: u64,
}

impl<T> Default for RuntimeState<T> {
    fn default() -> Self {
        Self {
            accounts: HashMap::new(),
            next_generation: 1,
            next_use: 1,
        }
    }
}

struct QuotaRefreshRuntimeInner<T> {
    state: Mutex<RuntimeState<T>>,
    permits: Arc<Semaphore>,
    success_ttl: Duration,
    failure_ttl: Duration,
    max_accounts: usize,
}

/// Cloneable process-level quota refresh coordinator.
pub struct QuotaRefreshRuntime<T> {
    inner: Arc<QuotaRefreshRuntimeInner<T>>,
}

impl<T> Clone for QuotaRefreshRuntime<T> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl<T> Default for QuotaRefreshRuntime<T>
where
    T: Clone + Send + 'static,
{
    fn default() -> Self {
        Self::new(
            DEFAULT_QUOTA_SUCCESS_TTL,
            DEFAULT_QUOTA_FAILURE_TTL,
            DEFAULT_QUOTA_MAX_ACCOUNTS,
            DEFAULT_QUOTA_MAX_CONCURRENCY,
        )
    }
}

impl<T> QuotaRefreshRuntime<T>
where
    T: Clone + Send + 'static,
{
    pub fn new(
        success_ttl: Duration,
        failure_ttl: Duration,
        max_accounts: usize,
        max_concurrency: usize,
    ) -> Self {
        Self {
            inner: Arc::new(QuotaRefreshRuntimeInner {
                state: Mutex::new(RuntimeState::default()),
                permits: Arc::new(Semaphore::new(max_concurrency.max(1))),
                success_ttl,
                failure_ttl,
                max_accounts: max_accounts.max(1),
            }),
        }
    }

    /// Refresh one account or share/cached-return an equivalent request.
    ///
    /// `force` bypasses completed success and failure TTLs. It intentionally
    /// does not bypass an equivalent in-flight request.
    pub async fn refresh<F, Fut>(
        &self,
        account_id: String,
        credential_revision: String,
        force: bool,
        operation: F,
    ) -> Result<T, String>
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<QuotaRefreshCompletion<T>, String>> + Send + 'static,
    {
        self.refresh_with_retry_policy(account_id, credential_revision, force, true, operation)
            .await
    }

    /// Refresh with the same cache, single-flight, and concurrency policy but
    /// without repeating a transient provider request.
    ///
    /// Use this for endpoints whose request-count contract is stricter than
    /// the default one-retry resilience policy.
    pub async fn refresh_without_transient_retry<F, Fut>(
        &self,
        account_id: String,
        credential_revision: String,
        force: bool,
        operation: F,
    ) -> Result<T, String>
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<QuotaRefreshCompletion<T>, String>> + Send + 'static,
    {
        self.refresh_with_retry_policy(account_id, credential_revision, force, false, operation)
            .await
    }

    async fn refresh_with_retry_policy<F, Fut>(
        &self,
        account_id: String,
        credential_revision: String,
        force: bool,
        retry_transient: bool,
        operation: F,
    ) -> Result<T, String>
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<QuotaRefreshCompletion<T>, String>> + Send + 'static,
    {
        let now = Instant::now();
        let started_at = SystemTime::now();
        let mut superseded = None;

        let (refresh, generation, is_leader) = {
            let mut state = self
                .inner
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.next_use = state.next_use.wrapping_add(1);
            let use_tick = state.next_use;

            if !state.accounts.contains_key(&account_id) {
                evict_for_capacity(&mut state, self.inner.max_accounts)?;
                state.next_generation = state.next_generation.wrapping_add(1);
                let generation = state.next_generation;
                state.accounts.insert(
                    account_id.clone(),
                    AccountRefresh {
                        credential_revision: credential_revision.clone(),
                        generation,
                        last_used: use_tick,
                        cached: None,
                        last_good: None,
                        last_attempt: None,
                        in_flight: None,
                    },
                );
            }

            let revision_changed = state
                .accounts
                .get(&account_id)
                .is_some_and(|entry| entry.credential_revision != credential_revision);
            if revision_changed {
                state.next_generation = state.next_generation.wrapping_add(1);
                let generation = state.next_generation;
                let entry = state
                    .accounts
                    .get_mut(&account_id)
                    .expect("account entry exists");
                superseded = entry.in_flight.take();
                entry.credential_revision = credential_revision.clone();
                entry.generation = generation;
                entry.cached = None;
                entry.last_good = None;
                entry.last_attempt = None;
            }

            let entry = state
                .accounts
                .get_mut(&account_id)
                .expect("account entry exists");
            entry.last_used = use_tick;

            if !force {
                if let Some(cached) = entry
                    .cached
                    .as_ref()
                    .filter(|cached| cached.expires_at > now)
                {
                    return cached.result.clone();
                }
            }

            if let Some(refresh) = entry.in_flight.as_ref() {
                (Arc::clone(refresh), entry.generation, false)
            } else {
                let refresh = Arc::new(InFlight {
                    state: Mutex::new(InFlightState {
                        result: None,
                        abort: Vec::new(),
                    }),
                    completed: Notify::new(),
                });
                entry.in_flight = Some(Arc::clone(&refresh));
                entry.last_attempt = Some(QuotaAttempt {
                    generation: entry.generation,
                    state: QuotaAttemptState::Running,
                    started_at,
                    finished_at: None,
                    error: None,
                });
                (refresh, entry.generation, true)
            }
        };

        if let Some(old_refresh) = superseded {
            old_refresh.cancel(Err(SUPERSEDED_ERROR.to_string()));
        }

        if is_leader {
            let permits = Arc::clone(&self.inner.permits);
            let provider_worker = tokio::spawn(async move {
                let permit = permits.acquire_owned().await;
                match permit {
                    Ok(_permit) if retry_transient => {
                        run_with_one_transient_retry(&operation).await
                    }
                    Ok(_permit) => operation().await,
                    Err(_) => Err("Quota refresh coordinator is shutting down".to_string()),
                }
            });
            let provider_abort = provider_worker.abort_handle();
            let runtime = self.clone();
            let refresh_for_worker = Arc::clone(&refresh);
            let supervisor = tokio::spawn(async move {
                let operation_result = match provider_worker.await {
                    Ok(result) => result,
                    Err(error) => Err(format!("Quota refresh provider worker failed: {error}")),
                };
                runtime.finish(
                    &account_id,
                    &credential_revision,
                    generation,
                    refresh_for_worker,
                    operation_result,
                );
            });
            refresh.set_abort_handles(vec![provider_abort, supervisor.abort_handle()]);
        }

        refresh.wait().await
    }

    /// Drop all retained state for an account (for deletion/sign-out).
    pub fn invalidate(&self, account_id: &str) {
        let removed = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .accounts
            .remove(account_id);
        if let Some(refresh) = removed.and_then(|entry| entry.in_flight) {
            refresh.cancel(Err(SUPERSEDED_ERROR.to_string()));
        }
    }

    pub fn status(&self, account_id: &str) -> Option<QuotaRefreshStatus<T>> {
        let now = Instant::now();
        self.inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .accounts
            .get(account_id)
            .map(|entry| {
                let freshness = if entry.in_flight.is_some() {
                    QuotaFreshness::Refreshing
                } else {
                    match entry.cached.as_ref() {
                        None => QuotaFreshness::Empty,
                        Some(cached) if cached.expires_at <= now => QuotaFreshness::Expired,
                        Some(cached) if cached.result.is_ok() => QuotaFreshness::FreshSuccess,
                        Some(_) => QuotaFreshness::FreshFailure,
                    }
                };
                let cache_expires_at = entry.cached.as_ref().map(|cached| cached.expires_at_wall);
                QuotaRefreshStatus {
                    generation: entry.generation,
                    freshness,
                    cache_expires_at,
                    last_good: entry.last_good.clone(),
                    last_attempt: entry.last_attempt.clone(),
                }
            })
    }

    fn finish(
        &self,
        account_id: &str,
        requested_revision: &str,
        generation: u64,
        refresh: Arc<InFlight<T>>,
        operation_result: Result<QuotaRefreshCompletion<T>, String>,
    ) {
        let now = Instant::now();
        let finished_at = SystemTime::now();
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let Some(entry) = state.accounts.get_mut(account_id) else {
            drop(state);
            refresh.finish(Err(SUPERSEDED_ERROR.to_string()));
            return;
        };
        let is_current = entry.generation == generation
            && entry.credential_revision == requested_revision
            && entry
                .in_flight
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, &refresh));
        if !is_current {
            drop(state);
            refresh.finish(Err(SUPERSEDED_ERROR.to_string()));
            return;
        }

        let result = match operation_result {
            Ok(completion) => {
                if let Some(next_revision) = completion.credential_revision {
                    entry.credential_revision = next_revision;
                }
                let value = completion.value;
                entry.last_good = Some(QuotaLastGood {
                    value: value.clone(),
                    captured_at: finished_at,
                });
                entry.last_attempt = Some(QuotaAttempt {
                    generation,
                    state: QuotaAttemptState::Succeeded,
                    started_at: entry
                        .last_attempt
                        .as_ref()
                        .map(|attempt| attempt.started_at)
                        .unwrap_or(finished_at),
                    finished_at: Some(finished_at),
                    error: None,
                });
                let result = Ok(value);
                entry.cached = Some(CachedResult {
                    result: result.clone(),
                    expires_at: now + self.inner.success_ttl,
                    expires_at_wall: finished_at + self.inner.success_ttl,
                });
                result
            }
            Err(error) => {
                entry.last_attempt = Some(QuotaAttempt {
                    generation,
                    state: QuotaAttemptState::Failed,
                    started_at: entry
                        .last_attempt
                        .as_ref()
                        .map(|attempt| attempt.started_at)
                        .unwrap_or(finished_at),
                    finished_at: Some(finished_at),
                    error: Some(error.clone()),
                });
                let result = Err(error);
                entry.cached = Some(CachedResult {
                    result: result.clone(),
                    expires_at: now + self.inner.failure_ttl,
                    expires_at_wall: finished_at + self.inner.failure_ttl,
                });
                result
            }
        };
        entry.in_flight = None;
        drop(state);
        refresh.finish(result);
    }
}

async fn run_with_one_transient_retry<T, F, Fut>(
    operation: &F,
) -> Result<QuotaRefreshCompletion<T>, String>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<QuotaRefreshCompletion<T>, String>>,
{
    let first = operation().await;
    let Err(error) = first else {
        return first;
    };
    if !is_transient_quota_error(&error) {
        return Err(error);
    }

    let delay = retry_after_from_error(&error).unwrap_or(TRANSIENT_RETRY_DELAY);
    tokio::time::sleep(delay.min(MAX_RETRY_AFTER)).await;
    operation().await
}

fn is_transient_quota_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    ["408", "429", "500", "502", "503", "504"]
        .iter()
        .any(|status| lower.contains(status))
        || [
            "timeout",
            "timed out",
            "connection reset",
            "connection closed",
            "temporarily unavailable",
            "upstream unavailable",
            "service unavailable",
        ]
        .iter()
        .any(|marker| lower.contains(marker))
}

fn retry_after_from_error(error: &str) -> Option<Duration> {
    let lower = error.to_ascii_lowercase();
    let marker_start = lower.find("retry-after")? + "retry-after".len();
    let suffix = lower[marker_start..].trim_start_matches([' ', ':', '=']);
    let seconds = suffix
        .split(|character: char| !character.is_ascii_digit())
        .next()?
        .parse::<u64>()
        .ok()?;
    Some(Duration::from_secs(seconds))
}

fn evict_for_capacity<T>(state: &mut RuntimeState<T>, max_accounts: usize) -> Result<(), String> {
    if state.accounts.len() < max_accounts {
        return Ok(());
    }

    let evict_id = state
        .accounts
        .iter()
        .filter(|(_, entry)| entry.in_flight.is_none())
        .min_by_key(|(_, entry)| entry.last_used)
        .map(|(account_id, _)| account_id.clone())
        .ok_or_else(|| {
            format!(
                "Quota refresh coordinator is at its {}-account capacity",
                max_accounts
            )
        })?;
    state.accounts.remove(&evict_id);
    Ok(())
}

#[cfg(test)]
#[path = "quota_runtime_tests.rs"]
mod tests;
