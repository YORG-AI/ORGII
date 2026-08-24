//! Tests for the run registry (`TestRunnerState`) and the wire shape of
//! `TestEvent` — the contract the frontend `TestEvent` union relies on.

use super::*;

#[test]
fn begin_stop_finish_lifecycle() {
    let state = TestRunnerState::new();

    let token = state.begin("run-1");
    assert_eq!(state.active_runs(), 1);
    assert!(!token.is_cancelled());

    assert!(state.request_stop("run-1"), "active run must be stoppable");
    assert!(token.is_cancelled(), "stop must signal the runner's token");

    state.finish("run-1");
    assert_eq!(state.active_runs(), 0);
    assert!(
        !state.request_stop("run-1"),
        "stopping a finished run reports false, not an error"
    );
}

#[test]
fn parallel_runs_are_isolated() {
    let state = TestRunnerState::new();
    let token_a = state.begin("run-a");
    let token_b = state.begin("run-b");

    assert!(state.request_stop("run-a"));
    assert!(token_a.is_cancelled());
    assert!(
        !token_b.is_cancelled(),
        "stopping run-a must not cancel run-b"
    );

    state.finish("run-a");
    assert_eq!(state.active_runs(), 1);
    state.finish("run-b");
    assert_eq!(state.active_runs(), 0);
}

#[test]
fn run_guard_deregisters_on_drop() {
    let state = TestRunnerState::new();
    let _token = state.begin("run-1");
    {
        let _guard = RunGuard {
            state: &state,
            run_id: "run-1",
        };
        assert_eq!(state.active_runs(), 1);
    }
    // Guard dropped (as it would be if Tauri dropped the command future):
    // the registry must not retain the terminal run.
    assert_eq!(state.active_runs(), 0);
}

#[test]
fn repeated_finish_is_idempotent() {
    let state = TestRunnerState::new();
    let _token = state.begin("run-1");
    state.finish("run-1");
    state.finish("run-1");
    assert_eq!(state.active_runs(), 0);
}

/// The frontend switch reads `data.runId` (camelCase). This pins the wire
/// format so a serde attribute regression cannot silently send `run_id`
/// again (which made the frontend see `undefined` run ids).
#[test]
fn test_event_wire_format_uses_camel_case_fields() {
    let started = serde_json::to_value(TestEvent::RunStarted {
        run_id: "r1".into(),
        total_tests: 5,
    })
    .expect("serialize");
    assert_eq!(started["type"], "run_started");
    assert_eq!(started["runId"], "r1");
    assert_eq!(started["totalTests"], 5);
    assert!(started.get("run_id").is_none());

    let cancelled = serde_json::to_value(TestEvent::RunCancelled {
        run_id: "r1".into(),
    })
    .expect("serialize");
    assert_eq!(cancelled["type"], "run_cancelled");
    assert_eq!(cancelled["runId"], "r1");

    let test_started = serde_json::to_value(TestEvent::TestStarted {
        test_id: "t1".into(),
        name: "adds".into(),
    })
    .expect("serialize");
    assert_eq!(test_started["testId"], "t1");
}

#[test]
fn summary_wire_format_includes_cancelled_flag() {
    let summary = TestRunSummary {
        run_id: "r1".into(),
        framework: TestFramework::Vitest,
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration_ms: 12,
        results: vec![],
        started_at: "2026-08-07T00:00:00Z".into(),
        finished_at: None,
        cancelled: true,
    };
    let value = serde_json::to_value(&summary).expect("serialize");
    assert_eq!(value["cancelled"], true);
    assert_eq!(value["runId"], "r1");
    assert_eq!(value["durationMs"], 12);

    // Old persisted/serialized summaries without the flag still deserialize.
    let legacy = serde_json::json!({
        "runId": "r0",
        "framework": "vitest",
        "total": 0,
        "passed": 0,
        "failed": 0,
        "skipped": 0,
        "durationMs": 1,
        "results": [],
        "startedAt": "2026-08-07T00:00:00Z",
        "finishedAt": null
    });
    let parsed: TestRunSummary = serde_json::from_value(legacy).expect("deserialize legacy");
    assert!(!parsed.cancelled);
}
