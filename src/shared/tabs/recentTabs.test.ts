import { describe, expect, it } from "vitest";

import {
  RECENT_TABS_LIMIT,
  recordRecentTab,
  removeRecentTab,
} from "./recentTabs";

describe("recent tab history", () => {
  it("keeps most recently visited unique entries first and enforces the bound", () => {
    const initial = Array.from({ length: RECENT_TABS_LIMIT }, (_, index) => ({
      id: `tab-${index}`,
    }));

    expect(
      recordRecentTab(initial, { id: "tab-1" }).map((tab) => tab.id)
    ).toEqual(["tab-1", "tab-0", "tab-2", "tab-3", "tab-4"]);
    expect(
      recordRecentTab(initial, { id: "tab-new" }).map((tab) => tab.id)
    ).toEqual(["tab-new", "tab-0", "tab-1", "tab-2", "tab-3"]);
  });

  it("removes the tab that becomes active", () => {
    expect(
      removeRecentTab([{ id: "tab-a" }, { id: "tab-b" }], "tab-a")
    ).toEqual([{ id: "tab-b" }]);
  });
});
