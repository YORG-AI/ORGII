import { describe, expect, it } from "vitest";

import {
  LATEST_ROUND_SELECTION,
  resolveRoundSelectionIndex,
  roundSelectionToUnboundedIndex,
  selectLatestRound,
  selectNextRound,
  selectPreviousRound,
  selectRoundIndex,
} from "./roundSelection";

describe("roundSelection", () => {
  it("resolves the null selection to the latest round", () => {
    expect(resolveRoundSelectionIndex(LATEST_ROUND_SELECTION, 4)).toBe(3);
    expect(roundSelectionToUnboundedIndex(LATEST_ROUND_SELECTION)).toBe(
      Number.MAX_SAFE_INTEGER
    );
    expect(selectLatestRound()).toBeNull();
  });

  it("moves from the latest round to the previous explicit round", () => {
    expect(selectPreviousRound(LATEST_ROUND_SELECTION, 4)).toBe(2);
    expect(selectPreviousRound(0, 4)).toBe(0);
  });

  it("normalizes next navigation to null when it reaches latest", () => {
    expect(selectNextRound(0, 3)).toBe(1);
    expect(selectNextRound(1, 3)).toBeNull();
    expect(selectNextRound(LATEST_ROUND_SELECTION, 3)).toBeNull();
  });

  it("keeps empty and single-page histories in follow-latest state", () => {
    for (const pageCount of [0, 1]) {
      expect(
        resolveRoundSelectionIndex(LATEST_ROUND_SELECTION, pageCount)
      ).toBe(0);
      expect(selectRoundIndex(0, pageCount)).toBeNull();
      expect(selectPreviousRound(LATEST_ROUND_SELECTION, pageCount)).toBeNull();
      expect(selectNextRound(LATEST_ROUND_SELECTION, pageCount)).toBeNull();
    }
  });

  it("clamps out-of-range selections before normalizing latest", () => {
    expect(resolveRoundSelectionIndex(-10, 3)).toBe(0);
    expect(resolveRoundSelectionIndex(10, 3)).toBe(2);
    expect(selectRoundIndex(-10, 3)).toBe(0);
    expect(selectRoundIndex(10, 3)).toBeNull();
  });
});
