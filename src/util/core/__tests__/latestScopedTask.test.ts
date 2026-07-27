import { describe, expect, it, vi } from "vitest";

import { LatestScopedTask } from "../latestScopedTask";

describe("LatestScopedTask", () => {
  it("shares one promise for the same scope", async () => {
    const coordinator = new LatestScopedTask();
    const operation = vi.fn().mockResolvedValue("done");

    const first = coordinator.run("same", operation);
    const second = coordinator.run("same", operation);

    expect(first).toBe(second);
    await expect(first).resolves.toBe("done");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("marks an older scope stale as soon as a newer scope starts", async () => {
    const coordinator = new LatestScopedTask();
    let oldIsCurrent!: () => boolean;
    let release!: () => void;
    const old = coordinator.run(
      "old",
      (context) =>
        new Promise<void>((resolve) => {
          oldIsCurrent = context.isCurrent;
          release = resolve;
        })
    );

    await coordinator.run("new", async (context) => {
      expect(context.isCurrent()).toBe(true);
    });
    expect(oldIsCurrent()).toBe(false);
    release();
    await old;
  });

  it("retries a scope after failure", async () => {
    const coordinator = new LatestScopedTask();
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValueOnce("retried");

    await expect(coordinator.run("scope", operation)).rejects.toThrow("failed");
    await expect(coordinator.run("scope", operation)).resolves.toBe("retried");
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
