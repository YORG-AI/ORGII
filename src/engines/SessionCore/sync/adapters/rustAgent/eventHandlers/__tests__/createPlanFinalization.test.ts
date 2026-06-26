import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type {
  AgentWSEvent,
  PlanReadyForApprovalEvent,
} from "@src/engines/SessionCore/sync/adapters/shared/types";

import {
  handlePlanApprovalArchived,
  handlePlanReadyForApproval,
} from "../agentSpecific";
import { handleToolCallDelta } from "../streamHandlers";
import { handleToolCall, handleToolResult } from "../toolHandlers";
import type { EventHandlerContext } from "../types";

vi.hoisted(() => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      },
    },
    configurable: true,
  });
});

const {
  storeEvents,
  upsertSpy,
  appendSpy,
  mergeSpy,
  patchByIdsSpy,
  completeLastRunningSpy,
} = vi.hoisted(() => {
  const events = new Map<string, SessionEvent>();
  const upsert = vi.fn((event: SessionEvent) => {
    events.set(event.id, event);
  });
  const append = vi.fn((incomingEvents: SessionEvent[]) => {
    for (const event of incomingEvents) events.set(event.id, event);
  });
  const patchByIds = vi.fn(
    (ids: string[], patch: Partial<SessionEvent>): number => {
      let count = 0;
      for (const id of ids) {
        const existing = events.get(id);
        if (!existing) continue;
        events.set(id, { ...existing, ...patch });
        count += 1;
      }
      return count;
    }
  );
  const merge = vi.fn((incomingEvents: SessionEvent[]) => {
    for (const event of incomingEvents) {
      if (event.actionType === "tool_result" && event.callId) {
        const target = Array.from(events.values()).find(
          (existing) =>
            existing.actionType === "tool_call" &&
            existing.callId === event.callId
        );
        if (target) {
          events.set(target.id, {
            ...target,
            result: event.result,
            displayStatus: "completed",
            activityStatus: "processed",
          });
          continue;
        }
      }
      events.set(event.id, event);
    }
  });
  return {
    storeEvents: events,
    upsertSpy: upsert,
    appendSpy: append,
    mergeSpy: merge,
    patchByIdsSpy: patchByIds,
    completeLastRunningSpy: vi.fn(),
  };
});

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    upsert: upsertSpy,
    append: appendSpy,
    mergeEvents: mergeSpy,
    patchByIds: patchByIdsSpy,
    completeLastRunning: completeLastRunningSpy,
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
  overrides: Partial<EventHandlerContext> = {}
): EventHandlerContext {
  return {
    filterSessionIdRef: ref("session-1"),
    assistantStreamRef: ref({ idRef: ref(""), contentRef: ref("") }),
    thinkingStreamRef: ref({ idRef: ref(""), contentRef: ref("") }),
    toolCallDeltaBuffersRef: ref(new Map()),
    execOutputBufferRef: ref(""),
    onAgentCompleteRef: ref(undefined),
    onContextUsageRef: ref(undefined),
    onTokenUpdateRef: ref(undefined),
    onStatusChangeRef: ref(undefined),
    onQuestionRequestRef: ref(undefined),
    setStreaming: vi.fn(),
    features: { hasToolCallDelta: true },
    getDefaultStore: () => null,
    ...overrides,
  };
}

beforeEach(() => {
  storeEvents.clear();
  upsertSpy.mockClear();
  appendSpy.mockClear();
  mergeSpy.mockClear();
  patchByIdsSpy.mockClear();
  completeLastRunningSpy.mockClear();
  vi.stubGlobal("window", {
    dispatchEvent: vi.fn(),
  });
  vi.stubGlobal(
    "CustomEvent",
    class CustomEventStub {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    }
  );
});

describe("create_plan streaming finalization", () => {
  it("marks the UI turn completed as soon as create_plan is ready for approval", () => {
    const setSpy = vi.fn();
    const statusSpy = vi.fn();
    const streamingSpy = vi.fn();
    const ctx = createCtx({
      getDefaultStore: () => ({ set: setSpy }) as never,
      onStatusChangeRef: ref(statusSpy),
      setStreaming: streamingSpy,
    });

    const event: AgentWSEvent &
      Pick<PlanReadyForApprovalEvent, "autoApproveAt"> = {
      type: "agent:plan_ready_for_approval",
      sessionId: "session-1",
      planPath: "/tmp/plan.md",
      planTitle: "Plan",
      planContent: "body",
      toolCallId: "call_plan_1",
      planEventSource: "create_plan",
      autoApproveAt: 123_456,
    };

    handlePlanReadyForApproval(event, "session-1", ctx);

    expect(setSpy).toHaveBeenCalledTimes(1);
    const [, updatePendingPlan] = setSpy.mock.calls[0];
    const nextPendingPlanMap = updatePendingPlan(new Map());
    expect(nextPendingPlanMap.get("session-1")?.current).toMatchObject({
      planTitle: "Plan",
      autoApproveAt: 123_456,
    });
    expect(streamingSpy).toHaveBeenCalledWith(false);
    expect(statusSpy).toHaveBeenCalledWith("completed");
  });

  it("patches archived plan approval lifecycle events onto the original transcript card", () => {
    handlePlanApprovalArchived(
      {
        type: "agent:plan_approval_archived",
        sessionId: "session-1",
        planPath: "/tmp/plan.md",
        planTitle: "Old plan",
        planContent: "old body",
        toolCallId: "call_plan_1",
        planId: "plan-1",
        planRevisionId: "call_plan_1",
        originToolCallId: "call_plan_1",
      },
      "session-1",
      createCtx()
    );

    expect(patchByIdsSpy).toHaveBeenCalledWith(
      ["call_plan_1", "tool-call-call_plan_1"],
      expect.objectContaining({
        displayStatus: "completed",
        activityStatus: "processed",
        result: expect.objectContaining({
          status: "archived",
          planRevisionId: "call_plan_1",
        }),
      }),
      "session-1"
    );
    expect(upsertSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "call_plan_1-archived" }),
      "session-1"
    );
  });

  it("buffers streamed create_plan deltas without creating duplicate EventStore rows", async () => {
    const ctx = createCtx();

    handleToolCallDelta(
      {
        type: "agent:tool_call_delta",
        tool: "create_plan",
        toolCallId: "call_plan_1",
        argumentsDelta: '{"title":"Plan","content":"draft"}',
        index: 0,
      },
      "session-1",
      ctx
    );

    expect(storeEvents.has("tool-call-call_plan_1")).toBe(false);
    expect(storeEvents.has("tool-call-draft-call_plan_1")).toBe(false);
    expect(ctx.toolCallDeltaBuffersRef!.current.get(0)).toMatchObject({
      toolCallId: "call_plan_1",
      toolName: "create_plan",
      messageId: "tool-call-call_plan_1",
    });

    handleToolCall(
      {
        type: "agent:tool_call",
        tool: "create_plan",
        toolCallId: "call_plan_1",
        args: { title: "Plan", content: "final" },
      },
      "session-1",
      "session-1",
      ctx
    );

    expect(upsertSpy).not.toHaveBeenCalled();
    expect(ctx.toolCallDeltaBuffersRef!.current.has(0)).toBe(false);

    await handleToolResult(
      {
        type: "agent:tool_result",
        tool: "create_plan",
        toolCallId: "call_plan_1",
        result: "PLAN_SUBMITTED_END_TURN:{}",
      },
      "session-1",
      ctx
    );

    expect(storeEvents.size).toBe(0);
    expect(storeEvents.has("tool-result-call_plan_1")).toBe(false);
    expect(mergeSpy).not.toHaveBeenCalled();
    expect(completeLastRunningSpy).not.toHaveBeenCalled();
  });
});
