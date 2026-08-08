import { describe, expect, it } from "vitest";

import { mapWithConcurrency } from "../mapWithConcurrency";

describe("mapWithConcurrency", () => {
  it("bounds active work and preserves result order", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];

    const work = mapWithConcurrency([3, 1, 2, 4], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return value * 10;
    });

    await Promise.resolve();
    expect(active).toBe(2);
    releases.shift()?.();
    releases.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(active).toBe(2);
    releases.shift()?.();
    releases.shift()?.();

    await expect(work).resolves.toEqual([30, 10, 20, 40]);
    expect(peak).toBe(2);
  });

  it("rejects invalid concurrency", async () => {
    await expect(
      mapWithConcurrency([1], 0, async (value) => value)
    ).rejects.toThrow("positive integer");
  });
});
