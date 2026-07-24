import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import { enterAgentOrgSessionIntervention } from "@src/api/tauri/agent";
import type { CancelReason } from "@src/api/tauri/agent/session";
import {
  getTurnGeneration,
  markTurnTerminal,
  toTurnTerminalStatus,
} from "@src/engines/SessionCore/control/turnLifecycle";
import { getActiveExternalReplayLease } from "@src/engines/SessionCore/sync/externalReplayTransport";

import type { AdapterSendInput } from "../../types";
import {
  hasRuntimeOutputAfterUserEvent,
  isCliTerminalStatus,
  markCliRuntimeRunning,
  markObservedCliTerminalStatus,
  protectedRunningTurnBySession,
  readCliStatus,
  waitForCliRunBoundary,
  waitForCliTerminalBoundary,
  waitForPersistedCliUserEvent,
} from "./cliLifecycle";

export async function sendCliMessage(input: AdapterSendInput): Promise<void> {
  const {
    sessionId,
    content,
    model,
    accountId,
    mode,
    imageDataUrls,
    adeContext,
    isResume,
  } = input;
  if (!isResume && content.trim()) {
    await enterAgentOrgSessionIntervention(sessionId);
  }
  // Bind every status/history wait to the exact visible replay episode that
  // initiated this send. A stale A wait must not resume after A→B→A.
  const replayLease = getActiveExternalReplayLease(sessionId);
  const isSendEpisodeActive = (): boolean =>
    replayLease !== null &&
    !replayLease.signal.aborted &&
    getActiveExternalReplayLease(sessionId)?.episodeId ===
      replayLease.episodeId;
  const waitOptions = {
    signal: replayLease?.signal,
    isSessionActive: isSendEpisodeActive,
  };
  const previousStatus = await readCliStatus(sessionId);
  const protectedTurn = {
    content,
    startedAt: Date.now(),
  };
  const clearProtectedTurn = (): void => {
    if (protectedRunningTurnBySession.get(sessionId) === protectedTurn) {
      protectedRunningTurnBySession.delete(sessionId);
    }
  };
  protectedRunningTurnBySession.set(sessionId, protectedTurn);
  markCliRuntimeRunning(sessionId);
  try {
    await tauriInvoke("cli_agent_message", {
      sessionId,
      content,
      ...(model ? { model } : {}),
      ...(accountId ? { accountId } : {}),
      ...(mode ? { mode } : {}),
      ...(imageDataUrls && imageDataUrls.length > 0
        ? { images: imageDataUrls }
        : {}),
      ...(adeContext ? { ideContext: adeContext } : {}),
    });
  } catch (error) {
    clearProtectedTurn();
    throw error;
  }
  const acceptedStatus = await waitForCliRunBoundary(
    sessionId,
    previousStatus,
    waitOptions
  );
  if (!isSendEpisodeActive()) {
    clearProtectedTurn();
    return;
  }
  markCliRuntimeRunning(sessionId);
  // Capture this dispatch's generation so a late terminal can never close a
  // newer turn.
  const dispatchGeneration = getTurnGeneration(sessionId);
  const persistedEvents = await waitForPersistedCliUserEvent(
    sessionId,
    content,
    waitOptions
  );
  if (!isSendEpisodeActive()) {
    clearProtectedTurn();
    return;
  }
  const acceptedTerminalIsCurrentTurn =
    isCliTerminalStatus(acceptedStatus?.status) &&
    hasRuntimeOutputAfterUserEvent(persistedEvents, content);
  if (acceptedTerminalIsCurrentTurn) {
    clearProtectedTurn();
    markObservedCliTerminalStatus(sessionId, acceptedStatus.status);
    markTurnTerminal(
      sessionId,
      toTurnTerminalStatus(acceptedStatus?.status ?? "completed"),
      { generation: dispatchGeneration }
    );
    return;
  }

  void waitForCliTerminalBoundary(
    sessionId,
    acceptedStatus?.updatedAt ?? previousStatus?.updatedAt,
    waitOptions
  )
    .then((terminalStatus) => {
      if (!isSendEpisodeActive()) return;
      if (!isCliTerminalStatus(terminalStatus?.status)) return;
      markObservedCliTerminalStatus(sessionId, terminalStatus.status);
      markTurnTerminal(sessionId, toTurnTerminalStatus(terminalStatus.status), {
        generation: dispatchGeneration,
      });
    })
    .finally(() => {
      clearProtectedTurn();
    });
}

export async function stopCliSession(
  sessionId: string,
  reason: CancelReason
): Promise<void> {
  await tauriInvoke("cli_agent_cancel", { sessionId, reason });
}
