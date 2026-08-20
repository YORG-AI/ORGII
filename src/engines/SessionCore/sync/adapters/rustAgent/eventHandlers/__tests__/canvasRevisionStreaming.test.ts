import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canvasRevisionDraftsAtom } from "@src/store/session/canvasRevisionDraftAtom";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import type { Session } from "@src/store/session/sessionAtom/types";

import { handleToolCallDelta } from "../streamHandlers";
import { resetAllStreamingState } from "../streamHelpers";
import { handleToolCall, handleToolResult } from "../toolHandlers";
import type { EventHandlerContext } from "../types";

const parseCounter = vi.hoisted(() => ({ count: 0 }));

vi.mock(
  "@src/engines/ChatPanel/blocks/CanvasInlineCard/openInSimulatorCanvas",
  () => ({ openInSimulatorCanvas: vi.fn() })
);

vi.mock("../../../shared/streamingParsers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../shared/streamingParsers")>();
  return {
    ...actual,
    parseCanvasRevisionDeltaMetadata: (
      ...args: Parameters<typeof actual.parseCanvasRevisionDeltaMetadata>
    ) => {
      parseCounter.count += 1;
      return actual.parseCanvasRevisionDeltaMetadata(...args);
    },
  };
});

function ref<T>(value: T): { current: T } {
  return { current: value };
}

function registerSession(
  store: ReturnType<typeof createStore>,
  sessionId: string
): void {
  store.set(sessionsAtom, (previous) => [
    ...previous,
    { session_id: sessionId } as unknown as Session,
  ]);
}

function context(store: ReturnType<typeof createStore>): EventHandlerContext {
  return {
    filterSessionIdRef: ref("session-a"),
    assistantStreamRef: ref({ idRef: ref(""), contentRef: ref("") }),
    thinkingStreamRef: ref({ idRef: ref(""), contentRef: ref("") }),
    toolCallDeltaBuffersRef: ref(new Map()),
    onAgentCompleteRef: ref(undefined),
    onContextUsageRef: ref(undefined),
    onTokenUpdateRef: ref(undefined),
    onStatusChangeRef: ref(undefined),
    onQuestionRequestRef: ref(undefined),
    setStreaming: vi.fn(),
    features: { hasToolCallDelta: true },
    getDefaultStore: () => store,
  };
}

describe("Canvas revision streaming lifecycle", () => {
  beforeEach(() => {
    parseCounter.count = 0;
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    vi.stubGlobal(
      "CustomEvent",
      class CustomEventStub {
        constructor(
          public type: string,
          public init?: { detail?: unknown }
        ) {}
      }
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes ephemeral progress, applies the final call, then clears it", async () => {
    const store = createStore();
    registerSession(store, "session-a");
    const ctx = context(store);

    handleToolCallDelta(
      {
        type: "agent:tool_call_delta",
        tool: "revise_inline_canvas",
        toolCallId: "revision-a",
        index: 0,
        argumentsDelta:
          '{"agent_steps":["替换按钮文案","核对原有交互"],"target_event_id":"canvas-a","mode":"react","title":"Coffee","edits":[',
      },
      "session-a",
      ctx
    );

    expect(store.get(canvasRevisionDraftsAtom).get("session-a")).toMatchObject({
      toolCallId: "revision-a",
      targetEventId: "canvas-a",
      mode: "react",
      title: "Coffee",
      agentSteps: ["替换按钮文案", "核对原有交互"],
      phase: "receiving",
    });

    handleToolCall(
      {
        type: "agent:tool_call",
        sessionId: "session-a",
        tool: "revise_inline_canvas",
        toolCallId: "revision-a",
        args: {
          target_event_id: "canvas-a",
          mode: "react",
          agent_steps: ["替换按钮文案", "核对原有交互"],
          edits: [{ find: "Start", replace: "Start setup" }],
        },
      },
      "session-a",
      "session-a",
      ctx
    );

    expect(store.get(canvasRevisionDraftsAtom).get("session-a")?.phase).toBe(
      "applying"
    );

    await handleToolResult(
      {
        type: "agent:tool_result",
        sessionId: "session-a",
        tool: "revise_inline_canvas",
        toolCallId: "revision-a",
        result: "accepted",
      },
      "session-a",
      ctx
    );

    expect(store.get(canvasRevisionDraftsAtom).has("session-a")).toBe(false);
  });

  it("clears a partial draft on cancellation, error, or adapter disposal", () => {
    const store = createStore();
    registerSession(store, "session-a");
    const ctx = context(store);
    handleToolCallDelta(
      {
        type: "agent:tool_call_delta",
        tool: "revise_inline_canvas",
        toolCallId: "revision-a",
        argumentsDelta: '{"target_event_id":"canvas-a"',
      },
      "session-a",
      ctx
    );
    expect(store.get(canvasRevisionDraftsAtom).has("session-a")).toBe(true);

    resetAllStreamingState(ctx);

    expect(store.get(canvasRevisionDraftsAtom).has("session-a")).toBe(false);
  });

  it("clears the draft for the explicit event session, not the adapter filter session", () => {
    const store = createStore();
    registerSession(store, "session-a");
    const ctx = context(store);
    // The adapter ref points elsewhere — e.g. the user switched sessions
    // while this turn's terminal event was still in flight.
    ctx.filterSessionIdRef.current = "session-other";
    handleToolCallDelta(
      {
        type: "agent:tool_call_delta",
        tool: "revise_inline_canvas",
        toolCallId: "revision-a",
        argumentsDelta: '{"target_event_id":"canvas-a"',
      },
      "session-a",
      ctx
    );
    expect(store.get(canvasRevisionDraftsAtom).has("session-a")).toBe(true);

    resetAllStreamingState(ctx, "session-a");

    expect(store.get(canvasRevisionDraftsAtom).has("session-a")).toBe(false);
  });

  it("ignores deltas for sessions that are no longer registered", () => {
    const store = createStore();
    const ctx = context(store);

    handleToolCallDelta(
      {
        type: "agent:tool_call_delta",
        tool: "revise_inline_canvas",
        toolCallId: "revision-a",
        argumentsDelta: '{"target_event_id":"canvas-a"',
      },
      "session-removed",
      ctx
    );

    expect(store.get(canvasRevisionDraftsAtom).has("session-removed")).toBe(
      false
    );
  });

  it("parses streamed metadata at most once per coalescer flush", () => {
    vi.useFakeTimers();
    const store = createStore();
    registerSession(store, "session-a");
    const ctx = context(store);
    const delta = (chunk: string) =>
      handleToolCallDelta(
        {
          type: "agent:tool_call_delta",
          tool: "revise_inline_canvas",
          toolCallId: "revision-a",
          index: 0,
          argumentsDelta: chunk,
        },
        "session-a",
        ctx
      );

    // First delta flushes immediately (first visible draft) — one parse.
    delta('{"target_event_id":"canvas-a","mode":"react",');
    expect(parseCounter.count).toBe(1);

    // A burst of deltas within one 50ms window shares a single trailing
    // flush, so only the final buffered state is parsed.
    delta('"title":"Coffee",');
    delta('"edits":[');
    delta('{"find":"Start",');
    expect(parseCounter.count).toBe(1);

    vi.advanceTimersByTime(60);
    expect(parseCounter.count).toBe(2);
    expect(store.get(canvasRevisionDraftsAtom).get("session-a")).toMatchObject({
      targetEventId: "canvas-a",
      mode: "react",
      title: "Coffee",
    });
  });
});
