import {
  type ExternalReplayCursor,
  type ExternalReplayDelta,
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

export interface ExternalReplaySessionLease {
  readonly sessionId: string;
  readonly epoch: number;
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
  /** Serialized foreground older-page reads; Rust request epochs are exclusive. */
  readTail: Promise<void> | null;
}

// Monotonic across ordinary renderer reloads as well as A→B→A switches.
// The backend compares this episode id before accepting delayed open/release
// commands, so an old cleanup cannot tear down a newly opened watcher.
let nextReplayEpoch = Date.now() * 1_000;
let activeReplaySession: ActiveReplaySession | null = null;

function releaseBackendEpisode(lease: ExternalReplaySessionLease): void {
  void externalReplayRelease(lease.sessionId, lease.epoch).catch((error) => {
    log.warn("Failed to release external replay foreground lease", error);
  });
}

function isCurrentLease(lease: ExternalReplaySessionLease): boolean {
  return (
    activeReplaySession?.lease.sessionId === lease.sessionId &&
    activeReplaySession.lease.epoch === lease.epoch
  );
}

/** Begin a new visible replay episode. Every switch/reload gets a new epoch. */
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
    epoch: ++nextReplayEpoch,
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
  nextReplayEpoch += 1;
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
    externalReplayOpenWindow(lease.sessionId, lease.epoch);
  state.openInFlight = request;
  try {
    const window = await request;
    if (!isCurrentLease(lease) || signal?.aborted) return null;
    activeReplaySession!.cursor = window.cursor;
    activeReplaySession!.watcherAvailable = window.watcherAvailable;
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
    externalReplayPollDelta(lease.sessionId, lease.epoch, cursor);
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
 * epoch. Different older pages queue behind each other, and a read that
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
    return externalReplayReadWindow({
      sessionId: lease.sessionId,
      episodeId: lease.epoch,
      ...selection,
    });
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
