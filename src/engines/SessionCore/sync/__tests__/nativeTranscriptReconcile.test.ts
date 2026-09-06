import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

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
    expect(mocks.getPersisted).not.toHaveBeenCalled();
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

    await expect(
      reconcileNativeTranscript(sessionId, {
        preserveInterruptedSuffix: true,
      })
    ).resolves.toEqual([...native, failed]);
    expect(mocks.set).toHaveBeenCalledWith([...native, failed], sessionId);
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
