import { createStore } from "jotai/vanilla";
import { describe, expect, it, vi } from "vitest";

import { shellProcessMapAtom } from "@src/store/session/shellProcessAtom";

import type { AgentWSEvent } from "../../../shared/types";
import {
  handleExecOutput,
  handleShellProcessBackgrounded,
  handleShellProcessExited,
  handleShellProcessStarted,
} from "../shellHandlers";
import type { EventHandlerContext } from "../types";

function context(
  sessionId: string,
  store = createStore()
): EventHandlerContext {
  return {
    filterSessionIdRef: { current: sessionId },
    onAgentCompleteRef: { current: undefined },
    onContextUsageRef: { current: undefined },
    onTokenUpdateRef: { current: undefined },
    onStatusChangeRef: { current: undefined },
    onQuestionRequestRef: { current: undefined },
    setStreaming: () => undefined,
    features: {},
    getDefaultStore: () => store,
  };
}

function lifecycleEvent(
  type: string,
  overrides: Partial<AgentWSEvent> = {}
): AgentWSEvent {
  return {
    type,
    sessionId: "session-1",
    toolCallId: "call-1",
    pid: 1234,
    command: "sleep 10",
    ...overrides,
  };
}

describe("exact shell lifecycle routing", () => {
  it("does not dispatch exec output without an exact routed identity", () => {
    const dispatch = vi.spyOn(window, "dispatchEvent");
    const ctx = {
      ...context("session-1"),
      features: { hasCodingSessionBridge: true },
    };

    handleExecOutput(
      lifecycleEvent("agent:exec_output", {
        toolCallId: undefined,
        chunk: "must be ignored",
        stream: "stdout",
      }),
      ctx
    );
    handleExecOutput(
      lifecycleEvent("agent:exec_output", {
        sessionId: "other-session",
        chunk: "must be ignored",
        stream: "stdout",
      }),
      ctx
    );

    expect(dispatch).not.toHaveBeenCalled();
    dispatch.mockRestore();
  });

  it("ignores a payload whose Session does not match the routed Session", () => {
    const store = createStore();
    const ctx = context("session-route", store);

    handleShellProcessStarted(
      lifecycleEvent("agent:shell_process_started"),
      "session-route",
      ctx
    );

    expect(store.get(shellProcessMapAtom).size).toBe(0);
  });

  it("also requires the payload Session to match the active filter", () => {
    const store = createStore();
    const ctx = context("different-filter", store);

    handleShellProcessStarted(
      lifecycleEvent("agent:shell_process_started"),
      "session-1",
      ctx
    );

    expect(store.get(shellProcessMapAtom).size).toBe(0);
  });

  it("ignores lifecycle events without a callId", () => {
    const store = createStore();
    const ctx = context("session-1", store);

    handleShellProcessStarted(
      lifecycleEvent("agent:shell_process_started", { toolCallId: undefined }),
      "session-1",
      ctx
    );

    expect(store.get(shellProcessMapAtom).size).toBe(0);
  });

  it("updates start/background/exit only for the exact Session and call", () => {
    const store = createStore();
    const ctx = context("session-1", store);
    handleShellProcessStarted(
      lifecycleEvent("agent:shell_process_started"),
      "session-1",
      ctx
    );
    handleShellProcessBackgrounded(
      lifecycleEvent("agent:shell_process_backgrounded", {
        toolCallId: "other-call",
      }),
      "session-1",
      ctx
    );
    expect(
      store.get(shellProcessMapAtom).get("session-1")?.get(1234)?.status
    ).toBe("running");

    handleShellProcessBackgrounded(
      lifecycleEvent("agent:shell_process_backgrounded"),
      "session-1",
      ctx
    );
    expect(
      store.get(shellProcessMapAtom).get("session-1")?.get(1234)?.status
    ).toBe("background");

    handleShellProcessExited(
      lifecycleEvent("agent:shell_process_exited", {
        exitCode: 0,
        killed: false,
      }),
      "session-1",
      ctx
    );
    expect(
      store.get(shellProcessMapAtom).get("session-1")?.get(1234)?.status
    ).toBe("exited");
  });
});
