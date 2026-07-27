import { describe, expect, it, vi } from "vitest";

import { createHistoryStartBackfillGate } from "../useChatViewportController";

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

  it("coalesces one rapid wheel gesture into four sequential bounded reads", async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const third = deferred<boolean>();
    const fourth = deferred<boolean>();
    const loadPrevious = vi
      .fn<() => Promise<boolean | void>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise)
      .mockReturnValueOnce(fourth.promise);
    const gate = createHistoryStartBackfillGate(loadPrevious);

    // Reaching the physical top starts one bounded read. Further wheel ticks
    // from the same trackpad gesture cannot start concurrent work or multiply
    // the fixed user-burst budget.
    gate.signal({ atStart: true, source: "scroll" });
    gate.signal({ atStart: true, source: "wheel" });
    gate.signal({ atStart: true, source: "wheel" });
    // Prepending preserves the visible anchor and therefore emits a non-top
    // scroll measurement. Geometry alone must not cancel the active burst.
    gate.signal({ atStart: false, source: "scroll" });
    expect(loadPrevious).toHaveBeenCalledTimes(1);

    first.resolve(true);
    await flushPromises();
    expect(loadPrevious).toHaveBeenCalledTimes(2);

    second.resolve(true);
    await flushPromises();
    expect(loadPrevious).toHaveBeenCalledTimes(3);

    third.resolve(true);
    await flushPromises();
    expect(loadPrevious).toHaveBeenCalledTimes(4);

    fourth.resolve(true);
    await flushPromises();
    expect(loadPrevious).toHaveBeenCalledTimes(4);
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
