import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activeSessionIdAtom } from "@src/store/session/viewAtom";
import {
  createInstrumentedStore,
  resetInstrumentedStore,
} from "@src/util/core/state/instrumentedStore";

import {
  CHAT_PANEL_TAB_HISTORY_LIMIT,
  activeChatPanelTabCanGoBackAtom,
  activeChatPanelTabCanGoForwardAtom,
  activeChatPanelTabHistoryAtom,
  chatPanelTabHistoriesAtom,
  goBackChatPanelTabAtom,
  goForwardChatPanelTabAtom,
  navigateChatPanelTabToSessionAtom,
  pushTabHistoryEntry,
} from "../chatPanelTabNavigationAtoms";
import {
  chatPanelTabsAtom,
  closeChatPanelTabAtom,
  openOrReplaceSessionInChatPanelTabAtom,
  openRecentChatPanelTabAtom,
  openRuntimeInChatPanelTabAtom,
  openSessionInNewChatTabAtom,
  recentChatPanelTabsAtom,
} from "../chatPanelTabsAtom";

function makeStore() {
  const store = createInstrumentedStore();
  const tabId = store.set(openSessionInNewChatTabAtom, {
    sessionId: "session-a",
    sessionName: "Session A",
  });
  return { store, tabId };
}

describe("chat panel tab navigation history", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetInstrumentedStore();
    localStorage.removeItem("orgii:chatPanelTabs:v2");
    localStorage.removeItem("orgii-v2-session-view");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("seeds a fresh session tab with a one-entry trail and nothing to walk", () => {
    const { store } = makeStore();

    expect(store.get(activeChatPanelTabHistoryAtom)).toEqual({
      entries: ["session-a"],
      index: 0,
    });
    expect(store.get(activeChatPanelTabCanGoBackAtom)).toBe(false);
    expect(store.get(activeChatPanelTabCanGoForwardAtom)).toBe(false);
  });

  it("walks back and forward along the trail without extending it", () => {
    const { store, tabId } = makeStore();
    store.set(openOrReplaceSessionInChatPanelTabAtom, {
      sessionId: "session-b",
    });
    store.set(openOrReplaceSessionInChatPanelTabAtom, {
      sessionId: "session-c",
    });
    expect(store.get(activeChatPanelTabHistoryAtom)).toEqual({
      entries: ["session-a", "session-b", "session-c"],
      index: 2,
    });

    expect(store.set(goBackChatPanelTabAtom)).toBe(true);
    expect(store.get(chatPanelTabsAtom)).toMatchObject({
      activeTabId: tabId,
      tabs: [{ id: tabId, sessionId: "session-b" }],
    });
    expect(store.get(activeSessionIdAtom)).toBe("session-b");
    expect(store.get(activeChatPanelTabCanGoBackAtom)).toBe(true);
    expect(store.get(activeChatPanelTabCanGoForwardAtom)).toBe(true);

    expect(store.set(goBackChatPanelTabAtom)).toBe(true);
    expect(store.get(activeSessionIdAtom)).toBe("session-a");
    expect(store.get(activeChatPanelTabCanGoBackAtom)).toBe(false);
    expect(store.set(goBackChatPanelTabAtom)).toBe(false);

    expect(store.set(goForwardChatPanelTabAtom)).toBe(true);
    expect(store.get(activeSessionIdAtom)).toBe("session-b");
    expect(store.get(activeChatPanelTabHistoryAtom)).toEqual({
      entries: ["session-a", "session-b", "session-c"],
      index: 1,
    });
  });

  it("drops the forward trail when navigating from the middle", () => {
    const { store } = makeStore();
    store.set(openOrReplaceSessionInChatPanelTabAtom, {
      sessionId: "session-b",
    });
    store.set(openOrReplaceSessionInChatPanelTabAtom, {
      sessionId: "session-c",
    });
    store.set(goBackChatPanelTabAtom);
    store.set(goBackChatPanelTabAtom);

    store.set(openOrReplaceSessionInChatPanelTabAtom, {
      sessionId: "session-d",
    });

    expect(store.get(activeChatPanelTabHistoryAtom)).toEqual({
      entries: ["session-a", "session-d"],
      index: 1,
    });
    expect(store.get(activeChatPanelTabCanGoForwardAtom)).toBe(false);
  });

  it("keeps a separate trail per tab", () => {
    const { store, tabId: tabA } = makeStore();
    store.set(openOrReplaceSessionInChatPanelTabAtom, {
      sessionId: "session-b",
    });
    const tabX = store.set(openSessionInNewChatTabAtom, {
      sessionId: "session-x",
    });
    store.set(openOrReplaceSessionInChatPanelTabAtom, {
      sessionId: "session-y",
    });

    expect(store.get(chatPanelTabHistoriesAtom)).toEqual({
      [tabA]: { entries: ["session-a", "session-b"], index: 1 },
      [tabX]: { entries: ["session-x", "session-y"], index: 1 },
    });
  });

  it("ignores Back / Forward while a non-session tab is active", () => {
    const { store } = makeStore();
    store.set(openOrReplaceSessionInChatPanelTabAtom, {
      sessionId: "session-b",
    });
    store.set(openRuntimeInChatPanelTabAtom, "Runtime");

    expect(store.get(activeChatPanelTabCanGoBackAtom)).toBe(false);
    expect(store.set(goBackChatPanelTabAtom)).toBe(false);
    expect(store.get(activeSessionIdAtom)).toBeNull();
  });

  it("forgets a tab's trail when the tab closes", () => {
    const { store, tabId } = makeStore();
    store.set(openOrReplaceSessionInChatPanelTabAtom, {
      sessionId: "session-b",
    });
    expect(store.get(chatPanelTabHistoriesAtom)).toHaveProperty(tabId);

    store.set(closeChatPanelTabAtom, tabId);

    expect(store.get(chatPanelTabHistoriesAtom)).toEqual({});
  });

  it("refuses to navigate a non-session tab", () => {
    const { store } = makeStore();
    const runtimeTabId = store.set(openRuntimeInChatPanelTabAtom, "Runtime");

    expect(
      store.set(navigateChatPanelTabToSessionAtom, {
        tabId: runtimeTabId,
        sessionId: "session-b",
      })
    ).toBe(false);
    expect(store.get(chatPanelTabsAtom).tabs).toMatchObject([
      { type: "session", sessionId: "session-a" },
      { id: runtimeTabId, type: "runtime" },
    ]);
  });

  it("offers the session it left in recent tabs without colliding with the live tab", () => {
    const { store, tabId } = makeStore();
    store.set(openOrReplaceSessionInChatPanelTabAtom, {
      sessionId: "session-b",
      sessionName: "Session B",
    });

    const recent = store.get(recentChatPanelTabsAtom);
    expect(recent).toMatchObject([
      { type: "session", sessionId: "session-a", title: "Session A" },
    ]);
    expect(recent[0].id).not.toBe(tabId);

    const restoredTabId = store.set(openRecentChatPanelTabAtom, recent[0].id);
    expect(restoredTabId).toBe(recent[0].id);
    expect(store.get(chatPanelTabsAtom)).toMatchObject({
      activeTabId: restoredTabId,
      tabs: [
        { id: tabId, sessionId: "session-b" },
        { id: restoredTabId, sessionId: "session-a" },
      ],
    });
    // Restoring appends a tab, so the tab being left joins the list in turn.
    expect(store.get(recentChatPanelTabsAtom)).toMatchObject([
      { id: tabId, sessionId: "session-b" },
    ]);
  });

  it("drops the destination from recent tabs when navigating to it in place", () => {
    const { store } = makeStore();
    store.set(openOrReplaceSessionInChatPanelTabAtom, {
      sessionId: "session-b",
    });
    store.set(openOrReplaceSessionInChatPanelTabAtom, {
      sessionId: "session-c",
    });
    expect(
      store.get(recentChatPanelTabsAtom).map((tab) => tab.sessionId)
    ).toEqual(["session-b", "session-a"]);

    store.set(goBackChatPanelTabAtom);

    expect(
      store.get(recentChatPanelTabsAtom).map((tab) => tab.sessionId)
    ).toEqual(["session-c", "session-a"]);
  });

  it("bounds the trail and skips a no-op push", () => {
    let history = { entries: ["s0"], index: 0 };
    expect(pushTabHistoryEntry(history, "s0")).toBe(history);
    for (let i = 1; i <= CHAT_PANEL_TAB_HISTORY_LIMIT + 5; i += 1) {
      history = pushTabHistoryEntry(history, `s${i}`);
    }
    expect(history.entries).toHaveLength(CHAT_PANEL_TAB_HISTORY_LIMIT);
    expect(history.entries[0]).toBe("s6");
    expect(history.index).toBe(CHAT_PANEL_TAB_HISTORY_LIMIT - 1);
  });
});
