import { describe, expect, it, vi } from "vitest";

import { refreshKanbanSources } from "../kanbanRefresh";

describe("refreshKanbanSources", () => {
  it("refreshes local and cloud projections together", async () => {
    const refreshLocal = vi.fn().mockResolvedValue(undefined);
    const refreshCloud = vi.fn().mockResolvedValue(undefined);

    await refreshKanbanSources({ refreshLocal, refreshCloud });

    expect(refreshLocal).toHaveBeenCalledOnce();
    expect(refreshCloud).toHaveBeenCalledOnce();
  });

  it("supports a missing cloud scope through a synchronous no-op", async () => {
    const refreshLocal = vi.fn().mockResolvedValue(undefined);
    const refreshCloud = vi.fn();

    await expect(
      refreshKanbanSources({ refreshLocal, refreshCloud })
    ).resolves.toBeUndefined();
  });

  it("rejects when an authoritative source cannot refresh", async () => {
    const failure = new Error("local roster unavailable");
    const refreshLocal = vi.fn().mockRejectedValue(failure);
    const refreshCloud = vi.fn();

    await expect(
      refreshKanbanSources({ refreshLocal, refreshCloud })
    ).rejects.toBe(failure);
    expect(refreshCloud).toHaveBeenCalledOnce();
  });
});
