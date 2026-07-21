/**
 * Shell Process Atom
 *
 * Tracks running shell processes per session for real-time status display
 * and one-click kill functionality in TerminalBlock.
 *
 * Updated by:
 * - agent:shell_process_started → adds process with "running" status
 * - agent:shell_process_exited → updates to "exited" or "killed"
 *
 * Consumed by:
 * - ShellEvent/ChatVariant → passes pid/status to TerminalBlock
 */
import { atom } from "jotai";

// ============================================
// Types
// ============================================

export type ShellProcessStatus = "running" | "background" | "exited" | "killed";

export interface ShellProcessState {
  pid: number;
  callId: string;
  command: string;
  status: ShellProcessStatus;
  exitCode?: number;
  startedAt: number;
}

/** Map<sessionId, Map<pid, ShellProcessState>> */
export type ShellProcessMap = Map<string, Map<number, ShellProcessState>>;

const MAX_EXITED_PROCESSES = 20;

/**
 * Prune exited/killed entries when the map exceeds a threshold,
 * keeping only the most recently started ones.
 */
function pruneExitedProcesses(
  sessionMap: Map<number, ShellProcessState>
): void {
  const exited = [...sessionMap.entries()].filter(
    ([, proc]) => proc.status === "exited" || proc.status === "killed"
  );
  if (exited.length <= MAX_EXITED_PROCESSES) return;
  exited.sort(([, a], [, b]) => a.startedAt - b.startedAt);
  const toRemove = exited.length - MAX_EXITED_PROCESSES;
  for (let idx = 0; idx < toRemove; idx++) {
    sessionMap.delete(exited[idx][0]);
  }
}

// ============================================
// Atoms
// ============================================

/** Raw shell process state map */
export const shellProcessMapAtom = atom<ShellProcessMap>(new Map());
shellProcessMapAtom.debugLabel = "shellProcessMap";

/** Write atom to update shell process state on start/exit events */
export const updateShellProcessAtom = atom(
  null,
  (
    get,
    set,
    action:
      | {
          type: "start";
          sessionId: string;
          pid: number;
          callId: string;
          command: string;
        }
      | {
          type: "exit";
          sessionId: string;
          pid: number;
          callId: string;
          exitCode?: number;
          killed: boolean;
        }
      | {
          type: "background";
          sessionId: string;
          pid: number;
          callId: string;
        }
  ) => {
    const currentMap = get(shellProcessMapAtom);
    // Create new map to trigger reactivity
    const newMap = new Map(currentMap);

    switch (action.type) {
      case "start": {
        let sessionProcesses = newMap.get(action.sessionId);
        if (!sessionProcesses) {
          sessionProcesses = new Map();
          newMap.set(action.sessionId, sessionProcesses);
        } else {
          // Clone to avoid mutating existing Map
          sessionProcesses = new Map(sessionProcesses);
          newMap.set(action.sessionId, sessionProcesses);
        }

        sessionProcesses.set(action.pid, {
          pid: action.pid,
          callId: action.callId,
          command: action.command,
          status: "running",
          startedAt: Date.now(),
        });
        break;
      }

      case "exit": {
        const sessionProcesses = newMap.get(action.sessionId);
        if (sessionProcesses) {
          const process = sessionProcesses.get(action.pid);
          if (process && process.callId === action.callId) {
            const newSessionProcesses = new Map(sessionProcesses);
            newSessionProcesses.set(action.pid, {
              ...process,
              status: action.killed ? "killed" : "exited",
              exitCode: action.exitCode,
            });
            pruneExitedProcesses(newSessionProcesses);
            if (newSessionProcesses.size === 0) {
              newMap.delete(action.sessionId);
            } else {
              newMap.set(action.sessionId, newSessionProcesses);
            }
          }
        }
        break;
      }

      case "background": {
        const sessionProcesses = newMap.get(action.sessionId);
        if (sessionProcesses) {
          const process = sessionProcesses.get(action.pid);
          if (
            process &&
            process.status === "running" &&
            process.callId === action.callId
          ) {
            // Clone session map and update process
            const newSessionProcesses = new Map(sessionProcesses);
            newSessionProcesses.set(action.pid, {
              ...process,
              status: "background",
            });
            newMap.set(action.sessionId, newSessionProcesses);
          }
        }
        break;
      }
    }

    set(shellProcessMapAtom, newMap);
  }
);
updateShellProcessAtom.debugLabel = "updateShellProcess";

/**
 * Get process status for a specific (sessionId, pid) pair.
 * Returns undefined if not found.
 */
export function getProcessStatus(
  processMap: ShellProcessMap,
  sessionId: string,
  pid: number
): ShellProcessState | undefined {
  return processMap.get(sessionId)?.get(pid);
}

/**
 * Clear all processes for a session (on session end/cleanup).
 */
export const clearSessionProcessesAtom = atom(
  null,
  (get, set, sessionId: string) => {
    const currentMap = get(shellProcessMapAtom);
    if (currentMap.has(sessionId)) {
      const newMap = new Map(currentMap);
      newMap.delete(sessionId);
      set(shellProcessMapAtom, newMap);
    }
  }
);
clearSessionProcessesAtom.debugLabel = "clearSessionProcesses";
