/** Persistent local execution episode for a shared conversation. */
import {
  type ConversationContinuationInput,
  type ConversationContinuationLineage,
  type ConversationContinuationRecord,
  advanceStoredContinuationReadThrough,
  clearStoredContinuation,
  loadStoredContinuation,
  loadStoredContinuationLineage,
  markStoredContinuationEstablished,
  prepareStoredContinuation,
  retireStoredContinuation,
  saveStoredContinuation,
} from "./conversationExecutionStore";

export type { ConversationContinuationLineage, ConversationContinuationRecord };

export function loadContinuation(
  executorScope: string,
  rootSessionId: string,
  backing?: Storage | null
): ConversationContinuationRecord | null {
  return loadStoredContinuation(executorScope, rootSessionId, backing);
}

export function saveContinuation(
  executorScope: string,
  rootSessionId: string,
  record: ConversationContinuationInput,
  backing?: Storage | null
): void {
  saveStoredContinuation(executorScope, rootSessionId, record, backing);
}

export function prepareContinuation(
  executorScope: string,
  rootSessionId: string,
  record: ConversationContinuationInput,
  preparedAt: string,
  backing?: Storage | null
): void {
  prepareStoredContinuation(
    executorScope,
    rootSessionId,
    record,
    preparedAt,
    backing
  );
}

export function loadContinuationLineage(
  executorScope: string,
  rootSessionId: string,
  backing?: Storage | null
): ConversationContinuationLineage | null {
  return loadStoredContinuationLineage(executorScope, rootSessionId, backing);
}

export function retireContinuation(
  executorScope: string,
  rootSessionId: string,
  rollReason: string,
  failed = false,
  backing?: Storage | null
): void {
  retireStoredContinuation(
    executorScope,
    rootSessionId,
    rollReason,
    failed ? "failed" : "retired",
    backing
  );
}

export function clearContinuation(
  executorScope: string,
  rootSessionId: string,
  backing?: Storage | null
): void {
  clearStoredContinuation(executorScope, rootSessionId, backing);
}

export function advanceContinuationReadThrough(
  executorScope: string,
  rootSessionId: string,
  planeSeq: number,
  backing?: Storage | null
): void {
  advanceStoredContinuationReadThrough(
    executorScope,
    rootSessionId,
    planeSeq,
    backing
  );
}

export function markContinuationEstablished(
  executorScope: string,
  rootSessionId: string,
  continuationSessionId: string,
  bootstrapTurnIntentId: string,
  backing?: Storage | null
): boolean {
  return markStoredContinuationEstablished(
    executorScope,
    rootSessionId,
    continuationSessionId,
    bootstrapTurnIntentId,
    backing
  );
}

export type ContinuationDecision =
  | { kind: "resume"; record: ConversationContinuationRecord }
  | { kind: "bootstrap"; record: ConversationContinuationRecord }
  | { kind: "fresh"; rollReason?: string };

export function decideContinuation(input: {
  record: ConversationContinuationRecord | null;
  turnIntentId: string;
  assignedAgentDefinitionId?: string;
  runtimeSetupChanged?: boolean;
}): ContinuationDecision {
  const { record } = input;
  if (!record) return { kind: "fresh" };
  if (
    input.assignedAgentDefinitionId &&
    input.assignedAgentDefinitionId !== record.agentDefinitionId
  ) {
    return { kind: "fresh", rollReason: "assigned_agent_changed" };
  }
  if (input.runtimeSetupChanged) {
    return { kind: "fresh", rollReason: "runtime_setup_changed" };
  }
  if (!record.established) {
    return record.bootstrapTurnIntentId === input.turnIntentId
      ? { kind: "bootstrap", record }
      : { kind: "fresh", rollReason: "bootstrap_intent_changed" };
  }
  return { kind: "resume", record };
}
