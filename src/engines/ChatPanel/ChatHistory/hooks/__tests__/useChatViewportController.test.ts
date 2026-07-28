import { describe, expect, it, vi } from "vitest";

import {
  HISTORY_START_MAX_USER_IPC_BYTES,
  createHistoryStartBackfillGate,
  shouldForwardHistoryStartSignal,
} from "../useChatViewportController";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createHistoryStartBackfillGate", () => {
  it("requires explicit upward-wheel demand after a paginated Round switch", () => {
    expect(shouldForwardHistoryStartSignal(true, "scroll")).toBe(false);
    expect(shouldForwardHistoryStartSignal(true, "wheel")).toBe(true);
    expect(shouldForwardHistoryStartSignal(false, "scroll")).toBe(true);
  });

  it("shares one coordinator between bootstrap and rapid user scroll-back", async () => {
    const bootstrap = deferred();
    const userContinuation = deferred<boolean>();
    const loadPrevious = vi
      .fn<() => Promise<boolean | void>>()
      .mockReturnValueOnce(bootstrap.promise)
      .mockReturnValueOnce(userContinuation.promise);
    const gate = createHistoryStartBackfillGate(loadPrevious);

    const bootstrapLoad = gate.bootstrap();
    gate.signal({ atStart: true, source: "wheel" });
    gate.signal({ atStart: true, source: "wheel" });
    expect(loadPrevious).toHaveBeenCalledTimes(1);

    bootstrap.resolve();
    await bootstrapLoad;
    await flushPromises();
    expect(loadPrevious).toHaveBeenCalledTimes(2);

    userContinuation.resolve(false);
    await flushPromises();
    expect(loadPrevious).toHaveBeenCalledTimes(2);
  });

  it("retains capped trackpad momentum that arrives during bootstrap", async () => {
    const bootstrap = deferred<boolean>();
    const userWindows = Array.from({ length: 12 }, () => deferred<boolean>());
    const loadPrevious = vi
      .fn<() => Promise<boolean | void>>()
      .mockReturnValueOnce(bootstrap.promise);
    userWindows.forEach((window) => {
      loadPrevious.mockReturnValueOnce(window.promise);
    });
    const gate = createHistoryStartBackfillGate(loadPrevious);

    const bootstrapLoad = gate.bootstrap();
    for (let index = 0; index < 20; index += 1) {
      gate.signal({ atStart: true, source: "wheel" });
    }
    expect(loadPrevious).toHaveBeenCalledTimes(1);

    bootstrap.resolve(true);
    await bootstrapLoad;
    await flushPromises();
    expect(loadPrevious).toHaveBeenCalledTimes(2);

    for (let index = 0; index < userWindows.length; index += 1) {
      userWindows[index].resolve(true);
      await flushPromises();
      expect(loadPrevious).toHaveBeenCalledTimes(
        Math.min(index + 3, userWindows.length + 1)
      );
    }
    expect(loadPrevious).toHaveBeenCalledTimes(13);
  });

  it("runs at most one bootstrap per replay episode", async () => {
    const loadPrevious = vi.fn().mockResolvedValue(undefined);
    const gate = createHistoryStartBackfillGate(loadPrevious);

    await gate.bootstrap();
    await gate.bootstrap();
    expect(loadPrevious).toHaveBeenCalledTimes(1);

    gate.reset();
    await gate.bootstrap();
    expect(loadPrevious).toHaveBeenCalledTimes(2);
  });

  it("does not let a stale bootstrap completion suppress a reopened episode", async () => {
    const stale = deferred();
    const loadPrevious = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue(undefined);
    const gate = createHistoryStartBackfillGate(loadPrevious);

    const staleLoad = gate.bootstrap();
    gate.reset();
    stale.resolve();
    await staleLoad;

    await gate.bootstrap();
    expect(loadPrevious).toHaveBeenCalledTimes(2);
  });

  it("treats layout as geometry only and never chains reads after a page merge", async () => {
    const first = deferred<boolean>();
    const loadPrevious = vi.fn(() => first.promise);
    const gate = createHistoryStartBackfillGate(loadPrevious);

    gate.signal({ atStart: true, source: "layout" });
    expect(loadPrevious).not.toHaveBeenCalled();

    gate.signal({ atStart: true, source: "scroll" });
    expect(loadPrevious).toHaveBeenCalledTimes(1);

    // The bounded page changes virtualListDataKey and reports layout again
    // while the read is in flight and after it settles. Neither signal is a
    // second user request.
    gate.signal({ atStart: true, source: "layout" });
    first.resolve(false);
    await flushPromises();
    gate.signal({ atStart: true, source: "layout" });
    await flushPromises();

    expect(loadPrevious).toHaveBeenCalledTimes(1);
  });

  it("does not treat an imperative Round navigation as user demand for an older page", () => {
    const loadPrevious = vi.fn();
    const gate = createHistoryStartBackfillGate(loadPrevious);

    gate.signal({ atStart: true, source: "programmatic" });

    expect(loadPrevious).not.toHaveBeenCalled();
  });

  it("retains rapid wheel demand up to the bounded burst cap", async () => {
    const windows = Array.from({ length: 12 }, () => deferred<boolean>());
    const loadPrevious = vi.fn<() => Promise<boolean | void>>();
    windows.forEach((window) => {
      loadPrevious.mockReturnValueOnce(window.promise);
    });
    const gate = createHistoryStartBackfillGate(loadPrevious);

    // Reaching the near-start runway starts the baseline bounded burst.
    // Trackpad momentum arriving while reads are in flight extends the same
    // serialized burst instead of disappearing.
    gate.signal({ atStart: true, source: "scroll" });
    for (let index = 0; index < 20; index += 1) {
      gate.signal({ atStart: true, source: "wheel" });
    }
    // Prepending preserves the visible anchor and therefore emits a non-top
    // scroll measurement. Geometry alone must not cancel the active burst.
    gate.signal({ atStart: false, source: "scroll" });
    expect(loadPrevious).toHaveBeenCalledTimes(1);

    for (let index = 0; index < windows.length; index += 1) {
      windows[index].resolve(true);
      await flushPromises();
      expect(loadPrevious).toHaveBeenCalledTimes(
        Math.min(index + 2, windows.length)
      );
    }
    expect(loadPrevious).toHaveBeenCalledTimes(12);
  });

  it("stops a momentum burst when its cumulative IPC budget is exhausted", async () => {
    const perWindowBytes = HISTORY_START_MAX_USER_IPC_BYTES / 4;
    const loadPrevious = vi.fn().mockResolvedValue({
      ipcBytes: perWindowBytes,
      progressed: true,
    });
    const gate = createHistoryStartBackfillGate(loadPrevious);

    gate.signal({ atStart: true, source: "scroll" });
    for (let index = 0; index < 20; index += 1) {
      gate.signal({ atStart: true, source: "wheel" });
    }
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(loadPrevious).toHaveBeenCalledTimes(4);
  });

  it("waits for each window lifecycle before requesting the next one", async () => {
    const firstLayout = deferred();
    const secondLayout = deferred();
    const loadPrevious = vi.fn().mockResolvedValue(true);
    const gate = createHistoryStartBackfillGate(loadPrevious, {
      onWindowLoaded: vi
        .fn()
        .mockReturnValueOnce(firstLayout.promise)
        .mockReturnValueOnce(secondLayout.promise)
        .mockResolvedValue(undefined),
    });

    gate.signal({ atStart: true, source: "scroll" });
    await flushPromises();
    expect(loadPrevious).toHaveBeenCalledTimes(1);

    firstLayout.resolve();
    await flushPromises();
    expect(loadPrevious).toHaveBeenCalledTimes(2);

    secondLayout.resolve();
  });

  it("cancels queued intent when a positive wheel reverses direction", async () => {
    const first = deferred<boolean>();
    const loadPrevious = vi.fn(() => first.promise);
    const gate = createHistoryStartBackfillGate(loadPrevious);

    gate.signal({ atStart: true, source: "scroll" });
    gate.signal({ atStart: true, source: "wheel" });
    gate.signal({ atStart: false, source: "wheel" });
    first.resolve(true);
    await flushPromises();

    expect(loadPrevious).toHaveBeenCalledTimes(1);
  });

  it("re-arms after a failed page and invalidates completions on reset", async () => {
    const stale = deferred();
    const current = deferred();
    const loadPrevious = vi
      .fn<() => Promise<boolean | void>>()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise)
      .mockResolvedValue(false);
    const gate = createHistoryStartBackfillGate(loadPrevious);

    gate.signal({ atStart: true, source: "scroll" });
    gate.signal({ atStart: true, source: "wheel" });
    gate.reset();
    gate.signal({ atStart: true, source: "scroll" });

    stale.reject(new Error("stale session"));
    await flushPromises();
    expect(loadPrevious).toHaveBeenCalledTimes(2);

    current.reject(new Error("current page failed"));
    await flushPromises();
    gate.signal({ atStart: true, source: "wheel" });
    expect(loadPrevious).toHaveBeenCalledTimes(3);
  });
});
