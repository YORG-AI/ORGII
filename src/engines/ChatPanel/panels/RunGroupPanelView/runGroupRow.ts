/**
 * Run-group row projection.
 *
 * Turns a stored group entry plus its live session record into everything one
 * row needs. Pure so the status mapping is testable without a store — and so
 * the panel stays a renderer.
 */
import {
  RUN_OUTCOME,
  type RunGroupEntry,
} from "@src/features/SessionCreator/multiRunner/runGroupContract";
import type { Session } from "@src/store/session";
import { toUnifiedStatus } from "@src/types/session/session";

/**
 * What the row shows as its state.
 *
 * Derived from the live session for launched runs — the stored group only
 * knows that a launch happened, never how the run ended. That is deliberate:
 * copying status into the group record would create a second source of truth
 * that goes stale the moment the session updates.
 */
export const RUN_ROW_STATE = {
  /** The session is alive: pending, running, or waiting on the user. */
  RUNNING: "running",
  /** The session finished successfully. */
  DONE: "done",
  /** The session errored out, or the launch itself threw. */
  FAILED: "failed",
  /** The user (or the app) stopped the session before it finished. */
  STOPPED: "stopped",
  /** Pre-flight refused the runner; no session was ever created. */
  SKIPPED: "skipped",
  /** Launched, but the session record has not reached the store yet. */
  PENDING: "pending",
} as const;

export type RunRowState = (typeof RUN_ROW_STATE)[keyof typeof RUN_ROW_STATE];

/**
 * Statuses that mean "ended because someone stopped it".
 *
 * `toUnifiedStatus` folds these into `failed`, which would report a run the
 * user deliberately stopped as a failure — worth distinguishing here, since a
 * stopped run is a normal outcome when one runner has clearly already won.
 */
const STOPPED_STATUSES: ReadonlySet<string> = new Set([
  "cancelled",
  "abandoned",
]);

export function resolveRunRowState(
  entry: RunGroupEntry,
  session: Session | undefined
): RunRowState {
  if (entry.outcome === RUN_OUTCOME.SKIPPED) return RUN_ROW_STATE.SKIPPED;
  if (entry.outcome === RUN_OUTCOME.FAILED) return RUN_ROW_STATE.FAILED;
  if (!session) return RUN_ROW_STATE.PENDING;
  if (STOPPED_STATUSES.has(session.status)) return RUN_ROW_STATE.STOPPED;

  switch (toUnifiedStatus(session.status)) {
    case "active":
      return RUN_ROW_STATE.RUNNING;
    case "completed":
      return RUN_ROW_STATE.DONE;
    case "failed":
      return RUN_ROW_STATE.FAILED;
  }
}

/** Only a live session can be stopped. */
export function canStopRun(state: RunRowState): boolean {
  return state === RUN_ROW_STATE.RUNNING;
}

/** A run that produced no usable session is the one worth retrying. */
export function canRetryRun(state: RunRowState): boolean {
  return state === RUN_ROW_STATE.FAILED || state === RUN_ROW_STATE.SKIPPED;
}

/** Elapsed wall-clock for a run, in whole seconds; `null` when unknowable. */
export function resolveRunElapsedSeconds(
  session: Session | undefined,
  nowMs: number
): number | null {
  if (!session) return null;
  const startedMs = Date.parse(session.created_at);
  if (Number.isNaN(startedMs)) return null;
  const endedMs = session.completed_at
    ? Date.parse(session.completed_at)
    : nowMs;
  const elapsedMs = (Number.isNaN(endedMs) ? nowMs : endedMs) - startedMs;
  return elapsedMs < 0 ? 0 : Math.floor(elapsedMs / 1000);
}

export function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
