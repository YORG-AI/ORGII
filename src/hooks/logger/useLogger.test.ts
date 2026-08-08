// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isTauriRuntimeHost } from "./useLogger";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

describe("isTauriRuntimeHost", () => {
  it("recognizes the Tauri v2 runtime marker", () => {
    expect(isTauriRuntimeHost({ __TAURI_INTERNALS__: {} })).toBe(true);
  });

  it("does not depend on the removed Tauri v1 global", () => {
    expect(isTauriRuntimeHost({ __TAURI__: {} })).toBe(false);
    expect(isTauriRuntimeHost(undefined)).toBe(false);
  });
});

describe("backend log persistence latch", () => {
  // The shared vitest setup transitively imports this module before any
  // test-file mock can apply, freezing a logger bound to the REAL invoke.
  // A fresh module graph per suite gets one bound to the mock instead.
  let mod: typeof import("./useLogger");
  let log: import("./useLogger").Logger;
  let RETRY_MS: number;
  const backendCalls = () =>
    invokeMock.mock.calls.filter(([cmd]) => cmd === "write_frontend_log");

  beforeEach(async () => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    vi.resetModules();
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    mod = await import("./useLogger");
    mod.__resetLogBackendStateForTests();
    log = mod.createLogger("LatchTest");
    RETRY_MS = mod.LOG_BACKEND_TRANSIENT_RETRY_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps writing after a transient transport failure (short cooldown only)", async () => {
    // One "Failed to fetch" — the IPC custom-protocol → postMessage
    // switchover signature — must NOT kill file logging for the process.
    invokeMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    invokeMock.mockResolvedValue(undefined);

    log.info("line during the blip");
    await vi.advanceTimersByTimeAsync(0);
    expect(backendCalls()).toHaveLength(1);

    // Inside the cooldown: lines are dropped without touching the bridge.
    log.info("line inside cooldown");
    await vi.advanceTimersByTimeAsync(0);
    expect(backendCalls()).toHaveLength(1);

    // After the cooldown: persistence resumes.
    await vi.advanceTimersByTimeAsync(RETRY_MS + 1);
    log.info("line after cooldown");
    await vi.advanceTimersByTimeAsync(0);
    expect(backendCalls()).toHaveLength(2);
  });

  it("latches permanently only when the command does not exist", async () => {
    invokeMock.mockRejectedValue(
      new Error("Command write_frontend_log not found")
    );

    log.info("first line");
    await vi.advanceTimersByTimeAsync(0);
    expect(backendCalls()).toHaveLength(1);

    // Far beyond any cooldown: still latched — the command will never appear
    // in this process.
    await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
    log.info("later line");
    await vi.advanceTimersByTimeAsync(0);
    expect(backendCalls()).toHaveLength(1);
  });

  it("persists every line while the bridge is healthy", async () => {
    invokeMock.mockResolvedValue(undefined);
    log.info("one");
    log.warn("two");
    await vi.advanceTimersByTimeAsync(0);
    expect(backendCalls()).toHaveLength(2);
  });
});
