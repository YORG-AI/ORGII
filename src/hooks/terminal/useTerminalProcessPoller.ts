/**
 * useTerminalProcessPoller
 *
 * Refreshes the foreground process and live CWD for the currently active
 * terminal session. Updates are written to the terminal session atoms so the
 * sidebar, tab title, and breadcrumb can reflect what's actually running.
 *
 * This is intentionally event-driven, not interval-based. Foreground process
 * inspection is display metadata only and should run when terminal activity or
 * visibility changes, not as a global heartbeat.
 *
 * Refreshing is paused when:
 * - The terminal tree is hidden
 * - No sessions exist
 * - The active session is read-only (agent terminal)
 * - The active session doesn't have a PID yet
 */
import { useCallback, useEffect, useRef } from "react";

import {
  TERMINAL_AGENT_STATUS,
  type TerminalSession,
} from "@src/engines/TerminalCore/types";
import { invokeTauri, isTauriReady } from "@src/util/platform/tauri/init";
import { toBackendPtySessionId } from "@src/util/ui/terminal/ptySessionId";

const ACTIVITY_REFRESH_DELAY_MS = 350;

interface ForegroundProcessInfo {
  process_name: string | null;
  pid: number | null;
  cwd: string | null;
}

interface UseTerminalProcessPollerOptions {
  activeSession: TerminalSession | undefined;
  enabled: boolean;
  refreshSignal: number;
  updateSessionInfo: (
    sessionId: string,
    info: Partial<
      Pick<TerminalSession, "processName" | "liveCwd" | "agentStatus">
    >
  ) => void;
}

function normalizeProcessName(value: string | undefined): string {
  return (value ?? "").replace(/\.(exe|cmd)$/i, "").toLowerCase();
}

export function deriveAgentStatus(
  session: TerminalSession,
  processName: string | undefined
): TerminalSession["agentStatus"] | undefined {
  if (!session.expectedProcess) return undefined;
  // Hermes lifecycle hooks distinguish active work from an idle TUI. Once a
  // hook event has arrived, foreground-process polling remains metadata-only
  // and must not overwrite the more precise state with a generic "running".
  if (session.agentStatusSource === "hook") return session.agentStatus;
  if (!processName) return session.agentStatus;

  const normalizedProcess = normalizeProcessName(processName);
  const normalizedExpected = normalizeProcessName(session.expectedProcess);
  if (
    normalizedProcess === normalizedExpected ||
    normalizedProcess.includes(normalizedExpected) ||
    normalizedExpected.includes(normalizedProcess)
  ) {
    return TERMINAL_AGENT_STATUS.RUNNING;
  }

  return TERMINAL_AGENT_STATUS.WAITING;
}

export function useTerminalProcessPoller({
  activeSession,
  enabled,
  refreshSignal,
  updateSessionInfo,
}: UseTerminalProcessPollerOptions): void {
  const prevProcessNameRef = useRef<string | undefined>(undefined);
  const prevLiveCwdRef = useRef<string | undefined>(undefined);
  const prevAgentStatusRef = useRef<TerminalSession["agentStatus"] | undefined>(
    undefined
  );

  const sessionId = activeSession?.id;
  const sessionPid = activeSession?.pid;
  const sessionReadOnly = activeSession?.readOnly;

  const poll = useCallback(async () => {
    if (
      !enabled ||
      !isTauriReady() ||
      !sessionPid ||
      sessionReadOnly ||
      !sessionId
    ) {
      return;
    }

    const ptySessionId = toBackendPtySessionId(sessionId);

    try {
      const info = await invokeTauri<ForegroundProcessInfo>(
        "get_pty_foreground_process",
        { sessionId: ptySessionId }
      );

      const processName = info.process_name ?? undefined;
      const liveCwd = info.cwd ?? undefined;
      const agentStatus = activeSession
        ? deriveAgentStatus(activeSession, processName)
        : undefined;

      const nameChanged = processName !== prevProcessNameRef.current;
      const cwdChanged = liveCwd !== prevLiveCwdRef.current;
      const agentStatusChanged = agentStatus !== prevAgentStatusRef.current;

      if (nameChanged || cwdChanged || agentStatusChanged) {
        prevProcessNameRef.current = processName;
        prevLiveCwdRef.current = liveCwd;
        prevAgentStatusRef.current = agentStatus;
        updateSessionInfo(sessionId, { processName, liveCwd, agentStatus });
      }
    } catch {
      // Session may have been closed between poll scheduling and execution
    }
  }, [
    activeSession,
    enabled,
    sessionId,
    sessionPid,
    sessionReadOnly,
    updateSessionInfo,
  ]);

  useEffect(() => {
    if (!enabled || !sessionPid || sessionReadOnly) {
      prevProcessNameRef.current = undefined;
      prevLiveCwdRef.current = undefined;
      prevAgentStatusRef.current = undefined;
      return;
    }

    const timeoutId = window.setTimeout(poll, ACTIVITY_REFRESH_DELAY_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [enabled, sessionId, sessionPid, sessionReadOnly, refreshSignal, poll]);
}
