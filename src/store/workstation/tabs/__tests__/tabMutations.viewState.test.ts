/**
 * Close mutations release the session-only state a tab owned: its saved
 * view state (`tabViewState`) and, for a working-tree `git-diff` tab, the
 * in-progress diff edit for its file (`gitDiffEditDrafts`). Uses the real
 * stores rather than mocks so the contract is the observable one.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearGitDiffEditDrafts,
  hasGitDiffEditDraft,
  setGitDiffEditDraft,
} from "@src/store/workstation/codeEditor/gitDiffEditDrafts";

import {
  closeAllTabs,
  closeOtherTabs,
  closeSavedTabs,
  closeTab,
  switchTab,
} from "../tabMutations";
import {
  clearTabViewStates,
  getTabViewState,
  setTabViewState,
} from "../tabViewState";
import type { PanelState, WorkStationTab } from "../types";

function tab(
  overrides: Partial<WorkStationTab> & { id: string }
): WorkStationTab {
  return {
    type: "file",
    title: overrides.id,
    data: {},
    ...overrides,
  };
}

const DIFF_FILE = "/repo/src/a.ts";

function seeded(): PanelState {
  setTabViewState("file:a.ts", "scroll", 10);
  setTabViewState("source-control:changes", "allChanges", { expanded: {} });
  setTabViewState("git-diff:a", "scroll", 3);
  setGitDiffEditDraft(DIFF_FILE, "base", "edited");
  return {
    tabs: [
      tab({ id: "file:a.ts" }),
      tab({
        id: "source-control:changes",
        type: "source-control",
        pinned: true,
        closable: false,
      }),
      tab({
        id: "git-diff:a",
        type: "git-diff",
        data: { filePath: DIFF_FILE },
      }),
    ],
    activeTabId: "file:a.ts",
  };
}

describe("tab view state + diff draft cleanup on close", () => {
  beforeEach(() => {
    clearTabViewStates();
    clearGitDiffEditDrafts();
  });

  it("switching tabs keeps every tab's view state (the tab is rebuilt from it)", () => {
    const state = seeded();
    switchTab(state, "source-control:changes");
    expect(getTabViewState("file:a.ts", "scroll")).toBe(10);
    expect(hasGitDiffEditDraft(DIFF_FILE)).toBe(true);
  });

  it("closeTab drops only the closed tab's view state", () => {
    const state = seeded();
    closeTab(state, "file:a.ts");
    expect(getTabViewState("file:a.ts", "scroll")).toBeUndefined();
    expect(
      getTabViewState("source-control:changes", "allChanges")
    ).toBeDefined();
    expect(hasGitDiffEditDraft(DIFF_FILE)).toBe(true);
  });

  it("closing a git-diff tab discards its file's edit draft", () => {
    const state = seeded();
    closeTab(state, "git-diff:a");
    expect(getTabViewState("git-diff:a", "scroll")).toBeUndefined();
    expect(hasGitDiffEditDraft(DIFF_FILE)).toBe(false);
  });

  it("closing a timeline diff tab leaves the working-tree draft alone", () => {
    const state: PanelState = {
      tabs: [
        tab({
          id: "git-diff:timeline",
          type: "git-diff",
          data: { filePath: DIFF_FILE, isTimeline: true },
        }),
      ],
      activeTabId: "git-diff:timeline",
    };
    setGitDiffEditDraft(DIFF_FILE, "base", "edited");
    closeTab(state, "git-diff:timeline");
    expect(hasGitDiffEditDraft(DIFF_FILE)).toBe(true);
  });

  it("closeOtherTabs keeps the retained tab's view state", () => {
    const state = seeded();
    closeOtherTabs(state, "source-control:changes");
    expect(
      getTabViewState("source-control:changes", "allChanges")
    ).toBeDefined();
    expect(getTabViewState("file:a.ts", "scroll")).toBeUndefined();
    expect(getTabViewState("git-diff:a", "scroll")).toBeUndefined();
    expect(hasGitDiffEditDraft(DIFF_FILE)).toBe(false);
  });

  it("closeSavedTabs keeps view state for dirty tabs only", () => {
    const state = seeded();
    state.tabs[0] = { ...state.tabs[0], hasUnsavedChanges: true };
    closeSavedTabs(state);
    expect(getTabViewState("file:a.ts", "scroll")).toBe(10);
    expect(
      getTabViewState("source-control:changes", "allChanges")
    ).toBeUndefined();
    expect(hasGitDiffEditDraft(DIFF_FILE)).toBe(false);
  });

  it("closeAllTabs clears everything", () => {
    const state = seeded();
    closeAllTabs(state);
    expect(getTabViewState("file:a.ts", "scroll")).toBeUndefined();
    expect(
      getTabViewState("source-control:changes", "allChanges")
    ).toBeUndefined();
    expect(hasGitDiffEditDraft(DIFF_FILE)).toBe(false);
  });
});
