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
import { type Getter, type Setter, atom } from "jotai";

import { getSettingsDefaults } from "@src/config/settingsSchema";
import { createLogger } from "@src/hooks/logger";
import { settingsAtom } from "@src/store/settings/settingsAtom";
import { invokeTauri, isTauriReady } from "@src/util/platform/tauri/init";
import { isChatPanelTerminalId } from "@src/util/ui/terminal/chatPanelSessionId";
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
          (session: TerminalSession) =>
            !isAgentPtySessionId(session.id) &&
            !isChatPanelTerminalId(session.id)
        );
        if (sessions.length === 0) return null;
        const isEphemeral = (id: string) =>
          isAgentPtySessionId(id) || isChatPanelTerminalId(id);
        const activeSessionId = isEphemeral(parsed.activeSessionId)
          ? sessions[0].id
          : parsed.activeSessionId;
        return {
          sessions,
          activeSessionId,
          initializedSessionIds: parsed.initializedSessionIds.filter(
            (sessionId: string) => !isEphemeral(sessionId)
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

function isWorkstationTerminalSession(session: TerminalSession): boolean {
  return !isAgentPtySessionId(session.id) && !isChatPanelTerminalId(session.id);
}

function createFreshWorkstationTerminal(
  get: Getter,
  existingNames: readonly string[] = []
): TerminalSession {
  const defaultBase = defaultTerminalLabelBaseFromSettings(get(settingsAtom));
  return {
    id: `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: generateUniqueLabelFromBase(defaultBase, [...existingNames]),
    isActive: true,
    isDefaultSession: true,
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

export interface TerminalSurfaceLifecycle {
  generation: number;
  phase: "open" | "closing" | "closed";
}

/** Async teardown episode for the shared WorkStation Terminal surface. */
export const terminalSurfaceLifecycleAtom = atom<TerminalSurfaceLifecycle>({
  generation: 0,
  phase: "open",
});
terminalSurfaceLifecycleAtom.debugLabel = "terminalSurfaceLifecycleAtom";

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
  const sessions = get(terminalSessionsAtom).filter(
    isWorkstationTerminalSession
  );
  const requestedActiveSessionId = get(activeTerminalIdAtom);
  const activeSessionId = sessions.some(
    (session) => session.id === requestedActiveSessionId
  )
    ? requestedActiveSessionId
    : (sessions[0]?.id ?? "");
  const liveIds = new Set(sessions.map((session) => session.id));
  const initializedSessionIds = [...get(initializedTerminalIdsAtom)].filter(
    (sessionId) => liveIds.has(sessionId)
  );

  try {
    localStorage.setItem(
      TERMINAL_STORAGE_KEY,
      JSON.stringify({
        sessions,
        activeSessionId,
        initializedSessionIds,
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

function removeTerminalSessionLocalOnly(
  get: Getter,
  set: Setter,
  sessionId: string
): void {
  const sessions = get(terminalSessionsAtom);
  const activeId = get(activeTerminalIdAtom);
  const target = sessions.find((session) => session.id === sessionId);
  if (!target) return;

  let filtered = sessions.filter((session) => session.id !== sessionId);
  if (
    isWorkstationTerminalSession(target) &&
    !filtered.some(isWorkstationTerminalSession)
  ) {
    filtered = [
      ...filtered,
      createFreshWorkstationTerminal(
        get,
        filtered.map((session) => session.name)
      ),
    ];
  }

  const requestedActiveId = sessionId === activeId ? undefined : activeId;
  const nextActiveId =
    filtered.find((session) => session.id === requestedActiveId)?.id ??
    filtered.find(isWorkstationTerminalSession)?.id ??
    filtered[0]?.id ??
    "";
  set(
    terminalSessionsAtom,
    filtered.map((session) => ({
      ...session,
      isActive: session.id === nextActiveId,
    }))
  );
  set(activeTerminalIdAtom, nextActiveId);

  set(initializedTerminalIdsAtom, (prev) => {
    const next = new Set(prev);
    next.delete(sessionId);
    return next;
  });
  set(terminalPersistAtom);
}

/** Add a new terminal session (editor bottom panel).
 *
 * Accepts optional `AddSessionOptions` to specify a shell profile,
 * custom shell path, args, env, or name. When omitted, uses defaults.
 */
export const editorAddTerminalSessionAtom = atom(
  null,
  (get, set, options?: AddSessionOptions) => {
    set(markTerminalSurfaceOpenedAtom);
    if (!options?.bypassCreationCooldown && !tryBeginTerminalCreation()) {
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
    removeTerminalSessionLocalOnly(get, set, sessionId);
    await killPty(sessionId);
  }
);
closeTerminalSessionAtom.debugLabel = "closeTerminalSessionAtom";

/**
 * Invalidate an in-flight close when the WorkStation Terminal surface opens.
 */
export const markTerminalSurfaceOpenedAtom = atom(null, (get, set) => {
  const current = get(terminalSurfaceLifecycleAtom);
  if (current.phase === "open") return;
  set(terminalSurfaceLifecycleAtom, {
    generation: current.generation + 1,
    phase: "open",
  });
});
markTerminalSurfaceOpenedAtom.debugLabel = "markTerminalSurfaceOpenedAtom";

/**
 * Close WorkStation-owned terminal sessions when the shared Terminal tab is
 * closed. ChatPanel and backend agent PTYs are separate resources and survive.
 * Local state rotates to a fresh ID before IPC, so a rapid reopen can never
 * attach to an old PTY that is still being torn down.
 */
export const closeAllTerminalSessionsAtom = atom(null, async (get, set) => {
  const targets = get(terminalSessionsAtom).filter(
    isWorkstationTerminalSession
  );
  if (targets.length === 0) return;

  const previousLifecycle = get(terminalSurfaceLifecycleAtom);
  const generation = previousLifecycle.generation + 1;
  set(terminalSurfaceLifecycleAtom, { generation, phase: "closing" });

  const removedIds = new Set(targets.map((session) => session.id));
  const survivors = get(terminalSessionsAtom).filter(
    (session) => !removedIds.has(session.id)
  );
  const fresh = createFreshWorkstationTerminal(
    get,
    survivors.map((session) => session.name)
  );
  set(terminalSessionsAtom, [
    ...survivors.map((session) => ({ ...session, isActive: false })),
    fresh,
  ]);
  set(activeTerminalIdAtom, fresh.id);
  set(initializedTerminalIdsAtom, (previous) => {
    const next = new Set(previous);
    for (const sessionId of removedIds) next.delete(sessionId);
    return next;
  });
  set(terminalPersistAtom);

  await Promise.all(
    targets
      .filter((session) => !session.readOnly)
      .map((session) => killPty(session.id))
  );

  const currentLifecycle = get(terminalSurfaceLifecycleAtom);
  if (
    currentLifecycle.generation === generation &&
    currentLifecycle.phase === "closing"
  ) {
    set(terminalSurfaceLifecycleAtom, { generation, phase: "closed" });
  }
});
closeAllTerminalSessionsAtom.debugLabel = "closeAllTerminalSessionsAtom";

export const removeStaleTerminalSessionAtom = atom(
  null,
  (get, set, sessionId: string) => {
    removeTerminalSessionLocalOnly(get, set, sessionId);
  }
);
removeStaleTerminalSessionAtom.debugLabel = "removeStaleTerminalSessionAtom";

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
    if (!sessions.some((session) => session.id === tabId)) return;
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
          | "agentStatus"
        >
      >;
    }
  ) => {
    const sessions = get(terminalSessionsAtom);
    const session = sessions.find((item) => item.id === params.sessionId);
    if (
      !session ||
      Object.entries(params.info).every(([key, value]) =>
        Object.is(session[key as keyof TerminalSession], value)
      )
    ) {
      return;
    }

    set(
      terminalSessionsAtom,
      sessions.map((item) =>
        item.id === params.sessionId ? { ...item, ...params.info } : item
      )
    );

    set(terminalPersistAtom);
  }
);
updateTerminalSessionInfoAtom.debugLabel = "updateTerminalSessionInfoAtom";
