// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createInstrumentedStore,
  resetInstrumentedStore,
} from "@src/util/core/state/instrumentedStore";

import {
  openRecentChatPanelTabAtom,
  recentChatPanelTabsAtom,
} from "../chatPanelRecentTabs";
import {
  buildDefaultLaunchpadTab,
  createSessionTab,
} from "../chatPanelTabFactories";
import { closeAndDestroyChatPanelTabAtom } from "../chatPanelTabLifecycleAtoms";
import { openOrReplaceSessionInChatPanelTabAtom } from "../chatPanelTabOpen/session";
import { activateChatPanelTabAtom } from "../chatPanelTabPresentationAtoms";
import { chatPanelTabsAtom } from "../chatPanelTabsState";

describe("Chat Panel recent tabs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetInstrumentedStore();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records tabs as navigation leaves them and excludes the destination", () => {
    const store = createInstrumentedStore();
    const launchpad = buildDefaultLaunchpadTab();
    const sessionA = createSessionTab({ sessionId: "session-a", title: "A" });
    const sessionB = createSessionTab({ sessionId: "session-b", title: "B" });
    store.set(chatPanelTabsAtom, {
      tabs: [launchpad, sessionA, sessionB],
      activeTabId: launchpad.id,
    });

    store.set(activateChatPanelTabAtom, sessionA.id);
    expect(store.get(recentChatPanelTabsAtom)).toEqual([]);

    store.set(activateChatPanelTabAtom, sessionB.id);
    expect(store.get(recentChatPanelTabsAtom)).toEqual([sessionA]);

    store.set(activateChatPanelTabAtom, launchpad.id);
    expect(store.get(recentChatPanelTabsAtom)).toEqual([sessionB, sessionA]);

    expect(store.set(openRecentChatPanelTabAtom, sessionA.id)).toBe(
      sessionA.id
    );
    expect(store.get(chatPanelTabsAtom).activeTabId).toBe(sessionA.id);
    expect(store.get(recentChatPanelTabsAtom)).toEqual([sessionB]);
  });

  it("keeps an explicitly closed tab available and restores its payload", async () => {
    const store = createInstrumentedStore();
    const tab = createSessionTab({
      sessionId: "session-recent",
      title: "Recent session",
    });
    store.set(chatPanelTabsAtom, { tabs: [tab], activeTabId: tab.id });

    await store.set(closeAndDestroyChatPanelTabAtom, tab.id);

    expect(store.get(recentChatPanelTabsAtom)).toEqual([tab]);
    expect(store.set(openRecentChatPanelTabAtom, tab.id)).toBe(tab.id);
    expect(store.get(chatPanelTabsAtom)).toMatchObject({
      tabs: [tab],
      activeTabId: tab.id,
    });
    expect(store.get(recentChatPanelTabsAtom)).toEqual([]);
  });

  it("removes a recent session when sidebar navigation consumes Launchpad", () => {
    const store = createInstrumentedStore();
    const launchpad = buildDefaultLaunchpadTab();
    const sessionA = createSessionTab({ sessionId: "session-a", title: "A" });
    store.set(chatPanelTabsAtom, {
      tabs: [launchpad],
      activeTabId: launchpad.id,
    });
    store.set(recentChatPanelTabsAtom, [sessionA]);

    const openedTabId = store.set(openOrReplaceSessionInChatPanelTabAtom, {
      sessionId: "session-a",
      sessionName: "A",
    });

    expect(store.get(chatPanelTabsAtom).activeTabId).toBe(openedTabId);
    expect(store.get(recentChatPanelTabsAtom)).toEqual([]);
  });

  it("does not offer the automatically reseeded sole Launchpad", async () => {
    const store = createInstrumentedStore();
    const state = store.get(chatPanelTabsAtom);

    await store.set(closeAndDestroyChatPanelTabAtom, state.activeTabId);

    expect(store.get(recentChatPanelTabsAtom)).toEqual([]);
  });
});
