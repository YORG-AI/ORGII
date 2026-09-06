/**
 * Shared Test Fixtures for Session Rendering Tests
 *
 * Factory functions and sample payloads for testing the rendering pipeline.
 * Used by propsNormalizer, propsDataExtractors, and integration tests.
 */
import type { OptimizedChatItem } from "@src/engines/ChatPanel/ChatHistory/chatItemPipeline/types";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type {
  EventStatus,
  EventVariant,
  RenderContext,
  UniversalEventProps,
} from "../../types/universalProps";

// ============================================
// Factory: UniversalEventProps
// ============================================

export function makeUniversalProps(
  overrides: Partial<UniversalEventProps> = {}
): UniversalEventProps {
  return {
    eventId: "evt-001",
    eventType: "tool_call",
    args: {},
    result: {},
    status: "success" as EventStatus,
    showActiveEventPainting: false,
    variant: "chat" as EventVariant,
    context: "chat" as RenderContext,
    ...overrides,
  };
}

// ============================================
// Factory: SessionEvent
// ============================================

let activityCounter = 0;

/**
 * Create a SessionEvent for testing. Fields default to a read_file tool_call.
 * Accepts shorthand overrides: `function` maps to `functionName`,
 * `action_type` maps to `actionType`, etc.
 */
export function makeSessionEvent(
  overrides: Partial<SessionEvent> & Record<string, unknown> = {}
): SessionEvent {
  activityCounter++;
  const functionName =
    (overrides.functionName as string) ??
    (overrides.function as string) ??
    "read_file";
  const actionType =
    (overrides.actionType as string) ??
    (overrides.action_type as string) ??
    "tool_call";
  return {
    id: overrides.id ?? `chunk-${activityCounter}`,
    chunk_id: overrides.chunk_id ?? null,
    sessionId: overrides.sessionId ?? "session-test-001",
    createdAt:
      overrides.createdAt ??
      `2026-04-01T10:00:${String(activityCounter).padStart(2, "0")}Z`,
    functionName,
    uiCanonical: (overrides.uiCanonical as string) ?? "",
    actionType,
    args:
      "args" in overrides ? (overrides.args as Record<string, unknown>) : {},
    result:
      "result" in overrides
        ? (overrides.result as Record<string, unknown>)
        : {},
    source: (overrides.source as SessionEvent["source"]) ?? "assistant",
    displayText: (overrides.displayText as string) ?? "",
    displayStatus:
      "displayStatus" in overrides
        ? (overrides.displayStatus as SessionEvent["displayStatus"])
        : "completed",
    displayVariant:
      (overrides.displayVariant as SessionEvent["displayVariant"]) ??
      "tool_call",
    activityStatus:
      (overrides.activityStatus as SessionEvent["activityStatus"]) ?? "agent",
    ...(overrides.threadId ? { threadId: overrides.threadId } : {}),
    ...(overrides.processId ? { processId: overrides.processId } : {}),
    ...(overrides.callId ? { callId: overrides.callId } : {}),
    ...(overrides.shellPid ? { shellPid: overrides.shellPid } : {}),
    ...(overrides.shellProcessStatus
      ? { shellProcessStatus: overrides.shellProcessStatus }
      : {}),
    ...(overrides.shellExitCode !== undefined
      ? { shellExitCode: overrides.shellExitCode }
      : {}),
    ...(overrides.shellLogPath ? { shellLogPath: overrides.shellLogPath } : {}),
    ...(overrides.isDelta !== undefined
      ? { isDelta: overrides.isDelta as boolean }
      : {}),
  } as SessionEvent;
}

export function resetActivityCounter(): void {
  activityCounter = 0;
}

// ============================================
// Factory: OptimizedChatItem (wrapping SessionEvent)
// ============================================

export function makeChatItem(
  event: SessionEvent,
  overrides: Partial<OptimizedChatItem> = {}
): OptimizedChatItem {
  return {
    type: "activity",
    chunk_id: event.id,
    event,
    ...overrides,
  };
}

// ============================================
// Factory: RawEventInput (for propsNormalizer)
// ============================================

export function makeChatInput(
  overrides: Record<string, unknown> = {},
  extras: Record<string, unknown> = {}
): Record<string, unknown> {
  // Map legacy snake_case test overrides to SessionEvent camelCase fields
  const { status, created_at, chunk_id, ...rest } = overrides;
  return {
    event: makeSessionEvent({
      id: (chunk_id as string) ?? "chunk-chat-001",
      actionType: "tool_call",
      function: "read_file",
      ...(status
        ? { displayStatus: status as SessionEvent["displayStatus"] }
        : {}),
      ...(created_at ? { createdAt: created_at as string } : {}),
      ...rest,
    }),
    ...extras,
  };
}

export function makeSimulatorInput(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    event_id: "evt-sim-001",
    function: "read_file",
    action_type: "tool_call",
    args: {},
    result: {},
    created_time: "2026-04-01T10:00:00Z",
    ...overrides,
  };
}

export function makeTrajectoryInput(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    event_id: "evt-traj-001",
    function: "read_file",
    action_type: "tool_call",
    args: {},
    result: {},
    isSelected: false,
    onSelect: () => {},
    ...overrides,
  };
}

// ============================================
// Real-World Payload Samples
// ============================================

export const APPLY_PATCH_PAYLOAD = {
  action_type: "tool_call",
  function: "apply_patch",
  args: {
    patch_text: [
      "*** Begin Patch",
      "*** Add File: src/newFile.ts",
      "+export const greeting = 'hello';",
      "+export const farewell = 'bye';",
      "*** Modify File: src/existing.ts",
      "-const old = true;",
      "+const updated = true;",
      " const unchanged = 42;",
      "*** End Patch",
    ].join("\n"),
  },
  result: { content: "Patch applied successfully" },
};
