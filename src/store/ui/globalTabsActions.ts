/**
 * Global Tabs — Write action atoms
 *
 * Organized by tab domain: browser, terminal, editor, files, sessions, shortcuts.
 */
import { invoke as invokeTauri } from "@tauri-apps/api/core";
import { atom } from "jotai";

import { createLogger } from "@src/hooks/logger";
import { isTauriDesktop } from "@src/util/platform/tauri";
import { toBackendPtySessionId } from "@src/util/ui/terminal/ptySessionId";

import type {
  BrowserTab,
  DocumentFile,
  EditorRepo,
  ShortcutItem,
  TerminalSession,
  WorkspaceSession,
} from "./globalTabsTypes";
import {
  MAX_BROWSER_TABS,
  MAX_DOCUMENT_FILES,
  MAX_EDITOR_REPOS,
  MAX_SHORTCUTS,
  MAX_TERMINAL_SESSIONS,
  MAX_WORKSPACE_SESSIONS,
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

// ============================================
// Editor Repos
// ============================================

export const addEditorRepoAtom = atom(
  null,
  (get, set, repo: Omit<EditorRepo, "timestamp">) => {
    const state = get(navigationSidebarTabsAtom);
    if (state.editor.some((e) => e.id === repo.id)) {
      set(navigationSidebarTabsAtom, {
        ...state,
        editor: state.editor.map((e) => ({
          ...e,
          isActive: e.id === repo.id,
        })),
      });
      return;
    }
    set(navigationSidebarTabsAtom, {
      ...state,
      editor: evictOldest(
        state.editor
          .map((e) => ({ ...e, isActive: false }))
          .concat({ ...repo, timestamp: Date.now() }),
        MAX_EDITOR_REPOS
      ),
    });
  }
);
addEditorRepoAtom.debugLabel = "addEditorRepoAtom";

export const removeEditorRepoAtom = atom(null, (get, set, repoId: string) => {
  const state = get(navigationSidebarTabsAtom);
  set(navigationSidebarTabsAtom, {
    ...state,
    editor: state.editor.filter((e) => e.id !== repoId),
  });
});
removeEditorRepoAtom.debugLabel = "removeEditorRepoAtom";

export const setActiveEditorRepoAtom = atom(
  null,
  (get, set, repoId: string) => {
    const state = get(navigationSidebarTabsAtom);
    set(navigationSidebarTabsAtom, {
      ...state,
      editor: state.editor.map((e) => ({
        ...e,
        isActive: e.id === repoId,
      })),
    });
  }
);
setActiveEditorRepoAtom.debugLabel = "setActiveEditorRepoAtom";

// ============================================
// Files/Documents
// ============================================

export const addDocumentFileAtom = atom(
  null,
  (get, set, doc: Omit<DocumentFile, "timestamp">) => {
    const state = get(navigationSidebarTabsAtom);
    if (state.files.some((f) => f.id === doc.id)) {
      set(navigationSidebarTabsAtom, {
        ...state,
        files: state.files.map((f) => ({
          ...f,
          isActive: f.id === doc.id,
        })),
      });
      return;
    }
    set(navigationSidebarTabsAtom, {
      ...state,
      files: evictOldest(
        state.files
          .map((f) => ({ ...f, isActive: false }))
          .concat({ ...doc, timestamp: Date.now() }),
        MAX_DOCUMENT_FILES
      ),
    });
  }
);
addDocumentFileAtom.debugLabel = "addDocumentFileAtom";

export const removeDocumentFileAtom = atom(null, (get, set, docId: string) => {
  const state = get(navigationSidebarTabsAtom);
  set(navigationSidebarTabsAtom, {
    ...state,
    files: state.files.filter((f) => f.id !== docId),
  });
});
removeDocumentFileAtom.debugLabel = "removeDocumentFileAtom";

export const setActiveDocumentFileAtom = atom(
  null,
  (get, set, docId: string) => {
    const state = get(navigationSidebarTabsAtom);
    set(navigationSidebarTabsAtom, {
      ...state,
      files: state.files.map((f) => ({
        ...f,
        isActive: f.id === docId,
      })),
    });
  }
);
setActiveDocumentFileAtom.debugLabel = "setActiveDocumentFileAtom";

// ============================================
// Workspace Sessions
// ============================================

export const addWorkspaceSessionAtom = atom(
  null,
  (get, set, session: Omit<WorkspaceSession, "timestamp">) => {
    const state = get(navigationSidebarTabsAtom);
    if (state.sessions.some((s) => s.session_id === session.session_id)) {
      set(navigationSidebarTabsAtom, {
        ...state,
        sessions: state.sessions.map((s) => ({
          ...s,
          isActive: s.session_id === session.session_id,
        })),
      });
      return;
    }
    set(navigationSidebarTabsAtom, {
      ...state,
      sessions: evictOldest(
        state.sessions
          .map((s) => ({ ...s, isActive: false }))
          .concat({ ...session, timestamp: Date.now() }),
        MAX_WORKSPACE_SESSIONS
      ),
    });
  }
);
addWorkspaceSessionAtom.debugLabel = "addWorkspaceSessionAtom";

export const removeWorkspaceSessionAtom = atom(
  null,
  (get, set, sessionId: string) => {
    const state = get(navigationSidebarTabsAtom);
    set(navigationSidebarTabsAtom, {
      ...state,
      sessions: state.sessions.filter((s) => s.session_id !== sessionId),
    });
  }
);
removeWorkspaceSessionAtom.debugLabel = "removeWorkspaceSessionAtom";

export const setActiveWorkspaceSessionAtom = atom(
  null,
  (get, set, sessionId: string) => {
    const state = get(navigationSidebarTabsAtom);
    set(navigationSidebarTabsAtom, {
      ...state,
      sessions: state.sessions.map((s) => ({
        ...s,
        isActive: s.session_id === sessionId,
      })),
    });
  }
);
setActiveWorkspaceSessionAtom.debugLabel = "setActiveWorkspaceSessionAtom";

// ============================================
// Shortcuts
// ============================================

export const addShortcutAtom = atom(
  null,
  (get, set, shortcut: Omit<ShortcutItem, "timestamp">) => {
    const state = get(navigationSidebarTabsAtom);
    if (state.shortcuts.some((s) => s.id === shortcut.id)) {
      set(navigationSidebarTabsAtom, {
        ...state,
        shortcuts: state.shortcuts.map((s) => ({
          ...s,
          isActive: s.id === shortcut.id,
        })),
      });
      return;
    }
    set(navigationSidebarTabsAtom, {
      ...state,
      shortcuts: evictOldest(
        state.shortcuts
          .map((s) => ({ ...s, isActive: false }))
          .concat({ ...shortcut, timestamp: Date.now() }),
        MAX_SHORTCUTS
      ),
    });
  }
);
addShortcutAtom.debugLabel = "addShortcutAtom";

export const removeShortcutAtom = atom(null, (get, set, shortcutId: string) => {
  const state = get(navigationSidebarTabsAtom);
  set(navigationSidebarTabsAtom, {
    ...state,
    shortcuts: state.shortcuts.filter((s) => s.id !== shortcutId),
  });
});
removeShortcutAtom.debugLabel = "removeShortcutAtom";

export const setActiveShortcutAtom = atom(
  null,
  (get, set, shortcutId: string) => {
    const state = get(navigationSidebarTabsAtom);
    set(navigationSidebarTabsAtom, {
      ...state,
      shortcuts: state.shortcuts.map((s) => ({
        ...s,
        isActive: s.id === shortcutId,
      })),
    });
  }
);
setActiveShortcutAtom.debugLabel = "setActiveShortcutAtom";
