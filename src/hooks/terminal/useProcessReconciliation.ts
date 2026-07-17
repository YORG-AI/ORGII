/**
 * useProcessReconciliation
 *
 * Reseeds in-memory process state from Rust's authoritative process tables.
 * Runs on mount and when the window regains focus/visibility so stale process
 * rows self-heal when the user returns without adding idle polling work.
 *
 * Agent shells:
 *   Calls `agent_list_running_shell_jobs` → seeds `shellProcessMapAtom`
 *   with processes that are still alive in Rust's job registry.
 *
 * PTY sessions:
 *   Calls `list_pty_sessions` → cross-references with `terminalSessionsAtom`
 *   (persisted in localStorage). Removes entries whose Rust PTY is gone,
 *   refreshes metadata (pid, shell, cwd) for entries that are still alive.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";

import { createLogger } from "@src/hooks/logger";
import {
  type ShellProcessMap,
  shellProcessMapAtom,
  updateShellProcessAtom,
} from "@src/store/session/shellProcessAtom";
import {
  pruneSubagentJobsAtom,
  updateSubagentJobAtom,
} from "@src/store/session/subagentJobAtom";
import { activeSessionIdAtom } from "@src/store/session/viewAtom";
import {
  removeStaleTerminalSessionAtom,
  terminalSessionsAtom,
  updateTerminalSessionInfoAtom,
} from "@src/store/workstation/codeEditor/terminal";
import type { ShellKind } from "@src/types/terminal";
import { invokeTauri } from "@src/util/platform/tauri/init";
import { toBackendPtySessionId } from "@src/util/ui/terminal/ptySessionId";

const log = createLogger("ProcessReconciliation");

interface RunningShellJob {
  session_id: string;
  pid: number;
  command: string;
  log_path: string | null;
}

interface RunningSubagentJob {
  sessionId: string;
  handle: string;
  agentName: string;
  subagentType: string;
  ageMs: number;
}

interface PtySessionInfo {
  session_id: string;
  pid: number | null;
  shell: string;
  shell_kind: ShellKind;
  cwd: string | null;
  name: string | null;
}

export function findStaleShellProcesses(
  processMap: ShellProcessMap,
  runningJobs: readonly RunningShellJob[]
): Array<{ sessionId: string; pid: number }> {
  const liveJobKeys = new Set(
    runningJobs.map((job) => `${job.session_id}:${job.pid}`)
  );
  const staleProcesses: Array<{ sessionId: string; pid: number }> = [];

  for (const [sessionId, sessionProcesses] of processMap.entries()) {
    for (const process of sessionProcesses.values()) {
      if (
        (process.status === "running" || process.status === "background") &&
        !liveJobKeys.has(`${sessionId}:${process.pid}`)
      ) {
        staleProcesses.push({ sessionId, pid: process.pid });
      }
    }
  }

  return staleProcesses;
}

export function useProcessReconciliation(): void {
  const shellProcessMap = useAtomValue(shellProcessMapAtom);
  const terminalSessions = useAtomValue(terminalSessionsAtom);
  const activeSessionId = useAtomValue(activeSessionIdAtom);
  const dispatchUpdateShellProcess = useSetAtom(updateShellProcessAtom);
  const dispatchUpdateSubagentJob = useSetAtom(updateSubagentJobAtom);
  const dispatchPruneSubagentJobs = useSetAtom(pruneSubagentJobsAtom);
  const dispatchUpdateTerminalInfo = useSetAtom(updateTerminalSessionInfoAtom);
  const dispatchRemoveStaleSession = useSetAtom(removeStaleTerminalSessionAtom);

  // Mirror the latest values into refs so the one-shot startup effect always
  // sees the current atom state even if it was still initializing on mount.
  const shellProcessMapRef = useRef(shellProcessMap);
  const terminalSessionsRef = useRef(terminalSessions);
  const dispatchUpdateShellProcessRef = useRef(dispatchUpdateShellProcess);
  const dispatchUpdateSubagentJobRef = useRef(dispatchUpdateSubagentJob);
  const dispatchPruneSubagentJobsRef = useRef(dispatchPruneSubagentJobs);
  const dispatchUpdateTerminalInfoRef = useRef(dispatchUpdateTerminalInfo);
  const dispatchRemoveStaleSessionRef = useRef(dispatchRemoveStaleSession);
  // Latest reconcile closure, exposed to the session-switch effect below
  // without re-running the one-shot listener setup.
  const reconcileRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    shellProcessMapRef.current = shellProcessMap;
    terminalSessionsRef.current = terminalSessions;
    dispatchUpdateShellProcessRef.current = dispatchUpdateShellProcess;
    dispatchUpdateSubagentJobRef.current = dispatchUpdateSubagentJob;
    dispatchPruneSubagentJobsRef.current = dispatchPruneSubagentJobs;
    dispatchUpdateTerminalInfoRef.current = dispatchUpdateTerminalInfo;
    dispatchRemoveStaleSessionRef.current = dispatchRemoveStaleSession;
  });

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let lastReconcileStartedAt = 0;
    const MIN_RECONCILE_GAP_MS = 1_000;

    async function reconcile() {
      if (cancelled || inFlight) return;

      const now = Date.now();
      if (now - lastReconcileStartedAt < MIN_RECONCILE_GAP_MS) return;

      inFlight = true;
      lastReconcileStartedAt = now;

      try {
        // --- Agent shell processes ---
        try {
          const runningJobs = await invokeTauri<RunningShellJob[]>(
            "agent_list_running_shell_jobs"
          );
          if (cancelled) return;

          for (const process of findStaleShellProcesses(
            shellProcessMapRef.current,
            runningJobs
          )) {
            dispatchUpdateShellProcessRef.current({
              type: "exit",
              sessionId: process.sessionId,
              pid: process.pid,
              killed: false,
            });
          }

          for (const job of runningJobs) {
            const existing = shellProcessMapRef.current
              .get(job.session_id)
              ?.get(job.pid);
            if (
              !existing ||
              existing.status === "exited" ||
              existing.status === "killed"
            ) {
              dispatchUpdateShellProcessRef.current({
                type: "start",
                sessionId: job.session_id,
                pid: job.pid,
                command: job.command,
                logPath: job.log_path ?? undefined,
              });
            }
          }
        } catch (err) {
          log.error("[ProcessReconciliation] agent jobs:", err);
        }

        // --- Background subagent workers ---
        try {
          const runningSubagents = await invokeTauri<RunningSubagentJob[]>(
            "agent_list_running_subagent_jobs"
          );
          if (cancelled) return;

          // Prune ghost rows: any "running" row whose handle is no longer in the
          // authoritative live set (broadcast lost, registry GC'd, app restart)
          // is stale and must be dropped so it can't linger unkillable.
          dispatchPruneSubagentJobsRef.current({
            liveHandles: new Set(runningSubagents.map((job) => job.handle)),
          });

          for (const job of runningSubagents) {
            dispatchUpdateSubagentJobRef.current({
              sessionId: job.sessionId,
              handle: job.handle,
              agentName: job.agentName,
              subagentType: job.subagentType,
              status: "running",
              startedAtOverride: Date.now() - job.ageMs,
            });
          }
        } catch (err) {
          log.error("[ProcessReconciliation] subagent jobs:", err);
        }

        // --- PTY sessions ---
        try {
          const livePtySessions =
            await invokeTauri<PtySessionInfo[]>("list_pty_sessions");
          if (cancelled) return;

          const livePtyIds = new Set(livePtySessions.map((s) => s.session_id));

          for (const session of terminalSessionsRef.current) {
            if (session.readOnly) continue;

            const ptyId = toBackendPtySessionId(session.id);
            if (!livePtyIds.has(ptyId)) {
              dispatchRemoveStaleSessionRef.current(session.id);
            } else {
              const info = livePtySessions.find((s) => s.session_id === ptyId);
              if (info) {
                dispatchUpdateTerminalInfoRef.current({
                  sessionId: session.id,
                  info: {
                    pid: info.pid ?? undefined,
                    shell: info.shell,
                    shellKind: info.shell_kind,
                    cwd: info.cwd ?? undefined,
                  },
                });
              }
            }
          }
        } catch (err) {
          log.error("[ProcessReconciliation] pty sessions:", err);
        }
      } finally {
        inFlight = false;
      }
    }

    reconcileRef.current = reconcile;

    // Run immediately on mount, then only reconcile when the user returns to
    // the app. Live process events remain the fast path while the app is open;
    // this path repairs stale state after reloads, missed events, or time away.
    reconcile();

    // Re-reconcile when the window regains focus / becomes visible so a
    // returning user sees an accurate process list without idle polling.
    const onFocus = () => {
      reconcile();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      reconcileRef.current = null;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []); // Reconciliation listeners set up once; live values accessed via refs
  // updated on every render above. Startup, focus, and visibility drive re-runs.

  // Session switches also reconcile. The per-session IPC channel only
  // subscribes to the VISIBLE session, so a subagent's terminal
  // `agent:subagent_job_changed` broadcast is lost while the user is on
  // another session — the ghost "running" row then keeps `hasLiveSubagent`
  // true forever (stuck planning footer / Stop button). Focus/visibility
  // can't catch this case because the window never lost focus.
  useEffect(() => {
    if (!activeSessionId) return;
    reconcileRef.current?.();
  }, [activeSessionId]);
}
