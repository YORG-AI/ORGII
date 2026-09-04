import type { PermissionSheetRequest } from "@src/components/PermissionPrompt";

/** FIFO permission queue from orgii/event bus envelopes. */

export interface PermissionBusEnvelope {
  type?: string;
  payload?: Record<string, unknown>;
  [field: string]: unknown;
}

const PERMISSION_REQUEST_EVENT = "permission:request";
const INTERACTION_FINALIZED_EVENT = "agent:interaction_finalized";

export interface InteractionQueueState {
  queue: PermissionSheetRequest[];
}

export function createInitialInteractionQueueState(): InteractionQueueState {
  return { queue: [] };
}

/**
 * Bus envelopes reach the phone in two shapes and both must parse:
 *
 * - `agent-core` wraps its native prompt through `bus::broadcast_event`, so
 *   the fields sit under `payload`.
 * - The managed CLI hook (`origin: "cli_hook"`) and the ACP bridge
 *   (`origin: "acp"`) broadcast a flat message whose top-level `session_id`
 *   is what routes it to this session, so the fields sit on the envelope.
 */
function permissionEventFields(
  envelope: PermissionBusEnvelope
): Record<string, unknown> {
  const payload = envelope.payload;
  if (payload && typeof payload === "object") return payload;
  return envelope as Record<string, unknown>;
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

/**
 * Drop a prompt the desktop already resolved. `agent:interaction_finalized`
 * is emitted by the native permission manager (any answer, from any surface)
 * and keys on `toolCallId`; the managed CLI and ACP registries emit nothing
 * on resolve, so their prompts still rely on an explicit dismiss.
 */
function resolveFinalizedInteraction(
  state: InteractionQueueState,
  payload: Record<string, unknown>
): InteractionQueueState {
  const sessionId = payload.sessionId;
  const toolCallId = payload.toolCallId;
  if (typeof sessionId !== "string" || typeof toolCallId !== "string") {
    return state;
  }
  const queue = state.queue.filter(
    (row) => row.sessionId !== sessionId || row.toolCallId !== toolCallId
  );
  return queue.length === state.queue.length ? state : { queue };
}

export function reduceInteractionQueueFromBusEvent(
  state: InteractionQueueState,
  envelope: PermissionBusEnvelope
): InteractionQueueState {
  if (envelope.type === INTERACTION_FINALIZED_EVENT) {
    return resolveFinalizedInteraction(state, permissionEventFields(envelope));
  }
  if (envelope.type !== PERMISSION_REQUEST_EVENT) {
    return state;
  }
  const request = parsePermissionRequest(permissionEventFields(envelope));
  if (!request) return state;
  if (state.queue.some((row) => row.requestId === request.requestId)) {
    return state;
  }
  return { queue: [...state.queue, request] };
}

/**
 * Remove one prompt. Always pass the `requestId` that was actually answered:
 * dropping the head blind removes whatever raced to the front of the queue.
 */
export function dequeuePermissionRequest(
  state: InteractionQueueState,
  requestId?: string
): InteractionQueueState {
  if (state.queue.length === 0) return state;
  if (requestId === undefined) return { queue: state.queue.slice(1) };
  const queue = state.queue.filter((row) => row.requestId !== requestId);
  return queue.length === state.queue.length ? state : { queue };
}

/**
 * Oldest prompt for `sessionId`. Scoping matters: a prompt raised for another
 * session (or one the desktop resolved) must not sit in front of the prompt
 * the user is currently looking at.
 */
export function peekPermissionRequest(
  state: InteractionQueueState,
  sessionId?: string | null
): PermissionSheetRequest | null {
  if (sessionId == null) return state.queue[0] ?? null;
  return state.queue.find((row) => row.sessionId === sessionId) ?? null;
}

/** How many prompts are queued, optionally narrowed to one session. */
export function countPermissionRequests(
  state: InteractionQueueState,
  sessionId?: string | null
): number {
  if (sessionId == null) return state.queue.length;
  return state.queue.reduce(
    (total, row) => (row.sessionId === sessionId ? total + 1 : total),
    0
  );
}
