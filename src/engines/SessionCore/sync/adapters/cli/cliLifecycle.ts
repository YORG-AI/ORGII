import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import { confirmTurnRunning } from "@src/engines/SessionCore/control/turnLifecycle";
import { loadSessionAtom } from "@src/engines/SessionCore/core/atoms";
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

import { isNativeTranscriptSession } from "../../nativeTranscriptReconcile";
import { loadCliHistory } from "./cliHistory";

const log = createLogger("CliAdapter");

export type CliStatusResponse = {
  status?: CliSessionStatus;
  updatedAt?: string;
};

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
  previousStatus: CliStatusResponse | null
): Promise<CliStatusResponse | null> {
  const deadline = Date.now() + 15_000;
  const previousUpdatedAt = previousStatus?.updatedAt;
  const previousWasTerminal = isCliTerminalStatus(previousStatus?.status);
  let lastStatus: CliStatusResponse | null = null;
  while (Date.now() < deadline) {
    lastStatus = await readCliStatus(sessionId);
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

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
  timeoutMs = 90_000
): Promise<CliStatusResponse | null> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: CliStatusResponse | null = null;
  while (Date.now() < deadline) {
    lastStatus = await readCliStatus(sessionId);
    const hasNewStatus =
      !previousUpdatedAt || lastStatus?.updatedAt !== previousUpdatedAt;
    if (hasNewStatus && isCliTerminalStatus(lastStatus?.status)) {
      return lastStatus;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return lastStatus;
}

async function refreshLoadedCliHistory(
  sessionId: string
): Promise<SessionEvent[]> {
  if (!isStoreInitialized()) return [];
  const events = await loadCliHistory(sessionId, new AbortController().signal);
  if (events.length === 0) return events;
  // Native-transcript sessions render the live turn from in-memory events
  // only. The replay is read here purely to observe persistence for the send
  // handshake; terminal reconcile remains the single on-screen replacement.
  if (!isNativeTranscriptSession(sessionId)) {
    await eventStoreProxy.mergeEvents(events, sessionId);
    getInstrumentedStore().set(loadSessionAtom, { sessionId, events });
  }
  return events;
}

function eventContainsText(event: SessionEvent, text: string): boolean {
  return JSON.stringify(event).includes(text);
}

export async function waitForPersistedCliUserEvent(
  sessionId: string,
  content: string
): Promise<SessionEvent[]> {
  const deadline = Date.now() + 15_000;
  let lastEventCount = 0;
  while (Date.now() < deadline) {
    const events = await refreshLoadedCliHistory(sessionId);
    lastEventCount = events.length;
    if (events.some((event) => eventContainsText(event, content))) {
      return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
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
