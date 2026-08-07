/**
 * Pure state transitions for the shared current-run state.
 *
 * Extracted from TestService so the run lifecycle (started → completed /
 * cancelled, stale-run guards, stop targeting) is unit-testable without
 * Tauri or the Jotai store.
 */
import type { TestEvent, TestRunState } from "@src/types/testing";

/**
 * Next current-run state after a backend test event.
 *
 * Terminal events (`run_finished` / `run_cancelled`) only apply to the run
 * currently being tracked: with parallel runs, a stale run finishing must
 * not clobber the state of the run the UI is following.
 */
export function nextRunState(
  current: TestRunState | null,
  event: TestEvent
): TestRunState | null {
  switch (event.type) {
    case "run_started":
      return { runId: event.runId, status: "running", progress: 0 };

    case "run_finished": {
      if (current && current.runId !== event.summary.runId) {
        return current;
      }
      return {
        runId: event.summary.runId,
        status: "completed",
        progress: 100,
      };
    }

    case "run_cancelled": {
      if (current && current.runId !== event.runId) {
        return current;
      }
      return {
        runId: event.runId,
        status: "cancelled",
        progress: current?.progress ?? 0,
      };
    }

    default:
      return current;
  }
}

/**
 * The run a stop request should target, or null when there is nothing
 * running — stopping an idle or already-terminal run is a no-op, not an
 * error.
 */
export function stopTargetRunId(current: TestRunState | null): string | null {
  return current && current.status === "running" ? current.runId : null;
}
