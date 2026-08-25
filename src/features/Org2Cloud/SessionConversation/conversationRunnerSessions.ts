/** Local lifecycle facade for invisible shared-conversation runners. */
import { deleteSession } from "@src/api/tauri/agent";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { clearCliTurnLifecycleSession } from "@src/hooks/cliSession/cliTurnLifecycleCoordinator";
import { createLogger } from "@src/hooks/logger";
import { removeSession, sessionsAtom } from "@src/store/session";
import { persistSessions } from "@src/store/session/sessionAtom/persistence";
import { isTerminalStatus } from "@src/types/session/session";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { invokeTauri } from "@src/util/platform/tauri/init";
import { isCliSession } from "@src/util/session/sessionDispatch";

import {
  collectStoredRunnerSessionIds,
  conversationExecutionKey,
  forgetStoredRunner,
  loadStoredRunnerRegistryEntry,
  markStoredRunnerTerminal,
} from "./conversationExecutionStore";

const log = createLogger("ConversationRunnerSessions");

export function conversationRunnerKey(
  executorScope: string,
  rootSessionId: string
): string {
  return conversationExecutionKey(executorScope, rootSessionId);
}

/** Every runner session id on this device — the My Sessions hide filter. */
export function collectConversationRunnerSessionIds(): Set<string> {
  return collectStoredRunnerSessionIds();
}

export function markConversationRunnerTerminal(
  key: string,
  runnerSessionId: string
): void {
  markStoredRunnerTerminal(key, runnerSessionId);
}

/** Delete a hidden runner through the same category-specific paths as UI. */
export async function cleanupConversationRunnerSession(
  runnerSessionId: string
): Promise<void> {
  let deletedSessionIds = [runnerSessionId];
  if (isCliSession(runnerSessionId)) {
    await invokeTauri("cli_agent_delete", { sessionId: runnerSessionId });
    clearCliTurnLifecycleSession(runnerSessionId);
  } else {
    const receipt = await deleteSession(runnerSessionId);
    if (receipt.deletedSessionIds.length > 0) {
      deletedSessionIds = receipt.deletedSessionIds;
    }
  }
  await Promise.all(
    deletedSessionIds.map((sessionId) =>
      eventStoreProxy.evictSession(sessionId).catch(() => undefined)
    )
  );
  for (const sessionId of deletedSessionIds) {
    removeSession(sessionId);
    forgetStoredRunner(sessionId);
  }
  const store = getInstrumentedStore();
  persistSessions(store.get(sessionsAtom));
}

export async function cleanupConversationRunnerBestEffort(
  runnerSessionId: string
): Promise<void> {
  try {
    await cleanupConversationRunnerSession(runnerSessionId);
  } catch (error) {
    log.warn(`hidden runner cleanup failed for ${runnerSessionId}`, error);
  }
}

/** Sweep only sessions proven terminal; retain the active continuation. */
export async function cleanupRetiredConversationRunners(
  key: string,
  keepSessionId: string
): Promise<void> {
  const entry = loadStoredRunnerRegistryEntry(key);
  if (!entry) return;
  const terminalIds = new Set(entry.terminalRunnerSessionIds);
  for (const session of getInstrumentedStore().get(sessionsAtom)) {
    if (
      entry.runnerSessionIds.includes(session.session_id) &&
      isTerminalStatus(session.status)
    ) {
      terminalIds.add(session.session_id);
    }
  }
  terminalIds.delete(keepSessionId);
  for (const sessionId of terminalIds) {
    await cleanupConversationRunnerBestEffort(sessionId);
  }
}
