/**
 * Global Tabs — Write action atoms
 *
 * Used by the browser and terminal context sync hooks.
 */
import { invoke as invokeTauri } from "@tauri-apps/api/core";
import { atom } from "jotai";

import { createLogger } from "@src/hooks/logger";
import { isTauriDesktop } from "@src/util/platform/tauri";
import { toBackendPtySessionId } from "@src/util/ui/terminal/ptySessionId";

import type { BrowserTab, TerminalSession } from "./globalTabsTypes";
import {
  MAX_BROWSER_TABS,
  MAX_TERMINAL_SESSIONS,
  evictOldest,
} from "./globalTabsTypes";
import { navigationSidebarTabsAtom } from "./navigationSidebarTabsAtom";

const log = createLogger("GlobalTabs");

// ============================================
// Browser Tabs
// ============================================

export const addBrowserTabAtom = atom(
  null,
  (get, set, tab: Omit<BrowserTab, "timestamp">) => {
    const state = get(navigationSidebarTabsAtom);
    const existing = state.browser.find((b) => b.id === tab.id);
    if (existing) {
      set(navigationSidebarTabsAtom, {
        ...state,
        browser: state.browser.map((b) =>
          b.id === tab.id
            ? { ...b, ...tab, isActive: true, timestamp: Date.now() }
            : { ...b, isActive: false }
        ),
      });
      return;
    }
    set(navigationSidebarTabsAtom, {
      ...state,
      browser: evictOldest(
        state.browser
          .map((b) => ({ ...b, isActive: false }))
          .concat({ ...tab, timestamp: Date.now() }),
        MAX_BROWSER_TABS
      ),
    });
  }
);
addBrowserTabAtom.debugLabel = "addBrowserTabAtom";

export const removeBrowserTabAtom = atom(null, (get, set, tabId: string) => {
  const state = get(navigationSidebarTabsAtom);
  set(navigationSidebarTabsAtom, {
    ...state,
    browser: state.browser.filter((b) => b.id !== tabId),
  });
});
removeBrowserTabAtom.debugLabel = "removeBrowserTabAtom";

export const setActiveBrowserTabAtom = atom(null, (get, set, tabId: string) => {
  const state = get(navigationSidebarTabsAtom);
  set(navigationSidebarTabsAtom, {
    ...state,
    browser: state.browser.map((b) => ({
      ...b,
      isActive: b.id === tabId,
    })),
  });
});
setActiveBrowserTabAtom.debugLabel = "setActiveBrowserTabAtom";

export const updateBrowserTabAtom = atom(
  null,
  (get, set, update: { id: string; title?: string; url?: string }) => {
    const state = get(navigationSidebarTabsAtom);
    set(navigationSidebarTabsAtom, {
      ...state,
      browser: state.browser.map((b) =>
        b.id === update.id ? { ...b, ...update, timestamp: Date.now() } : b
      ),
    });
  }
);
updateBrowserTabAtom.debugLabel = "updateBrowserTabAtom";

// ============================================
// Terminal Sessions
// ============================================

export const addTerminalSessionAtom = atom(
  null,
  (get, set, session: Omit<TerminalSession, "timestamp">) => {
    const state = get(navigationSidebarTabsAtom);
    const existing = state.terminal.find((t) => t.id === session.id);
    if (existing) {
      set(navigationSidebarTabsAtom, {
        ...state,
        terminal: state.terminal.map((t) =>
          t.id === session.id
            ? { ...t, ...session, isActive: true, timestamp: Date.now() }
            : { ...t, isActive: false }
        ),
      });
      return;
    }
    set(navigationSidebarTabsAtom, {
      ...state,
      terminal: evictOldest(
        state.terminal
          .map((t) => ({ ...t, isActive: false }))
          .concat({ ...session, timestamp: Date.now() }),
        MAX_TERMINAL_SESSIONS
      ),
    });
  }
);
addTerminalSessionAtom.debugLabel = "addTerminalSessionAtom";

export const removeTerminalSessionAtom = atom(
  null,
  (get, set, sessionId: string) => {
    if (isTauriDesktop()) {
      const ptySessionId = toBackendPtySessionId(sessionId);
      invokeTauri("close_pty", { sessionId: ptySessionId })
        .then(() => {})
        .catch((err) => {
          log.error(`Failed to close PTY ${ptySessionId}:`, err);
        });
    }
    const state = get(navigationSidebarTabsAtom);
    set(navigationSidebarTabsAtom, {
      ...state,
      terminal: state.terminal.filter((t) => t.id !== sessionId),
    });
  }
);
removeTerminalSessionAtom.debugLabel = "removeTerminalSessionAtom";

export const setActiveTerminalSessionAtom = atom(
  null,
  (get, set, sessionId: string) => {
    const state = get(navigationSidebarTabsAtom);
    set(navigationSidebarTabsAtom, {
      ...state,
      terminal: state.terminal.map((t) => ({
        ...t,
        isActive: t.id === sessionId,
      })),
    });
  }
);
setActiveTerminalSessionAtom.debugLabel = "setActiveTerminalSessionAtom";
