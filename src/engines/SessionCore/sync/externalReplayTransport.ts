import {
  type ExternalReplayCursor,
  type ExternalReplayDelta,
  type ExternalReplayLimits,
  type ExternalReplayWindow,
  externalReplayOpenWindow,
  externalReplayPollDelta,
  externalReplayReadWindow,
  externalReplayRelease,
  resolveExternalReplayTarget,
} from "@src/api/tauri/externalHistory/replay";
import { createLogger } from "@src/hooks/logger";

import { deactivateExternalReplayTurnState } from "./externalReplayTurnState";

const log = createLogger("externalReplayTransport");
const DEFAULT_WINDOW_LIMITS: Required<ExternalReplayLimits> = {
  maxTurns: 10,
  maxEvents: 200,
  maxIpcBytes: 4 * 1024 * 1024,
};
const DEFAULT_OPEN_WINDOW_LIMITS: Required<ExternalReplayLimits> = {
  ...DEFAULT_WINDOW_LIMITS,
  // Rust's public open default intentionally loads only the latest turn.
  // A wire-budget retry must shrink that request, never widen it to the
  // generic ten-turn read ceiling.
  maxTurns: 1,
};

declare global {
  interface Window {
    __orgiiE2EReplayBudgetRetries?: number;
    __orgiiE2EReplayWindows?: Array<{
      operation: "open" | "read";
      episodeId: number;
      generation: string;
      revision: number;
      throughSequence: number;
      eventCount: number;
      userEventCount: number;
      turnCount: number;
      turnIndices: number[];
      ipcBytes: number;
      windowStartSequence: number | null;
      hasOlder: boolean;
      maxEvents: number | null;
      selection: ExternalReplayReadSelection | null;
    }>;
    __orgiiE2ELastReplayRead?: {
      eventIds: string[];
      userEventIds: string[];
      maxEvents: number | null;
      selection: ExternalReplayReadSelection;
    };
  }
}

function recordE2EReplayWindow(
  operation: "open" | "read",
  lease: ExternalReplaySessionLease,
  replayWindow: ExternalReplayWindow,
  selection: ExternalReplayReadSelection | null,
  maxEvents: number | null
): void {
  if (
    process.env.NODE_ENV === "production" ||
    typeof globalThis.window === "undefined"
  ) {
    return;
  }
  const records = globalThis.window.__orgiiE2EReplayWindows ?? [];
  records.push({
    operation,
    episodeId: lease.episodeId,
    generation: replayWindow.cursor.generation,
    revision: replayWindow.cursor.revision,
    throughSequence: replayWindow.cursor.throughSequence,
    eventCount: replayWindow.events.length,
    userEventCount: replayWindow.events.filter(
      (event) => event.source === "user"
    ).length,
    turnCount: replayWindow.turnHeaders.length,
    turnIndices: replayWindow.turnHeaders.map((header) => header.turnIndex),
    ipcBytes: replayWindow.stats.ipcBytes,
    windowStartSequence: replayWindow.windowStartSequence,
    hasOlder: replayWindow.hasOlder,
    maxEvents,
    selection,
  });
  globalThis.window.__orgiiE2EReplayWindows = records.slice(-64);
}

function recordE2EReplayBudgetRetry(): void {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") {
    return;
  }
  window.__orgiiE2EReplayBudgetRetries =
    (window.__orgiiE2EReplayBudgetRetries ?? 0) + 1;
}

function recordE2EReplayRead(
  window: ExternalReplayWindow,
  selection: ExternalReplayReadSelection,
  maxEvents: number | null
): void {
  if (
    process.env.NODE_ENV === "production" ||
    typeof globalThis.window === "undefined"
  ) {
    return;
  }
  globalThis.window.__orgiiE2ELastReplayRead = {
    eventIds: window.events.map((event) => event.id),
    userEventIds: window.events
      .filter((event) => event.source === "user")
      .map((event) => event.id),
    maxEvents,
    selection,
  };
}

export interface ExternalReplaySessionLease {
  readonly sessionId: string;
  readonly episodeId: number;
  /** Aborted exactly when this visible replay episode is superseded/released. */
  readonly signal: AbortSignal;
}

interface ActiveReplaySession {
  lease: ExternalReplaySessionLease;
  controller: AbortController;
  cursor: ExternalReplayCursor | null;
  watcherAvailable: boolean;
  openInFlight: Promise<ExternalReplayWindow> | null;
  pollInFlight: Promise<ExternalReplayDelta> | null;
  /** Serialized foreground older-page reads; Rust request tokens are exclusive. */
  readTail: Promise<void> | null;
  /** Largest event slice that fit this source's normalized 4 MiB wire budget. */
  readMaxEvents: number;
}

// Monotonic across ordinary renderer reloads as well as A→B→A switches.
// The backend compares this episode id before accepting delayed open/release
// commands, so an old cleanup cannot tear down a newly opened watcher.
let nextReplayEpisodeId = Date.now() * 1_000;
let activeReplaySession: ActiveReplaySession | null = null;

function releaseBackendEpisode(lease: ExternalReplaySessionLease): void {
  void externalReplayRelease(lease.sessionId, lease.episodeId).catch(
    (error) => {
      log.warn("Failed to release external replay foreground lease", error);
    }
  );
}

function isCurrentLease(lease: ExternalReplaySessionLease): boolean {
  return (
    activeReplaySession?.lease.sessionId === lease.sessionId &&
    activeReplaySession.lease.episodeId === lease.episodeId
  );
}

function isShellManifestSnapshotRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Shell replay changed while publishing manifests") &&
    message.includes("retry the bounded replay request")
  );
}

function isNormalizedWindowBudgetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Bounded replay window requires") &&
    message.includes("serialized bytes after normalization")
  );
}

async function retryNormalizedWindowBudget(
  operation: (limits?: ExternalReplayLimits) => Promise<ExternalReplayWindow>,
  requestedLimits?: ExternalReplayLimits,
  defaultLimits: Required<ExternalReplayLimits> = DEFAULT_WINDOW_LIMITS,
  onRetryLimit?: (maxEvents: number) => void
): Promise<ExternalReplayWindow> {
  let limits = requestedLimits;
  for (;;) {
    try {
      return await operation(limits);
    } catch (error) {
      if (!isNormalizedWindowBudgetError(error)) throw error;
      recordE2EReplayBudgetRetry();
      const current = {
        ...defaultLimits,
        ...limits,
      };
      if (current.maxEvents <= 1) throw error;
      const nextMaxEvents = Math.max(1, Math.floor(current.maxEvents / 2));
      limits = {
        ...current,
        maxEvents: nextMaxEvents,
      };
      onRetryLimit?.(nextMaxEvents);
      log.warn(
        "Normalized replay window exceeded its wire budget; retrying a smaller event slice",
        {
          previousMaxEvents: current.maxEvents,
          nextMaxEvents,
        }
      );
    }
  }
}

async function retryShellManifestSnapshotRace<T>(
  lease: ExternalReplaySessionLease,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      !isShellManifestSnapshotRace(error) ||
      !isCurrentLease(lease) ||
      signal?.aborted
    ) {
      throw error;
    }
    // Snapshot validation deliberately fails closed if the provider advances
    // while a Shell manifest is materialized. One fresh bounded request reads
    // the newly published replay revision; a second failure remains visible.
    return operation();
  }
}

/** Begin a new visible replay episode. Every switch/reload gets a new episode id. */
export function activateExternalReplaySession(
  sessionId: string
): ExternalReplaySessionLease {
  if (!resolveExternalReplayTarget(sessionId)) {
    throw new Error(`Cannot activate bounded replay for ${sessionId}`);
  }
  if (activeReplaySession) {
    activeReplaySession.controller.abort();
    releaseBackendEpisode(activeReplaySession.lease);
    deactivateExternalReplayTurnState(activeReplaySession.lease.sessionId);
  }
  const controller = new AbortController();
  const lease = Object.freeze({
    sessionId,
    episodeId: ++nextReplayEpisodeId,
    signal: controller.signal,
  });
  activeReplaySession = {
    lease,
    controller,
    cursor: null,
    watcherAvailable: false,
    openInFlight: null,
    pollInFlight: null,
    readTail: null,
    readMaxEvents: DEFAULT_WINDOW_LIMITS.maxEvents,
  };
  return lease;
}

/** Invalidate all late completions owned by this visible replay episode. */
export function deactivateExternalReplaySession(
  lease: ExternalReplaySessionLease
): void {
  if (!isCurrentLease(lease)) return;
  activeReplaySession?.controller.abort();
  activeReplaySession = null;
  nextReplayEpisodeId += 1;
  deactivateExternalReplayTurnState(lease.sessionId);
  releaseBackendEpisode(lease);
}

export function getActiveExternalReplayLease(
  sessionId: string
): ExternalReplaySessionLease | null {
  return activeReplaySession?.lease.sessionId === sessionId
    ? activeReplaySession.lease
    : null;
}

export async function openExternalReplaySession(
  lease: ExternalReplaySessionLease,
  signal?: AbortSignal
): Promise<ExternalReplayWindow | null> {
  if (!isCurrentLease(lease) || signal?.aborted) return null;
  const state = activeReplaySession;
  if (!state) return null;

  const request =
    state.openInFlight ??
    retryShellManifestSnapshotRace(lease, signal, () =>
      retryNormalizedWindowBudget(
        (limits) =>
          externalReplayOpenWindow(lease.sessionId, lease.episodeId, limits),
        undefined,
        DEFAULT_OPEN_WINDOW_LIMITS
      )
    );
  state.openInFlight = request;
  try {
    const window = await request;
    if (!isCurrentLease(lease) || signal?.aborted) return null;
    activeReplaySession!.cursor = window.cursor;
    activeReplaySession!.watcherAvailable = window.watcherAvailable;
    recordE2EReplayWindow("open", lease, window, null, null);
    return window;
  } finally {
    if (
      isCurrentLease(lease) &&
      activeReplaySession?.openInFlight === request
    ) {
      activeReplaySession.openInFlight = null;
    }
  }
}

/**
 * Poll one true source delta. Concurrent timer/focus/watcher triggers share
 * one request; late A→B→A completions cannot advance the new episode cursor.
 */
export async function pollExternalReplaySession(
  lease: ExternalReplaySessionLease,
  signal?: AbortSignal
): Promise<ExternalReplayDelta | null> {
  if (!isCurrentLease(lease) || signal?.aborted) return null;
  const state = activeReplaySession;
  if (!state?.cursor || state.openInFlight || state.readTail) return null;

  const cursor = state.cursor;
  const request =
    state.pollInFlight ??
    retryShellManifestSnapshotRace(lease, signal, () =>
      externalReplayPollDelta(lease.sessionId, lease.episodeId, cursor)
    );
  state.pollInFlight = request;
  try {
    const delta = await request;
    if (!isCurrentLease(lease) || signal?.aborted) return null;
    activeReplaySession!.cursor = delta.cursor;
    activeReplaySession!.watcherAvailable = delta.watcherAvailable;
    return delta;
  } finally {
    if (
      isCurrentLease(lease) &&
      activeReplaySession?.pollInFlight === request
    ) {
      activeReplaySession.pollInFlight = null;
    }
  }
}

type ExternalReplayReadSelection = Omit<
  Parameters<typeof externalReplayReadWindow>[0],
  "sessionId" | "episodeId"
>;

/**
 * Read one foreground older page without racing Rust's exclusive request
 * episode. Different older pages queue behind each other, and a read that
 * arrives during a poll waits for that poll before it enters the backend.
 * The page cursor intentionally does not replace the live poll cursor.
 */
export async function readExternalReplaySession(
  lease: ExternalReplaySessionLease,
  selection: ExternalReplayReadSelection,
  signal?: AbortSignal
): Promise<ExternalReplayWindow | null> {
  if (!isCurrentLease(lease) || signal?.aborted) return null;
  const state = activeReplaySession;
  if (!state) return null;

  const priorRead = state.readTail;
  const priorPoll = state.pollInFlight;
  const priorOpen = state.openInFlight;
  const request = (async () => {
    const blockers: Promise<unknown>[] = [];
    if (priorOpen) blockers.push(priorOpen);
    if (priorPoll) blockers.push(priorPoll);
    if (priorRead) blockers.push(priorRead);
    await Promise.allSettled(blockers);
    if (!isCurrentLease(lease) || signal?.aborted) return null;
    const currentReadMaxEvents =
      activeReplaySession?.readMaxEvents ?? DEFAULT_WINDOW_LIMITS.maxEvents;
    const effectiveSelection = selection.limits
      ? {
          ...selection,
          limits: {
            ...selection.limits,
            maxEvents: Math.min(
              selection.limits.maxEvents ?? DEFAULT_WINDOW_LIMITS.maxEvents,
              currentReadMaxEvents
            ),
          },
        }
      : selection;
    return retryShellManifestSnapshotRace(lease, signal, () =>
      retryNormalizedWindowBudget(
        (limits) =>
          externalReplayReadWindow({
            sessionId: lease.sessionId,
            episodeId: lease.episodeId,
            ...effectiveSelection,
            limits,
          }),
        effectiveSelection.limits,
        DEFAULT_WINDOW_LIMITS,
        (maxEvents) => {
          if (!isCurrentLease(lease) || !activeReplaySession) return;
          activeReplaySession.readMaxEvents = Math.min(
            activeReplaySession.readMaxEvents,
            maxEvents
          );
        }
      )
    );
  })();
  const tail = request.then(
    () => undefined,
    () => undefined
  );
  state.readTail = tail;

  try {
    const window = await request;
    if (!window || !isCurrentLease(lease) || signal?.aborted) return null;
    activeReplaySession!.watcherAvailable = window.watcherAvailable;
    recordE2EReplayWindow(
      "read",
      lease,
      window,
      selection,
      activeReplaySession?.readMaxEvents ?? null
    );
    recordE2EReplayRead(
      window,
      selection,
      activeReplaySession?.readMaxEvents ?? null
    );
    return window;
  } finally {
    if (isCurrentLease(lease) && activeReplaySession?.readTail === tail) {
      activeReplaySession.readTail = null;
    }
  }
}

export function getExternalReplayWatcherAvailable(
  lease: ExternalReplaySessionLease
): boolean {
  return isCurrentLease(lease)
    ? (activeReplaySession?.watcherAvailable ?? false)
    : false;
}

/** Test-only observability without exposing mutable coordinator state. */
export function getExternalReplayCursorForTest(
  lease: ExternalReplaySessionLease
): ExternalReplayCursor | null {
  return isCurrentLease(lease) ? (activeReplaySession?.cursor ?? null) : null;
}

/** Read-only E2E diagnostics for the active bounded-replay coordinator. */
export function getExternalReplayDebugStateForTest(): {
  sessionId: string;
  episodeId: number;
  generation: string | null;
  revision: number | null;
  throughSequence: number | null;
  watcherAvailable: boolean;
  openInFlight: boolean;
  pollInFlight: boolean;
  readInFlight: boolean;
  readMaxEvents: number;
} | null {
  const state = activeReplaySession;
  if (!state) return null;
  return {
    sessionId: state.lease.sessionId,
    episodeId: state.lease.episodeId,
    generation: state.cursor?.generation ?? null,
    revision: state.cursor?.revision ?? null,
    throughSequence: state.cursor?.throughSequence ?? null,
    watcherAvailable: state.watcherAvailable,
    openInFlight: state.openInFlight !== null,
    pollInFlight: state.pollInFlight !== null,
    readInFlight: state.readTail !== null,
    readMaxEvents: state.readMaxEvents,
  };
}
