import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { dispatchAgentEvent } from "..";
import {
  handleMessageDelta,
  handleStreamingComplete,
  handleThinkingDelta,
} from "../streamHandlers";
import {
  clearSessionStreamingStopped,
  markSessionStreamingStopped,
} from "../streamHelpers";
import type { EventHandlerContext } from "../types";

const { upsertSpy, replaceAndRemoveSpy, removeByIdPrefixSpy } = vi.hoisted(
  () => ({
    upsertSpy: vi.fn().mockResolvedValue(undefined),
    replaceAndRemoveSpy: vi.fn().mockResolvedValue(true),
    removeByIdPrefixSpy: vi.fn().mockResolvedValue(1),
  })
);

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    upsert: upsertSpy,
    replaceAndRemove: replaceAndRemoveSpy,
    removeByIdPrefix: removeByIdPrefixSpy,
    saveToCache: vi.fn().mockResolvedValue(undefined),
  },
}));

function ref<T>(value: T): { current: T } {
  return { current: value };
}

function createCtx(): EventHandlerContext {
  return {
    filterSessionIdRef: ref("session-1"),
    assistantStreamRef: ref({ idRef: ref(""), contentRef: ref("") }),
    thinkingStreamRef: ref({ idRef: ref(""), contentRef: ref("") }),
    execOutputBufferRef: ref(""),
    streamingInfoRef: ref({
      isStreaming: false,
      isThinking: false,
      content: "",
    }),
    onStreamingDeltaRef: ref(vi.fn()),
    onAgentCompleteRef: ref(undefined),
    onContextUsageRef: ref(undefined),
    onTokenUpdateRef: ref(undefined),
    onStatusChangeRef: ref(vi.fn()),
    onQuestionRequestRef: ref(undefined),
    setStreaming: vi.fn(),
    features: {},
    getDefaultStore: () => null,
  };
}

function makeMessageCompleteEvent(): SessionEvent {
  return {
    id: "stream-msg-session-1-1-final",
    chunk_id: null,
    sessionId: "session-1",
    createdAt: "2026-05-22T07:02:25.900Z",
    functionName: "assistant_message",
    uiCanonical: "assistant_message",
    actionType: "assistant",
    args: {},
    result: {
      content: "Done.",
    },
    source: "assistant",
    displayText: "Done.",
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
  };
}

function makeThinkingCompleteEvent(): SessionEvent {
  return {
    id: "stream-think-session-1-1-final",
    chunk_id: null,
    sessionId: "session-1",
    createdAt: "2026-05-22T07:02:25.900Z",
    functionName: "thinking",
    uiCanonical: "thinking",
    actionType: "llm_thinking",
    args: {},
    result: {
      content: "The user wants a simple plan in Chinese.",
      thought: "The user wants a simple plan in Chinese.",
    },
    source: "assistant",
    displayText: "The user wants a simple plan in Chinese.",
    displayStatus: "completed",
    displayVariant: "thinking",
    activityStatus: "agent",
  };
}

describe("Rust Agent stream handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSessionStreamingStopped("session-1");
  });

  it("drops stopped-turn live stream events without poisoning the next turn", async () => {
    const ctx = createCtx();

    await dispatchAgentEvent(
      {
        type: "agent:message_delta",
        sessionId: "session-1",
        turnId: "turn-a",
        content: "before stop",
      },
      ctx
    );
    expect(upsertSpy).not.toHaveBeenCalled();
    vi.clearAllMocks();

    markSessionStreamingStopped("session-1");

    await dispatchAgentEvent(
      {
        type: "agent:message_delta",
        sessionId: "session-1",
        turnId: "turn-a",
        content: "late",
      },
      ctx
    );
    await dispatchAgentEvent(
      {
        type: "agent:thinking_delta",
        sessionId: "session-1",
        turnId: "turn-a",
        content: "late",
      },
      ctx
    );
    await dispatchAgentEvent(
      {
        type: "agent:tool_call_delta",
        sessionId: "session-1",
        turnId: "turn-a",
        toolCallId: "call-1",
        tool: "edit_file",
        argumentsDelta: "{}",
      },
      ctx
    );
    await dispatchAgentEvent(
      {
        type: "agent:streaming_complete",
        sessionId: "session-1",
        turnId: "turn-a",
        streamType: "message",
        event: makeMessageCompleteEvent(),
      },
      ctx
    );

    expect(upsertSpy).not.toHaveBeenCalled();
    expect(replaceAndRemoveSpy).not.toHaveBeenCalled();
    expect(ctx.setStreaming).not.toHaveBeenCalled();
    expect(ctx.onStatusChangeRef.current).not.toHaveBeenCalledWith("running");

    clearSessionStreamingStopped("session-1");
    await dispatchAgentEvent(
      {
        type: "agent:message_delta",
        sessionId: "session-1",
        turnId: "turn-b",
        content: "new turn",
      },
      ctx
    );

    expect(upsertSpy).not.toHaveBeenCalled();
    expect(ctx.setStreaming).toHaveBeenCalledWith(true);
  });

  it("survives hostile late-stream flood after stop without poisoning the next turn", async () => {
    const ctx = createCtx();

    markSessionStreamingStopped("session-1");

    for (let idx = 0; idx < 250; idx += 1) {
      await dispatchAgentEvent(
        {
          type: idx % 2 === 0 ? "agent:message_delta" : "agent:thinking_delta",
          sessionId: "session-1",
          turnId: "turn-late",
          content: `late-${idx} `,
        },
        ctx
      );
    }
    await dispatchAgentEvent(
      {
        type: "agent:streaming_complete",
        sessionId: "session-1",
        turnId: "turn-late",
        streamType: "message",
        event: makeMessageCompleteEvent(),
      },
      ctx
    );

    expect(upsertSpy).not.toHaveBeenCalled();
    expect(replaceAndRemoveSpy).not.toHaveBeenCalled();
    expect(ctx.setStreaming).not.toHaveBeenCalled();
    expect(ctx.onStreamingDeltaRef?.current).not.toHaveBeenCalled();

    clearSessionStreamingStopped("session-1");
    vi.clearAllMocks();

    await dispatchAgentEvent(
      {
        type: "agent:message_delta",
        sessionId: "session-1",
        turnId: "turn-late",
        content: "still late",
      },
      ctx
    );
    expect(ctx.setStreaming).not.toHaveBeenCalled();

    await dispatchAgentEvent(
      {
        type: "agent:message_delta",
        sessionId: "session-1",
        turnId: "turn-new",
        content: "new turn",
      },
      ctx
    );

    expect(upsertSpy).not.toHaveBeenCalled();
    expect(ctx.setStreaming).toHaveBeenCalledWith(true);
    expect(ctx.onStreamingDeltaRef?.current).toHaveBeenCalledWith({
      isStreaming: true,
      isThinking: false,
      content: "new turn",
    });
  });

  it("keeps message deltas in ephemeral streaming state", () => {
    const ctx = createCtx();

    handleMessageDelta(
      { type: "agent:message_delta", content: "Hello" },
      "session-1",
      ctx
    );

    expect(ctx.assistantStreamRef?.current.contentRef.current).toBe("Hello");
    expect(ctx.assistantStreamRef?.current.idRef.current).toMatch(
      /^stream-msg-live-session-1-/
    );
    expect(ctx.onStreamingDeltaRef?.current).toHaveBeenCalledWith({
      isStreaming: true,
      isThinking: false,
      content: "Hello",
    });
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(replaceAndRemoveSpy).not.toHaveBeenCalled();
  });

  it("normalizes cumulative message delta snapshots without durable writes", () => {
    const ctx = createCtx();

    handleMessageDelta(
      { type: "agent:message_delta", content: "Hello" },
      "session-1",
      ctx
    );
    handleMessageDelta(
      { type: "agent:message_delta", content: "Hello world" },
      "session-1",
      ctx
    );

    expect(ctx.assistantStreamRef?.current.contentRef.current).toBe(
      "Hello world"
    );
    expect(ctx.onStreamingDeltaRef?.current).toHaveBeenLastCalledWith({
      isStreaming: true,
      isThinking: false,
      content: "Hello world",
    });
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("does not enqueue durable writes during live message flood", () => {
    const ctx = createCtx();

    for (let idx = 0; idx < 100; idx += 1) {
      handleMessageDelta(
        {
          type: "agent:message_delta",
          sessionId: "session-1",
          turnId: "turn-flood",
          content: `token-${idx} `,
        },
        "session-1",
        ctx
      );
    }

    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("removes live message placeholder on backend-authoritative completion", async () => {
    const ctx = createCtx();
    handleMessageDelta(
      { type: "agent:message_delta", content: "Hello" },
      "session-1",
      ctx
    );
    const completeEvent = makeMessageCompleteEvent();

    await handleStreamingComplete(
      {
        type: "agent:streaming_complete",
        streamType: "message",
        event: completeEvent,
      },
      "session-1",
      ctx
    );

    expect(ctx.assistantStreamRef?.current.idRef.current).toBe("");
    expect(ctx.assistantStreamRef?.current.contentRef.current).toBe("");
    expect(ctx.setStreaming).toHaveBeenCalledWith(false);
    // Stream completion is an intermediate signal — it must NOT be treated
    // as a turn terminal by the FSM ingestion layer.
    expect(ctx.onStatusChangeRef.current).toHaveBeenCalledWith(
      "completed",
      undefined,
      { intermediate: true }
    );
    expect(replaceAndRemoveSpy).not.toHaveBeenCalled();
    expect(removeByIdPrefixSpy).not.toHaveBeenCalled();
  });

  it("agent complete releases streaming UI even when turn_summary is still pending", async () => {
    const ctx = createCtx();
    handleMessageDelta(
      { type: "agent:message_delta", content: "Done." },
      "session-1",
      ctx
    );

    await dispatchAgentEvent(
      {
        type: "agent:complete",
        sessionId: "session-1",
        turnId: "turn-a",
      },
      ctx
    );

    expect(ctx.assistantStreamRef?.current.idRef.current).toBe("");
    expect(ctx.assistantStreamRef?.current.contentRef.current).toBe("");
    expect(ctx.streamingInfoRef?.current).toEqual({
      isStreaming: false,
      isThinking: false,
      content: "",
    });
    expect(ctx.onStreamingDeltaRef?.current).toHaveBeenLastCalledWith({
      isStreaming: false,
      isThinking: false,
      content: "",
    });
    expect(ctx.setStreaming).toHaveBeenCalledWith(false);
    expect(ctx.onStatusChangeRef.current).toHaveBeenCalledWith("completed");

    await dispatchAgentEvent(
      {
        type: "agent:turn_summary",
        sessionId: "session-1",
        turnId: "turn-a",
        createdAt: "2026-05-22T07:02:26.000Z",
        summary: "Summary after completion",
      },
      ctx
    );

    expect(ctx.setStreaming).toHaveBeenCalledTimes(2);
    expect(ctx.onStatusChangeRef.current).toHaveBeenCalledTimes(1);
  });

  it("keeps thinking deltas in ephemeral streaming state", () => {
    const ctx = createCtx();

    handleThinkingDelta(
      { type: "agent:thinking_delta", content: "Thinking" },
      "session-1",
      ctx
    );

    expect(ctx.thinkingStreamRef?.current.contentRef.current).toBe("Thinking");
    expect(ctx.thinkingStreamRef?.current.idRef.current).toMatch(
      /^stream-think-live-session-1-/
    );
    expect(ctx.onStreamingDeltaRef?.current).toHaveBeenCalledWith({
      isStreaming: true,
      isThinking: true,
      content: "Thinking",
    });
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(replaceAndRemoveSpy).not.toHaveBeenCalled();
  });

  it("normalizes cumulative thinking delta snapshots without durable writes", () => {
    const ctx = createCtx();

    handleThinkingDelta(
      { type: "agent:thinking_delta", content: "Thinking" },
      "session-1",
      ctx
    );
    handleThinkingDelta(
      { type: "agent:thinking_delta", content: "Thinking through it" },
      "session-1",
      ctx
    );

    expect(ctx.thinkingStreamRef?.current.contentRef.current).toBe(
      "Thinking through it"
    );
    expect(ctx.onStreamingDeltaRef?.current).toHaveBeenLastCalledWith({
      isStreaming: true,
      isThinking: true,
      content: "Thinking through it",
    });
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("removes live thinking placeholder on backend-authoritative completion", async () => {
    const ctx = createCtx();
    handleThinkingDelta(
      { type: "agent:thinking_delta", content: "Thinking" },
      "session-1",
      ctx
    );
    const completeEvent = makeThinkingCompleteEvent();

    await handleStreamingComplete(
      {
        type: "agent:streaming_complete",
        streamType: "thinking",
        event: completeEvent,
      },
      "session-1",
      ctx
    );

    expect(ctx.thinkingStreamRef?.current.idRef.current).toBe("");
    expect(ctx.thinkingStreamRef?.current.contentRef.current).toBe("");
    expect(ctx.onStreamingDeltaRef?.current).toHaveBeenLastCalledWith({
      isStreaming: false,
      isThinking: false,
      content: "",
    });
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(replaceAndRemoveSpy).not.toHaveBeenCalled();
    expect(removeByIdPrefixSpy).not.toHaveBeenCalled();
  });
});
