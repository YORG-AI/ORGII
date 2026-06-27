import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginOptimisticTurn,
  clearRecentOptimisticTurn,
} from "@src/engines/SessionCore/control/optimisticTurnStatus";
import {
  markTurnRunning,
  markTurnTerminal,
} from "@src/engines/SessionCore/control/turnLifecycle";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { getLatestContextUsageSnapshot } from "@src/engines/SessionCore/sync/adapters/createRustAgentAdapter";
import {
  applyPostLoadResult,
  createSessionEventHandlerCallbacks,
  resetSessionSwitchState,
} from "@src/engines/SessionCore/sync/sessionSyncStateHelpers";
import type { SessionEventHandlerStateActions } from "@src/engines/SessionCore/sync/sessionSyncStateHelpers";
import { updateSessionStatus } from "@src/store/session";
import { createInstrumentedStore } from "@src/util/core/state/instrumentedStore";

createInstrumentedStore();

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    pinSession: vi.fn(),
    unpinSession: vi.fn(),
  },
}));

vi.mock("@src/store/session", () => ({
  updateSessionStatus: vi.fn(),
}));

vi.mock("@src/engines/SessionCore/control/turnLifecycle", () => ({
  markTurnRunning: vi.fn(),
  markTurnTerminal: vi.fn(),
  toTurnTerminalStatus: (status: string) =>
    status === "failed" || status === "error" || status === "timeout"
      ? "failed"
      : status === "cancelled" || status === "abandoned"
        ? "cancelled"
        : "completed",
}));

function createActions(): SessionEventHandlerStateActions & {
  streamingMap: Map<string, string>;
} {
  const actions = {
    streamingMap: new Map<string, string>(),
    setSessionContextTokens: vi.fn(),
    setSessionContextUsage: vi.fn(),
    setSessionContextBreakdown: vi.fn(),
    setSessionRuntimeStatus: vi.fn(),
    setSessionRuntimeError: vi.fn(),
    setPendingCancel: vi.fn(),
    setSessionRolledBack: vi.fn(),
    setStreamingDeltaContent: vi.fn((update) => {
      actions.streamingMap =
        typeof update === "function" ? update(actions.streamingMap) : update;
    }),
  };
  return actions;
}

describe("session sync state callbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears live streaming content before completed status can leave Stop UI stuck", () => {
    const actions = createActions();
    actions.streamingMap.set("session-1", "live answer");
    const callbacks = createSessionEventHandlerCallbacks(
      "session-1",
      actions,
      vi.fn()
    );

    callbacks.onStreamingDelta?.({
      isStreaming: true,
      isThinking: false,
      content: "live answer",
    });
    expect(actions.streamingMap.get("session-1")).toBe("live answer");

    callbacks.onStreamingDelta?.({
      isStreaming: false,
      isThinking: false,
      content: "",
    });
    callbacks.onStatusChange?.("completed");

    expect(actions.streamingMap.has("session-1")).toBe(false);
    expect(actions.setSessionRuntimeStatus).toHaveBeenCalledWith("completed");
    expect(actions.setPendingCancel).toHaveBeenCalledWith(false);
    expect(eventStoreProxy.unpinSession).toHaveBeenCalledWith("session-1");
  });

  it("does not clear live assistant content on thinking deltas", () => {
    const actions = createActions();
    actions.streamingMap.set("session-1", "partial answer");
    const callbacks = createSessionEventHandlerCallbacks(
      "session-1",
      actions,
      vi.fn()
    );

    callbacks.onStreamingDelta?.({
      isStreaming: true,
      isThinking: true,
      content: "reasoning token",
    });

    expect(actions.streamingMap.get("session-1")).toBe("partial answer");
    expect(actions.setStreamingDeltaContent).not.toHaveBeenCalled();
  });

  it("marks terminal status changes as FSM turn terminals", () => {
    const actions = createActions();
    const callbacks = createSessionEventHandlerCallbacks(
      "session-1",
      actions,
      vi.fn()
    );

    callbacks.onStatusChange?.("completed", undefined, {
      turnId: "turn-1",
      turnStatus: "completed",
    });

    expect(markTurnTerminal).toHaveBeenCalledWith("session-1", "completed");
  });

  it("does NOT mark the FSM terminal for intermediate status signals", () => {
    const actions = createActions();
    const callbacks = createSessionEventHandlerCallbacks(
      "session-1",
      actions,
      vi.fn()
    );

    callbacks.onStatusChange?.("completed", undefined, {
      intermediate: true,
    });

    expect(markTurnTerminal).not.toHaveBeenCalled();
  });

  it("does NOT leak intermediate signals into any session-level state", () => {
    // Regression: a per-message streaming_complete mid-turn used to write
    // "completed" into the runtime-status mirror, flipping the composer's
    // Stop button back to Send while the agent was still executing tools
    // (2026-06-10). Intermediate signals must be a full no-op.
    const actions = createActions();
    const callbacks = createSessionEventHandlerCallbacks(
      "session-1",
      actions,
      vi.fn()
    );

    callbacks.onStatusChange?.("completed", undefined, {
      intermediate: true,
    });

    expect(actions.setSessionRuntimeStatus).not.toHaveBeenCalled();
    expect(actions.setPendingCancel).not.toHaveBeenCalled();
    expect(eventStoreProxy.unpinSession).not.toHaveBeenCalled();
    expect(updateSessionStatus).not.toHaveBeenCalled();
  });

  it("opens the FSM turn on running status", () => {
    const actions = createActions();
    const callbacks = createSessionEventHandlerCallbacks(
      "session-1",
      actions,
      vi.fn()
    );

    callbacks.onStatusChange?.("running");

    expect(markTurnRunning).toHaveBeenCalledWith("session-1");
  });
});

describe("resetSessionSwitchState optimistic-running preservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createSwitchActions() {
    return {
      clearSessionLoadError: vi.fn(),
      setWpReadOnly: vi.fn(),
      setSessionContextTokens: vi.fn(),
      setSessionContextUsage: vi.fn(),
      setSessionContextBreakdown: vi.fn(),
      setSessionRuntimeStatus: vi.fn(),
      setSessionRuntimeError: vi.fn(),
      setPendingCancel: vi.fn(),
      setStreamRetryStatus: vi.fn(),
    };
  }

  it("resets to idle for a normal switch (no recent optimistic start)", () => {
    const actions = createSwitchActions();
    resetSessionSwitchState(actions, "session-plain");
    expect(actions.setSessionRuntimeStatus).toHaveBeenCalledWith("idle");
  });

  it("resets to idle when no sessionId is provided", () => {
    const actions = createSwitchActions();
    resetSessionSwitchState(actions);
    expect(actions.setSessionRuntimeStatus).toHaveBeenCalledWith("idle");
  });

  it("clears restored context usage on session switch", () => {
    const actions = createSwitchActions();
    resetSessionSwitchState(actions, "session-plain");
    expect(actions.setSessionContextTokens).toHaveBeenCalledWith(0);
    expect(actions.setSessionContextUsage).toHaveBeenCalledWith(null);
    expect(actions.setSessionContextBreakdown).toHaveBeenCalledWith(null);
  });

  it("preserves running for a session just optimistically started", () => {
    // beginOptimisticTurn records the session-scoped "recently started" marker
    // that resetSessionSwitchState consults.
    beginOptimisticTurn("session-launched", "launch");
    const actions = createSwitchActions();
    resetSessionSwitchState(actions, "session-launched");
    expect(actions.setSessionRuntimeStatus).not.toHaveBeenCalled();
    // Other resets still run.
    expect(actions.setPendingCancel).toHaveBeenCalledWith(false);
    expect(actions.setStreamRetryStatus).toHaveBeenCalledWith(null);
    clearRecentOptimisticTurn("session-launched");
  });

  it("does NOT preserve running for a different session than the launched one", () => {
    beginOptimisticTurn("session-launched", "launch");
    const actions = createSwitchActions();
    resetSessionSwitchState(actions, "session-other");
    expect(actions.setSessionRuntimeStatus).toHaveBeenCalledWith("idle");
    clearRecentOptimisticTurn("session-launched");
  });
});

describe("applyPostLoadResult", () => {
  it("restores context usage snapshot from post-load metadata", () => {
    const contextUsage = {
      usedTokens: 1200,
      maxTokens: 8000,
      percentUsed: 15,
      updatedAt: "2026-06-25T00:00:00.000Z",
      sections: [
        {
          category: "conversation" as const,
          label: "Conversation",
          estimatedTokens: 1200,
          percent: 100,
          items: [],
        },
      ],
      warnings: [],
    };
    const actions = {
      setSessionContextTokens: vi.fn(),
      setSessionContextUsage: vi.fn(),
      setSessionRuntimeStatus: vi.fn(),
      setSessionRuntimeError: vi.fn(),
    };

    applyPostLoadResult(
      "session-1",
      { contextTokens: 1200, contextUsage },
      actions
    );

    expect(actions.setSessionContextTokens).toHaveBeenCalledWith(1200);
    expect(actions.setSessionContextUsage).toHaveBeenCalledWith(contextUsage);
  });
});

describe("getLatestContextUsageSnapshot", () => {
  it("uses the latest persisted breakdown even when the newest token row has only totals", () => {
    const contextUsage = {
      usedTokens: 1200,
      maxTokens: 8000,
      percentUsed: 15,
      updatedAt: "2026-06-25T00:00:00.000Z",
      sections: [
        {
          category: "conversation" as const,
          label: "Conversation",
          estimatedTokens: 1200,
          percent: 100,
          items: [],
        },
      ],
      warnings: [],
    };

    expect(
      getLatestContextUsageSnapshot([
        { contextUsageJson: JSON.stringify(contextUsage) },
        { contextUsageJson: null },
      ])
    ).toEqual(contextUsage);
  });
});
