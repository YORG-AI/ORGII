import type { PermissionSheetRequest } from "@src/components/PermissionPrompt";

/** FIFO permission queue from orgii/event bus envelopes. */

export interface PermissionBusEnvelope {
  type?: string;
  payload?: Record<string, unknown>;
}

export interface InteractionQueueState {
  queue: PermissionSheetRequest[];
}

export function createInitialInteractionQueueState(): InteractionQueueState {
  return { queue: [] };
}

function parsePermissionRequest(
  payload: Record<string, unknown>
): PermissionSheetRequest | null {
  const requestId = payload.requestId;
  const sessionId = payload.sessionId;
  const toolName = payload.toolName;
  if (
    typeof requestId !== "string" ||
    typeof sessionId !== "string" ||
    typeof toolName !== "string"
  ) {
    return null;
  }
  const toolArgs =
    payload.toolArgs && typeof payload.toolArgs === "object"
      ? (payload.toolArgs as Record<string, unknown>)
      : {};
  return {
    requestId,
    sessionId,
    toolName,
    toolCallId:
      typeof payload.toolCallId === "string" ? payload.toolCallId : undefined,
    toolArgs,
    origin:
      payload.origin === "rust_agent" ||
      payload.origin === "cli_hook" ||
      payload.origin === "acp"
        ? payload.origin
        : undefined,
  };
}

export function reduceInteractionQueueFromBusEvent(
  state: InteractionQueueState,
  envelope: PermissionBusEnvelope
): InteractionQueueState {
  if (envelope.type !== "permission:request" || !envelope.payload) {
    return state;
  }
  const request = parsePermissionRequest(envelope.payload);
  if (!request) return state;
  if (state.queue.some((row) => row.requestId === request.requestId)) {
    return state;
  }
  return { queue: [...state.queue, request] };
}

export function dequeuePermissionRequest(
  state: InteractionQueueState
): InteractionQueueState {
  if (state.queue.length === 0) return state;
  return { queue: state.queue.slice(1) };
}

export function peekPermissionRequest(
  state: InteractionQueueState
): PermissionSheetRequest | null {
  return state.queue[0] ?? null;
}
