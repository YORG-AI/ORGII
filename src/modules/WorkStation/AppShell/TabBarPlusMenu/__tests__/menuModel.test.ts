import { describe, expect, it } from "vitest";

import {
  DEFAULT_TAB_BAR_PLUS_MENU_ITEMS,
  getVisibleTabBarPlusMenuItems,
} from "../menuModel";

describe("TabBarPlusMenu menu model", () => {
  it("keeps the canonical default order", () => {
    expect(DEFAULT_TAB_BAR_PLUS_MENU_ITEMS).toEqual([
      "searchFile",
      "newBrowserTab",
      "newPrivateBrowserTab",
      "workItems",
      "projects",
    ]);
  });

  it("filters unknown runtime values without mutating or reordering input", () => {
    const items = ["projects", "futureItem", "searchFile"] as const;
    const visible = getVisibleTabBarPlusMenuItems(items);
    expect(visible).toEqual(["projects", "searchFile"]);
    expect(items).toEqual(["projects", "futureItem", "searchFile"]);
  });

  it("supports an empty menu", () => {
    expect(getVisibleTabBarPlusMenuItems([])).toEqual([]);
  });
});
