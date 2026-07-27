import { describe, expect, it } from "vitest";

import {
  resolveActiveGroupPinState,
  resolveVisibleGroupIndices,
  shouldUseStaticChatHistoryRendering,
} from "../ChatHistoryList";

describe("shouldUseStaticChatHistoryRendering", () => {
  it("keeps a large turn virtualized when its collapsed body has one visible item", () => {
    const sourceItemCount = 25;
    const collapsedVisibleItemCount = 1;

    expect(collapsedVisibleItemCount).toBeLessThan(sourceItemCount);
    expect(shouldUseStaticChatHistoryRendering(sourceItemCount)).toBe(false);
  });

  it("keeps small turns on the static renderer at the threshold", () => {
    expect(shouldUseStaticChatHistoryRendering(24)).toBe(true);
  });
});

describe("resolveVisibleGroupIndices", () => {
  it("returns every group intersecting the viewport", () => {
    expect(
      resolveVisibleGroupIndices(
        [
          { groupIndex: 0, top: -100, bottom: -1 },
          { groupIndex: 1, top: -20, bottom: 80 },
          { groupIndex: 2, top: 80, bottom: 180 },
          { groupIndex: 3, top: 180, bottom: 280 },
        ],
        160
      )
    ).toEqual([1, 2]);
  });
});

describe("resolveActiveGroupPinState", () => {
  it("pins as soon as the active turn crosses the top", () => {
    expect(resolveActiveGroupPinState([{ groupIndex: 0, top: -1 }])).toEqual({
      groupIndex: 0,
      pinned: true,
    });
  });

  it("does not pin before the first turn crosses the top", () => {
    expect(resolveActiveGroupPinState([{ groupIndex: 0, top: 1 }])).toEqual({
      groupIndex: 0,
      pinned: false,
    });
  });

  it("switches the pin to the latest turn that crossed the top", () => {
    expect(
      resolveActiveGroupPinState([
        { groupIndex: 0, top: -600 },
        { groupIndex: 1, top: -10 },
      ])
    ).toEqual({ groupIndex: 1, pinned: true });
  });
});
