import { describe, expect, it } from "vitest";

import {
  CONVERSATION_MINIMAP_FLUSH_CONTAINER_PX,
  findNearestConversationMarker,
  getConversationMarkerWidthClass,
  getConversationMinimapPlacementClasses,
  getConversationPreviewPositionClass,
  getNavigableConversationGroupIndices,
  hasConversationMinimapRail,
  resolveActiveConversationMarker,
  resolveConversationMinimapVisibilityClass,
  resolveHighlightedConversationMarkers,
  sampleConversationGroupIndices,
} from "../ConversationMinimap";

describe("getConversationMinimapPlacementClasses", () => {
  const railed = getConversationMinimapPlacementClasses(true);
  const side = getConversationMinimapPlacementClasses(false);

  it("floats the identical pill in both panes", () => {
    // The floating half is one shared literal: a maximized pane that is too
    // narrow for a column must look exactly like the side pane, not like a
    // wider variant of itself.
    const floatingHalf = (classes: string) =>
      classes
        .split(" ")
        .filter((token) => !token.startsWith("@["))
        .join(" ");

    expect(floatingHalf(railed.nav)).toBe(floatingHalf(side.nav));
    expect(floatingHalf(railed.marker)).toBe(floatingHalf(side.marker));
    expect(floatingHalf(railed.markerButton)).toBe(
      floatingHalf(side.markerButton)
    );
  });

  it("gives the floating pill compact right-hugging markers", () => {
    for (const classes of [railed, side]) {
      expect(classes.nav).toContain("right-3");
      expect(classes.nav).toContain("rounded-xl");
      expect(classes.marker).toContain("w-2");
      expect(classes.marker).toContain("justify-end");
    }
  });

  it("crosses over to a flush rail at each pane's own width", () => {
    expect(railed.nav).toContain("@[850px]/focusedchat:right-0");
    expect(railed.nav).toContain("@[850px]/focusedchat:shadow-none");
    expect(railed.marker).toContain("@[850px]/focusedchat:w-9");
    expect(railed.nav).toContain("@[1100px]/focusedchat:top-2");

    expect(side.nav).toContain(
      `@[${CONVERSATION_MINIMAP_FLUSH_CONTAINER_PX}px]/chatbody:right-0`
    );
    expect(side.nav).toContain("@[960px]/chatbody:shadow-none");
    expect(side.marker).toContain("@[960px]/chatbody:w-9");
  });
});

describe("resolveConversationMinimapVisibilityClass", () => {
  it("shows the rail outright while scrolling or hovering, in either pane", () => {
    for (const inWorkstationRail of [true, false]) {
      expect(
        resolveConversationMinimapVisibilityClass({
          showFloatingMinimap: true,
          inWorkstationRail,
        })
      ).toBe("flex");
    }
  });

  it("uses the side pane's idle rule while the maximized rail floats", () => {
    // Floating is floating: a narrow maximized pane must not keep the rail
    // up when the side pane would have hidden it.
    const maximized = resolveConversationMinimapVisibilityClass({
      showFloatingMinimap: false,
      inWorkstationRail: true,
    });
    const side = resolveConversationMinimapVisibilityClass({
      showFloatingMinimap: false,
      inWorkstationRail: false,
    });

    expect(side).toBe("hidden @[640px]/chatbody:flex");
    expect(maximized.startsWith(side)).toBe(true);
  });

  it("keeps the rail up once a maximized pane gives it a column", () => {
    // A wide trail can leave the body under 640px, so the column state has
    // to say so itself rather than relying on the body-width rule.
    expect(
      resolveConversationMinimapVisibilityClass({
        showFloatingMinimap: false,
        inWorkstationRail: true,
      })
    ).toContain("@[850px]/focusedchat:flex");
  });
});

describe("getConversationPreviewPositionClass", () => {
  it("opens a left-docked chat preview into the chat interior (not outward)", () => {
    const positionClass = getConversationPreviewPositionClass("left");

    // Minimap is pinned to the chat's right edge, so the preview opens left
    // (into the chat) rather than outward where the pane edge would clip it.
    expect(positionClass).toContain("right-full");
    expect(positionClass).not.toContain("left-full");
  });

  it("keeps a right-docked chat preview opening to the left", () => {
    expect(getConversationPreviewPositionClass("right")).toContain(
      "right-full"
    );
  });
});

describe("resolveHighlightedConversationMarkers", () => {
  it("maps every visible round to its nearest sampled marker", () => {
    expect(
      resolveHighlightedConversationMarkers(
        [0, 5, 10, 15],
        [4, 6, 11],
        4,
        false
      )
    ).toEqual([5, 10]);
  });

  it("always includes the final marker at the content bottom", () => {
    expect(
      resolveHighlightedConversationMarkers([0, 5, 10], [5], 5, true)
    ).toEqual([5, 10]);
  });
});

describe("getConversationMarkerWidthClass", () => {
  it("fans seven handles to 8, 12, 16, 20, 16, 12, 8 pixels", () => {
    expect(
      Array.from({ length: 7 }, (_, markerIndex) =>
        getConversationMarkerWidthClass(markerIndex, 3)
      )
    ).toEqual(["w-2", "w-3", "w-4", "w-5", "w-4", "w-3", "w-2"]);
  });

  it("keeps resting handles at eight pixels", () => {
    expect(getConversationMarkerWidthClass(3, -1)).toBe("w-2");
  });
});

describe("hasConversationMinimapRail", () => {
  it("shows the rail once two rounds are navigable", () => {
    expect(hasConversationMinimapRail([{}, {}], [1, 1])).toBe(true);
  });

  it("keeps the rail hidden for empty and single-round conversations", () => {
    expect(hasConversationMinimapRail([], [])).toBe(false);
    expect(hasConversationMinimapRail([{}], [3])).toBe(false);
  });

  it("ignores fully empty groups when counting navigable rounds", () => {
    expect(hasConversationMinimapRail([{}, null], [2, 0])).toBe(false);
  });
});

describe("getNavigableConversationGroupIndices", () => {
  it("keeps non-empty headerless rounds and skips fully empty groups", () => {
    expect(
      getNavigableConversationGroupIndices([null, null, null], [2, 1, 0])
    ).toEqual([0, 1]);
  });

  it("keeps a user-only round even when it has no body items", () => {
    expect(getNavigableConversationGroupIndices([{}, {}], [1, 0])).toEqual([
      0, 1,
    ]);
  });
});

describe("sampleConversationGroupIndices", () => {
  it("keeps every turn when the conversation fits within the marker cap", () => {
    expect(sampleConversationGroupIndices([1, 2, 4, 7])).toEqual([1, 2, 4, 7]);
  });

  it("samples long conversations by percentage and retains both ends", () => {
    const groupIndices = Array.from({ length: 101 }, (_, index) => index);
    const sampled = sampleConversationGroupIndices(groupIndices, 20);

    expect(sampled).toHaveLength(20);
    expect(sampled[0]).toBe(0);
    expect(sampled.at(-1)).toBe(100);
    expect(new Set(sampled).size).toBe(20);
    expect(sampled[10]).toBeGreaterThanOrEqual(50);
    expect(sampled[10]).toBeLessThanOrEqual(55);
  });

  it("returns the final turn when only one marker is requested", () => {
    expect(sampleConversationGroupIndices([2, 8, 13], 1)).toEqual([13]);
  });
});

describe("findNearestConversationMarker", () => {
  it("maps an unsampled active turn to its nearest percentage marker", () => {
    expect(findNearestConversationMarker([0, 5, 10, 15], 8)).toBe(10);
  });

  it("returns null when no markers are available", () => {
    expect(findNearestConversationMarker([], 3)).toBeNull();
  });
});

describe("resolveActiveConversationMarker", () => {
  it("selects the final sampled round at the content bottom", () => {
    expect(resolveActiveConversationMarker([0, 5, 10, 15], 10, true)).toBe(15);
  });

  it("uses the nearest sampled round away from the content bottom", () => {
    expect(resolveActiveConversationMarker([0, 5, 10, 15], 8, false)).toBe(10);
  });
});
