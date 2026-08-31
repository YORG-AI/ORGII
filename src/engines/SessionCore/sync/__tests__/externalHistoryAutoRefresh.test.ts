import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ExternalHistoryRefreshSchedulerEnvironment,
  type TranscriptSettleState,
  externalHistoryReloadCooldownMs,
  refreshImportedHistorySession,
  shouldWaitForStableTranscript,
  startExternalHistoryRefreshScheduler,
} from "../externalHistoryAutoRefresh";

const mocks = vi.hoisted(() => ({
  loadHistory: vi.fn(),
  loadHistoryFromObservedSignature: vi.fn(),
  getAdapterForSession: vi.fn(),
}));

vi.mock("../types", () => ({
  getAdapterForSession: mocks.getAdapterForSession,
}));

class RefreshSchedulerEnvironment implements ExternalHistoryRefreshSchedulerEnvironment {
  hidden = false;
  focused = true;
  private readonly focusListeners = new Set<() => void>();
  private readonly blurListeners = new Set<() => void>();
  private readonly visibilityListeners = new Set<() => void>();

  isHidden(): boolean {
    return this.hidden;
  }

  isFocused(): boolean {
    return this.focused && !this.hidden;
  }

  setTimer(
    callback: () => void,
    delayMs: number
  ): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  }

  clearTimer(timer: ReturnType<typeof setTimeout>): void {
    clearTimeout(timer);
  }

  subscribeFocus(callback: () => void): () => void {
    this.focusListeners.add(callback);
    return () => this.focusListeners.delete(callback);
  }

  subscribeBlur(callback: () => void): () => void {
    this.blurListeners.add(callback);
    return () => this.blurListeners.delete(callback);
  }

  subscribeVisibility(callback: () => void): () => void {
    this.visibilityListeners.add(callback);
    return () => this.visibilityListeners.delete(callback);
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
    const listeners = focused ? this.focusListeners : this.blurListeners;
    for (const listener of listeners) listener();
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of this.visibilityListeners) listener();
  }
}

describe("refreshImportedHistorySession", () => {
  beforeEach(() => {
    mocks.loadHistory.mockReset();
    mocks.loadHistoryFromObservedSignature.mockReset();
    mocks.getAdapterForSession.mockReset().mockReturnValue({
      category: "external_history",
      loadHistory: mocks.loadHistory,
      loadHistoryFromObservedSignature: mocks.loadHistoryFromObservedSignature,
    });
  });

  it("reuses a signature already observed by the refresh scheduler", async () => {
    const events = [
      {
        id: "event-1",
        sessionId: "codexapp-active",
        createdAt: "2026-07-16T05:00:00.000Z",
      },
    ];
    mocks.loadHistoryFromObservedSignature.mockResolvedValue(events);
    const dispatchLoadSession = vi.fn();
    const controller = new AbortController();

    await expect(
      refreshImportedHistorySession(
        "codexapp-active",
        controller.signal,
        dispatchLoadSession,
        "100:200"
      )
    ).resolves.toBe(true);

    expect(mocks.loadHistoryFromObservedSignature).toHaveBeenCalledWith(
      "codexapp-active",
      controller.signal,
      "100:200"
    );
    expect(mocks.loadHistory).not.toHaveBeenCalled();
  });

  it("reloads and publishes the currently open external transcript", async () => {
    const events = [
      {
        id: "event-1",
        sessionId: "codexapp-active",
        createdAt: "2026-07-16T05:00:00.000Z",
      },
    ];
    mocks.loadHistory.mockResolvedValue(events);
    const dispatchLoadSession = vi.fn();
    const controller = new AbortController();

    await expect(
      refreshImportedHistorySession(
        "codexapp-active",
        controller.signal,
        dispatchLoadSession
      )
    ).resolves.toBe(true);

    expect(mocks.loadHistory).toHaveBeenCalledWith(
      "codexapp-active",
      controller.signal
    );
    expect(dispatchLoadSession).toHaveBeenCalledWith({
      sessionId: "codexapp-active",
      events,
      replace: true,
    });
  });

  it("does not poll a native ORGII session", async () => {
    await expect(
      refreshImportedHistorySession(
        "osagent-native",
        new AbortController().signal,
        vi.fn()
      )
    ).resolves.toBe(false);

    expect(mocks.getAdapterForSession).not.toHaveBeenCalled();
  });
});

describe("startExternalHistoryRefreshScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules the actual background cadence instead of foreground wakeups", async () => {
    const environment = new RefreshSchedulerEnvironment();
    environment.focused = false;
    const poll = vi.fn(() => Promise.resolve());
    const stop = startExternalHistoryRefreshScheduler({
      poll,
      foregroundIntervalMs: 3_000,
      environment,
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(1);

    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("owns no hidden timer and refreshes once when visible or focused", async () => {
    const environment = new RefreshSchedulerEnvironment();
    const poll = vi.fn(() => Promise.resolve());
    const onHidden = vi.fn();
    const stop = startExternalHistoryRefreshScheduler({
      poll,
      foregroundIntervalMs: 3_000,
      onHidden,
      environment,
    });

    expect(vi.getTimerCount()).toBe(1);
    environment.setHidden(true);
    expect(onHidden).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).not.toHaveBeenCalled();

    environment.setHidden(false);
    expect(poll).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    environment.setFocused(true);
    expect(poll).toHaveBeenCalledTimes(1);

    environment.setFocused(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(poll).toHaveBeenCalledTimes(1);
    environment.setFocused(true);
    expect(poll).toHaveBeenCalledTimes(2);

    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never overlaps and does not reschedule after disposal", async () => {
    const environment = new RefreshSchedulerEnvironment();
    let resolvePoll!: () => void;
    const poll = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePoll = resolve;
        })
    );
    const stop = startExternalHistoryRefreshScheduler({
      poll,
      foregroundIntervalMs: 1_000,
      environment,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(poll).toHaveBeenCalledTimes(1);
    environment.setFocused(false);
    environment.setFocused(true);
    expect(poll).toHaveBeenCalledTimes(1);

    stop();
    resolvePoll();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("shouldWaitForStableTranscript", () => {
  it("waits for the same changed signature to remain stable", () => {
    const state: TranscriptSettleState = {
      signature: null,
      firstObservedAt: 0,
    };

    expect(shouldWaitForStableTranscript(state, "100:200", 1_000, 5_000)).toBe(
      true
    );
    expect(shouldWaitForStableTranscript(state, "100:200", 5_999, 5_000)).toBe(
      true
    );
    expect(shouldWaitForStableTranscript(state, "100:200", 6_000, 5_000)).toBe(
      false
    );
  });

  it("restarts settling when a live transcript changes again", () => {
    const state: TranscriptSettleState = {
      signature: "100:200",
      firstObservedAt: 1_000,
    };

    expect(shouldWaitForStableTranscript(state, "101:250", 5_000, 5_000)).toBe(
      true
    );
    expect(state).toEqual({ signature: "101:250", firstObservedAt: 5_000 });
  });

  it("does not block sources that cannot provide a signature", () => {
    const state: TranscriptSettleState = {
      signature: null,
      firstObservedAt: 0,
    };
    expect(shouldWaitForStableTranscript(state, null, 1_000, 5_000)).toBe(
      false
    );
  });
});

describe("externalHistoryReloadCooldownMs", () => {
  const mib = 1024 * 1024;

  it("keeps the configured live behavior for ordinary transcripts", () => {
    expect(externalHistoryReloadCooldownMs(64 * mib - 1)).toBe(0);
  });

  it("progressively rate-limits expensive large-transcript reloads", () => {
    expect(externalHistoryReloadCooldownMs(64 * mib)).toBe(15_000);
    expect(externalHistoryReloadCooldownMs(256 * mib)).toBe(30_000);
    expect(externalHistoryReloadCooldownMs(1024 * mib)).toBe(60_000);
  });
});
