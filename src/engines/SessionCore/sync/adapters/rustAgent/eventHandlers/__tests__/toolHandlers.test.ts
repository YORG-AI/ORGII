import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { AgentWSEvent } from "@src/engines/SessionCore/sync/adapters/shared/types";

import { handleToolResult } from "../toolHandlers";
import type { EventHandlerContext } from "../types";

const { events, updateByIdSpy, getEventsSpy } = vi.hoisted(() => {
  const eventMap = new Map<string, SessionEvent>();
  return {
    events: eventMap,
    updateByIdSpy: vi.fn(
      (id: string, patch: Partial<SessionEvent>, _sessionId?: string) => {
        const existing = eventMap.get(id);
        if (existing) eventMap.set(id, { ...existing, ...patch });
      }
    ),
    getEventsSpy: vi.fn(async () => Array.from(eventMap.values())),
  };
});

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    getEvents: getEventsSpy,
    updateById: updateByIdSpy,
  },
}));

vi.mock(
  "@src/engines/ChatPanel/blocks/CanvasInlineCard/openInSimulatorCanvas",
  () => ({
    openInSimulatorCanvas: vi.fn(),
  })
);

vi.mock("@src/store/session/mcpProgressAtom", () => ({
  clearMcpProgressForCallAtom: {},
}));

function ref<T>(value: T): { current: T } {
  return { current: value };
}

function createCtx(): EventHandlerContext {
  return {
    filterSessionIdRef: ref("session-1"),
    assistantStreamRef: ref({ idRef: ref(""), contentRef: ref("") }),
    thinkingStreamRef: ref({ idRef: ref(""), contentRef: ref("") }),
    toolCallDeltaBuffersRef: ref(new Map()),
    trackedCodingSessionsRef: ref(new Map()),
    onAgentCompleteRef: ref(undefined),
    onContextUsageRef: ref(undefined),
    onTokenUpdateRef: ref(undefined),
    onStatusChangeRef: ref(undefined),
    onQuestionRequestRef: ref(undefined),
    setStreaming: vi.fn(),
    features: { hasCodingSessionBridge: true },
    getDefaultStore: () => null,
  };
}

function parentAgentEvent(): SessionEvent {
  return {
    id: "parent-agent-call",
    chunk_id: "parent-agent-call",
    sessionId: "session-1",
    createdAt: "2026-07-04T22:52:45.000Z",
    functionName: "agent",
    uiCanonical: "subagent",
    actionType: "tool_call",
    args: {
      subagentSessionId:
        "agent-builtin:explore-69cdc86a-24d1-42a9-9bbb-0a6025068f79",
      action: "delegate",
    },
    result: {
      content:
        "Subagent launched. Session ID: agent-builtin:explore-69cdc86a-24d1-42a9-9bbb-0a6025068f79",
    },
    source: "assistant",
    displayText: "agent",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "processed",
    callId: "call-agent-1",
  };
}

describe("rust agent tool result handler", () => {
  beforeEach(() => {
    events.clear();
    updateByIdSpy.mockClear();
    getEventsSpy.mockClear();
  });

  it("does not downgrade an authoritative completed subagent parent card back to running", async () => {
    events.set("parent-agent-call", parentAgentEvent());

    const event: AgentWSEvent = {
      type: "agent:tool_result",
      sessionId: "session-1",
      tool: "agent",
      toolCallId: "call-agent-1",
      result:
        "Subagent launched. Session ID: agent-builtin:explore-69cdc86a-24d1-42a9-9bbb-0a6025068f79",
    };

    await handleToolResult(event, "session-1", createCtx());

    expect(updateByIdSpy).not.toHaveBeenCalled();
    expect(events.get("parent-agent-call")?.displayStatus).toBe("completed");
  });
});
