import { describe, expect, it } from "vitest";

import {
  RECENTLY_CLOSED_TABS_LIMIT,
  prependRecentlyClosedTabs,
  removeRecentlyClosedTab,
} from "./recentlyClosedTabs";

describe("recently closed tab history", () => {
  it("keeps newest unique entries first and enforces the bound", () => {
    const initial = Array.from(
      { length: RECENTLY_CLOSED_TABS_LIMIT },
      (_, index) => ({ id: `tab-${index}` })
    );

    expect(
      prependRecentlyClosedTabs(initial, [
        { id: "tab-1" },
        { id: "tab-new" },
      ]).map((tab) => tab.id)
    ).toEqual(["tab-new", "tab-1", "tab-0", "tab-2", "tab-3"]);
  });

  it("removes an entry after it is restored", () => {
    expect(
      removeRecentlyClosedTab([{ id: "tab-a" }, { id: "tab-b" }], "tab-a")
    ).toEqual([{ id: "tab-b" }]);
  });
});
