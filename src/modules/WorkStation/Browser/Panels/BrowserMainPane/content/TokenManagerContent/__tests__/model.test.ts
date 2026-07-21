import { describe, expect, it } from "vitest";

import type { TokenCategory } from "@src/modules/WorkStation/Browser/hooks/useGlobalTokens";

import {
  areAllTokenSectionsCollapsed,
  countCategoryTokens,
  filterTokenCategories,
  getTokenColorStyle,
  toggleCollapsedTokenSection,
} from "../model";

const categories = [
  {
    name: "primary",
    expanded: false,
    tokens: [
      { name: "primary-1", value: "#fff" },
      { name: "primary-2", value: "12, 24, 36" },
    ],
  },
  {
    name: "text",
    expanded: false,
    tokens: [{ name: "text-1", value: "var(--foreground)" }],
  },
] as TokenCategory[];

describe("TokenManagerContent model", () => {
  it("filters categories by token name and value", () => {
    expect(
      filterTokenCategories(categories, "primary-2")[0].tokens
    ).toHaveLength(1);
    expect(filterTokenCategories(categories, "foreground")[0].name).toBe(
      "text"
    );
    expect(filterTokenCategories(categories, "missing")).toEqual([]);
  });

  it("counts and toggles collapsed sections immutably", () => {
    expect(countCategoryTokens(categories)).toBe(3);
    const collapsed = toggleCollapsedTokenSection(new Set(), "primary");
    expect(collapsed.has("primary")).toBe(true);
    expect(areAllTokenSectionsCollapsed(categories, collapsed)).toBe(false);
  });

  it("normalizes supported color values", () => {
    expect(getTokenColorStyle({ value: "#fff" })).toEqual({
      backgroundColor: "#fff",
    });
    expect(getTokenColorStyle({ value: "12, 24, 36" })).toEqual({
      backgroundColor: "rgb(12, 24, 36)",
    });
    expect(getTokenColorStyle({ value: "1rem" })).toBeUndefined();
  });
});
