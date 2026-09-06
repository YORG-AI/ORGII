import { describe, expect, it } from "vitest";

import { normalizeBackgroundConfig } from "../backgroundConfigAtom";

describe("normalizeBackgroundConfig", () => {
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
