import { beforeEach, describe, expect, it, vi } from "vitest";

import { runSessionSwitchOrchestrator } from "../sessionSwitchOrchestrator";
import type { SessionAdapter } from "../types";

const mocks = vi.hoisted(() => ({
  applyPostLoadResult: vi.fn(),
  dispatchLoadSession: vi.fn(),
  getEvents: vi.fn(),
  hydrateSessionStoreBeforeDisplay: vi.fn(),
  loadInitialTurnWindow: vi.fn(),
  loadPersistedHistory: vi.fn(),
  messageError: vi.fn(),
  reconcileInFlightHistory: vi.fn(),
  rehydratePendingPlanApproval: vi.fn(),
  switchSession: vi.fn(),
}));

vi.mock("@src/components/Message", () => ({
  Message: { error: mocks.messageError },
}));

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    getEvents: mocks.getEvents,
    loadInitialTurnWindow: mocks.loadInitialTurnWindow,
    switchSession: mocks.switchSession,
  },
}));

vi.mock("@src/engines/SessionCore/ingestion/visibilityFilters", () => ({
  isVisibleInChat: () => true,
}));

vi.mock("@src/util/session/sessionDispatch", () => ({
  composerIdFromSessionId: () => null,
  isImportedHistorySession: () => false,
}));

vi.mock("../sessionSyncDerivedState", () => ({
  isCursorIdeSessionId: () => false,
}));

vi.mock("../sessionSyncPlanApproval", () => ({
  rehydratePendingPlanApproval: mocks.rehydratePendingPlanApproval,
}));

vi.mock("../sessionSyncReconcile", () => ({
  reconcileInFlightHistory: mocks.reconcileInFlightHistory,
}));

vi.mock("../sessionSyncStateHelpers", () => ({
  applyPostLoadResult: mocks.applyPostLoadResult,
}));

vi.mock("../sessionSyncUtils", () => ({
  hydrateSessionStoreBeforeDisplay: mocks.hydrateSessionStoreBeforeDisplay,
  isInFlightRunStatus: (status: string | undefined) =>
    status === "running" ||
    status === "waiting_for_user" ||
    status === "waiting_for_funds",
  loadPersistedHistory: mocks.loadPersistedHistory,
}));

function createActions() {
  return {
    dispatchLoadSession: mocks.dispatchLoadSession,
    failSessionLoad: vi.fn(),
    setEvents: vi.fn(),
    setLoadStatus: vi.fn(),
    setSessionContextTokens: vi.fn(),
    setSessionContextUsage: vi.fn(),
    setSessionRuntimeError: vi.fn(),
    setSessionRuntimeStatus: vi.fn(),
    setWpReadOnly: vi.fn(),
  };
}

describe("runSessionSwitchOrchestrator reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.switchSession.mockResolvedValue(true);
    mocks.getEvents.mockResolvedValue([{ id: "visible" }]);
  });

  it.each([
    [undefined, false],
    ["idle", false],
    ["completed", false],
    ["running", true],
    ["waiting_for_user", true],
    ["waiting_for_funds", true],
  ] as const)(
    "reconciles only an in-flight session (status=%s)",
    async (runStatus, shouldReconcile) => {
      const adapter = {
        category: "agent",
        historyMode: "persisted-db",
        loadHistory: vi.fn(),
        postLoad: vi
          .fn()
          .mockResolvedValue(runStatus === undefined ? {} : { runStatus }),
      } as unknown as SessionAdapter;

      runSessionSwitchOrchestrator({
        sessionId: "sdeagent-session",
        adapter,
        abortController: new AbortController(),
        refs: { liveSessionIdRef: { current: "sdeagent-session" } },
        actions: createActions(),
        setPendingPlanApprovals: vi.fn(),
        logger: { error: vi.fn() } as never,
      });

      await vi.waitFor(() => {
        expect(mocks.dispatchLoadSession).toHaveBeenCalledOnce();
      });
      expect(mocks.reconcileInFlightHistory).toHaveBeenCalledTimes(
        shouldReconcile ? 1 : 0
      );
    }
  );
});
