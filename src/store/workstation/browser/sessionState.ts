import { atom } from "jotai";
import { v4 as uuidv4 } from "uuid";

import type { BrowserSession } from "@src/types/ui/tabs";

import { NEW_PRIVATE_TAB_TITLE, NEW_TAB_TITLE } from "./sessionTitles";

export const BROWSER_SESSIONS_STORAGE_KEY = "browser-explorer-sessions";

export interface BrowserSessionState {
  sessions: BrowserSession[];
  activeSessionId: string;
}

const EMPTY_BROWSER_SESSION_STATE: BrowserSessionState = {
  sessions: [],
  activeSessionId: "",
};

function getTitleFromUrl(url: string): string {
  if (!url) return NEW_TAB_TITLE;
  try {
    return new URL(url).hostname || NEW_TAB_TITLE;
  } catch {
    return NEW_TAB_TITLE;
  }
}

export function loadBrowserSessionState(): BrowserSessionState {
  try {
    const stored = localStorage.getItem(BROWSER_SESSIONS_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : null;
    const sessions = Array.isArray(parsed?.sessions)
      ? (parsed.sessions as BrowserSession[])
      : [];
    if (sessions.length === 0) return EMPTY_BROWSER_SESSION_STATE;

    const requestedActiveSessionId =
      typeof parsed?.activeSessionId === "string" ? parsed.activeSessionId : "";
    const activeSessionId = sessions.some(
      (session) => session.id === requestedActiveSessionId
    )
      ? requestedActiveSessionId
      : (sessions[0]?.id ?? "");
    return { sessions, activeSessionId };
  } catch {
    return EMPTY_BROWSER_SESSION_STATE;
  }
}

export function persistBrowserSessionState(state: BrowserSessionState): void {
  try {
    if (state.sessions.length === 0) {
      localStorage.removeItem(BROWSER_SESSIONS_STORAGE_KEY);
      return;
    }
    localStorage.setItem(BROWSER_SESSIONS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Browser sessions remain usable in memory when storage is unavailable.
  }
}

function commitBrowserSessionState(
  set: (
    atom: typeof browserSessionStateAtom,
    state: BrowserSessionState
  ) => void,
  state: BrowserSessionState
): void {
  set(browserSessionStateAtom, state);
  persistBrowserSessionState(state);
}

/**
 * Authoritative browser-session state. WorkStation browser tabs are a derived
 * presentation of this resource list and must not outlive a removed session.
 */
export const browserSessionStateAtom = atom<BrowserSessionState>(
  loadBrowserSessionState()
);
browserSessionStateAtom.debugLabel = "browserSessionStateAtom";

export const addBrowserSessionAtom = atom(
  null,
  (_get, set, request: { url?: string; incognito?: boolean } = {}): string => {
    const url = request.url ?? "";
    const incognito = request.incognito ?? false;
    const sessionId = uuidv4();
    const session: BrowserSession = {
      id: sessionId,
      title: url
        ? getTitleFromUrl(url)
        : incognito
          ? NEW_PRIVATE_TAB_TITLE
          : NEW_TAB_TITLE,
      url,
      history: url ? [url] : [],
      historyIndex: url ? 0 : -1,
      historyEntries: url
        ? [{ url, title: getTitleFromUrl(url), visitedAt: Date.now() }]
        : [],
      isLoading: false,
      error: null,
      incognito,
    };
    set(browserSessionStateAtom, (previous) => {
      const next = {
        sessions: [...previous.sessions, session],
        activeSessionId: sessionId,
      };
      persistBrowserSessionState(next);
      return next;
    });
    return sessionId;
  }
);
addBrowserSessionAtom.debugLabel = "addBrowserSessionAtom";

export const setActiveBrowserSessionAtom = atom(
  null,
  (get, set, sessionId: string) => {
    const previous = get(browserSessionStateAtom);
    if (
      previous.activeSessionId === sessionId ||
      !previous.sessions.some((session) => session.id === sessionId)
    ) {
      return;
    }
    commitBrowserSessionState(set, {
      ...previous,
      activeSessionId: sessionId,
    });
  }
);
setActiveBrowserSessionAtom.debugLabel = "setActiveBrowserSessionAtom";

export const closeBrowserSessionsAtom = atom(
  null,
  (get, set, sessionIds: readonly string[]) => {
    const previous = get(browserSessionStateAtom);
    const removedIds = new Set(sessionIds);
    if (!previous.sessions.some((session) => removedIds.has(session.id))) {
      return;
    }

    const sessions = previous.sessions.filter(
      (session) => !removedIds.has(session.id)
    );
    const activeSessionId = removedIds.has(previous.activeSessionId)
      ? (sessions[0]?.id ?? "")
      : previous.activeSessionId;
    commitBrowserSessionState(set, { sessions, activeSessionId });
  }
);
closeBrowserSessionsAtom.debugLabel = "closeBrowserSessionsAtom";

export const closeBrowserSessionAtom = atom(
  null,
  (_get, set, sessionId: string) => {
    set(closeBrowserSessionsAtom, [sessionId]);
  }
);
closeBrowserSessionAtom.debugLabel = "closeBrowserSessionAtom";

export const updateBrowserSessionAtom = atom(
  null,
  (
    get,
    set,
    request: { sessionId: string; updates: Partial<BrowserSession> }
  ) => {
    const previous = get(browserSessionStateAtom);
    const targetIndex = previous.sessions.findIndex(
      (session) => session.id === request.sessionId
    );
    if (targetIndex === -1) return;

    const sessions = [...previous.sessions];
    sessions[targetIndex] = {
      ...sessions[targetIndex],
      ...request.updates,
      id: request.sessionId,
    };
    commitBrowserSessionState(set, { ...previous, sessions });
  }
);
updateBrowserSessionAtom.debugLabel = "updateBrowserSessionAtom";

export const forceSaveBrowserSessionsAtom = atom(null, (get) => {
  persistBrowserSessionState(get(browserSessionStateAtom));
});
forceSaveBrowserSessionsAtom.debugLabel = "forceSaveBrowserSessionsAtom";
