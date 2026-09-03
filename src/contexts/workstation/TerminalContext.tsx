/**
 * Terminal Context
 *
 * Provides terminal session state management across Terminal page and TerminalExtraSidebar
 */
import { useAtomValue } from "jotai";
import React, {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { getSettingsDefaults } from "@src/config/settingsSchema";
import { createLogger } from "@src/hooks/logger";
import { useGlobalTerminalTabs } from "@src/hooks/ui/tabs/useGlobalTabs";
import { useSyncTerminalSessions } from "@src/hooks/ui/tabs/useSyncGlobalTabs";
import { settingsAtom } from "@src/store/settings/settingsAtom";
import {
  notifyTerminalCreationCooldown,
  tryBeginTerminalCreation,
} from "@src/util/ui/terminal/creationThrottle";
import {
  defaultTerminalLabelBaseFromSettings,
  generateUniqueLabelFromBase,
} from "@src/util/ui/terminal/naming";
import { toBackendPtySessionId } from "@src/util/ui/terminal/ptySessionId";

const log = createLogger("TerminalContext");

interface TerminalSession {
  id: string;
  name: string;
  isActive: boolean;
}

interface TerminalContextValue {
  sessions: TerminalSession[];
  activeSessionId: string;
  filterValue: string;
  initializedSessions: Set<string>;
  setFilterValue: (value: string) => void;
  handleSessionClick: (sessionId: string) => void;
  handleAddSession: () => void;
  handleCloseSession: (sessionId: string, e?: React.MouseEvent) => void;
}

const TerminalContext = createContext<TerminalContextValue | null>(null);

// Default initial state for terminal tab
const getDefaultState = (): {
  sessions: TerminalSession[];
  activeSessionId: string;
  filterValue: string;
  initializedSessionIds: string[];
} => {
  const defaultBase = defaultTerminalLabelBaseFromSettings(
    getSettingsDefaults()
  );
  const initialName = generateUniqueLabelFromBase(defaultBase, []);
  return {
    sessions: [{ id: "1", name: initialName, isActive: true }],
    activeSessionId: "1",
    filterValue: "",
    initializedSessionIds: ["1"],
  };
};

export const TerminalProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { removeTerminalSession } = useGlobalTerminalTabs();
  const settings = useAtomValue(settingsAtom);
  const defaultLabelBase = useMemo(
    () => defaultTerminalLabelBaseFromSettings(settings),
    [settings]
  );

  const sessionsRef = useRef<TerminalSession[]>([]);
  const removeTerminalSessionRef = useRef(removeTerminalSession);

  // Keep removeTerminalSession ref up to date
  useEffect(() => {
    removeTerminalSessionRef.current = removeTerminalSession;
  }, [removeTerminalSession]);

  const [sessions, setSessions] = useState<TerminalSession[]>(
    () => getDefaultState().sessions
  );
  const [activeSessionId, setActiveSessionId] = useState<string>(
    () => getDefaultState().activeSessionId
  );
  const [filterValue, setFilterValue] = useState(
    () => getDefaultState().filterValue
  );
  const [initializedSessions, setInitializedSessions] = useState<Set<string>>(
    () => new Set(getDefaultState().initializedSessionIds)
  );

  // ✨ Sync to global tabs state (for components that use navigationSidebarTabsAtom)
  useSyncTerminalSessions(sessions, activeSessionId);

  // Keep sessionsRef up to date
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // Cleanup PTY sessions when terminal tab is closed (provider unmounted)
  useEffect(() => {
    return () => {
      // When the terminal tab is actually closed (not just navigated away),
      // kill all PTY sessions and clear global atom
      const currentSessions = sessionsRef.current;
      if (currentSessions.length > 0) {
        const cleanupAllPTY = async () => {
          try {
            const { isTauriDesktop } = await import("@src/util/platform/tauri");
            if (isTauriDesktop()) {
              const { invoke } = await import("@tauri-apps/api/core");
              // Kill all PTY sessions in parallel
              const cleanupPromises = currentSessions.map(async (session) => {
                try {
                  await invoke("close_pty", {
                    sessionId: toBackendPtySessionId(session.id),
                  });
                } catch {
                  // Ignore errors - PTY might already be closed
                }
              });
              await Promise.all(cleanupPromises);
            }
          } catch (error) {
            log.error("[TerminalContext] PTY cleanup error:", error);
          }
        };
        cleanupAllPTY();

        // Also clear from global atom
        currentSessions.forEach((session) => {
          removeTerminalSessionRef.current(session.id);
        });
      }
    };
  }, []); // Empty deps - only run on unmount

  // Add a new session
  const handleAddSession = useCallback(() => {
    if (!tryBeginTerminalCreation()) {
      notifyTerminalCreationCooldown();
      return;
    }

    const newId = Date.now().toString();
    const newName = generateUniqueLabelFromBase(
      defaultLabelBase,
      sessions.map((session) => session.name)
    );

    setSessions((prev) => [
      ...prev.map((session) => ({ ...session, isActive: false })),
      { id: newId, name: newName, isActive: true },
    ]);
    setActiveSessionId(newId);

    // Mark as initialized immediately
    setInitializedSessions((prev) => new Set([...prev, newId]));
  }, [sessions, defaultLabelBase]);

  // Switch to a session
  const handleSessionClick = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    setSessions((prev) =>
      prev.map((session) => ({
        ...session,
        isActive: session.id === sessionId,
      }))
    );
  }, []);

  // Close a session
  const handleCloseSession = useCallback(
    (sessionId: string, e?: React.MouseEvent) => {
      e?.stopPropagation();

      // Kill the PTY process immediately (force cleanup)
      const killPTY = async () => {
        try {
          const { isTauriDesktop } = await import("@src/util/platform/tauri");
          if (isTauriDesktop()) {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("close_pty", {
              sessionId: toBackendPtySessionId(sessionId),
            });
          }
        } catch (err) {
          log.error(`[TerminalContext] Failed to kill PTY:`, err);
        }
      };
      killPTY();

      // Check if this is the last session BEFORE the state update
      // (React's setState callback is async, so we can't check inside it)
      const isLastSession = sessions.length === 1;

      if (isLastSession) {
        // Closing the last session - create a new default one
        const newId = Date.now().toString();
        const newName = generateUniqueLabelFromBase(defaultLabelBase, []);
        const newSession = { id: newId, name: newName, isActive: true };

        // Set all states together - no race conditions
        setSessions([newSession]);
        setActiveSessionId(newId);
        setInitializedSessions(new Set([newId]));
      } else {
        // Not the last session - just remove it
        setSessions((prev) => {
          const filtered = prev.filter((session) => session.id !== sessionId);

          // If closing the active session, activate the first remaining session
          if (sessionId === activeSessionId && filtered.length > 0) {
            const newActiveId = filtered[0].id;
            setActiveSessionId(newActiveId);
            return filtered.map((session) => ({
              ...session,
              isActive: session.id === newActiveId,
            }));
          }

          return filtered;
        });

        // Remove closed session from initialized set
        setInitializedSessions((prev) => {
          const newSet = new Set(prev);
          newSet.delete(sessionId);
          return newSet;
        });
      }
    },
    [activeSessionId, sessions, defaultLabelBase]
  );

  const value = useMemo<TerminalContextValue>(
    () => ({
      sessions,
      activeSessionId,
      filterValue,
      initializedSessions,
      setFilterValue,
      handleSessionClick,
      handleAddSession,
      handleCloseSession,
    }),
    [
      sessions,
      activeSessionId,
      filterValue,
      initializedSessions,
      handleSessionClick,
      handleAddSession,
      handleCloseSession,
    ]
  );

  return (
    <TerminalContext.Provider value={value}>
      {children}
    </TerminalContext.Provider>
  );
};
