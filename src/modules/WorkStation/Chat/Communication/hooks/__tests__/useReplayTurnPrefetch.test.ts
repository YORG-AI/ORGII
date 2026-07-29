/**
 * useReplayTurnPrefetch: pure selection-logic tests.
 *
 * No @testing-library — these exercise the exported pure helpers directly
 * (same style as `Communication/__tests__/utils.test.ts`), not the hook's
 * effect wiring, which needs a React render environment this suite doesn't
 * set up.
 */
import { describe, expect, it } from "vitest";

import {
  type ReplayPrefetchEntry,
  findNearestUnloadedTurnId,
  getReplayPrefetchRadius,
  selectUnloadedTurnIdsAheadOfCursor,
} from "../useReplayTurnPrefetch";

function entry(
  eventId: string,
  turnId: string | null = null
): ReplayPrefetchEntry {
  return {
    eventId,
    unloadedTurn: turnId ? { turnId } : null,
  };
}

describe("selectUnloadedTurnIdsAheadOfCursor", () => {
  it("skips loaded (non-placeholder) entries between the cursor and a placeholder", () => {
    const entries = [
      entry("evt-0"), // cursor
      entry("evt-1"), // loaded, no turnId
      entry("evt-2"), // loaded, no turnId
      entry("evt-3", "turn-3"),
    ];

    expect(selectUnloadedTurnIdsAheadOfCursor(entries, 0, 2)).toEqual([
      "turn-3",
    ]);
  });

  it("de-dupes a turnId spanning multiple consecutive placeholder entries", () => {
    const entries = [
      entry("evt-0"),
      entry("evt-1", "turn-1"),
      entry("evt-2", "turn-1"),
      entry("evt-3", "turn-2"),
    ];

    expect(selectUnloadedTurnIdsAheadOfCursor(entries, 0, 2)).toEqual([
      "turn-1",
      "turn-2",
    ]);
  });

  it("respects the radius cap, stopping at N distinct turnIds", () => {
    const entries = [
      entry("evt-0"),
      entry("evt-1", "turn-1"),
      entry("evt-2", "turn-2"),
      entry("evt-3", "turn-3"),
      entry("evt-4", "turn-4"),
    ];

    expect(selectUnloadedTurnIdsAheadOfCursor(entries, 0, 2)).toEqual([
      "turn-1",
      "turn-2",
    ]);
  });

  it("returns empty when the cursor is at (or past) the end of the list", () => {
    const entries = [entry("evt-0"), entry("evt-1", "turn-1")];

    expect(selectUnloadedTurnIdsAheadOfCursor(entries, 1, 2)).toEqual([]);
    expect(selectUnloadedTurnIdsAheadOfCursor(entries, 5, 2)).toEqual([]);
  });

  it("returns empty for a non-positive radius or an unknown cursor", () => {
    const entries = [entry("evt-0"), entry("evt-1", "turn-1")];

    expect(selectUnloadedTurnIdsAheadOfCursor(entries, 0, 0)).toEqual([]);
    expect(selectUnloadedTurnIdsAheadOfCursor(entries, -1, 2)).toEqual([]);
  });
});

describe("findNearestUnloadedTurnId", () => {
  it("returns the turnId at the cursor when the cursor itself is a placeholder", () => {
    const entries = [entry("evt-0"), entry("evt-1", "turn-1")];
    expect(findNearestUnloadedTurnId(entries, 1)).toBe("turn-1");
  });

  it("walks backward to the nearest placeholder when the cursor is loaded content", () => {
    const entries = [entry("evt-0", "turn-0"), entry("evt-1"), entry("evt-2")];
    expect(findNearestUnloadedTurnId(entries, 2)).toBe("turn-0");
  });

  it("returns null when nothing behind the cursor is unloaded", () => {
    const entries = [entry("evt-0"), entry("evt-1")];
    expect(findNearestUnloadedTurnId(entries, 1)).toBeNull();
  });

  it("returns null for an unknown cursor or an empty list", () => {
    expect(findNearestUnloadedTurnId([], 0)).toBeNull();
    expect(findNearestUnloadedTurnId([entry("evt-0")], -1)).toBeNull();
  });
});

describe("getReplayPrefetchRadius", () => {
  it("returns 0 for Codex app imported sessions", () => {
    expect(getReplayPrefetchRadius("codexapp-large")).toBe(0);
  });

  it("returns the configured prefetch-ahead radius for other imported sessions", () => {
    expect(getReplayPrefetchRadius("claudecodeapp-abc")).toBeGreaterThan(0);
  });

  it("returns the configured radius for a nullish session id (gating happens elsewhere)", () => {
    expect(getReplayPrefetchRadius(null)).toBeGreaterThan(0);
  });
});
