/**
 * ChatPanelTerminalContent
 *
 * Renders a live PTY terminal inside the chat pane for a single terminal tab.
 *
 * Architecture:
 *   - Each chat-pane terminal tab has a unique terminal session ID prefixed
 *     "chatpanel-" in the shared terminal atom store.
 *   - This component builds a synthetic `UseTerminalStateReturn` that scopes
 *     the shared global terminal atoms down to the single session for this tab.
 *   - The same TerminalCore / TerminalInteractive / PTY pipeline used by the
 *     Workstation is reused — no duplication.
 *
 * Performance:
 *   - `useAtomValue(terminalSessionsAtom)` re-renders this component when any
 *     terminal session changes. Since the sessions list is small and the render
 *     is cheap (just a memo lookup), this is acceptable. The TerminalView
 *     instances themselves are DOM-managed by xterm.js and do not re-render.
 *   - `useTerminalProcessPoller` polls every 2 s for the active terminal's
 *     process info. This is the same cadence used by the Workstation terminal
 *     panel — no additional polling is introduced here.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAtomValue, useSetAtom } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { getCodeEditorWebSocket } from "@src/api/realtime/codeEditorWebSocket";
import {
  notifyAgentApproval,
  onSystemNotificationAction,
} from "@src/api/services/notification";
import {
  getHermesApprovalNotificationBody,
  isHermesApprovalNotificationFor,
  shouldNotifyHermesApproval,
} from "@src/engines/ChatPanel/components/TerminalAgentHoverCard/presentation";
import { TerminalCore } from "@src/engines/TerminalCore";
import {
  type AddSessionOptions,
  TERMINAL_AGENT_STATUS,
  type TerminalAgentActivity,
  type TerminalAgentStatus,
  type UseTerminalStateReturn,
  getTerminalDisplayTitle,
} from "@src/engines/TerminalCore/types";
import { createLogger } from "@src/hooks/logger";
import {
  activateChatPanelTabAtom,
  clearChatPanelTabCliCommandAtom,
  setChatPanelTabTitleAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import {
  initializedTerminalIdsAtom,
  markTerminalInitializedAtom,
  terminalSessionsAtom,
  updateTerminalSessionInfoAtom,
} from "@src/store/chatPanel/chatPanelTerminalAtom";
import { notificationSettingsAtom } from "@src/store/ui/notificationAtom";
import { invokeTauri, listenTauri } from "@src/util/platform/tauri/init";
import { toBackendPtySessionId } from "@src/util/ui/terminal/ptySessionId";

const logger = createLogger("ChatPanelTerminalContent");

const TERMINAL_AGENT_STATUSES = new Set<string>(
  Object.values(TERMINAL_AGENT_STATUS)
);

interface HermesTerminalStatusMessage {
  type: "terminal_agent.status_changed";
  terminal_session_id?: string;
  cli_agent_type?: string;
  agent_status?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input_preview?: string;
  model?: string;
  cwd?: string;
  duration_ms?: number;
  timestamp?: number;
}

// ─── Props ─────────────────────────────────────────────────────────────────

interface ChatPanelTerminalContentProps {
  /** Tab ID — used to sync title when the terminal title changes */
  tabId: string;
  /** Terminal session ID in the shared terminal atom store */
  terminalSessionId: string;
  /**
   * CLI agent binary command to inject into the PTY shell once it's ready.
   * Written once with a trailing newline then cleared from the tab state.
   */
  cliCommand?: string;
  className?: string;
  visible?: boolean;
}

// ─── Component ─────────────────────────────────────────────────────────────

export function ChatPanelTerminalContent({
  tabId,
  terminalSessionId,
  cliCommand,
  className = "",
  visible = true,
}: ChatPanelTerminalContentProps): React.ReactNode {
  const allSessions = useAtomValue(terminalSessionsAtom);
  const initializedIds = useAtomValue(initializedTerminalIdsAtom);
  const notificationSettings = useAtomValue(notificationSettingsAtom);
  const dispatchMarkInitialized = useSetAtom(markTerminalInitializedAtom);
  const dispatchUpdateInfo = useSetAtom(updateTerminalSessionInfoAtom);
  const activateTab = useSetAtom(activateChatPanelTabAtom);
  const setTabTitle = useSetAtom(setChatPanelTabTitleAtom);
  const clearCliCommand = useSetAtom(clearChatPanelTabCliCommandAtom);

  // Find this tab's session
  const session = useMemo(
    () => allSessions.find((sess) => sess.id === terminalSessionId),
    [allSessions, terminalSessionId]
  );
  const lastHermesStatusRef = useRef<TerminalAgentStatus | undefined>(
    session?.agentStatus
  );
  const lastHermesActivityRef = useRef<TerminalAgentActivity | undefined>(
    session?.agentActivity
  );

  // Sync terminal title → tab title whenever process / OSC title metadata changes.
  useEffect(() => {
    if (!session) return;
    setTabTitle({ tabId, title: getTerminalDisplayTitle(session) });
  }, [
    session,
    session?.name,
    session?.processName,
    session?.sequenceTitle,
    session?.userTitle,
    tabId,
    setTabTitle,
  ]);

  useEffect(() => {
    if (!session?.agentCommand) return;

    const ptySessionId = toBackendPtySessionId(terminalSessionId);
    const unlistenPromise = listenTauri(`pty-exit-${ptySessionId}`, () => {
      lastHermesStatusRef.current = TERMINAL_AGENT_STATUS.DONE;
      dispatchUpdateInfo({
        sessionId: terminalSessionId,
        info: { agentStatus: TERMINAL_AGENT_STATUS.DONE },
      });
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [session?.agentCommand, terminalSessionId, dispatchUpdateInfo]);

  // Notification actions are global, so each terminal listener filters by the
  // opaque target metadata attached to its own approval notification.
  useEffect(() => {
    if (session?.cliAgentType !== "hermes") return;
    let disposed = false;
    let removeListener: (() => Promise<void>) | undefined;

    void onSystemNotificationAction((notification) => {
      if (
        !isHermesApprovalNotificationFor(
          notification.extra,
          tabId,
          terminalSessionId
        )
      ) {
        return;
      }

      activateTab(tabId);
      void (async () => {
        try {
          const appWindow = getCurrentWindow();
          await appWindow.show();
          await appWindow.unminimize();
          await appWindow.setFocus();
        } catch (error) {
          logger.warn("Failed to focus Hermes approval terminal", error);
        }
      })();
    })
      .then((remove) => {
        if (disposed) {
          void remove();
          return;
        }
        removeListener = remove;
      })
      .catch((error: unknown) => {
        logger.warn("Failed to subscribe to notification actions", error);
      });

    return () => {
      disposed = true;
      if (removeListener) void removeListener();
    };
  }, [session?.cliAgentType, tabId, terminalSessionId, activateTab]);

  // Hermes' plugin hook is the authoritative busy/idle signal once it has
  // emitted. Subscribe before command injection so the first session-start
  // callback cannot race the terminal listener.
  useEffect(() => {
    if (session?.cliAgentType !== "hermes") return;
    const websocket = getCodeEditorWebSocket();
    if (!websocket) return;

    return websocket.on("terminal_agent.status_changed", (raw) => {
      const message = raw as unknown as HermesTerminalStatusMessage;
      if (
        message.terminal_session_id !== terminalSessionId ||
        message.cli_agent_type !== "hermes" ||
        !message.agent_status ||
        !TERMINAL_AGENT_STATUSES.has(message.agent_status)
      ) {
        return;
      }
      const nextStatus = message.agent_status as TerminalAgentStatus;
      const previousStatus = lastHermesStatusRef.current;
      const previousActivity = lastHermesActivityRef.current;
      const nextActivity: TerminalAgentActivity = {
        hookEventName: message.hook_event_name,
        toolName: message.tool_name || previousActivity?.toolName,
        toolInputPreview:
          message.tool_input_preview || previousActivity?.toolInputPreview,
        model: message.model || previousActivity?.model,
        cwd: message.cwd || previousActivity?.cwd,
        durationMs: message.duration_ms,
        updatedAt: message.timestamp ?? Date.now(),
      };
      lastHermesStatusRef.current = nextStatus;
      lastHermesActivityRef.current = nextActivity;

      dispatchUpdateInfo({
        sessionId: terminalSessionId,
        info: {
          agentStatus: nextStatus,
          agentStatusSource: "hook",
          agentActivity: nextActivity,
        },
      });

      if (
        shouldNotifyHermesApproval(
          previousStatus,
          nextStatus,
          document.hidden,
          document.hasFocus()
        )
      ) {
        void notifyAgentApproval(
          getHermesApprovalNotificationBody(nextActivity),
          notificationSettings,
          {
            kind: "hermes-approval",
            tabId,
            terminalSessionId,
          }
        );
      }
    });
  }, [
    session?.cliAgentType,
    tabId,
    terminalSessionId,
    notificationSettings,
    dispatchUpdateInfo,
  ]);

  // Track whether we've already injected the CLI command to avoid double-write
  const injectedRef = useRef(false);

  // Once the PTY is initialized and a CLI command is pending, write it to the shell
  useEffect(() => {
    if (!cliCommand || injectedRef.current) return;
    if (!initializedIds.has(terminalSessionId)) return;

    injectedRef.current = true;
    const ptySessionId = toBackendPtySessionId(terminalSessionId);

    // Small delay so the shell prompt has time to render before we send input
    const timerId = window.setTimeout(() => {
      invokeTauri("write_pty", {
        sessionId: ptySessionId,
        data: `${cliCommand}\n`,
      }).catch((err: unknown) => {
        logger.warn("Failed to inject CLI command into PTY", err);
      });
      clearCliCommand(tabId);
    }, 300);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [cliCommand, terminalSessionId, initializedIds, tabId, clearCliCommand]);

  // ── Synthetic terminalState scoped to this single session ──────────────

  const sessions = useMemo(() => (session ? [session] : []), [session]);

  const addSession = useCallback(
    (_options?: AddSessionOptions): string => {
      // Single-session mode: adding is a no-op; return the existing ID
      return terminalSessionId;
    },
    [terminalSessionId]
  );

  const closeSession = useCallback((_sessionId: string): void => {
    // Closing is handled at the tab level (closeChatPanelTabAtom → unmount → destroyTerminal)
  }, []);

  const setActiveSession = useCallback((_sessionId: string): void => {
    // Single-session view — nothing to switch
  }, []);

  const markSessionInitialized = useCallback(
    (sessionId: string): void => {
      dispatchMarkInitialized(sessionId);
    },
    [dispatchMarkInitialized]
  );

  const updateSessionInfo: UseTerminalStateReturn["updateSessionInfo"] =
    useCallback(
      (sessionId, info) => {
        dispatchUpdateInfo({ sessionId, info });
      },
      [dispatchUpdateInfo]
    );

  const renameSession = useCallback(
    (_sessionId: string, _title: string): void => {
      // Not exposed in chat pane terminal for now
    },
    []
  );

  const terminalState = useMemo<UseTerminalStateReturn>(
    () => ({
      sessions,
      activeSessionId: terminalSessionId,
      activeSession: session,
      initializedSessions: initializedIds,
      addSession,
      closeSession,
      setActiveSession,
      markSessionInitialized,
      updateSessionInfo,
      renameSession,
    }),
    [
      sessions,
      terminalSessionId,
      session,
      initializedIds,
      addSession,
      closeSession,
      setActiveSession,
      markSessionInitialized,
      updateSessionInfo,
      renameSession,
    ]
  );

  // Resolve the *visible* chat-pane background at runtime so xterm's opaque
  // WebGL fill matches whatever the chat-pane surface looks like right now.
  // We read the parent's computed `background-color` (an already-resolved
  // rgb/rgba value) so any wallpaper tint via page-opacity is captured too.
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [resolvedBg, setResolvedBg] = useState<string | undefined>(undefined);

  useEffect(() => {
    const node = wrapperRef.current;
    if (!node) return;
    const computed = getComputedStyle(node).backgroundColor;
    if (computed && computed !== "rgba(0, 0, 0, 0)") setResolvedBg(computed);
  }, [visible]);

  if (!session) {
    return (
      <div
        className={`flex items-center justify-center text-[13px] text-text-3 ${className}`}
      >
        Terminal session not found.
      </div>
    );
  }

  return (
    <div
      ref={wrapperRef}
      className={`chat-panel-terminal-wrapper flex min-h-0 w-full flex-1 flex-col bg-chat-pane ${className}`}
    >
      <TerminalCore
        terminalState={terminalState}
        className="terminal-core chat-panel-terminal-core min-h-0 flex-1 bg-chat-pane"
        backgroundColor={resolvedBg ?? "var(--color-chat-pane-base)"}
        visible={visible}
      />
    </div>
  );
}
