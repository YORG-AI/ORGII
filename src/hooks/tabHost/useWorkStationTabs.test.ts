/**
 * useWorkStationTabs — tests the extractable pure helpers.
 *
 * The hook itself is a React-hook wrapper around `tabMutations`. Rather
 * than reproducing the mutation tests (covered in tabMutations.test.ts),
 * this file tests the thin pure logic that lives inside the hook itself:
 *
 *   • The `closeAllTabs` guard: if `tabs === []` and `activeTabId === null`
 *     the updater is a no-op (returns the same state reference).
 *   • The `updateTabMeta` early-exit: no state change when title+icon
 *     are unchanged.
 *   • The `setTabUnsaved` early-exit: no state change when the flag is
 *     already at the requested value.
 *
 * All three are inline anonymous functions inside the hook; we extract
 * their equivalent logic here as named helpers so they can be unit tested
 * without React.
 */
import { describe, expect, it } from "vitest";

import type { PanelState, WorkStationTab } from "@src/store/workstation/tabs";

function tab(
  id: string,
  overrides: Partial<WorkStationTab> = {}
): WorkStationTab {
  return {
    id,
    type: "file",
    title: id,
    data: {},
    ...overrides,
  };
}

// ── closeAllTabs guard ────────────────────────────────────────────────────────

function closeAllTabsGuard(state: PanelState): PanelState {
  if (state.tabs.length === 0 && state.activeTabId === null) return state;
  return { tabs: [], activeTabId: null };
}

describe("closeAllTabs guard", () => {
  it("returns the same reference when already empty", () => {
    const state: PanelState = { tabs: [], activeTabId: null };
    expect(closeAllTabsGuard(state)).toBe(state);
  });

  it("clears tabs when there are tabs", () => {
    const state: PanelState = { tabs: [tab("a")], activeTabId: "a" };
    const next = closeAllTabsGuard(state);
    expect(next.tabs).toHaveLength(0);
    expect(next.activeTabId).toBeNull();
  });

  it("clears when activeTabId is set but tabs array is empty", () => {
    const state: PanelState = { tabs: [], activeTabId: "orphaned" };
    const next = closeAllTabsGuard(state);
    expect(next.tabs).toHaveLength(0);
    expect(next.activeTabId).toBeNull();
  });
});

// ── updateTabMeta early-exit ──────────────────────────────────────────────────

function updateTabMeta(
  state: PanelState,
  tabId: string,
  meta: Partial<Pick<WorkStationTab, "title" | "icon">>
): PanelState {
  const target = state.tabs.find((t) => t.id === tabId);
  if (!target) return state;
  const nextTitle = meta.title ?? target.title;
  const nextIcon = meta.icon ?? target.icon;
  if (target.title === nextTitle && target.icon === nextIcon) return state;
  return {
    ...state,
    tabs: state.tabs.map((t) =>
      t.id === tabId ? { ...t, title: nextTitle, icon: nextIcon } : t
    ),
  };
}

describe("updateTabMeta", () => {
  it("returns the same reference when title and icon are unchanged", () => {
    const state: PanelState = {
      tabs: [tab("a", { title: "MyTitle", icon: "icon-x" })],
      activeTabId: "a",
    };
    const next = updateTabMeta(state, "a", {
      title: "MyTitle",
      icon: "icon-x",
    });
    expect(next).toBe(state);
  });

  it("updates title when changed", () => {
    const state: PanelState = {
      tabs: [tab("a", { title: "Old" })],
      activeTabId: "a",
    };
    const next = updateTabMeta(state, "a", { title: "New" });
    expect(next.tabs[0].title).toBe("New");
    expect(next).not.toBe(state);
  });

  it("returns the same reference for an unknown tabId", () => {
    const state: PanelState = { tabs: [tab("a")], activeTabId: "a" };
    expect(updateTabMeta(state, "unknown", { title: "X" })).toBe(state);
  });

  it("leaves other tabs untouched", () => {
    const a = tab("a", { title: "A" });
    const b = tab("b", { title: "B" });
    const state: PanelState = { tabs: [a, b], activeTabId: "a" };
    const next = updateTabMeta(state, "a", { title: "A2" });
    expect(next.tabs[1]).toBe(b);
  });
});

// ── setTabUnsaved early-exit ──────────────────────────────────────────────────

function setTabUnsaved(
  state: PanelState,
  tabId: string,
  hasUnsavedChanges: boolean
): PanelState {
  const target = state.tabs.find((t) => t.id === tabId);
  if (!target || target.hasUnsavedChanges === hasUnsavedChanges) return state;
  return {
    ...state,
    tabs: state.tabs.map((t) =>
      t.id === tabId ? { ...t, hasUnsavedChanges } : t
    ),
  };
}

describe("setTabUnsaved", () => {
  it("returns the same reference when flag is already at the requested value", () => {
    const state: PanelState = {
      tabs: [tab("a", { hasUnsavedChanges: true })],
      activeTabId: "a",
    };
    expect(setTabUnsaved(state, "a", true)).toBe(state);
  });

  it("sets hasUnsavedChanges to true when currently false", () => {
    const state: PanelState = {
      tabs: [tab("a", { hasUnsavedChanges: false })],
      activeTabId: "a",
    };
    const next = setTabUnsaved(state, "a", true);
    expect(next.tabs[0].hasUnsavedChanges).toBe(true);
  });

  it("clears hasUnsavedChanges", () => {
    const state: PanelState = {
      tabs: [tab("a", { hasUnsavedChanges: true })],
      activeTabId: "a",
    };
    const next = setTabUnsaved(state, "a", false);
    expect(next.tabs[0].hasUnsavedChanges).toBe(false);
  });

  it("returns the same reference for an unknown tabId", () => {
    const state: PanelState = { tabs: [tab("a")], activeTabId: "a" };
    expect(setTabUnsaved(state, "unknown", true)).toBe(state);
  });
});
