import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAvailableAgents } = vi.hoisted(() => ({
  getAvailableAgents: vi.fn(),
}));

vi.mock("@src/api/tauri/rpc", () => ({
  rpc: {
    validation: {
      getAvailableAgents,
    },
  },
}));

describe("loadAvailableAgents", () => {
  beforeEach(() => {
    getAvailableAgents.mockReset();
    vi.resetModules();
  });

  it("shares one in-flight IPC request across concurrent consumers", async () => {
    let resolveRequest: ((value: never[]) => void) | undefined;
    getAvailableAgents.mockReturnValue(
      new Promise<never[]>((resolve) => {
        resolveRequest = resolve;
      })
    );
    const { loadAvailableAgents } = await import("./availableAgents");

    const first = loadAvailableAgents();
    const second = loadAvailableAgents();

    expect(second).toBe(first);
    expect(getAvailableAgents).toHaveBeenCalledTimes(1);

    resolveRequest?.([]);
    await expect(first).resolves.toEqual([]);
  });

  it("starts a new request after the previous request settles", async () => {
    getAvailableAgents.mockResolvedValue([]);
    const { loadAvailableAgents } = await import("./availableAgents");

    await loadAvailableAgents();
    await loadAvailableAgents();

    expect(getAvailableAgents).toHaveBeenCalledTimes(2);
  });

  it("allows retry after a rejected request", async () => {
    getAvailableAgents
      .mockRejectedValueOnce(new Error("IPC unavailable"))
      .mockResolvedValueOnce([]);
    const { loadAvailableAgents } = await import("./availableAgents");

    await expect(loadAvailableAgents()).rejects.toThrow("IPC unavailable");
    await expect(loadAvailableAgents()).resolves.toEqual([]);
    expect(getAvailableAgents).toHaveBeenCalledTimes(2);
  });
});
