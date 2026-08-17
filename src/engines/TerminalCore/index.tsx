/**
 * TerminalCore Component
 *
 * Reusable terminal component that can work with:
 * 1. TerminalContext (for main terminal page)
 * 2. Prop-based state (for simulator or standalone use)
 *
 * Features:
 * - Multiple sessions (tabs)
 * - XTerm.js terminal rendering
 * - PTY process management
 * - Text selection with actions
 * - Find in terminal (Cmd+F)
 */
import { TextSelectionDropdown } from "@/src/scaffold/ContextMenu/exports";
import { useSetAtom } from "jotai";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import {
  type TerminalFileLinkTarget,
  TerminalView,
  type TerminalViewHandle,
} from "@src/components/TerminalInteractive";
import { useTerminalProcessPoller } from "@src/hooks/terminal";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { addToAgentAtom } from "@src/store/ui/addToAgentAtom";
import { activeStationChatVisibleAtom } from "@src/store/ui/chatPanelAtom";
import {
  commandCwdChangedAtom,
  commandExecutedAtom,
  commandFinishedAtom,
  commandPromptStartAtom,
} from "@src/store/workstation/codeEditor/terminal/commandDetection";

import { TerminalSearchPanel } from "./components/TerminalSearchPanel";
import {
  pushRecentTerminalId,
  selectMountedTerminalSessions,
} from "./terminalMountWindow";
import type { UseTerminalStateReturn } from "./types";

// Lazy-load the read-only terminal to keep xterm (~300KB) from doubling the chunk
const TerminalReadOnly = React.lazy(
  () => import("@src/components/TerminalReadOnly")
);

// ============================================
// Types
// ============================================

interface SelectionState {
  visible: boolean;
  text: string;
  position: { x: number; y: number };
  lineStart?: number;
  lineEnd?: number;
}

export interface TerminalCoreProps {
  /** Terminal state (sessions, active session, handlers) */
  terminalState: UseTerminalStateReturn;
  /** Custom className */
  className?: string;
  /** Background color override */
  backgroundColor?: string;
  /** Repository path for terminal working directory */
  repoPath?: string;
  /** Opens file references detected in terminal output */
  onOpenFileLink?: (target: TerminalFileLinkTarget) => void;
  /** True when this terminal tree is visible after tab switching. */
  visible?: boolean;
}

// ============================================
// Component
// ============================================

export const TerminalCore: React.FC<TerminalCoreProps> = ({
  terminalState,
  className = "",
  backgroundColor,
  repoPath,
  onOpenFileLink,
  visible = true,
}) => {
  const { sessions, activeSessionId, initializedSessions, updateSessionInfo } =
    terminalState;
  const [processRefreshSignal, setProcessRefreshSignal] = useState(0);

  const requestProcessRefresh = useCallback(() => {
    if (!visible) return;
    setProcessRefreshSignal((signal) => signal + 1);
  }, [visible]);

  useTerminalProcessPoller({
    activeSession: terminalState.activeSession,
    enabled: visible,
    refreshSignal: processRefreshSignal,
    updateSessionInfo,
  });

  // Command detection dispatchers (OSC 633)
  const dispatchPromptStart = useSetAtom(commandPromptStartAtom);
  const dispatchCommandExecuted = useSetAtom(commandExecutedAtom);
  const dispatchCommandFinished = useSetAtom(commandFinishedAtom);
  const dispatchCwdChanged = useSetAtom(commandCwdChangedAtom);

  const { t } = useTranslation("sessions");

  const setAddToAgent = useSetAtom(addToAgentAtom);
  const setStationChatVisible = useSetAtom(activeStationChatVisibleAtom);

  const terminalRefs = useRef<Map<string, TerminalViewHandle>>(new Map());

  const [searchOpen, setSearchOpen] = useState(false);

  // Most-recently-active terminal ids (newest first) — see
  // ./terminalMountWindow.ts for the mount policy this drives.
  const [recentTerminalIds, setRecentTerminalIds] = useState<readonly string[]>(
    []
  );
  // Derived-from-previous-render state (React's "storing information from
  // previous renders" pattern): update synchronously during render instead
  // of in an effect so the evicted pane never renders once with stale data.
  if (activeSessionId) {
    const nextRecent = pushRecentTerminalId(recentTerminalIds, activeSessionId);
    if (nextRecent !== recentTerminalIds) setRecentTerminalIds(nextRecent);
  }

  const [selection, setSelection] = useState<SelectionState>({
    visible: false,
    text: "",
    position: { x: 0, y: 0 },
  });

  const getActiveTerminalRef = useCallback(() => {
    return terminalRefs.current.get(activeSessionId);
  }, [activeSessionId]);

  useEffect(() => {
    if (!activeSessionId || !visible) return;
    const handle = terminalRefs.current.get(activeSessionId);
    handle?.redrawAfterShow();
    const firstFrameId = window.requestAnimationFrame(() => {
      handle?.redrawAfterShow();
    });
    const settleTimerId = window.setTimeout(() => {
      handle?.redrawAfterShow();
    }, 120);

    return () => {
      window.cancelAnimationFrame(firstFrameId);
      window.clearTimeout(settleTimerId);
    };
  }, [activeSessionId, visible]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "f") {
        const terminalEl = document.querySelector(".terminal-core");
        if (
          terminalEl?.contains(document.activeElement) ||
          terminalEl === document.activeElement
        ) {
          event.preventDefault();
          event.stopPropagation();
          setSearchOpen((prev) => !prev);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  useEffect(() => {
    const handleSelectAll = () => {
      const terminalRef = getActiveTerminalRef();
      terminalRef?.selectAll();
    };

    window.addEventListener("terminal-select-all", handleSelectAll);
    return () => {
      window.removeEventListener("terminal-select-all", handleSelectAll);
    };
  }, [getActiveTerminalRef]);

  useEffect(() => {
    const handleTerminalCopy = () => {
      const terminalEl = document.querySelector(".terminal-core");
      if (
        !terminalEl?.contains(document.activeElement) &&
        terminalEl !== document.activeElement
      ) {
        return;
      }

      const selectedText = selection.text;
      if (!selectedText?.trim()) return;

      const activeSession = sessions.find(
        (session) => session.id === activeSessionId
      );
      const sessionName = activeSession?.name || "Terminal";
      const lineCount = selectedText.split("\n").length;

      window.__orgiiLastTerminalCopy = {
        sessionId: activeSessionId,
        sessionName,
        lineCount,
        lineStart: selection.lineStart,
        lineEnd: selection.lineEnd,
        text: selectedText,
        timestamp: Date.now(),
      };
    };

    document.addEventListener("copy", handleTerminalCopy, true);
    return () => {
      document.removeEventListener("copy", handleTerminalCopy, true);
    };
  }, [
    sessions,
    activeSessionId,
    selection.text,
    selection.lineStart,
    selection.lineEnd,
  ]);

  const handleFindNext = useCallback(
    (
      query: string,
      options: { caseSensitive: boolean; regex: boolean; wholeWord: boolean }
    ) => {
      const terminalRef = getActiveTerminalRef();
      return terminalRef?.findNext(query, options) ?? false;
    },
    [getActiveTerminalRef]
  );

  const handleFindPrevious = useCallback(
    (
      query: string,
      options: { caseSensitive: boolean; regex: boolean; wholeWord: boolean }
    ) => {
      const terminalRef = getActiveTerminalRef();
      return terminalRef?.findPrevious(query, options) ?? false;
    },
    [getActiveTerminalRef]
  );

  const handleClearSearch = useCallback(() => {
    const terminalRef = getActiveTerminalRef();
    terminalRef?.clearSearch();
  }, [getActiveTerminalRef]);

  const handleFocusTerminal = useCallback(() => {
    const terminalRef = getActiveTerminalRef();
    terminalRef?.focus();
  }, [getActiveTerminalRef]);

  const handleCloseSearch = useCallback(() => {
    setSearchOpen(false);
  }, []);

  const handleSelectionChange = useCallback(
    (
      selectionInfo: {
        text: string;
        position: { x: number; y: number };
        lineStart?: number;
        lineEnd?: number;
      } | null
    ) => {
      if (selectionInfo && selectionInfo.text.length > 0) {
        setSelection({
          visible: true,
          text: selectionInfo.text,
          position: selectionInfo.position,
          lineStart: selectionInfo.lineStart,
          lineEnd: selectionInfo.lineEnd,
        });
      } else {
        setSelection((prev) => ({
          ...prev,
          visible: false,
          lineStart: undefined,
          lineEnd: undefined,
        }));
      }
    },
    []
  );

  const handleCloseDropdown = useCallback(() => {
    setSelection((prev) => ({
      ...prev,
      visible: false,
      lineStart: undefined,
      lineEnd: undefined,
    }));
  }, []);

  const handleAddToChat = useCallback(
    (_text: string, _sessionId: string | null) => {
      if (!selection.text.trim()) return;
      setStationChatVisible("my-station", true);
      setAddToAgent({
        type: "terminal",
        text: selection.text,
        lineStart: selection.lineStart,
        lineEnd: selection.lineEnd,
      });
      Message.success(t("terminal.sentToAgent"));
    },
    [
      selection.text,
      selection.lineStart,
      selection.lineEnd,
      setStationChatVisible,
      setAddToAgent,
      t,
    ]
  );

  const bgColor = backgroundColor || "var(--cm-editor-background)";

  const visibleSessions = selectMountedTerminalSessions(
    sessions,
    activeSessionId,
    initializedSessions,
    recentTerminalIds
  );

  return (
    <div className={`terminal-core flex h-full w-full flex-col ${className}`}>
      <TerminalSearchPanel
        isOpen={searchOpen}
        onClose={handleCloseSearch}
        onFindNext={handleFindNext}
        onFindPrevious={handleFindPrevious}
        onClearSearch={handleClearSearch}
        onFocusTerminal={handleFocusTerminal}
      />

      <div
        className="terminal-content-area relative flex flex-1 flex-col overflow-hidden"
        style={{ backgroundColor: bgColor }}
      >
        {visibleSessions.length === 0 && (
          <Placeholder variant="empty" fillParentHeight />
        )}
        {visibleSessions.map((session) => (
          <div
            key={session.id}
            className="terminal-session-wrapper absolute inset-0 flex h-full w-full flex-col rounded-[8px]"
            style={{
              display: session.id === activeSessionId ? "flex" : "none",
              backgroundColor: bgColor,
            }}
          >
            {session.readOnly && session.agentSessionId ? (
              <React.Suspense fallback={null}>
                <TerminalReadOnly agentSessionId={session.agentSessionId} />
              </React.Suspense>
            ) : (
              <TerminalView
                ref={(handle) => {
                  if (handle) {
                    terminalRefs.current.set(session.id, handle);
                  } else {
                    terminalRefs.current.delete(session.id);
                  }
                }}
                sessionKey={session.id}
                onSelectionChange={handleSelectionChange}
                repoPath={session.cwd || repoPath}
                workingDirectory={session.liveCwd || session.cwd}
                onOpenFileLink={onOpenFileLink}
                backgroundColor={bgColor}
                // Managed CLI terminals use the configured default shell.
                // `session.shell` becomes runtime metadata after the PTY connects,
                // so reusing it as a launch override would recreate xterm.
                shellOverride={session.agentCommand ? undefined : session.shell}
                // CLI-agent terminals: pin the PTY to the session's cwd
                // (worktree) and let lifecycle hooks attribute status and
                // transcripts to the backing managed session row.
                forceRepoCwd={Boolean(session.agentCommand)}
                envOverride={session.envOverride}
                nameOverride={session.name}
                onUserInput={() => {
                  requestProcessRefresh();
                  if (!session.hasUserInput) {
                    updateSessionInfo(session.id, { hasUserInput: true });
                  }
                }}
                onTitleChange={(title) => {
                  updateSessionInfo(session.id, {
                    sequenceTitle: title,
                  });
                }}
                onSessionInfoReady={(info) => {
                  terminalState.markSessionInitialized(info.sessionKey);
                  updateSessionInfo(info.sessionKey, {
                    pid: info.pid,
                    shell: info.shell,
                    cwd: info.cwd,
                  });
                  requestProcessRefresh();
                }}
                shellIntegration={{
                  onPromptStart: () => dispatchPromptStart(session.id),
                  onCommandExecuted: (commandLine) => {
                    requestProcessRefresh();
                    dispatchCommandExecuted({
                      sessionId: session.id,
                      commandLine,
                    });
                  },
                  onCommandFinished: (exitCode) => {
                    requestProcessRefresh();
                    dispatchCommandFinished({
                      sessionId: session.id,
                      exitCode,
                    });
                  },
                  onCwdChanged: (cwd) => {
                    dispatchCwdChanged({
                      sessionId: session.id,
                      cwd,
                    });
                    updateSessionInfo(session.id, { liveCwd: cwd });
                  },
                }}
              />
            )}
          </div>
        ))}
      </div>

      <TextSelectionDropdown
        visible={selection.visible}
        position={selection.position}
        selectedText={selection.text}
        source="terminal"
        onClose={handleCloseDropdown}
        onAddToContext={handleAddToChat}
      />
    </div>
  );
};

export default TerminalCore;
