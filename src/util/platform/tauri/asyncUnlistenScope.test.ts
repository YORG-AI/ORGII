import { describe, expect, it, vi } from "vitest";

import { AsyncUnlistenScope } from "./asyncUnlistenScope";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("AsyncUnlistenScope", () => {
  it("releases a listener that resolves after disposal", async () => {
    const pending = deferred<() => void>();
    const unlisten = vi.fn();
    const scope = new AsyncUnlistenScope();

    const registration = scope.register(() => pending.promise);
    scope.dispose();
    pending.resolve(unlisten);
    await registration;

    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("rolls back earlier listeners when a later registration fails", async () => {
    const firstUnlisten = vi.fn();
    const scope = new AsyncUnlistenScope();

    await expect(
      scope.registerAll([
        async () => firstUnlisten,
        async () => {
          throw new Error("registration failed");
        },
      ])
    ).rejects.toThrow("registration failed");

    expect(firstUnlisten).toHaveBeenCalledOnce();
    expect(scope.isDisposed).toBe(true);
  });

  it("releases active listeners exactly once", async () => {
    const firstUnlisten = vi.fn();
    const secondUnlisten = vi.fn();
    const scope = new AsyncUnlistenScope();
    await scope.registerAll([
      async () => firstUnlisten,
      async () => secondUnlisten,
    ]);

    scope.dispose();
    scope.dispose();

    expect(firstUnlisten).toHaveBeenCalledOnce();
    expect(secondUnlisten).toHaveBeenCalledOnce();
  });

  it("does not start new registrations after disposal", async () => {
    const register = vi.fn(async () => vi.fn());
    const scope = new AsyncUnlistenScope();
    scope.dispose();

    await scope.register(register);

    expect(register).not.toHaveBeenCalled();
  });
});
