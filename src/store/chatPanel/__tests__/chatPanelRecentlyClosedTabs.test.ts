// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createInstrumentedStore,
  resetInstrumentedStore,
} from "@src/util/core/state/instrumentedStore";

import {
  recentlyClosedChatPanelTabsAtom,
  restoreRecentlyClosedChatPanelTabAtom,
} from "../chatPanelRecentlyClosedTabs";
import { createSessionTab } from "../chatPanelTabFactories";
import { closeAndDestroyChatPanelTabAtom } from "../chatPanelTabLifecycleAtoms";
import { chatPanelTabsAtom } from "../chatPanelTabsState";

describe("Chat Panel recently closed tabs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetInstrumentedStore();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records an explicit close and restores the same tab payload", async () => {
    const store = createInstrumentedStore();
    const tab = createSessionTab({
      sessionId: "session-recent",
      title: "Recent session",
    });
    store.set(chatPanelTabsAtom, { tabs: [tab], activeTabId: tab.id });

    await store.set(closeAndDestroyChatPanelTabAtom, tab.id);

    expect(store.get(recentlyClosedChatPanelTabsAtom)).toEqual([tab]);

    expect(store.set(restoreRecentlyClosedChatPanelTabAtom, tab.id)).toBe(
      tab.id
    );
    expect(store.get(chatPanelTabsAtom)).toMatchObject({
      tabs: [tab],
      activeTabId: tab.id,
    });
    expect(store.get(recentlyClosedChatPanelTabsAtom)).toEqual([]);
  });

  it("does not offer the automatically reseeded sole Launchpad", async () => {
    const store = createInstrumentedStore();
    const state = store.get(chatPanelTabsAtom);

    await store.set(closeAndDestroyChatPanelTabAtom, state.activeTabId);

    expect(store.get(recentlyClosedChatPanelTabsAtom)).toEqual([]);
  });
});
