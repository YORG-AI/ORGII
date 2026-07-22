import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import { confirmTurnRunning } from "@src/engines/SessionCore/control/turnLifecycle";
import { isTurnBlockingRuntimeEvent } from "@src/engines/SessionCore/core/runningEventGate";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { createLogger } from "@src/hooks/logger";
import { setSessionRuntimeStatusAtom } from "@src/store/session/cliSessionStatusAtom";
import type { CliSessionStatus } from "@src/types/session/session";
import {
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";

import {
  getActiveExternalReplayLease,
  pollExternalReplaySession,
} from "../../externalReplayTransport";

const log = createLogger("CliAdapter");

export type CliStatusResponse = {
  status?: CliSessionStatus;
  updatedAt?: string;
};

export interface CliPollingWaitOptions {
  signal?: AbortSignal;
  /** Exact visible replay-episode guard; prevents A→B→A reuse. */
  isSessionActive?: () => boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

function isPollingCancelled(options: CliPollingWaitOptions): boolean {
  return Boolean(
    options.signal?.aborted || options.isSessionActive?.() === false
  );
}

function waitForPollingDelay(
  delayMs: number,
  options: CliPollingWaitOptions
): Promise<boolean> {
  if (isPollingCancelled(options)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = (): void => finish(false);
    const timer = setTimeout(
      () => finish(!isPollingCancelled(options)),
      delayMs
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const CLI_TERMINAL_STATUSES = new Set<CliSessionStatus>([
  "completed",
  "failed",
  "error",
  "cancelled",
  "abandoned",
  "timeout",
  "archived",
]);

export const protectedRunningTurnBySession = new Map<
  string,
  { content: string; startedAt: number }
>();

export function isCliTerminalStatus(
  status: CliSessionStatus | undefined
): status is CliSessionStatus {
  return status !== undefined && CLI_TERMINAL_STATUSES.has(status);
}

export async function readCliStatus(
  sessionId: string
): Promise<CliStatusResponse | null> {
  return (await tauriInvoke("cli_agent_status", {
    sessionId,
  })) as CliStatusResponse | null;
}

export async function waitForCliRunBoundary(
  sessionId: string,
  previousStatus: CliStatusResponse | null,
  options: CliPollingWaitOptions = {}
): Promise<CliStatusResponse | null> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const previousUpdatedAt = previousStatus?.updatedAt;
  const previousWasTerminal = isCliTerminalStatus(previousStatus?.status);
  let lastStatus: CliStatusResponse | null = null;
  while (Date.now() < deadline && !isPollingCancelled(options)) {
    lastStatus = await readCliStatus(sessionId);
    if (isPollingCancelled(options)) return lastStatus;
    const hasNewStatus =
      !previousUpdatedAt || lastStatus?.updatedAt !== previousUpdatedAt;
    const hasDurableBoundary =
      Boolean(previousUpdatedAt) && lastStatus?.updatedAt !== previousUpdatedAt;
    if (lastStatus?.status === "running" && hasNewStatus) {
      return lastStatus;
    }
    if (
      isCliTerminalStatus(lastStatus?.status) &&
      (hasDurableBoundary || !previousWasTerminal)
    ) {
      return lastStatus;
    }
    if (!(await waitForPollingDelay(pollIntervalMs, options))) {
      return lastStatus;
    }
  }

  if (isPollingCancelled(options)) return lastStatus;

  throw new Error(
    `CLI run boundary was not observed for ${sessionId}; lastStatus=${JSON.stringify(lastStatus)}`
  );
}

async function closeObservedCliTerminalEvents(
  sessionId: string,
  status: CliSessionStatus
): Promise<void> {
  const events = await eventStoreProxy.getEvents(sessionId);
  const closableEvents = events.filter((event) => {
    if (event.sessionId && event.sessionId !== sessionId) return false;
    return isTurnBlockingRuntimeEvent(event);
  });
  if (closableEvents.length === 0) return;
  const displayStatus =
    status === "failed" || status === "error" ? "failed" : "completed";
  await Promise.all(
    closableEvents.map((event) =>
      eventStoreProxy.upsert(
        {
          ...event,
          displayStatus,
          activityStatus: "processed",
          result: { ...event.result, status: displayStatus },
          isDelta: false,
        },
        sessionId
      )
    )
  );
}

export function markCliRuntimeRunning(sessionId: string): void {
  // FSM running ack is visibility-independent: the dispatch reserved the
  // turn, so promote it to "working" even for background sessions.
  confirmTurnRunning(sessionId);
  if (!isStoreInitialized()) return;
  const store = getInstrumentedStore();
  store.set(setSessionRuntimeStatusAtom, {
    sessionId,
    status: "running",
    source: "sync",
  });
}

export function isProtectedCliTurnTerminal(
  sessionId: string,
  status: CliSessionStatus | undefined
): boolean {
  return (
    isCliTerminalStatus(status) && protectedRunningTurnBySession.has(sessionId)
  );
}

export function markObservedCliTerminalStatus(
  sessionId: string,
  status: CliSessionStatus | undefined
): void {
  if (!isCliTerminalStatus(status) || !isStoreInitialized()) return;
  if (isProtectedCliTurnTerminal(sessionId, status)) return;
  const store = getInstrumentedStore();
  store.set(setSessionRuntimeStatusAtom, { sessionId, status, source: "sync" });
  void closeObservedCliTerminalEvents(sessionId, status).catch((error) => {
    log.warn("[cliAdapter] failed to close terminal CLI events:", error);
  });
}

export async function waitForCliTerminalBoundary(
  sessionId: string,
  previousUpdatedAt: string | null | undefined,
  options: CliPollingWaitOptions = {}
): Promise<CliStatusResponse | null> {
  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  let lastStatus: CliStatusResponse | null = null;
  while (Date.now() < deadline && !isPollingCancelled(options)) {
    lastStatus = await readCliStatus(sessionId);
    if (isPollingCancelled(options)) return lastStatus;
    const hasNewStatus =
      !previousUpdatedAt || lastStatus?.updatedAt !== previousUpdatedAt;
    if (hasNewStatus && isCliTerminalStatus(lastStatus?.status)) {
      return lastStatus;
    }
    if (!(await waitForPollingDelay(pollIntervalMs, options))) {
      return lastStatus;
    }
  }
  return lastStatus;
}

async function refreshLoadedCliHistory(
  sessionId: string
): Promise<SessionEvent[]> {
  if (!isStoreInitialized()) return [];
  const lease = getActiveExternalReplayLease(sessionId);
  if (!lease) return [];
  const delta = await pollExternalReplaySession(lease);
  if (delta?.events.length) return delta.events;
  // A focus/watcher refresh may have consumed the same source delta first.
  // The active EventStore is itself bounded, so this does not rematerialize
  // the source transcript or cross the Rust → JS → Rust ingestion path.
  return eventStoreProxy.getEvents(sessionId);
}

function eventContainsText(event: SessionEvent, text: string): boolean {
  return JSON.stringify(event).includes(text);
}

export async function waitForPersistedCliUserEvent(
  sessionId: string,
  content: string,
  options: CliPollingWaitOptions = {}
): Promise<SessionEvent[]> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  let lastEventCount = 0;
  let lastEvents: SessionEvent[] = [];
  while (Date.now() < deadline && !isPollingCancelled(options)) {
    const events = await refreshLoadedCliHistory(sessionId);
    lastEvents = events;
    if (isPollingCancelled(options)) return lastEvents;
    lastEventCount = events.length;
    if (events.some((event) => eventContainsText(event, content))) {
      return events;
    }
    if (!(await waitForPollingDelay(pollIntervalMs, options))) {
      return lastEvents;
    }
  }
  if (isPollingCancelled(options)) return lastEvents;
  throw new Error(
    `CLI user event was not persisted for ${sessionId}; eventCount=${lastEventCount}`
  );
}

export function hasRuntimeOutputAfterUserEvent(
  events: SessionEvent[],
  content: string
): boolean {
  let userIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.source === "user" && eventContainsText(event, content)) {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return false;
  return events.slice(userIndex + 1).some((event) => event.source !== "user");
}
