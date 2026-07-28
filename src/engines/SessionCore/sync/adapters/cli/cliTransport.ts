import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import { enterAgentOrgSessionIntervention } from "@src/api/tauri/agent";
import type { CancelReason } from "@src/api/tauri/agent/session";
import {
  getTurnGeneration,
  markTurnTerminal,
  toTurnTerminalStatus,
} from "@src/engines/SessionCore/control/turnLifecycle";

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
  const previousStatus = await readCliStatus(sessionId);
  protectedRunningTurnBySession.set(sessionId, {
    content,
    startedAt: Date.now(),
  });
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
    protectedRunningTurnBySession.delete(sessionId);
    throw error;
  }
  const acceptedStatus = await waitForCliRunBoundary(sessionId, previousStatus);
  markCliRuntimeRunning(sessionId);
  // Capture this dispatch's generation so a late terminal can never close a
  // newer turn.
  const dispatchGeneration = getTurnGeneration(sessionId);
  const persistedEvents = await waitForPersistedCliUserEvent(
    sessionId,
    content
  );
  const acceptedTerminalIsCurrentTurn =
    isCliTerminalStatus(acceptedStatus?.status) &&
    hasRuntimeOutputAfterUserEvent(persistedEvents, content);
  if (acceptedTerminalIsCurrentTurn) {
    protectedRunningTurnBySession.delete(sessionId);
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
    acceptedStatus?.updatedAt ?? previousStatus?.updatedAt
  ).then((terminalStatus) => {
    if (!isCliTerminalStatus(terminalStatus?.status)) return;
    protectedRunningTurnBySession.delete(sessionId);
    markObservedCliTerminalStatus(sessionId, terminalStatus.status);
    markTurnTerminal(sessionId, toTurnTerminalStatus(terminalStatus.status), {
      generation: dispatchGeneration,
    });
  });
}

export async function stopCliSession(
  sessionId: string,
  reason: CancelReason
): Promise<void> {
  await tauriInvoke("cli_agent_cancel", { sessionId, reason });
}
