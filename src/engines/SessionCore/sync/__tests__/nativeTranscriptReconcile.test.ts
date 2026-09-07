import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { selectConversationRunnerTail } from "@src/features/Org2Cloud/SessionConversation/conversationRunnerOverlay";

import {
  reconcileNativeTranscript,
  recoverNativeTranscriptAfterMismatch,
  scheduleNativeTranscriptReconcile,
} from "../nativeTranscriptReconcile";

const mocks = vi.hoisted(() => ({
  loadAuthoritative: vi.fn(),
  getPersisted: vi.fn(),
  set: vi.fn(),
  setStreaming: vi.fn(),
  cliStatus: vi.fn(),
  closeTerminalEvents: vi.fn(),
}));

vi.mock("@src/api/tauri/rpc", () => ({
  rpc: { cli: { status: mocks.cliStatus } },
}));

vi.mock("../adapters/cli/cliLifecycle", () => ({
  closeObservedCliTerminalEvents: mocks.closeTerminalEvents,
  isCliTerminalStatus: (status: string | undefined) =>
    [
      "completed",
      "failed",
      "error",
      "cancelled",
      "abandoned",
      "timeout",
    ].includes(status ?? ""),
}));

vi.mock("../authoritativeSessionEvents", () => ({
  loadAuthoritativeSessionEvents: mocks.loadAuthoritative,
}));

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    getPersistedEvents: mocks.getPersisted,
    set: mocks.set,
    setStreaming: mocks.setStreaming,
  },
}));

function makeEvent(id: string, sessionId: string): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId,
    createdAt: "2026-08-01T00:00:00.000Z",
    functionName: "assistant_message",
    uiCanonical: "assistant_message",
    actionType: "assistant",
    args: {},
    result: { observation: id },
    source: "assistant",
    displayText: id,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
  };
}

function historySequence(sequence: SessionEvent[][]): void {
  let call = 0;
  mocks.loadAuthoritative.mockImplementation(async () => ({
    events: sequence[Math.min(call++, sequence.length - 1)] ?? [],
    source: "cli_history",
  }));
}

describe("single-owner native transcript reconcile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cliStatus.mockResolvedValue({ transcriptSource: "native" });
    mocks.closeTerminalEvents.mockResolvedValue(undefined);
    mocks.getPersisted.mockResolvedValue([]);
    mocks.set.mockResolvedValue(undefined);
    mocks.setStreaming.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not schedule a non-native Session", async () => {
    const sessionId = "reconcile-legacy";
    mocks.cliStatus.mockResolvedValue({ transcriptSource: "chunks" });
    historySequence([[makeEvent("a", sessionId)]]);
    scheduleNativeTranscriptReconcile(sessionId);
    await vi.waitFor(() => expect(mocks.cliStatus).toHaveBeenCalledOnce());
    expect(mocks.loadAuthoritative).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("publishes the provider transcript and closes streaming", async () => {
    const sessionId = "reconcile-publish";
    const events = [makeEvent("a", sessionId)];
    historySequence([events]);

    await expect(reconcileNativeTranscript(sessionId)).resolves.toEqual(events);
    expect(mocks.loadAuthoritative).toHaveBeenCalledTimes(1);
    expect(mocks.getPersisted).toHaveBeenCalledWith(sessionId);
    expect(mocks.set).toHaveBeenCalledWith(events, sessionId);
    expect(mocks.setStreaming).toHaveBeenCalledWith(false, sessionId);
  });

  it("clears a stale projection when the authoritative transcript is empty", async () => {
    const sessionId = "reconcile-authoritative-empty";
    historySequence([[]]);

    await expect(reconcileNativeTranscript(sessionId)).resolves.toEqual([]);
    expect(mocks.loadAuthoritative).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenCalledWith([], sessionId);
    expect(mocks.setStreaming).toHaveBeenCalledWith(false, sessionId);
  });

  it("does not treat an unavailable authoritative loader as an empty transcript", async () => {
    const sessionId = "reconcile-loader-unavailable";
    mocks.loadAuthoritative.mockRejectedValueOnce(
      new Error("authoritative reader unavailable")
    );

    await expect(reconcileNativeTranscript(sessionId)).rejects.toThrow(
      "authoritative reader unavailable"
    );
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.setStreaming).not.toHaveBeenCalled();
  });

  it("retries only after an explicit semantic mismatch and stops when recovered", async () => {
    vi.useFakeTimers();
    const sessionId = "reconcile-late-flush";
    const first = [makeEvent("a", sessionId)];
    const grown = [...first, makeEvent("late", sessionId)];
    historySequence([grown]);

    const resultPromise = recoverNativeTranscriptAfterMismatch(
      sessionId,
      first,
      (events) => events.length === grown.length
    );
    expect(mocks.loadAuthoritative).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(249);
    expect(mocks.loadAuthoritative).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(resultPromise).resolves.toEqual(grown);
    expect(mocks.loadAuthoritative).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenLastCalledWith(grown, sessionId);
  });

  it("bounds mismatch recovery when the native transcript never catches up", async () => {
    vi.useFakeTimers();
    const sessionId = "reconcile-still-missing";
    const events = [makeEvent("before", sessionId)];
    historySequence([events]);

    const resultPromise = recoverNativeTranscriptAfterMismatch(
      sessionId,
      events,
      () => false
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(resultPromise).resolves.toEqual(events);
    expect(mocks.loadAuthoritative).toHaveBeenCalledTimes(2);
    expect(mocks.set).toHaveBeenCalledTimes(2);
  });

  it("coalesces foreground and background callers into one reconcile", async () => {
    const sessionId = "reconcile-coalesced";
    const events = [makeEvent("a", sessionId)];
    historySequence([events]);

    const first = reconcileNativeTranscript(sessionId);
    const second = reconcileNativeTranscript(sessionId);
    scheduleNativeTranscriptReconcile(sessionId);
    expect(second).toBe(first);
    await first;
    expect(mocks.loadAuthoritative).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenCalledTimes(1);
  });

  it("upgrades an in-flight job to preserve an interrupted partial suffix", async () => {
    const sessionId = "reconcile-interrupted";
    const native = [makeEvent("native", sessionId)];
    const partial = makeEvent("partial", sessionId);
    mocks.cliStatus.mockResolvedValue({
      transcriptSource: "native",
      status: "cancelled",
    });
    historySequence([native]);
    mocks.getPersisted.mockResolvedValue([...native, partial]);

    const first = reconcileNativeTranscript(sessionId);
    const joined = reconcileNativeTranscript(sessionId, {
      preserveInterruptedSuffix: true,
    });
    expect(joined).toBe(first);
    await expect(first).resolves.toEqual([...native, partial]);
    expect(mocks.getPersisted).toHaveBeenCalledWith(sessionId);
    expect(mocks.set).toHaveBeenCalledWith([...native, partial], sessionId);
    expect(mocks.closeTerminalEvents).toHaveBeenCalledWith(
      sessionId,
      "cancelled"
    );
    expect(mocks.closeTerminalEvents.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getPersisted.mock.invocationCallOrder[0]
    );
  });

  it("keeps a durable failed user delivery across terminal native reconcile", async () => {
    const sessionId = "reconcile-failed-delivery";
    const native = [makeEvent("native", sessionId)];
    const failed = {
      ...makeEvent("queued-user:q1:", sessionId),
      functionName: "user_message",
      actionType: "raw",
      source: "user",
      displayText: "retry me",
      displayStatus: "failed",
      result: {
        syntheticUserInput: true,
        deliveryStatus: "failed",
        deliveryError: "provider unavailable",
        turnIntentId: "turn-failed",
        message: { role: "user", content: "retry me" },
      },
    } as SessionEvent;
    historySequence([native]);
    mocks.getPersisted.mockResolvedValue([failed]);

    await expect(reconcileNativeTranscript(sessionId)).resolves.toEqual([
      ...native,
      failed,
    ]);
    expect(mocks.set).toHaveBeenCalledWith([...native, failed], sessionId);
  });

  it("keeps the exact accepted turn visible when native terminal rows replace live ids", async () => {
    const sessionId = "reconcile-terminal-overlay";
    const user = (id: string, turnIntentId?: string): SessionEvent => ({
      ...makeEvent(id, sessionId),
      source: "user",
      functionName: "user_message",
      uiCanonical: "user_message",
      displayText: "repeat",
      result: {
        message: { role: "user", content: "repeat" },
        ...(turnIntentId ? { turnIntentId } : {}),
      },
    });
    const oldUser = user("native-old-user");
    const oldAnswer = makeEvent("old-answer", sessionId);
    const tool = (id: string, callId: string): SessionEvent => ({
      ...makeEvent(id, sessionId),
      functionName: "read_file",
      uiCanonical: "tool_call",
      actionType: "tool_call",
      callId,
      args: { path: "/repo/README.md" },
      result: { status: "completed", output: "file contents" },
      displayVariant: "tool_call",
    });
    const nativeUser = user("native-new-user");
    const compact = {
      ...makeEvent("compact", sessionId),
      functionName: "context_compacted",
      actionType: "context_compacted",
    };
    const final = makeEvent("native-final", sessionId);
    const following = user("native-following-user");
    const otherAnswer = makeEvent("other-answer", sessionId);
    const native = [
      oldUser,
      oldAnswer,
      tool("native-tool", "provider_alias"),
      nativeUser,
      compact,
      final,
      following,
      otherAnswer,
    ];
    historySequence([native]);
    mocks.getPersisted.mockResolvedValue([
      oldUser,
      oldAnswer,
      tool("projected-tool", "old_call_id"),
      user("optimistic-current", "intent-current"),
      {
        ...makeEvent("live-final", sessionId),
        result: { turnIntentId: "intent-current" },
      },
      {
        ...user("queued-next", "intent-next"),
        displayStatus: "pending",
        result: {
          ...user("queued-next", "intent-next").result,
          deliveryStatus: "pending",
        },
      },
    ]);
    const settled = await reconcileNativeTranscript(sessionId);
    expect(settled[0].result?.turnIntentId).toBeUndefined();
    expect(settled[2].result?.turnIntentId).toBeUndefined();
    expect(settled[3].result?.turnIntentId).toBe("intent-current");
    expect(settled[5].displayText).toBe("native-final");
    expect(settled[6].result?.turnIntentId).toBeUndefined();
    expect(
      selectConversationRunnerTail(
        {
          runnerSessionId: sessionId,
          turnId: "intent-current",
          eventStartIndex: 2,
        },
        settled
      ).map((event) => event.id)
    ).toEqual(["compact", "native-final"]);
    expect(mocks.set).toHaveBeenCalledWith(settled, sessionId);
  });

  it("does not move intent identity onto equal text after a divergent native prefix", async () => {
    const sessionId = "reconcile-divergent-prefix";
    const user = {
      ...makeEvent("user", sessionId),
      source: "user",
      result: {
        turnIntentId: "current",
        message: { role: "user", content: "repeat" },
      },
    } as SessionEvent;
    const nativeUser = {
      ...user,
      result: { message: { role: "user", content: "repeat" } },
    };
    const native = [
      makeEvent("different-history", sessionId),
      nativeUser,
      makeEvent("answer", sessionId),
    ];
    historySequence([native]);
    mocks.getPersisted.mockResolvedValue([
      makeEvent("old-history", sessionId),
      user,
    ]);
    await expect(reconcileNativeTranscript(sessionId)).resolves.toEqual(native);
  });

  it("does not erase delivery metadata when the projection read fails", async () => {
    const sessionId = "reconcile-projection-unavailable";
    historySequence([[makeEvent("native", sessionId)]]);
    mocks.getPersisted.mockRejectedValueOnce(
      new Error("projection unavailable")
    );
    await expect(reconcileNativeTranscript(sessionId)).rejects.toThrow(
      "projection unavailable"
    );
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("releases a failed job so a later terminal can retry", async () => {
    const sessionId = "reconcile-retry-after-error";
    mocks.loadAuthoritative.mockRejectedValueOnce(new Error("store locked"));

    const failed = reconcileNativeTranscript(sessionId);
    const failureAssertion = expect(failed).rejects.toThrow("store locked");
    await failureAssertion;

    const recovered = [makeEvent("recovered", sessionId)];
    historySequence([recovered]);
    const retry = reconcileNativeTranscript(sessionId);
    await expect(retry).resolves.toEqual(recovered);
  });
});
