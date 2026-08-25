/** Local registry facade for invisible shared-conversation runners. */
import {
  collectStoredRunnerSessionIds,
  conversationExecutionKey,
  markStoredRunnerTerminal,
  registerStoredRunner,
} from "./conversationExecutionStore";

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

export function registerConversationRunner(
  key: string,
  runnerSessionId: string,
  updatedAt: string
): void {
  registerStoredRunner(key, runnerSessionId, updatedAt);
}

export function markConversationRunnerTerminal(
  key: string,
  runnerSessionId: string
): void {
  markStoredRunnerTerminal(key, runnerSessionId);
}
