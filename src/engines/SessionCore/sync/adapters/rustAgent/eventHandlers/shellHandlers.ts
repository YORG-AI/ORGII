/**
 * Shell Process Handlers
 *
 * Handlers for exec_output and shell process lifecycle events
 * (agent:shell_process_started, agent:shell_process_backgrounded,
 * agent:shell_process_exited).
 */
import { createLogger } from "@src/hooks/logger";
import { updateShellProcessAtom } from "@src/store/session/shellProcessAtom";
import {
  type SubagentJobStatus,
  updateSubagentJobAtom,
} from "@src/store/session/subagentJobAtom";

import type { AgentWSEvent } from "../../shared/types";
import type { EventHandlerContext } from "./types";

const log = createLogger("ShellLifecycleHandlers");

function exactShellLifecycleIdentity(
  event: AgentWSEvent,
  routedSessionId: string | undefined,
  ctx: EventHandlerContext
): { sessionId: string; callId: string } | null {
  const sessionId = event.sessionId?.trim();
  const callId = event.toolCallId?.trim();
  const routed = routedSessionId?.trim();
  const filtered = ctx.filterSessionIdRef.current?.trim();

  if (!sessionId || !callId) {
    log.warn("Ignoring shell lifecycle event without exact identity", {
      type: event.type,
      sessionId,
      callId,
    });
    return null;
  }
  if (
    (routed && routed !== sessionId) ||
    (filtered && filtered !== sessionId)
  ) {
    log.warn("Ignoring cross-session shell lifecycle event", {
      type: event.type,
      routedSessionId: routed,
      filterSessionId: filtered,
      payloadSessionId: sessionId,
      callId,
    });
    return null;
  }
  return { sessionId, callId };
}

export function handleExecOutput(
  event: AgentWSEvent,
  ctx: EventHandlerContext
): void {
  const identity = exactShellLifecycleIdentity(
    event,
    ctx.filterSessionIdRef.current,
    ctx
  );
  const execStream = event.stream ?? "stdout";
  if (
    !identity ||
    !event.chunk ||
    (execStream !== "stdout" && execStream !== "stderr")
  )
    return;

  // OS Agent dispatches window event
  if (ctx.features.hasCodingSessionBridge) {
    window.dispatchEvent(
      new CustomEvent("agent-exec-output", {
        detail: {
          sessionId: identity.sessionId,
          callId: identity.callId,
          sequence: event.sequence,
          persistedBytes: event.persistedBytes,
          chunk: event.chunk ?? "",
          stream: execStream,
        },
      })
    );
  }
}

/**
 * Handle shell process started event.
 * Updates shellProcessAtom and the last shell event's pid/status.
 */
export function handleShellProcessStarted(
  event: AgentWSEvent,
  sessionId: string | undefined,
  ctx: EventHandlerContext
): void {
  const identity = exactShellLifecycleIdentity(event, sessionId, ctx);
  const pid = event.pid;
  const command = event.command || "";

  if (!pid || !identity) return;

  const store = ctx.getDefaultStore();
  if (store) {
    store.set(updateShellProcessAtom, {
      type: "start",
      sessionId: identity.sessionId,
      pid,
      callId: identity.callId,
      command,
    });
  }
}

/**
 * Handle shell process backgrounded event.
 *
 * Emitted when `run_shell` spawns with `mode="background"` (reason: "explicit")
 * or when a blocking run hits `wait_secs` without exiting (reason: "timeout").
 * Transitions the last shell event's `shellProcessStatus` from `"running"` to
 * `"background"` so `TerminalBlock` keeps the chat card expanded with a
 * "backgrounded · PID N" chip and the Stop button remains active until
 * `shell_process_exited` eventually arrives.
 */
export function handleShellProcessBackgrounded(
  event: AgentWSEvent,
  sessionId: string | undefined,
  ctx: EventHandlerContext
): void {
  const identity = exactShellLifecycleIdentity(event, sessionId, ctx);
  const pid = event.pid;

  if (!pid || !identity) return;

  const store = ctx.getDefaultStore();
  if (store) {
    store.set(updateShellProcessAtom, {
      type: "background",
      sessionId: identity.sessionId,
      pid,
      callId: identity.callId,
    });
  }
}

/**
 * Handle shell process exited event.
 * Updates shellProcessAtom status and the last shell event's processStatus.
 */
export function handleShellProcessExited(
  event: AgentWSEvent,
  sessionId: string | undefined,
  ctx: EventHandlerContext
): void {
  const identity = exactShellLifecycleIdentity(event, sessionId, ctx);
  const pid = event.pid;
  const exitCode = event.exitCode;
  const killed = event.killed ?? false;

  if (!pid || !identity) return;

  const store = ctx.getDefaultStore();
  if (store) {
    store.set(updateShellProcessAtom, {
      type: "exit",
      sessionId: identity.sessionId,
      pid,
      callId: identity.callId,
      exitCode,
      killed,
    });
  }
}

const SUBAGENT_JOB_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "completed",
  "failed",
  "killed",
]);

/**
 * Handle background subagent job lifecycle event
 * (agent:subagent_job_changed).
 *
 * Mirrors the shell process handlers above but for Delegate/Shadow workers:
 * "running" inserts a row into `subagentJobMapAtom` (pin bar above the
 * composer), any terminal status removes it.
 */
export function handleSubagentJobChanged(
  event: AgentWSEvent,
  sessionId: string | undefined,
  ctx: EventHandlerContext
): void {
  const resolvedSessionId =
    sessionId || event.sessionId || ctx.filterSessionIdRef.current || "";
  const handle = event.handle;
  const status = event.status;

  if (!handle || !resolvedSessionId) return;
  if (!status || !SUBAGENT_JOB_STATUSES.has(status)) return;

  const store = ctx.getDefaultStore();
  if (!store) return;

  store.set(updateSubagentJobAtom, {
    sessionId: resolvedSessionId,
    handle,
    agentName: event.agentName || handle,
    subagentType: event.subagentType || "delegate",
    status: status as SubagentJobStatus,
  });
}
