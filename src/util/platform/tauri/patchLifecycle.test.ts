// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

describe("Tauri event internals patch lifecycle", () => {
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "window"
  );

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.resetModules();
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, "window", originalWindowDescriptor);
    }
  });

  it("stops a pending startup retry when its window is torn down", async () => {
    vi.useFakeTimers();
    vi.resetModules();

    await import("./index");
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    expect(Reflect.deleteProperty(globalThis, "window")).toBe(true);
    expect(typeof window).toBe("undefined");

    expect(() => vi.runAllTimers()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
