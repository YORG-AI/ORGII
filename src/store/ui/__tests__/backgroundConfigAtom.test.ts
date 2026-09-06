import { describe, expect, it } from "vitest";

import { normalizeBackgroundConfig } from "../backgroundConfigAtom";

describe("normalizeBackgroundConfig", () => {
  it("drops retired image-background fields from persisted state", () => {
    expect(
      normalizeBackgroundConfig({
        imageUrl: "data:image/png;base64,legacy",
        selectedImageId: "old-image",
        customImages: ["old-image"],
        blurAmount: 12,
        adaptiveColors: true,
        glass: "regular",
      })
    ).toEqual({
      customColors: [],
      backgroundColorId: "graphite",
      pageOpacity: 100,
      sidebarOpacity: 85,
    });
  });

  it("preserves a valid custom solid color and sanitizes its palette", () => {
    expect(
      normalizeBackgroundConfig({
        backgroundColor: " #ABC ",
        customColors: ["#ABC", "#aabbcc", "invalid", 42],
        pageOpacity: 73.6,
        sidebarOpacity: -5,
      })
    ).toEqual({
      customColors: ["#aabbcc"],
      backgroundColor: "#aabbcc",
      pageOpacity: 74,
      sidebarOpacity: 0,
    });
  });

  it("keeps a valid preset as the canonical background selection", () => {
    expect(
      normalizeBackgroundConfig({
        backgroundColorId: "ocean",
        backgroundColor: "#ffffff",
        pageOpacity: 20,
        sidebarOpacity: 120,
      })
    ).toEqual({
      customColors: [],
      backgroundColorId: "ocean",
      pageOpacity: 40,
      sidebarOpacity: 100,
    });
  });
});
