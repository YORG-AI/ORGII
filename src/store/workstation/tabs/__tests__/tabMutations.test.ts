/**
 * Pure tab mutation helpers (panel tab strip).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearSearchTabSessionStates,
  deleteSearchTabSessionState,
} from "@src/store/workstation/codeEditor/search";

import {
  closeAllTabs,
  closeOtherTabs,
  closeSavedTabs,
  closeTab,
  openTab,
  reorderTabs,
  switchTab,
  updateTabData,
} from "../tabMutations";
import { TAB_RETURN_TARGET_DATA_KEY } from "../types";
import type { PanelState, WorkStationTab } from "../types";

// The search session cache is the one resource teardown that lives *inside*
// the close mutations (see tabMutations.ts). Mock it so we can assert the
// "offload on close" contract without touching the real module-level Map.
vi.mock("@src/store/workstation/codeEditor/search", () => ({
  deleteSearchTabSessionState: vi.fn(),
  clearSearchTabSessionStates: vi.fn(),
}));

const mockDeleteSearchTabSessionState = vi.mocked(deleteSearchTabSessionState);
const mockClearSearchTabSessionStates = vi.mocked(clearSearchTabSessionStates);

function tab(
  overrides: Partial<WorkStationTab> & Pick<WorkStationTab, "id">
): WorkStationTab {
  return {
    type: "file",
    title: overrides.id,
    data: {},
    ...overrides,
  };
}

const empty: PanelState = { tabs: [], activeTabId: null };

// The Explorer ("Files") tab is a transient picker — opening a file retires it.
const explorerTab = tab({
  id: "explorer:main",
  type: "explorer",
  title: "Files",
});

describe("openTab", () => {
  it("appends a new tab and activates it", () => {
    const next = openTab(empty, tab({ id: "file:a.ts" }));
    expect(next.tabs).toHaveLength(1);
    expect(next.activeTabId).toBe("file:a.ts");
  });

  it("switches active tab when the id already exists", () => {
    const state: PanelState = {
      tabs: [tab({ id: "file:a.ts" }), tab({ id: "file:b.ts" })],
      activeTabId: "file:a.ts",
    };
    const next = openTab(state, tab({ id: "file:b.ts" }));
    expect(next.tabs).toHaveLength(2);
    expect(next.activeTabId).toBe("file:b.ts");
  });

  it("updates targetLine on an existing tab when provided", () => {
    const state: PanelState = {
      tabs: [tab({ id: "file:a.ts", data: { path: "/a.ts" } })],
      activeTabId: "file:a.ts",
    };
    const next = openTab(
      state,
      tab({ id: "file:a.ts", data: { targetLine: 42 } })
    );
    expect(next.tabs[0].data.targetLine).toBe(42);
    expect(next.activeTabId).toBe("file:a.ts");
  });

  it("replaces the Explorer tab in place when a file tab is opened", () => {
    const state: PanelState = {
      tabs: [explorerTab, tab({ id: "terminal:main", type: "terminal" })],
      activeTabId: "explorer:main",
    };
    const next = openTab(state, tab({ id: "file:a.ts" }));
    expect(next.tabs.map((item) => item.id)).toEqual([
      "file:a.ts",
      "terminal:main",
    ]);
    expect(next.activeTabId).toBe("file:a.ts");
  });

  it("retires the Explorer tab when an already-open file tab is reopened", () => {
    const state: PanelState = {
      tabs: [tab({ id: "file:a.ts" }), explorerTab],
      activeTabId: "explorer:main",
    };
    const next = openTab(state, tab({ id: "file:a.ts" }));
    expect(next.tabs.map((item) => item.id)).toEqual(["file:a.ts"]);
    expect(next.activeTabId).toBe("file:a.ts");
  });

  it("keeps the Explorer tab when a non-file tab is opened", () => {
    const state: PanelState = {
      tabs: [explorerTab],
      activeTabId: "explorer:main",
    };
    const next = openTab(
      state,
      tab({ id: "search:1", type: "search", title: "Search" })
    );
    expect(next.tabs.map((item) => item.id)).toEqual([
      "explorer:main",
      "search:1",
    ]);
    expect(next.activeTabId).toBe("search:1");
  });

  it("keeps a pinned Explorer fixture when a file tab is opened", () => {
    const state: PanelState = {
      tabs: [{ ...explorerTab, pinned: true }],
      activeTabId: "explorer:main",
    };
    const next = openTab(state, tab({ id: "file:a.ts" }));
    expect(next.tabs.map((item) => item.id)).toEqual([
      "explorer:main",
      "file:a.ts",
    ]);
  });
});

describe("closeTab", () => {
  it("removes the tab and activates a neighbor when the active tab closes", () => {
    const state: PanelState = {
      tabs: [
        tab({ id: "file:a.ts" }),
        tab({ id: "file:b.ts" }),
        tab({ id: "file:c.ts" }),
      ],
      activeTabId: "file:b.ts",
    };
    const next = closeTab(state, "file:b.ts");
    expect(next.tabs.map((t) => t.id)).toEqual(["file:a.ts", "file:c.ts"]);
    expect(next.activeTabId).toBe("file:c.ts");
  });

  it("returns to the source tab when the closed active tab has a return target", () => {
    const state: PanelState = {
      tabs: [
        tab({ id: "project-dashboard:main" }),
        tab({ id: "project-work-items:org:personal-org" }),
        tab({
          id: "workItem-detail:wi-1",
          data: {
            [TAB_RETURN_TARGET_DATA_KEY]: "project-work-items:org:personal-org",
          },
        }),
      ],
      activeTabId: "workItem-detail:wi-1",
    };
    const next = closeTab(state, "workItem-detail:wi-1");
    expect(next.tabs.map((item) => item.id)).toEqual([
      "project-dashboard:main",
      "project-work-items:org:personal-org",
    ]);
    expect(next.activeTabId).toBe("project-work-items:org:personal-org");
  });

  it("returns empty panel when the last tab closes", () => {
    const state: PanelState = {
      tabs: [tab({ id: "file:a.ts" })],
      activeTabId: "file:a.ts",
    };
    const next = closeTab(state, "file:a.ts");
    expect(next.tabs).toHaveLength(0);
    expect(next.activeTabId).toBeNull();
  });
});

describe("switchTab", () => {
  it("no-ops when the tab id is missing", () => {
    const state: PanelState = {
      tabs: [tab({ id: "file:a.ts" })],
      activeTabId: "file:a.ts",
    };
    const next = switchTab(state, "missing");
    expect(next).toEqual(state);
  });
});

describe("reorderTabs", () => {
  it("moves a tab from startIndex to endIndex", () => {
    const state: PanelState = {
      tabs: [tab({ id: "t1" }), tab({ id: "t2" }), tab({ id: "t3" })],
      activeTabId: "t2",
    };
    const next = reorderTabs(state, 0, 2);
    expect(next.tabs.map((t) => t.id)).toEqual(["t2", "t3", "t1"]);
    expect(next.activeTabId).toBe("t2");
  });
});

describe("updateTabData", () => {
  it("merges data for the matching tab id", () => {
    const state: PanelState = {
      tabs: [tab({ id: "file:a.ts", data: { path: "/a.ts" } })],
      activeTabId: "file:a.ts",
    };
    const next = updateTabData(state, "file:a.ts", { scrollTop: 10 });
    expect(next.tabs[0].data).toEqual({ path: "/a.ts", scrollTop: 10 });
  });
});

// "Offload on close": search tabs own an in-memory session-cache entry
// (query + options + result array) keyed by the `search:` tab id. Every
// close mutation must release it so it does not outlive the tab. This is
// the only resource teardown wired inside the mutation helpers, so it is
// locked here against regressions to the `search:` id prefix / strategy.
describe("search session cache cleanup on close", () => {
  beforeEach(() => {
    mockDeleteSearchTabSessionState.mockClear();
    mockClearSearchTabSessionStates.mockClear();
  });

  it("closeTab deletes the session state for a search tab", () => {
    const state: PanelState = {
      tabs: [tab({ id: "search:123-abc", type: "search" })],
      activeTabId: "search:123-abc",
    };
    closeTab(state, "search:123-abc");
    expect(mockDeleteSearchTabSessionState).toHaveBeenCalledWith(
      "search:123-abc"
    );
  });

  it("closeTab does not touch the cache for a non-search tab", () => {
    const state: PanelState = {
      tabs: [tab({ id: "file:a.ts" })],
      activeTabId: "file:a.ts",
    };
    closeTab(state, "file:a.ts");
    expect(mockDeleteSearchTabSessionState).not.toHaveBeenCalled();
  });

  it("closeAllTabs clears every search session state when a search tab existed", () => {
    const state: PanelState = {
      tabs: [tab({ id: "file:a.ts" }), tab({ id: "search:1", type: "search" })],
      activeTabId: "search:1",
    };
    closeAllTabs(state);
    expect(mockClearSearchTabSessionStates).toHaveBeenCalledTimes(1);
  });

  it("closeAllTabs skips the cache clear when no search tab existed", () => {
    const state: PanelState = {
      tabs: [tab({ id: "file:a.ts" })],
      activeTabId: "file:a.ts",
    };
    closeAllTabs(state);
    expect(mockClearSearchTabSessionStates).not.toHaveBeenCalled();
  });

  it("closeOtherTabs deletes closed search tabs but keeps the retained one", () => {
    const state: PanelState = {
      tabs: [
        tab({ id: "search:keep", type: "search" }),
        tab({ id: "search:drop", type: "search" }),
        tab({ id: "file:a.ts" }),
      ],
      activeTabId: "search:keep",
    };
    closeOtherTabs(state, "search:keep");
    expect(mockDeleteSearchTabSessionState).toHaveBeenCalledWith("search:drop");
    expect(mockDeleteSearchTabSessionState).not.toHaveBeenCalledWith(
      "search:keep"
    );
  });

  it("closeSavedTabs deletes session state for closed (saved) search tabs", () => {
    const state: PanelState = {
      tabs: [
        tab({ id: "search:saved", type: "search" }),
        tab({
          id: "search:dirty",
          type: "search",
          hasUnsavedChanges: true,
        }),
      ],
      activeTabId: "search:saved",
    };
    closeSavedTabs(state);
    expect(mockDeleteSearchTabSessionState).toHaveBeenCalledWith(
      "search:saved"
    );
    expect(mockDeleteSearchTabSessionState).not.toHaveBeenCalledWith(
      "search:dirty"
    );
  });
});
