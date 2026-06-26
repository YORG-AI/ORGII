/**
 * Terminal State Atoms
 *
 * Unified state management for terminal sessions.
 * Used by both useTerminalState hook and TerminalService.
 *
 * Architecture:
 * - Core atoms: Raw state storage (fine-grained for performance)
 * - Derived atoms: Computed values (auto-memoized)
 * - Action atoms: Write-only operations with encapsulated logic
 */
import type {
  AddSessionOptions,
  TerminalSession,
} from "@/src/engines/TerminalCore/types";
import { atom } from "jotai";

import { getSettingsDefaults } from "@src/config/settingsSchema";
import { createLogger } from "@src/hooks/logger";
import { settingsAtom } from "@src/store/settings/settingsAtom";
import { invokeTauri, isTauriReady } from "@src/util/platform/tauri/init";
import {
  notifyTerminalCreationCooldown,
  tryBeginTerminalCreation,
} from "@src/util/ui/terminal/creationThrottle";
import {
  defaultTerminalLabelBaseFromSettings,
  generateUniqueLabelFromBase,
  resolveTerminalDisplayName,
} from "@src/util/ui/terminal/naming";
import {
  isAgentPtySessionId,
  toBackendPtySessionId,
} from "@src/util/ui/terminal/ptySessionId";

const log = createLogger("TerminalStore");

// ============================================
// Storage Keys
// ============================================

const TERMINAL_STORAGE_KEY = "work_station_terminal_state";

// ============================================
// Helper Functions
// ============================================

/**
 * Kill PTY process for a session
 */
async function killPty(sessionId: string): Promise<void> {
  if (!isTauriReady()) return;

  try {
    await invokeTauri("close_pty", {
      sessionId: toBackendPtySessionId(sessionId),
    });
  } catch (error) {
    log.error(`[TerminalStore] Failed to kill PTY:`, error);
  }
}

/**
 * Load initial state from localStorage
 *
 * PERFORMANCE: This runs once at module load time.
 * We keep it simple and synchronous for initial state hydration.
 */
function loadPersistedState(): {
  sessions: TerminalSession[];
  activeSessionId: string;
  initializedSessionIds: string[];
} | null {
  try {
    const stored = localStorage.getItem(TERMINAL_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (
        parsed.sessions &&
        Array.isArray(parsed.sessions) &&
        parsed.activeSessionId &&
        parsed.initializedSessionIds &&
        Array.isArray(parsed.initializedSessionIds)
      ) {
        const sessions = parsed.sessions.filter(
          (session: TerminalSession) => !isAgentPtySessionId(session.id)
        );
        if (sessions.length === 0) return null;
        const activeSessionId = isAgentPtySessionId(parsed.activeSessionId)
          ? sessions[0].id
          : parsed.activeSessionId;
        return {
          sessions,
          activeSessionId,
          initializedSessionIds: parsed.initializedSessionIds.filter(
            (sessionId: string) => !isAgentPtySessionId(sessionId)
          ),
        };
      }
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

/**
 * Get default initial state
 */
function getDefaultState(): {
  sessions: TerminalSession[];
  activeSessionId: string;
  initializedSessionIds: Set<string>;
} {
  const defaultBase = defaultTerminalLabelBaseFromSettings(
    getSettingsDefaults()
  );
  const initialName = generateUniqueLabelFromBase(defaultBase, []);
  return {
    sessions: [
      { id: "1", name: initialName, isActive: true, isDefaultSession: true },
    ],
    activeSessionId: "1",
    initializedSessionIds: new Set(["1"]),
  };
}

// Initialize from persisted or default
const persisted = loadPersistedState();
const initialState = persisted
  ? {
      sessions: persisted.sessions,
      activeSessionId: persisted.activeSessionId,
      initializedSessionIds: new Set(persisted.initializedSessionIds),
    }
  : getDefaultState();

// ============================================
// Core State Atoms (fine-grained for performance)
// ============================================

/** All terminal sessions */
export const terminalSessionsAtom = atom<TerminalSession[]>(
  initialState.sessions
);
terminalSessionsAtom.debugLabel = "terminalSessionsAtom";

/** Currently active terminal session ID */
export const activeTerminalIdAtom = atom<string>(initialState.activeSessionId);
activeTerminalIdAtom.debugLabel = "activeTerminalIdAtom";

/** Set of initialized session IDs (PTY connections ready) */
export const initializedTerminalIdsAtom = atom<Set<string>>(
  initialState.initializedSessionIds
);
initializedTerminalIdsAtom.debugLabel = "initializedTerminalIdsAtom";

// ============================================
// Derived Atoms (computed, no extra storage)
// ============================================

/** Currently active terminal session object (editor bottom panel) */
export const editorActiveTerminalSessionAtom = atom((get) => {
  const sessions = get(terminalSessionsAtom);
  const activeId = get(activeTerminalIdAtom);
  return sessions.find((session) => session.id === activeId);
});
editorActiveTerminalSessionAtom.debugLabel = "editorActiveTerminalSessionAtom";

/** Number of terminal sessions */
export const terminalSessionCountAtom = atom((get) => {
  return get(terminalSessionsAtom).length;
});
terminalSessionCountAtom.debugLabel = "terminalSessionCountAtom";

/** Check if a session is initialized */
export const isTerminalInitializedAtom = atom((get) => {
  const initialized = get(initializedTerminalIdsAtom);
  return (sessionId: string) => initialized.has(sessionId);
});

// ============================================
// Persistence Atom (syncs to localStorage)
// ============================================

/** Persist state to localStorage on changes */
export const terminalPersistAtom = atom(null, (get) => {
  const sessions = get(terminalSessionsAtom);
  const activeSessionId = get(activeTerminalIdAtom);
  const initializedSessionIds = get(initializedTerminalIdsAtom);

  try {
    localStorage.setItem(
      TERMINAL_STORAGE_KEY,
      JSON.stringify({
        sessions,
        activeSessionId,
        initializedSessionIds: [...initializedSessionIds],
      })
    );
  } catch {
    // Ignore storage errors
  }
});
terminalPersistAtom.debugLabel = "terminalPersistAtom";

// ============================================
// Action Atoms (write-only, encapsulate logic)
// ============================================

/** Add a new terminal session (editor bottom panel).
 *
 * Accepts optional `AddSessionOptions` to specify a shell profile,
 * custom shell path, args, env, or name. When omitted, uses defaults.
 */
export const editorAddTerminalSessionAtom = atom(
  null,
  (get, set, options?: AddSessionOptions) => {
    if (!tryBeginTerminalCreation()) {
      notifyTerminalCreationCooldown();
      return get(activeTerminalIdAtom);
    }

    const sessions = get(terminalSessionsAtom);
    const existingNames = sessions.map((session) => session.name);
    const defaultBase = defaultTerminalLabelBaseFromSettings(get(settingsAtom));
    const displayName = resolveTerminalDisplayName(
      options,
      existingNames,
      defaultBase
    );
    const newId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const newSession: TerminalSession = {
      id: newId,
      name: displayName,
      isActive: true,
      profileId: options?.profileId,
      shell: options?.shell,
      cwd: options?.cwd,
    };

    set(terminalSessionsAtom, [
      ...sessions.map((session) => ({ ...session, isActive: false })),
      newSession,
    ]);
    set(activeTerminalIdAtom, newId);

    set(terminalPersistAtom);

    return newId;
  }
);
editorAddTerminalSessionAtom.debugLabel = "editorAddTerminalSessionAtom";

/** Close a terminal session */
export const closeTerminalSessionAtom = atom(
  null,
  async (get, set, sessionId: string) => {
    // Kill PTY first
    await killPty(sessionId);

    const sessions = get(terminalSessionsAtom);
    const activeId = get(activeTerminalIdAtom);

    if (sessions.length === 1) {
      // Create new default session when closing the last one
      const newId = Date.now().toString();
      const defaultBase = defaultTerminalLabelBaseFromSettings(
        get(settingsAtom)
      );
      const newSession: TerminalSession = {
        id: newId,
        name: generateUniqueLabelFromBase(defaultBase, []),
        isActive: true,
        isDefaultSession: true,
      };
      set(terminalSessionsAtom, [newSession]);
      set(activeTerminalIdAtom, newId);
      set(initializedTerminalIdsAtom, new Set([newId]));
    } else {
      const filtered = sessions.filter((session) => session.id !== sessionId);

      // If closing active session, activate the first remaining
      if (sessionId === activeId && filtered.length > 0) {
        const newActiveId = filtered[0].id;
        set(
          terminalSessionsAtom,
          filtered.map((session) => ({
            ...session,
            isActive: session.id === newActiveId,
          }))
        );
        set(activeTerminalIdAtom, newActiveId);
      } else {
        set(terminalSessionsAtom, filtered);
      }

      set(initializedTerminalIdsAtom, (prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }

    // Persist
    set(terminalPersistAtom);
  }
);
closeTerminalSessionAtom.debugLabel = "closeTerminalSessionAtom";

/** Set the active terminal session */
export const setActiveTerminalAtom = atom(
  null,
  (get, set, sessionId: string) => {
    const sessions = get(terminalSessionsAtom);

    // Update isActive flag on all sessions
    set(
      terminalSessionsAtom,
      sessions.map((session) => ({
        ...session,
        isActive: session.id === sessionId,
      }))
    );
    set(activeTerminalIdAtom, sessionId);

    // Persist
    set(terminalPersistAtom);
  }
);
setActiveTerminalAtom.debugLabel = "setActiveTerminalAtom";

/** Mark a session as initialized (PTY ready) */
export const markTerminalInitializedAtom = atom(
  null,
  (get, set, sessionId: string) => {
    set(initializedTerminalIdsAtom, (prev) => new Set([...prev, sessionId]));

    // Persist
    set(terminalPersistAtom);
  }
);
markTerminalInitializedAtom.debugLabel = "markTerminalInitializedAtom";

/** Create (or switch to) a read-only agent session terminal tab.
 *
 * Uses a deterministic ID (`agent-session-{agentSessionId}`) to prevent
 * duplicates. This tab is read-only and renders normal agent session events.
 */
export const createAgentSessionTerminalAtom = atom(
  null,
  (get, set, params: { agentSessionId: string; label?: string }) => {
    const tabId = `agent-session-${params.agentSessionId}`;
    const sessions = get(terminalSessionsAtom);

    // Already exists — just switch to it
    if (sessions.some((session) => session.id === tabId)) {
      set(setActiveTerminalAtom, tabId);
      return tabId;
    }

    const newSession: TerminalSession = {
      id: tabId,
      name: params.label || "Agent",
      isActive: true,
      readOnly: true,
      agentSessionId: params.agentSessionId,
    };

    set(terminalSessionsAtom, [
      ...sessions.map((session) => ({ ...session, isActive: false })),
      newSession,
    ]);
    set(activeTerminalIdAtom, tabId);

    // Mark as initialized immediately (no PTY to wait for)
    set(initializedTerminalIdsAtom, (prev) => new Set([...prev, tabId]));

    set(terminalPersistAtom);
    return tabId;
  }
);
createAgentSessionTerminalAtom.debugLabel = "createAgentSessionTerminalAtom";

/** Remove the read-only agent session terminal tab.
 *
 * Called when an OS agent session ends. Does not kill a PTY (there is none).
 */
export const removeAgentSessionTerminalAtom = atom(
  null,
  (get, set, agentSessionId: string) => {
    const tabId = `agent-session-${agentSessionId}`;
    const sessions = get(terminalSessionsAtom);
    const activeId = get(activeTerminalIdAtom);

    const filtered = sessions.filter((session) => session.id !== tabId);

    if (filtered.length === 0) {
      // Don't remove the last tab — create a default one
      const newId = Date.now().toString();
      const defaultBase = defaultTerminalLabelBaseFromSettings(
        get(settingsAtom)
      );
      const newSession: TerminalSession = {
        id: newId,
        name: generateUniqueLabelFromBase(defaultBase, []),
        isActive: true,
        isDefaultSession: true,
      };
      set(terminalSessionsAtom, [newSession]);
      set(activeTerminalIdAtom, newId);
      set(initializedTerminalIdsAtom, new Set([newId]));
    } else if (activeId === tabId) {
      // Was active — switch to first remaining
      const newActiveId = filtered[0].id;
      set(
        terminalSessionsAtom,
        filtered.map((session) => ({
          ...session,
          isActive: session.id === newActiveId,
        }))
      );
      set(activeTerminalIdAtom, newActiveId);
    } else {
      set(terminalSessionsAtom, filtered);
    }

    set(initializedTerminalIdsAtom, (prev) => {
      const next = new Set(prev);
      next.delete(tabId);
      return next;
    });

    set(terminalPersistAtom);
  }
);
removeAgentSessionTerminalAtom.debugLabel = "removeAgentSessionTerminalAtom";

/** Rename a terminal session (sets userTitle, highest display priority). */
export const renameTerminalSessionAtom = atom(
  null,
  (get, set, params: { sessionId: string; title: string }) => {
    const sessions = get(terminalSessionsAtom);
    set(
      terminalSessionsAtom,
      sessions.map((session) =>
        session.id === params.sessionId
          ? {
              ...session,
              userTitle: params.title || undefined,
              name: params.title || session.name,
            }
          : session
      )
    );
    set(terminalPersistAtom);
  }
);
renameTerminalSessionAtom.debugLabel = "renameTerminalSessionAtom";

/** Update session info (PID, shell, cwd, titles, process name, etc.) */
export const updateTerminalSessionInfoAtom = atom(
  null,
  (
    get,
    set,
    params: {
      sessionId: string;
      info: Partial<
        Pick<
          TerminalSession,
          | "pid"
          | "shell"
          | "shellKind"
          | "cwd"
          | "userTitle"
          | "sequenceTitle"
          | "processName"
          | "liveCwd"
          | "isDefaultSession"
          | "hasUserInput"
        >
      >;
    }
  ) => {
    const sessions = get(terminalSessionsAtom);
    set(
      terminalSessionsAtom,
      sessions.map((session) =>
        session.id === params.sessionId
          ? { ...session, ...params.info }
          : session
      )
    );

    set(terminalPersistAtom);
  }
);
updateTerminalSessionInfoAtom.debugLabel = "updateTerminalSessionInfoAtom";
