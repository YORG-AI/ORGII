import { describe, expect, it } from "vitest";

import type { TestEvent, TestRunState, TestRunSummary } from "@src/types/testing";

import { nextRunState, stopTargetRunId } from "../testRunLifecycle";

function createRunState(overrides?: Partial<TestRunState>): TestRunState {
  return { runId: "run-1", status: "running", progress: 0, ...overrides };
}

function createSummary(overrides?: Partial<TestRunSummary>): TestRunSummary {
  return {
    runId: "run-1",
    framework: "vitest",
    total: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    durationMs: 10,
    results: [],
    startedAt: "2026-08-07T00:00:00Z",
    ...overrides,
  };
}

describe("nextRunState", () => {
  it("starts tracking a run on run_started", () => {
    const next = nextRunState(null, {
      type: "run_started",
      runId: "run-1",
      totalTests: 3,
    });
    expect(next).toEqual({ runId: "run-1", status: "running", progress: 0 });
  });

  it("a newly started run supersedes the tracked one", () => {
    const next = nextRunState(createRunState(), {
      type: "run_started",
      runId: "run-2",
      totalTests: 0,
    });
    expect(next).toEqual({ runId: "run-2", status: "running", progress: 0 });
  });

  it("completes the tracked run on run_finished", () => {
    const next = nextRunState(createRunState(), {
      type: "run_finished",
      summary: createSummary(),
    });
    expect(next).toEqual({ runId: "run-1", status: "completed", progress: 100 });
  });

  it("ignores run_finished from a stale parallel run", () => {
    const current = createRunState({ runId: "run-2" });
    const next = nextRunState(current, {
      type: "run_finished",
      summary: createSummary({ runId: "run-1" }),
    });
    expect(next).toBe(current);
  });

  it("marks the tracked run cancelled on run_cancelled", () => {
    const next = nextRunState(createRunState({ progress: 40 }), {
      type: "run_cancelled",
      runId: "run-1",
    });
    expect(next).toEqual({ runId: "run-1", status: "cancelled", progress: 40 });
  });

  it("ignores run_cancelled from a stale parallel run", () => {
    const current = createRunState({ runId: "run-2" });
    const next = nextRunState(current, {
      type: "run_cancelled",
      runId: "run-1",
    });
    expect(next).toBe(current);
  });

  it("applies terminal events even when no run is tracked", () => {
    expect(
      nextRunState(null, { type: "run_finished", summary: createSummary() })
    ).toEqual({ runId: "run-1", status: "completed", progress: 100 });
    expect(
      nextRunState(null, { type: "run_cancelled", runId: "run-1" })
    ).toEqual({ runId: "run-1", status: "cancelled", progress: 0 });
  });

  it("leaves run state untouched for per-test and error events", () => {
    const current = createRunState();
    const events: TestEvent[] = [
      { type: "test_started", testId: "t1", name: "adds" },
      {
        type: "test_finished",
        result: { testId: "t1", status: "passed" },
      },
      { type: "error", message: "boom" },
    ];
    for (const event of events) {
      expect(nextRunState(current, event)).toBe(current);
    }
  });
});

describe("stopTargetRunId", () => {
  it("targets the tracked running run", () => {
    expect(stopTargetRunId(createRunState())).toBe("run-1");
  });

  it("returns null when nothing is tracked", () => {
    expect(stopTargetRunId(null)).toBeNull();
  });

  it("returns null for already-terminal runs", () => {
    expect(stopTargetRunId(createRunState({ status: "completed" }))).toBeNull();
    expect(stopTargetRunId(createRunState({ status: "cancelled" }))).toBeNull();
  });
});
