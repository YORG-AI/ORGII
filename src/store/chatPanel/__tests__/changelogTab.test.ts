import { createStore } from "jotai/vanilla";
import { describe, expect, it } from "vitest";

import {
  chatPanelTabsAtom,
  openChangelogInChatPanelTabAtom,
} from "../chatPanelTabsAtom";
import {
  CHANGELOG_TAB_ID,
  normalizePersistedChatPanelTabsState,
} from "../chatPanelTabsModel";

describe("Changelog ChatPanel tab", () => {
  it("opens as a singleton and focuses the existing tab", () => {
    const store = createStore();

    const firstId = store.set(openChangelogInChatPanelTabAtom, "Changelog");
    const secondId = store.set(openChangelogInChatPanelTabAtom, "Changelog");
    const state = store.get(chatPanelTabsAtom);

    expect(firstId).toBe(CHANGELOG_TAB_ID);
    expect(secondId).toBe(firstId);
    expect(state.activeTabId).toBe(firstId);
    expect(state.tabs.filter((tab) => tab.type === "changelog")).toHaveLength(
      1
    );
  });

  it("collapses duplicate persisted Changelog tabs, preferring the active one", () => {
    const normalized = normalizePersistedChatPanelTabsState({
      activeTabId: "changelog-b",
      tabs: [
        { id: "launchpad", type: "start-page", title: "Launchpad" },
        { id: "changelog-a", type: "changelog", title: "Changelog" },
        { id: "changelog-b", type: "changelog", title: "Changelog" },
      ],
    });

    expect(normalized?.tabs.filter((tab) => tab.type === "changelog")).toEqual([
      { id: "changelog-b", type: "changelog", title: "Changelog" },
    ]);
    expect(normalized?.activeTabId).toBe("changelog-b");
  });
});
