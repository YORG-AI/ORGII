import { describe, expect, it } from "vitest";

import {
  appendMerkleFrontier,
  buildMerkleFrontier,
  hashStringList,
  isValidMerkleFrontier,
  merkleFrontierCommitment,
} from "./org2CloudMerkleFrontier";

function fakeHashes(count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    `h${index}`.padEnd(64, "0")
  );
}

describe("org2CloudMerkleFrontier", () => {
  it("append after any split equals the batch build over the whole sequence", async () => {
    // The incremental path extends the persisted frontier with only the new
    // event hashes; correctness of every later commitment check rests on the
    // two constructions agreeing at every count and split point.
    for (const total of [0, 1, 2, 3, 4, 5, 8, 13, 16, 31, 32, 33, 64]) {
      const hashes = fakeHashes(total);
      const batch = await buildMerkleFrontier(hashes);
      for (const split of new Set([
        0,
        1,
        Math.floor(total / 2),
        Math.max(0, total - 1),
        total,
      ])) {
        const appended = await appendMerkleFrontier(
          await buildMerkleFrontier(hashes.slice(0, split)),
          split,
          hashes.slice(split)
        );
        expect(
          await merkleFrontierCommitment(appended, total),
          `split ${split} of ${total}`
        ).toBe(await merkleFrontierCommitment(batch, total));
      }
    }
  });

  it("commitments survive a JSON persistence round trip of the frontier", async () => {
    // buildMerkleFrontier leaves holes at even heights; storage persists
    // them as null. Both forms must commit identically or every restart
    // silently invalidates the checkpoint.
    for (const total of [1, 4, 5, 21]) {
      const frontier = await buildMerkleFrontier(fakeHashes(total));
      const reloaded = JSON.parse(JSON.stringify(frontier)) as Array<
        string | null
      >;
      expect(await merkleFrontierCommitment(reloaded, total)).toBe(
        await merkleFrontierCommitment(frontier, total)
      );
      expect(isValidMerkleFrontier(reloaded, total)).toBe(true);
    }
  });

  it("validates frontier structure against the count's binary digits", async () => {
    const frontier = await buildMerkleFrontier(fakeHashes(5)); // bits 101
    expect(isValidMerkleFrontier(frontier, 5)).toBe(true);
    expect(isValidMerkleFrontier(frontier, 4)).toBe(false);
    expect(isValidMerkleFrontier(frontier, 6)).toBe(false);
    expect(isValidMerkleFrontier(frontier, 7)).toBe(false);
    expect(isValidMerkleFrontier([], 0)).toBe(true);
    expect(isValidMerkleFrontier([], 1)).toBe(false);
    expect(isValidMerkleFrontier(frontier, -5)).toBe(false);
    expect(isValidMerkleFrontier(frontier, 5.5)).toBe(false);
    expect(isValidMerkleFrontier(frontier, Number.MAX_SAFE_INTEGER + 1)).toBe(
      false
    );
    const oversized = Array.from({ length: 55 }, () => null);
    expect(isValidMerkleFrontier(oversized, 0)).toBe(false);
  });

  it("append refuses a frontier that disagrees with its claimed count", async () => {
    // Height 0 must hold a node when the count is odd; the checkpoint
    // validator screens this, and append double-checks it defensively.
    await expect(
      appendMerkleFrontier([null], 1, fakeHashes(1))
    ).rejects.toThrow("Invalid imported replay Merkle frontier");
  });

  it("hashes string lists without element-boundary collisions", async () => {
    // Provider-native turn ids are free-form external strings; a plain
    // separator join would let ["a\nb"] collide with ["a", "b"] inside
    // prefixTurnIdsHash.
    expect(await hashStringList(["a\nb"])).not.toBe(
      await hashStringList(["a", "b"])
    );
    expect(await hashStringList([])).not.toBe(await hashStringList([""]));
    expect(await hashStringList(["x", "y"])).toBe(
      await hashStringList(["x", "y"])
    );
  });
});
