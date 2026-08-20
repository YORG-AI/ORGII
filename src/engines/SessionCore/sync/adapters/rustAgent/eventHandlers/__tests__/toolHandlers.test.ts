import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { openInSimulatorCanvas } from "@src/engines/ChatPanel/blocks/CanvasInlineCard/openInSimulatorCanvas";
import type { CanvasInlinePayload } from "@src/engines/ChatPanel/blocks/CanvasInlineCard/types";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { AgentWSEvent } from "@src/engines/SessionCore/sync/adapters/shared/types";
import { canvasPreviewAtom } from "@src/store/session/canvasPreviewAtom";

import {
  buildCanvasInlinePayloadFromToolArgs,
  estimateCanvasRevisionReceivedCharacters,
  handleToolCall,
  handleToolResult,
} from "../toolHandlers";
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

function createCtx(
  store: ReturnType<typeof createStore> | null = null
): EventHandlerContext {
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
    getDefaultStore: () => store,
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
    vi.mocked(openInSimulatorCanvas).mockClear();
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

  it("dispatches revise_inline_canvas with its target identity intact", () => {
    const event: AgentWSEvent = {
      type: "agent:tool_call",
      sessionId: "session-1",
      tool: "revise_inline_canvas",
      toolCallId: "call-revision-1",
      args: {
        target_event_id: "tool-call-original",
        mode: "react",
        content: "function App() { return <div>Updated</div>; }",
        title: "Updated Canvas",
      },
    };

    handleToolCall(event, "session-1", "session-1", createCtx());

    expect(openInSimulatorCanvas).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        eventId: "tool-call-call-revision-1",
        revisesEventId: "tool-call-original",
        content: expect.stringContaining("Updated"),
      })
    );
  });

  it("materializes an edits-only revision against the previous preview payload", () => {
    const store = createStore();
    store.set(canvasPreviewAtom, {
      sessionId: "session-1",
      payload: {
        mode: "html",
        content: "<p>Start here</p>",
        title: "Original",
        eventId: "tool-call-original",
      },
    });

    handleToolCall(
      {
        type: "agent:tool_call",
        sessionId: "session-1",
        tool: "revise_inline_canvas",
        toolCallId: "call-revision-2",
        args: {
          target_event_id: "tool-call-original",
          edits: [{ find: "Start here", replace: "Start setup" }],
        },
      },
      "session-1",
      "session-1",
      createCtx(store)
    );

    expect(openInSimulatorCanvas).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        eventId: "tool-call-call-revision-2",
        revisesEventId: "tool-call-original",
        mode: "html",
        content: "<p>Start setup</p>",
      })
    );
  });

  it("preserves the existing preview when an edits-only revision has no base", () => {
    const store = createStore();
    // Preview belongs to an unrelated canvas — must not be used as a base.
    store.set(canvasPreviewAtom, {
      sessionId: "session-1",
      payload: {
        mode: "html",
        content: "<p>Unrelated</p>",
        eventId: "tool-call-unrelated",
      },
    });

    handleToolCall(
      {
        type: "agent:tool_call",
        sessionId: "session-1",
        tool: "revise_inline_canvas",
        toolCallId: "call-revision-3",
        args: {
          target_event_id: "tool-call-missing",
          edits: [{ find: "Start", replace: "Finish" }],
        },
      },
      "session-1",
      "session-1",
      createCtx(store)
    );

    expect(openInSimulatorCanvas).not.toHaveBeenCalled();
    expect(store.get(canvasPreviewAtom)?.payload.content).toBe(
      "<p>Unrelated</p>"
    );
  });
});

describe("estimateCanvasRevisionReceivedCharacters", () => {
  it("sums content and edit strings without serializing the args object", () => {
    expect(estimateCanvasRevisionReceivedCharacters(undefined)).toBe(0);
    expect(estimateCanvasRevisionReceivedCharacters({ content: "abcd" })).toBe(
      4
    );
    expect(
      estimateCanvasRevisionReceivedCharacters({
        edits: [
          { find: "one", replace: "three" },
          { find: "xx", replace: "" },
          "garbage",
        ],
      })
    ).toBe(10);
  });
});

describe("buildCanvasInlinePayloadFromToolArgs", () => {
  const previousEntry = {
    sessionId: "session-1",
    payload: {
      mode: "react",
      content: "function App() { return <b>Count 1</b>; }",
      title: "Counter",
      eventId: "tool-call-base",
    } as CanvasInlinePayload,
  };

  it("passes creates and full-content revisions through unchanged", () => {
    expect(
      buildCanvasInlinePayloadFromToolArgs(
        "session-1",
        { mode: "html", content: "<p>New</p>" },
        "call-a",
        null
      )
    ).toMatchObject({ mode: "html", content: "<p>New</p>" });

    expect(
      buildCanvasInlinePayloadFromToolArgs(
        "session-1",
        {
          target_event_id: "tool-call-base",
          mode: "react",
          content: "function App() { return null; }",
        },
        "call-b",
        previousEntry
      )
    ).toMatchObject({ content: "function App() { return null; }" });
  });

  it("applies edits against the previous payload and keeps its mode", () => {
    const payload = buildCanvasInlinePayloadFromToolArgs(
      "session-1",
      {
        target_event_id: "tool-call-base",
        edits: [{ find: "Count 1", replace: "Count 2" }],
      },
      "call-c",
      previousEntry
    );

    expect(payload).toMatchObject({
      mode: "react",
      content: "function App() { return <b>Count 2</b>; }",
      eventId: "tool-call-call-c",
      revisesEventId: "tool-call-base",
    });
  });

  it("returns null instead of a contentless payload when materialization fails", () => {
    // Base present but the edit does not match the previous content.
    expect(
      buildCanvasInlinePayloadFromToolArgs(
        "session-1",
        {
          target_event_id: "tool-call-base",
          edits: [{ find: "No such text", replace: "x" }],
        },
        "call-d",
        previousEntry
      )
    ).toBeNull();

    // No base at all.
    expect(
      buildCanvasInlinePayloadFromToolArgs(
        "session-1",
        {
          target_event_id: "tool-call-base",
          edits: [{ find: "Count 1", replace: "Count 2" }],
        },
        "call-e",
        null
      )
    ).toBeNull();

    // Base from a different session must not leak across sessions.
    expect(
      buildCanvasInlinePayloadFromToolArgs(
        "session-2",
        {
          target_event_id: "tool-call-base",
          edits: [{ find: "Count 1", replace: "Count 2" }],
        },
        "call-f",
        previousEntry
      )
    ).toBeNull();
  });
});
