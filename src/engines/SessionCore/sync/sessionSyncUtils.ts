/**
 * sessionSyncUtils
 *
 * Pure utility functions and constants for useSessionSync.
 * Extracted to keep useSessionSync.ts under the 600-line limit.
 *
 * All functions here are pure or depend only on stable external APIs
 * (no React hooks, no atoms).
 */
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import {
  loadEvents,
  loadInitialTurnWindow,
} from "@src/engines/SessionCore/storage/cacheAdapter";
import { createLogger } from "@src/hooks/logger";
import type { CliSessionStatus } from "@src/types/session/session";
import { isCollaborationImportedSession } from "@src/util/session/sessionDispatch";

import type { SessionAdapter } from "./types";

const logger = createLogger("SessionSync");

// ── Constants ────────────────────────────────────────────────────────────────

// Mirror of `CliSessionStatus`. Must stay aligned with the Rust
// `SessionStatus` enum in `agent_core/core/session/types/enums.rs` — any
// value emitted by the backend but missing here falls back to `"idle"`,
// which incorrectly resurrects terminal sessions and blocks chat
// rendering.
export const CLI_SESSION_STATUSES = new Set<string>([
  "idle",
  "running",
  "installing",
  "pending",
  "paused",
  "completed",
  "failed",
  "error",
  "cancelled",
  "abandoned",
  "timeout",
  "archived",
  "waiting_for_user",
  "waiting_for_funds",
]);

/** Retry delays for reconciling in-flight history after a session switch. */
export const IN_FLIGHT_HISTORY_RECONCILE_DELAYS_MS = [
  0, 1_500, 3_000, 6_000, 12_000, 24_000, 48_000,
];

/**
 * Cadence of the background EventStore → disk-cache sync. Keeping the cache
 * fresh lets a switch-back to this session be an instant cache hit instead
 * of a SQLite round-trip. 30s is a balance: short enough that a crash loses
 * little, long enough that the write does not churn during heavy streaming.
 */
export const EVENT_STORE_CACHE_SYNC_INTERVAL_MS = 30_000;

// ── Status narrowing helpers ─────────────────────────────────────────────────
// `runStatus` from PostLoadResult is typed as `string` (wire format). These
// guards validate the value before it is written into typed atoms so that an
// unexpected Rust-side value surfaces as a logged warning + idle fallback
// rather than silently corrupting derived atom state.

export function toCliSessionStatus(raw: string): CliSessionStatus {
  if (CLI_SESSION_STATUSES.has(raw)) return raw as CliSessionStatus;
  logger.warn("Unknown runStatus value:", raw, "— falling back to 'idle'");
  return "idle";
}

export function isInFlightRunStatus(status: string | undefined): boolean {
  return (
    status === "running" ||
    status === "waiting_for_user" ||
    status === "waiting_for_funds"
  );
}

export function isTerminalRunStatus(status: string | undefined): boolean {
  // Mirror of `SessionStatus::is_terminal()` in
  // `agent_core/core/session/types/enums.rs`. Missing a terminal value here
  // causes the in-flight history reconcile loop to keep retrying for a
  // session that will never produce new events (e.g. `abandoned`
  // recovery-swept rows), which blocks the chat from settling.
  return (
    status === "completed" ||
    status === "failed" ||
    status === "error" ||
    status === "cancelled" ||
    status === "abandoned" ||
    status === "timeout" ||
    status === "archived"
  );
}

// ── Async helpers ────────────────────────────────────────────────────────────

export function waitForReconcileDelay(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

export async function loadOwnSessionInitialEvents(
  sessionId: string
): Promise<SessionEvent[]> {
  const window = await loadInitialTurnWindow(
    sessionId,
    isCollaborationImportedSession(sessionId) ? 0 : undefined
  );
  if (window.turns.length === 0) {
    return loadEvents(sessionId);
  }
  return window.events;
}

export async function loadPersistedHistory(
  adapter: SessionAdapter,
  sessionId: string,
  signal: AbortSignal
): Promise<SessionEvent[]> {
  if (adapter.category === "agent") {
    const events = await loadOwnSessionInitialEvents(sessionId);
    if (events.length > 0 || signal.aborted) {
      return events;
    }
    return adapter.loadHistory(sessionId, signal);
  }
  return adapter.loadHistory(sessionId, signal);
}

export async function hydrateSessionStoreBeforeDisplay(
  sessionId: string,
  events: SessionEvent[],
  mode: "replace" | "merge" = "replace"
): Promise<void> {
  if (events.length === 0) return;
  if (mode === "replace") {
    await eventStoreProxy.set(events, sessionId);
    return;
  }
  await eventStoreProxy.mergeEvents(events, sessionId);
}
