import { createStore } from "jotai/vanilla";
import { beforeEach, describe, expect, it } from "vitest";

import { invalidateSessionChatPanelTabsAtom } from "./chatPanelSessionInvalidationAtom";
import { chatPanelTabsAtom } from "./chatPanelTabsState";

beforeEach(() => {
  localStorage.clear();
});

describe("invalidateSessionChatPanelTabsAtom", () => {
  it("removes every matching projection and activates the nearest survivor", () => {
    const store = createStore();
    store.set(chatPanelTabsAtom, {
      tabs: [
        { id: "launch", type: "start-page", title: "Launchpad" },
        {
          id: "deleted-one",
          type: "session",
          title: "Deleted one",
          sessionId: "deleted",
        },
        {
          id: "live",
          type: "runtime",
          title: "Runtime",
        },
        {
          id: "deleted-two",
          type: "session",
          title: "Deleted two",
          sessionId: "deleted",
        },
      ],
      activeTabId: "deleted-two",
    });

    store.set(invalidateSessionChatPanelTabsAtom, "deleted");

    expect(store.get(chatPanelTabsAtom)).toEqual({
      tabs: [
        { id: "launch", type: "start-page", title: "Launchpad" },
        {
          id: "live",
          type: "runtime",
          title: "Runtime",
        },
      ],
      activeTabId: "live",
    });
  });

  it("restores Launchpad when the deleted session owned the final tab", () => {
    const store = createStore();
    store.set(chatPanelTabsAtom, {
      tabs: [
        {
          id: "deleted",
          type: "session",
          title: "Deleted",
          sessionId: "deleted",
        },
      ],
      activeTabId: "deleted",
    });

    store.set(invalidateSessionChatPanelTabsAtom, "deleted");

    const state = store.get(chatPanelTabsAtom);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].type).toBe("start-page");
    expect(state.activeTabId).toBe(state.tabs[0].id);
  });
});
