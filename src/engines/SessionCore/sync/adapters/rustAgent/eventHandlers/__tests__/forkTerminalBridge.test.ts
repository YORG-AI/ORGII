import { beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchAgentEvent } from "..";
import type { EventHandlerContext } from "../types";

const { getEventsSpy, saveToCacheSpy } = vi.hoisted(() => ({
  getEventsSpy: vi.fn().mockResolvedValue([]),
  saveToCacheSpy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    getEvents: getEventsSpy,
    saveToCache: saveToCacheSpy,
    upsert: vi.fn().mockResolvedValue(undefined),
    append: vi.fn().mockResolvedValue(undefined),
    replaceAndRemove: vi.fn().mockResolvedValue(true),
    removeByIdPrefix: vi.fn().mockResolvedValue(1),
  },
}));

function ref<T>(value: T): { current: T } {
  return { current: value };
}

/** A relay fork's own id: `agentsession-<uuid>` (createForkedSessionId). */
const FORK_SESSION_ID = "agentsession-fddce7b4-6a90-4cad-a52e-689a77e6d406";

function createForkCtx(onStatusChange: ReturnType<typeof vi.fn>) {
  return {
    filterSessionIdRef: ref(FORK_SESSION_ID),
    trackedCodingSessionsRef: ref(new Map<string, string>()),
    assistantStreamRef: ref({ idRef: ref(""), contentRef: ref("") }),
    thinkingStreamRef: ref({ idRef: ref(""), contentRef: ref("") }),
    streamingInfoRef: ref({
      isStreaming: false,
      isThinking: false,
      content: "",
    }),
    onStreamingDeltaRef: ref(vi.fn()),
    onAgentCompleteRef: ref(vi.fn()),
    onContextUsageRef: ref(undefined),
    onTokenUpdateRef: ref(undefined),
    onStatusChangeRef: ref(onStatusChange),
    onQuestionRequestRef: ref(undefined),
    setStreaming: vi.fn(),
    features: { hasCodingSessionBridge: true },
    getDefaultStore: () => null,
  } as unknown as EventHandlerContext;
}

beforeEach(() => {
  getEventsSpy.mockClear().mockResolvedValue([]);
  saveToCacheSpy.mockClear();
});

describe("relay fork terminals are never swallowed by the subagent bridge", () => {
  it("completes the turn for the handler's own agentsession- id", async () => {
    // The fork's own id matches SPAWNED_SESSION_RE, and only terminals carry
    // a sessionId — so before the guard this event was dropped outright and
    // the turn only ended via the 60s planning watchdog.
    const onStatusChange = vi.fn();
    const ctx = createForkCtx(onStatusChange);

    await dispatchAgentEvent(
      {
        type: "agent:complete",
        sessionId: FORK_SESSION_ID,
        content: "ok",
        totalTokens: 10,
      } as never,
      ctx
    );

    expect(onStatusChange).toHaveBeenCalledWith("completed");
  });

  it("still dispatches normally when an untracked spawned id has no active parent call", async () => {
    const onStatusChange = vi.fn();
    const ctx = createForkCtx(onStatusChange);
    // A different session's terminal with no spawning tool_call to attach to:
    // the session filter drops it, but it must not be swallowed by the bridge
    // before the filter can even see it.
    getEventsSpy.mockResolvedValue([]);

    await dispatchAgentEvent(
      {
        type: "agent:complete",
        sessionId: "agentsession-11111111-2222-3333-4444-555555555555",
        content: "other",
      } as never,
      ctx
    );

    expect(onStatusChange).not.toHaveBeenCalled();
  });
});
