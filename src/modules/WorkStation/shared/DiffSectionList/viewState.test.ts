import { describe, expect, it } from "vitest";

import {
  type RememberedExpansion,
  createRestoredExpansions,
  pruneRestoredExpansions,
  seedRestoredExpansion,
  snapshotExpansions,
} from "./viewState";

describe("snapshotExpansions", () => {
  it("keeps only overrides whose signal still matches the row's signal", () => {
    const remembered = new Map<string, RememberedExpansion>([
      ["a-", { signal: 0, expanded: true }],
      ["b-", { signal: 1, expanded: true }], // invalidated by collapse-all
      ["focused-", { signal: 3, expanded: false }], // collapse 0 + nonce 3
    ]);
    const signalFor = (key: string) => (key === "focused-" ? 3 : 0);
    expect(snapshotExpansions(remembered, signalFor)).toEqual({
      "a-": true,
      "focused-": false,
    });
  });

  it("drops overrides for rows that no longer exist", () => {
    const remembered = new Map<string, RememberedExpansion>([
      ["gone-", { signal: 0, expanded: true }],
    ]);
    expect(snapshotExpansions(remembered, () => undefined)).toEqual({});
  });
});

describe("seedRestoredExpansion", () => {
  it("re-applies a restored override with the row's live signal, once", () => {
    const remembered = new Map<string, RememberedExpansion>();
    const restored = createRestoredExpansions({
      expanded: { "a-": true },
      scroll: null,
      focusNonce: null,
    });

    expect(seedRestoredExpansion(remembered, restored, "a-", 2)).toBe(true);
    expect(remembered.get("a-")).toEqual({ signal: 2, expanded: true });
    expect(restored.has("a-")).toBe(false);
    // Already remembered: nothing pending, nothing overwritten.
    expect(
      seedRestoredExpansion(remembered, restored, "a-", 2)
    ).toBeUndefined();
  });

  it("never overrides an expansion the user set in this mount", () => {
    const remembered = new Map<string, RememberedExpansion>([
      ["a-", { signal: 0, expanded: false }],
    ]);
    const restored = new Map([["a-", true]]);
    expect(
      seedRestoredExpansion(remembered, restored, "a-", 0)
    ).toBeUndefined();
    expect(remembered.get("a-")).toEqual({ signal: 0, expanded: false });
  });

  it("returns undefined for rows without a pending override", () => {
    expect(
      seedRestoredExpansion(new Map(), new Map(), "a-", 0)
    ).toBeUndefined();
  });
});

describe("createRestoredExpansions / pruneRestoredExpansions", () => {
  it("starts empty without a snapshot", () => {
    expect(createRestoredExpansions(null).size).toBe(0);
    expect(createRestoredExpansions(undefined).size).toBe(0);
  });

  it("does not prune while the list is still empty (not yet populated)", () => {
    const restored = createRestoredExpansions({
      expanded: { "a-": true },
      scroll: null,
      focusNonce: null,
    });
    pruneRestoredExpansions(restored, new Set());
    expect(restored.get("a-")).toBe(true);
  });

  it("prunes pending overrides for rows that left the list", () => {
    const restored = createRestoredExpansions({
      expanded: { "a-": true, "b-": false },
      scroll: null,
      focusNonce: null,
    });
    pruneRestoredExpansions(restored, new Set(["b-"]));
    expect([...restored.keys()]).toEqual(["b-"]);
  });
});
