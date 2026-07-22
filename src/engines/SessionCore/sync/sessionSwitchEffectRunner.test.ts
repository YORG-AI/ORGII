import { beforeEach, describe, expect, it, vi } from "vitest";

import { runSessionSwitchEffect } from "./sessionSwitchEffectRunner";

const mocks = vi.hoisted(() => ({
  getAdapterForSession: vi.fn(),
  runOrchestrator: vi.fn(),
  activateReplay: vi.fn(),
  deactivateReplay: vi.fn(),
  disposeHandler: vi.fn(),
  resetReloadGuard: vi.fn(),
  resetSwitchState: vi.fn(),
  createCallbacks: vi.fn(() => ({})),
}));

vi.mock("./types", () => ({
  getAdapterForSession: mocks.getAdapterForSession,
}));
vi.mock("./sessionSwitchOrchestrator", () => ({
  runSessionSwitchOrchestrator: mocks.runOrchestrator,
}));
vi.mock("./externalReplayTransport", () => ({
  activateExternalReplaySession: mocks.activateReplay,
  deactivateExternalReplaySession: mocks.deactivateReplay,
}));
vi.mock("./sessionSyncLifecycle", () => ({
  disposeCurrentHandler: mocks.disposeHandler,
  resetReloadGuardForSession: mocks.resetReloadGuard,
}));
vi.mock("./sessionSyncStateHelpers", () => ({
  resetSessionSwitchState: mocks.resetSwitchState,
  createSessionEventHandlerCallbacks: mocks.createCallbacks,
}));

describe("runSessionSwitchEffect history transport isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("never activates external replay for a native SDE adapter", () => {
    const handler = {
      handleEvent: vi.fn(),
      reset: vi.fn(),
      isStreaming: false,
      dispose: vi.fn(),
    };
    const nativeLoadHistory = vi.fn();
    mocks.getAdapterForSession.mockReturnValue({
      category: "agent",
      historyMode: "persisted-db",
      loadHistory: nativeLoadHistory,
      createEventHandler: vi.fn(() => handler),
      sendMessage: vi.fn(),
      stopSession: vi.fn(),
    });
    const refs = {
      adapterRef: { current: null },
      handlerRef: { current: null },
      prevSessionIdRef: { current: null },
      prevReloadEpochRef: { current: 0 },
      liveSessionIdRef: { current: "sdeagent-native" },
    };

    const cleanup = runSessionSwitchEffect({
      sessionId: "sdeagent-native",
      reloadEpoch: 0,
      refs,
      switchActions: {} as never,
      loadActions: {} as never,
      handlerActions: {} as never,
      setPendingPlanApprovals: vi.fn(),
      logStatusChange: vi.fn(),
      logger: {} as never,
    });

    expect(mocks.activateReplay).not.toHaveBeenCalled();
    expect(nativeLoadHistory).not.toHaveBeenCalled();
    expect(mocks.runOrchestrator).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sdeagent-native",
        replayLease: undefined,
      })
    );

    cleanup();
    expect(mocks.deactivateReplay).not.toHaveBeenCalled();
  });

  it("aborts and releases the exact bounded-replay episode on switch-away", () => {
    const replayLease = {
      sessionId: "codexapp-external",
      epoch: 42,
    };
    const handler = {
      handleEvent: vi.fn(),
      reset: vi.fn(),
      isStreaming: false,
      dispose: vi.fn(),
    };
    mocks.getAdapterForSession.mockReturnValue({
      category: "external_history",
      historyMode: "bounded-replay",
      createEventHandler: vi.fn(() => handler),
      sendMessage: vi.fn(),
      stopSession: vi.fn(),
    });
    mocks.activateReplay.mockReturnValue(replayLease);
    const refs = {
      adapterRef: { current: null },
      handlerRef: { current: null },
      prevSessionIdRef: { current: null },
      prevReloadEpochRef: { current: 0 },
      liveSessionIdRef: { current: "codexapp-external" },
    };

    const cleanup = runSessionSwitchEffect({
      sessionId: "codexapp-external",
      reloadEpoch: 0,
      refs,
      switchActions: {} as never,
      loadActions: {} as never,
      handlerActions: {} as never,
      setPendingPlanApprovals: vi.fn(),
      logStatusChange: vi.fn(),
      logger: {} as never,
    });

    const orchestratorOptions = mocks.runOrchestrator.mock.calls[0]?.[0];
    expect(mocks.activateReplay).toHaveBeenCalledWith("codexapp-external");
    expect(orchestratorOptions).toEqual(
      expect.objectContaining({ replayLease })
    );
    expect(orchestratorOptions.abortController.signal.aborted).toBe(false);

    cleanup();

    expect(orchestratorOptions.abortController.signal.aborted).toBe(true);
    expect(mocks.deactivateReplay).toHaveBeenCalledTimes(1);
    expect(mocks.deactivateReplay).toHaveBeenCalledWith(replayLease);
    expect(mocks.resetReloadGuard).toHaveBeenCalledWith(
      "codexapp-external",
      refs
    );
  });
});
