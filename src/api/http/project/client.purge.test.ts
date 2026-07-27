import { beforeEach, describe, expect, it, vi } from "vitest";

import { __TESTS_ONLY, purgeExpiredDeletedWorkItems } from "./client";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("expired work-item purge coordination", () => {
  beforeEach(() => {
    __TESTS_ONLY.resetPurgeCoordinator();
    invokeMock.mockReset();
  });

  it("shares an active purge and throttles later filter refreshes", async () => {
    invokeMock.mockResolvedValue(0);

    const first = purgeExpiredDeletedWorkItems("project-a");
    const joined = purgeExpiredDeletedWorkItems("project-a");
    await expect(Promise.all([first, joined])).resolves.toEqual([0, 0]);
    await expect(purgeExpiredDeletedWorkItems("project-a")).resolves.toBe(0);

    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("releases a failed purge so the next request can retry", async () => {
    invokeMock
      .mockRejectedValueOnce(new Error("database busy"))
      .mockResolvedValueOnce(0);

    await expect(purgeExpiredDeletedWorkItems("project-a")).rejects.toThrow(
      "database busy"
    );
    await expect(purgeExpiredDeletedWorkItems("project-a")).resolves.toBe(0);

    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
