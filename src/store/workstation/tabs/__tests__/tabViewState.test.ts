import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_TAB_VIEW_STATE_TABS,
  clearTabViewStates,
  deleteTabViewState,
  getTabViewState,
  getTabViewStateCount,
  setTabViewState,
} from "../tabViewState";

describe("tabViewState", () => {
  beforeEach(() => {
    clearTabViewStates();
  });

  it("returns undefined for a tab that never saved anything", () => {
    expect(getTabViewState("tab:1", "scroll")).toBeUndefined();
  });

  it("round-trips slots independently per tab", () => {
    setTabViewState("tab:1", "scroll", 120);
    setTabViewState("tab:1", "expanded", { a: true });
    setTabViewState("tab:2", "scroll", 7);

    expect(getTabViewState("tab:1", "scroll")).toBe(120);
    expect(getTabViewState("tab:1", "expanded")).toEqual({ a: true });
    expect(getTabViewState("tab:2", "scroll")).toBe(7);
    expect(getTabViewState("tab:2", "expanded")).toBeUndefined();
  });

  it("overwrites a slot in place", () => {
    setTabViewState("tab:1", "scroll", 1);
    setTabViewState("tab:1", "scroll", 2);
    expect(getTabViewState("tab:1", "scroll")).toBe(2);
    expect(getTabViewStateCount()).toBe(1);
  });

  it("drops every slot of a tab on delete", () => {
    setTabViewState("tab:1", "scroll", 1);
    setTabViewState("tab:1", "expanded", {});
    deleteTabViewState("tab:1");
    expect(getTabViewState("tab:1", "scroll")).toBeUndefined();
    expect(getTabViewState("tab:1", "expanded")).toBeUndefined();
    expect(getTabViewStateCount()).toBe(0);
  });

  it("ignores empty tab ids so unkeyed callers persist nothing", () => {
    setTabViewState("", "scroll", 1);
    expect(getTabViewState("", "scroll")).toBeUndefined();
    expect(getTabViewStateCount()).toBe(0);
  });

  it("evicts the least recently used tab beyond the cap", () => {
    for (let index = 0; index < MAX_TAB_VIEW_STATE_TABS; index += 1) {
      setTabViewState(`tab:${index}`, "scroll", index);
    }
    // Touch the oldest so it becomes most-recently-used.
    expect(getTabViewState("tab:0", "scroll")).toBe(0);
    setTabViewState("tab:overflow", "scroll", -1);

    expect(getTabViewStateCount()).toBe(MAX_TAB_VIEW_STATE_TABS);
    expect(getTabViewState("tab:0", "scroll")).toBe(0);
    expect(getTabViewState("tab:1", "scroll")).toBeUndefined();
    expect(getTabViewState("tab:overflow", "scroll")).toBe(-1);
  });
});
