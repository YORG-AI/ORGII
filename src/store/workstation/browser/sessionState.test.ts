import { createStore } from "jotai/vanilla";
import { beforeEach, describe, expect, it } from "vitest";

import type { BrowserSession } from "@src/types/ui/tabs";

import {
  BROWSER_SESSIONS_STORAGE_KEY,
  addBrowserSessionAtom,
  browserSessionStateAtom,
  closeBrowserSessionAtom,
  closeBrowserSessionsAtom,
  loadBrowserSessionState,
  persistBrowserSessionState,
  setActiveBrowserSessionAtom,
  updateBrowserSessionAtom,
} from "./sessionState";

function session(
  id: string,
  url = `https://${id}.example.com`
): BrowserSession {
  return {
    id,
    title: id,
    url,
    history: [url],
    historyIndex: 0,
    historyEntries: [{ url, title: id, visitedAt: 1 }],
    isLoading: false,
    error: null,
    incognito: false,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("browserSessionStateAtom", () => {
  it("closes the authoritative active session and persists the fallback selection", () => {
    const store = createStore();
    store.set(browserSessionStateAtom, {
      sessions: [session("one"), session("two")],
      activeSessionId: "two",
    });

    store.set(closeBrowserSessionAtom, "two");

    expect(store.get(browserSessionStateAtom)).toEqual({
      sessions: [session("one")],
      activeSessionId: "one",
    });
    expect(
      JSON.parse(localStorage.getItem(BROWSER_SESSIONS_STORAGE_KEY)!)
    ).toEqual(store.get(browserSessionStateAtom));
  });

  it("batch-closes sessions in one transition and clears durable storage", () => {
    const store = createStore();
    const initial = {
      sessions: [session("one"), session("two")],
      activeSessionId: "one",
    };
    store.set(browserSessionStateAtom, initial);
    persistBrowserSessionState(initial);

    store.set(closeBrowserSessionsAtom, ["one", "two", "missing"]);

    expect(store.get(browserSessionStateAtom)).toEqual({
      sessions: [],
      activeSessionId: "",
    });
    expect(localStorage.getItem(BROWSER_SESSIONS_STORAGE_KEY)).toBeNull();
  });

  it("keeps the active-session invariant across add, select, and update", () => {
    const store = createStore();
    const firstId = store.set(addBrowserSessionAtom, {
      url: "https://first.example.com/path",
    });
    const secondId = store.set(addBrowserSessionAtom, {});

    store.set(setActiveBrowserSessionAtom, firstId);
    store.set(updateBrowserSessionAtom, {
      sessionId: firstId,
      updates: { title: "First", id: "cannot-replace-id" },
    });
    store.set(setActiveBrowserSessionAtom, "missing");

    const state = store.get(browserSessionStateAtom);
    expect(state.activeSessionId).toBe(firstId);
    expect(state.sessions.map((item) => item.id)).toEqual([firstId, secondId]);
    expect(state.sessions[0]?.title).toBe("First");
  });

  it("hydrates a valid fallback when persisted active selection is stale", () => {
    localStorage.setItem(
      BROWSER_SESSIONS_STORAGE_KEY,
      JSON.stringify({
        sessions: [session("one"), session("two")],
        activeSessionId: "missing",
      })
    );

    expect(loadBrowserSessionState().activeSessionId).toBe("one");
  });
});
