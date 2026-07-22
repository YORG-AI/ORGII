import { beforeEach, describe, expect, it, vi } from "vitest";

import { waitForCliTerminalBoundary } from "./cliLifecycle";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

describe("CLI lifecycle polling cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aborts the 250ms terminal wait without issuing another status request", async () => {
    mocks.invoke.mockResolvedValue({ status: "running", updatedAt: "u-1" });
    const controller = new AbortController();
    const wait = waitForCliTerminalBoundary("cliagent-a", "u-0", {
      signal: controller.signal,
      pollIntervalMs: 60_000,
    });

    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(wait).resolves.toEqual({
      status: "running",
      updatedAt: "u-1",
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("stops when the exact replay episode is no longer active", async () => {
    let active = true;
    mocks.invoke.mockImplementation(async () => {
      active = false;
      return { status: "running", updatedAt: "u-1" };
    });

    await expect(
      waitForCliTerminalBoundary("cliagent-a", "u-0", {
        isSessionActive: () => active,
        pollIntervalMs: 0,
      })
    ).resolves.toEqual({ status: "running", updatedAt: "u-1" });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
});
