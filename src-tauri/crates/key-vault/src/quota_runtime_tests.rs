use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Barrier, Notify};

use super::{
    QuotaAttemptState, QuotaFreshness, QuotaRefreshCompletion, QuotaRefreshRuntime,
    SUPERSEDED_ERROR,
};

fn runtime(max_accounts: usize, max_concurrency: usize) -> QuotaRefreshRuntime<usize> {
    QuotaRefreshRuntime::new(
        Duration::from_secs(60),
        Duration::from_secs(60),
        max_accounts,
        max_concurrency,
    )
}

#[tokio::test]
async fn equivalent_requests_share_one_provider_attempt_and_success_ttl() {
    let runtime = runtime(8, 4);
    let calls = Arc::new(AtomicUsize::new(0));
    let barrier = Arc::new(Barrier::new(2));

    let mut tasks = Vec::new();
    for _ in 0..2 {
        let runtime = runtime.clone();
        let calls = Arc::clone(&calls);
        let barrier = Arc::clone(&barrier);
        tasks.push(tokio::spawn(async move {
            runtime
                .refresh("account".into(), "revision".into(), false, move || {
                    let calls = Arc::clone(&calls);
                    let barrier = Arc::clone(&barrier);
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        barrier.wait().await;
                        Ok(QuotaRefreshCompletion::unchanged(42))
                    }
                })
                .await
        }));
    }

    barrier.wait().await;
    for task in tasks {
        assert_eq!(task.await.unwrap().unwrap(), 42);
    }
    let cached = runtime
        .refresh("account".into(), "revision".into(), false, || async {
            panic!("fresh success should be served from the TTL cache")
        })
        .await
        .unwrap();

    assert_eq!(cached, 42);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn force_bypasses_completed_cache_but_joins_in_flight_work() {
    let runtime = runtime(8, 4);
    let calls = Arc::new(AtomicUsize::new(0));

    let first = runtime
        .refresh("account".into(), "revision".into(), false, {
            let calls = Arc::clone(&calls);
            move || {
                let calls = Arc::clone(&calls);
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(QuotaRefreshCompletion::unchanged(1))
                }
            }
        })
        .await
        .unwrap();
    assert_eq!(first, 1);

    let forced = runtime
        .refresh("account".into(), "revision".into(), true, {
            let calls = Arc::clone(&calls);
            move || {
                let calls = Arc::clone(&calls);
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(QuotaRefreshCompletion::unchanged(2))
                }
            }
        })
        .await
        .unwrap();

    assert_eq!(forced, 2);
    assert_eq!(calls.load(Ordering::SeqCst), 2);

    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let leader_runtime = runtime.clone();
    let started_for_leader = Arc::clone(&started);
    let release_for_leader = Arc::clone(&release);
    let leader = tokio::spawn(async move {
        leader_runtime
            .refresh("joining".into(), "revision".into(), false, move || {
                let started = Arc::clone(&started_for_leader);
                let release = Arc::clone(&release_for_leader);
                async move {
                    started.notify_one();
                    release.notified().await;
                    Ok(QuotaRefreshCompletion::unchanged(3))
                }
            })
            .await
    });
    started.notified().await;

    let waiter_runtime = runtime.clone();
    let forced_waiter = tokio::spawn(async move {
        waiter_runtime
            .refresh("joining".into(), "revision".into(), true, || async {
                panic!("force must join equivalent in-flight work")
            })
            .await
    });
    release.notify_one();

    assert_eq!(leader.await.unwrap().unwrap(), 3);
    assert_eq!(forced_waiter.await.unwrap().unwrap(), 3);
}

#[tokio::test]
async fn short_failure_cache_retains_last_good_and_attempt_status() {
    let runtime = runtime(8, 4);
    let calls = Arc::new(AtomicUsize::new(0));

    runtime
        .refresh("account".into(), "revision".into(), false, || async {
            Ok(QuotaRefreshCompletion::unchanged(7))
        })
        .await
        .unwrap();

    let error = runtime
        .refresh("account".into(), "revision".into(), true, {
            let calls = Arc::clone(&calls);
            move || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Err("upstream unavailable".to_string()) }
            }
        })
        .await
        .unwrap_err();
    assert_eq!(error, "upstream unavailable");

    let cached_error = runtime
        .refresh("account".into(), "revision".into(), false, {
            let calls = Arc::clone(&calls);
            move || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Ok(QuotaRefreshCompletion::unchanged(99)) }
            }
        })
        .await
        .unwrap_err();
    assert_eq!(cached_error, "upstream unavailable");
    assert_eq!(calls.load(Ordering::SeqCst), 2);

    let status = runtime.status("account").unwrap();
    assert_eq!(status.freshness, QuotaFreshness::FreshFailure);
    assert!(status.cache_expires_at.is_some());
    assert_eq!(status.last_good.unwrap().value, 7);
    let attempt = status.last_attempt.unwrap();
    assert_eq!(attempt.state, QuotaAttemptState::Failed);
    assert!(attempt.finished_at.is_some());
    assert_eq!(attempt.error.as_deref(), Some("upstream unavailable"));
}

#[tokio::test]
async fn credential_generation_rejects_late_old_completion() {
    let runtime = runtime(8, 4);
    let old_started = Arc::new(Notify::new());
    let release_old = Arc::new(Notify::new());

    let old_runtime = runtime.clone();
    let started_for_worker = Arc::clone(&old_started);
    let release_for_worker = Arc::clone(&release_old);
    let old = tokio::spawn(async move {
        old_runtime
            .refresh("account".into(), "old".into(), false, move || {
                let started = Arc::clone(&started_for_worker);
                let release = Arc::clone(&release_for_worker);
                async move {
                    started.notify_one();
                    release.notified().await;
                    Ok(QuotaRefreshCompletion::unchanged(1))
                }
            })
            .await
    });
    old_started.notified().await;

    let current = runtime
        .refresh("account".into(), "new".into(), false, || async {
            Ok(QuotaRefreshCompletion::unchanged(2))
        })
        .await
        .unwrap();
    assert_eq!(current, 2);

    release_old.notify_one();
    assert_eq!(old.await.unwrap().unwrap_err(), SUPERSEDED_ERROR);
    assert_eq!(
        runtime.status("account").unwrap().last_good.unwrap().value,
        2
    );
}

#[tokio::test]
async fn provider_fan_out_is_bounded_across_accounts() {
    let runtime = runtime(16, 2);
    let active = Arc::new(AtomicUsize::new(0));
    let max_active = Arc::new(AtomicUsize::new(0));
    let barrier = Arc::new(Barrier::new(3));
    let mut tasks = Vec::new();

    for account in 0..6 {
        let runtime = runtime.clone();
        let active = Arc::clone(&active);
        let max_active = Arc::clone(&max_active);
        let barrier = Arc::clone(&barrier);
        tasks.push(tokio::spawn(async move {
            runtime
                .refresh(
                    format!("account-{account}"),
                    "revision".into(),
                    false,
                    move || {
                        let active = Arc::clone(&active);
                        let max_active = Arc::clone(&max_active);
                        let barrier = Arc::clone(&barrier);
                        async move {
                            let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                            max_active.fetch_max(current, Ordering::SeqCst);
                            if account < 2 {
                                barrier.wait().await;
                            }
                            tokio::time::sleep(Duration::from_millis(10)).await;
                            active.fetch_sub(1, Ordering::SeqCst);
                            Ok(QuotaRefreshCompletion::unchanged(account))
                        }
                    },
                )
                .await
        }));
    }

    barrier.wait().await;
    for task in tasks {
        task.await.unwrap().unwrap();
    }
    assert_eq!(max_active.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn account_cache_is_lru_bounded_and_invalidation_evicts_state() {
    let runtime = runtime(2, 2);
    for account in ["a", "b", "c"] {
        runtime
            .refresh(account.into(), "revision".into(), false, || async {
                Ok(QuotaRefreshCompletion::unchanged(1))
            })
            .await
            .unwrap();
    }

    assert!(runtime.status("a").is_none());
    assert!(runtime.status("b").is_some());
    assert!(runtime.status("c").is_some());

    runtime.invalidate("b");
    assert!(runtime.status("b").is_none());
}

#[tokio::test]
async fn expired_success_is_reported_and_refetched() {
    let runtime =
        QuotaRefreshRuntime::new(Duration::from_millis(5), Duration::from_millis(5), 4, 1);
    let calls = Arc::new(AtomicUsize::new(0));

    runtime
        .refresh("account".into(), "revision".into(), false, {
            let calls = Arc::clone(&calls);
            move || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Ok(QuotaRefreshCompletion::unchanged(1)) }
            }
        })
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert_eq!(
        runtime.status("account").unwrap().freshness,
        QuotaFreshness::Expired
    );

    runtime
        .refresh("account".into(), "revision".into(), false, {
            let calls = Arc::clone(&calls);
            move || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Ok(QuotaRefreshCompletion::unchanged(2)) }
            }
        })
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn transient_error_retries_once_and_non_transient_error_does_not() {
    let runtime = runtime(4, 1);
    let transient_calls = Arc::new(AtomicUsize::new(0));
    let value = runtime
        .refresh("transient".into(), "revision".into(), false, {
            let transient_calls = Arc::clone(&transient_calls);
            move || {
                let attempt = transient_calls.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt == 0 {
                        Err("HTTP 503 retry-after: 0".to_string())
                    } else {
                        Ok(QuotaRefreshCompletion::unchanged(5))
                    }
                }
            }
        })
        .await
        .unwrap();
    assert_eq!(value, 5);
    assert_eq!(transient_calls.load(Ordering::SeqCst), 2);

    let permanent_calls = Arc::new(AtomicUsize::new(0));
    let error = runtime
        .refresh("permanent".into(), "revision".into(), false, {
            let permanent_calls = Arc::clone(&permanent_calls);
            move || {
                permanent_calls.fetch_add(1, Ordering::SeqCst);
                async { Err("HTTP 401 unauthorized".to_string()) }
            }
        })
        .await
        .unwrap_err();
    assert_eq!(error, "HTTP 401 unauthorized");
    assert_eq!(permanent_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn strict_request_policy_does_not_retry_transient_errors() {
    let runtime = runtime(4, 1);
    let calls = Arc::new(AtomicUsize::new(0));
    let error = runtime
        .refresh_without_transient_retry("strict".into(), "revision".into(), false, {
            let calls = Arc::clone(&calls);
            move || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Err("HTTP 503 retry-after: 0".to_string()) }
            }
        })
        .await
        .unwrap_err();

    assert_eq!(error, "HTTP 503 retry-after: 0");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn provider_worker_panic_releases_single_flight_waiters() {
    let runtime = runtime(4, 1);
    let error = runtime
        .refresh("panic".into(), "revision".into(), false, || async {
            panic!("provider panic")
        })
        .await
        .unwrap_err();

    assert!(error.contains("provider worker failed"));
}
