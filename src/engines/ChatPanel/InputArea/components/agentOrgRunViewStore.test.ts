import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_ORG_BOOTSTRAP_JOIN_TIMEOUT_MS,
  AGENT_ORG_RUN_VIEW_FALLBACK_MS,
  AGENT_ORG_RUN_VIEW_PUSH_DEBOUNCE_MS,
  agentOrgRunViewStoreTestApi,
  getAgentOrgRunViewSnapshot,
  refreshAgentOrgRunViewForChangedSession,
  subscribeAgentOrgRunView,
} from "./agentOrgRunViewStore";

const mocks = vi.hoisted(() => ({
  getAgentOrgSessionRunView: vi.fn(),
  subscribeAgentOrgStateChanges: vi.fn(),
  unsubscribeStateChanges: vi.fn(),
  websocketOn: vi.fn(),
  unsubscribeBackendChanges: vi.fn(),
}));

vi.mock("@src/api/tauri/agent/orgTasks", () => ({
  getAgentOrgSessionRunView: mocks.getAgentOrgSessionRunView,
  subscribeAgentOrgStateChanges: mocks.subscribeAgentOrgStateChanges,
}));

vi.mock("@src/api/realtime/codeEditorWebSocket", () => ({
  getCodeEditorWebSocket: () => ({ on: mocks.websocketOn }),
}));

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function runView(
  runStatus: "starting" | "running" | "paused" | "idle" | "failed" | "archived"
) {
  return {
    context: {
      runId: "run-1",
      orgId: "org-1",
      orgName: "Test org",
      orgRole: "Test",
      coordinatorAgentId: "agent-coordinator",
      coordinatorName: "Coordinator",
      coordinatorRole: "Lead",
      members: [],
      rootSessionId: "session-root",
    },
    runStatus,
    runPhase: runStatus === "running" ? "coordinating" : runStatus,
    currentMemberId: "coordinator",
    members: [
      {
        memberId: "coordinator",
        name: "Coordinator",
        role: "Lead",
        agentId: "agent-coordinator",
        isCoordinator: true,
        sessionRuntime: {
          sessionId: "session-root",
          status: "running",
          updatedAt: "2026-07-17T00:00:00Z",
        },
        unreadInboxCount: 0,
        inboxActivityCount: 0,
        activeTaskCount: 0,
        pendingTaskCount: 0,
        inProgressTaskCount: 0,
        completedTaskCount: 0,
      },
      {
        memberId: "worker",
        name: "Worker",
        role: "Implement",
        agentId: "agent-worker",
        isCoordinator: false,
        sessionRuntime: {
          sessionId: "session-worker",
          status: "running",
          updatedAt: "2026-07-17T00:00:00Z",
        },
        intervention: null,
        unreadInboxCount: 0,
        inboxActivityCount: 0,
        activeTaskCount: 0,
        pendingTaskCount: 0,
        inProgressTaskCount: 0,
        completedTaskCount: 0,
      },
    ],
    tasks: [],
    inbox: [],
  };
}

function runViewForRoot(
  runStatus: "starting" | "running" | "paused" | "idle" | "failed" | "archived",
  runId: string,
  rootSessionId: string
) {
  const view = runView(runStatus);
  view.context.runId = runId;
  view.context.rootSessionId = rootSessionId;
  view.members[0].sessionRuntime.sessionId = rootSessionId;
  return view;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  agentOrgRunViewStoreTestApi.reset();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Agent Org run-view store", () => {
  it("shares one fallback per run, coalesces pushes, and stops immediately on Idle", async () => {
    vi.useFakeTimers();
    let stateChangeHandler: ((sessionId: string) => void) | undefined;
    let backendChangeHandler:
      | ((event: { payload?: unknown }) => void)
      | undefined;
    let cliChangeHandler:
      | ((event: { session_id?: unknown }) => void)
      | undefined;
    mocks.subscribeAgentOrgStateChanges.mockImplementation(
      (handler: (sessionId: string) => void) => {
        stateChangeHandler = handler;
        return mocks.unsubscribeStateChanges;
      }
    );
    mocks.websocketOn.mockImplementation(
      (
        event: string,
        handler: (event: { payload?: unknown; session_id?: unknown }) => void
      ) => {
        if (event === "agent_org:run_changed") {
          backendChangeHandler = handler;
        } else if (event === "code_session.status_changed") {
          cliChangeHandler = handler;
        }
        return mocks.unsubscribeBackendChanges;
      }
    );
    mocks.getAgentOrgSessionRunView
      .mockResolvedValueOnce(runView("running"))
      .mockResolvedValueOnce(runView("idle"));

    const rootSubscriber = vi.fn();
    const secondRootSubscriber = vi.fn();
    const workerSubscriber = vi.fn();
    const unsubscribeRoot = subscribeAgentOrgRunView(
      "session-root",
      rootSubscriber
    );
    const unsubscribeSecondRoot = subscribeAgentOrgRunView(
      "session-root",
      secondRootSubscriber
    );

    expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(1);
    await flushPromises();

    const unsubscribeWorker = subscribeAgentOrgRunView(
      "session-worker",
      workerSubscriber
    );
    expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(1);
    expect(
      getAgentOrgRunViewSnapshot("session-worker").view?.currentMemberId
    ).toBe("worker");

    backendChangeHandler?.({ payload: { orgRunId: "run-1" } });
    cliChangeHandler?.({ session_id: "session-worker" });
    stateChangeHandler?.("session-worker");
    await vi.advanceTimersByTimeAsync(AGENT_ORG_RUN_VIEW_PUSH_DEBOUNCE_MS - 1);
    expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(AGENT_ORG_RUN_VIEW_FALLBACK_MS * 2);
    expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(2);

    unsubscribeRoot();
    unsubscribeSecondRoot();
    unsubscribeWorker();
    expect(mocks.unsubscribeStateChanges).toHaveBeenCalledTimes(1);
    expect(mocks.unsubscribeBackendChanges).toHaveBeenCalledTimes(3);
  });

  it("reconciles a mounted Idle member exactly once after its native Session terminal", async () => {
    vi.useFakeTimers();
    mocks.subscribeAgentOrgStateChanges.mockReturnValue(
      mocks.unsubscribeStateChanges
    );
    mocks.getAgentOrgSessionRunView
      .mockResolvedValueOnce(runView("idle"))
      .mockResolvedValueOnce(runView("idle"));

    const unsubscribe = subscribeAgentOrgRunView("session-worker", vi.fn());
    await flushPromises();
    expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(1);
    expect(agentOrgRunViewStoreTestApi.hasPollingTimer()).toBe(false);

    refreshAgentOrgRunViewForChangedSession("session-worker");
    refreshAgentOrgRunViewForChangedSession("session-worker");
    await vi.advanceTimersByTimeAsync(AGENT_ORG_RUN_VIEW_PUSH_DEBOUNCE_MS);
    await flushPromises();

    expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(2);
    expect(agentOrgRunViewStoreTestApi.hasPollingTimer()).toBe(false);
    unsubscribe();
  });

  it("does not query for an unrelated native Session status change", async () => {
    vi.useFakeTimers();
    mocks.subscribeAgentOrgStateChanges.mockReturnValue(
      mocks.unsubscribeStateChanges
    );
    mocks.getAgentOrgSessionRunView.mockResolvedValue(runView("idle"));

    const unsubscribe = subscribeAgentOrgRunView("session-worker", vi.fn());
    await flushPromises();
    refreshAgentOrgRunViewForChangedSession("ordinary-sde");
    await vi.advanceTimersByTimeAsync(AGENT_ORG_RUN_VIEW_PUSH_DEBOUNCE_MS);
    await flushPromises();

    expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("stops probing a non-org session after its initial discovery", async () => {
    vi.useFakeTimers();
    mocks.subscribeAgentOrgStateChanges.mockReturnValue(
      mocks.unsubscribeStateChanges
    );
    mocks.getAgentOrgSessionRunView.mockResolvedValue(null);

    const unsubscribe = subscribeAgentOrgRunView("ordinary-session", vi.fn());
    expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(1);
    await flushPromises();

    await vi.advanceTimersByTimeAsync(AGENT_ORG_RUN_VIEW_FALLBACK_MS * 5);
    expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("performs one bounded follow-up when bootstrap first observes Starting", async () => {
    mocks.subscribeAgentOrgStateChanges.mockReturnValue(
      mocks.unsubscribeStateChanges
    );
    mocks.getAgentOrgSessionRunView
      .mockResolvedValueOnce(runView("starting"))
      .mockResolvedValueOnce(runView("running"));

    const unsubscribe = subscribeAgentOrgRunView("session-root", vi.fn());
    await flushPromises();
    await flushPromises();

    expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(2);
    expect(getAgentOrgRunViewSnapshot("session-root").view?.runStatus).toBe(
      "running"
    );
    unsubscribe();
  });

  it.each(["paused", "idle", "failed", "archived"] as const)(
    "does not retain a fallback interval when the initial Team is %s",
    async (status) => {
      vi.useFakeTimers();
      mocks.subscribeAgentOrgStateChanges.mockReturnValue(
        mocks.unsubscribeStateChanges
      );
      mocks.getAgentOrgSessionRunView.mockResolvedValue(runView(status));

      const unsubscribe = subscribeAgentOrgRunView("session-root", vi.fn());
      await flushPromises();

      expect(agentOrgRunViewStoreTestApi.hasPollingTimer()).toBe(false);
      await vi.advanceTimersByTimeAsync(AGENT_ORG_RUN_VIEW_FALLBACK_MS * 5);
      expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(1);
      unsubscribe();
    }
  );

  it("does not poll a Working Team whose derived phase is Idle", async () => {
    vi.useFakeTimers();
    mocks.subscribeAgentOrgStateChanges.mockReturnValue(
      mocks.unsubscribeStateChanges
    );
    const idleWorkingView = runView("running");
    idleWorkingView.runPhase = "idle";
    mocks.getAgentOrgSessionRunView.mockResolvedValue(idleWorkingView);

    const unsubscribe = subscribeAgentOrgRunView("session-root", vi.fn());
    await flushPromises();

    expect(agentOrgRunViewStoreTestApi.hasPollingTimer()).toBe(false);
    await vi.advanceTimersByTimeAsync(AGENT_ORG_RUN_VIEW_FALLBACK_MS * 5);
    expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("reconciles a Paused Run once on WebSocket reconnect without starting polling", async () => {
    vi.useFakeTimers();
    let connectedHandler: (() => void) | undefined;
    mocks.subscribeAgentOrgStateChanges.mockReturnValue(
      mocks.unsubscribeStateChanges
    );
    mocks.websocketOn.mockImplementation(
      (event: string, handler: () => void) => {
        if (event === "connected") connectedHandler = handler;
        return mocks.unsubscribeBackendChanges;
      }
    );
    const draining = runView("paused") as ReturnType<typeof runView> & {
      pauseHandoff?: {
        episodeId: string;
        pauseGeneration: number;
        totalCount: number;
        drainingCount: number;
        timedOutCount: number;
      };
    };
    draining.pauseHandoff = {
      episodeId: "episode-1",
      pauseGeneration: 2,
      totalCount: 2,
      drainingCount: 2,
      timedOutCount: 0,
    };
    const released = structuredClone(draining);
    released.pauseHandoff!.drainingCount = 0;
    mocks.getAgentOrgSessionRunView
      .mockResolvedValueOnce(draining)
      .mockResolvedValueOnce(released);

    const unsubscribe = subscribeAgentOrgRunView("session-root", vi.fn());
    await flushPromises();
    expect(agentOrgRunViewStoreTestApi.hasPollingTimer()).toBe(false);
    expect(
      getAgentOrgRunViewSnapshot("session-root").view?.pauseHandoff
        ?.drainingCount
    ).toBe(2);

    connectedHandler?.();
    await flushPromises();

    expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(2);
    expect(
      getAgentOrgRunViewSnapshot("session-root").view?.pauseHandoff
        ?.drainingCount
    ).toBe(0);
    expect(agentOrgRunViewStoreTestApi.hasPollingTimer()).toBe(false);

    await vi.advanceTimersByTimeAsync(AGENT_ORG_RUN_VIEW_FALLBACK_MS * 5);
    expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("destroys the shared interval when the last pollable Team becomes Idle", async () => {
    vi.useFakeTimers();
    mocks.subscribeAgentOrgStateChanges.mockReturnValue(
      mocks.unsubscribeStateChanges
    );
    mocks.getAgentOrgSessionRunView.mockImplementation((sessionId: string) => {
      if (sessionId === "root-a") {
        return Promise.resolve(runViewForRoot("running", "run-a", "root-a"));
      }
      return Promise.resolve(runViewForRoot("running", "run-b", "root-b"));
    });

    const unsubscribeA = subscribeAgentOrgRunView("root-a", vi.fn());
    const unsubscribeB = subscribeAgentOrgRunView("root-b", vi.fn());
    await flushPromises();
    expect(agentOrgRunViewStoreTestApi.hasPollingTimer()).toBe(true);

    mocks.getAgentOrgSessionRunView.mockImplementation((sessionId: string) =>
      Promise.resolve(
        sessionId === "root-a"
          ? runViewForRoot("idle", "run-a", "root-a")
          : runViewForRoot("running", "run-b", "root-b")
      )
    );
    await agentOrgRunViewStoreTestApi.refresh("root-a");
    expect(agentOrgRunViewStoreTestApi.hasPollingTimer()).toBe(true);

    mocks.getAgentOrgSessionRunView.mockImplementation((sessionId: string) =>
      Promise.resolve(
        sessionId === "root-b"
          ? runViewForRoot("idle", "run-b", "root-b")
          : runViewForRoot("idle", "run-a", "root-a")
      )
    );
    await agentOrgRunViewStoreTestApi.refresh("root-b");
    expect(agentOrgRunViewStoreTestApi.hasPollingTimer()).toBe(false);

    unsubscribeA();
    unsubscribeB();
  });

  it("clears polling while hidden and performs one bounded refresh when visible", async () => {
    vi.useFakeTimers();
    let hidden = false;
    let visibilityChange: (() => void) | undefined;
    vi.stubGlobal("document", {
      get hidden() {
        return hidden;
      },
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === "visibilitychange") visibilityChange = handler;
      }),
      removeEventListener: vi.fn(),
    });
    mocks.subscribeAgentOrgStateChanges.mockReturnValue(
      mocks.unsubscribeStateChanges
    );
    mocks.getAgentOrgSessionRunView.mockResolvedValue(runView("running"));

    const unsubscribe = subscribeAgentOrgRunView("session-root", vi.fn());
    await flushPromises();
    expect(agentOrgRunViewStoreTestApi.hasPollingTimer()).toBe(true);
    expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(1);

    hidden = true;
    visibilityChange?.();
    expect(agentOrgRunViewStoreTestApi.hasPollingTimer()).toBe(false);
    await vi.advanceTimersByTimeAsync(AGENT_ORG_RUN_VIEW_FALLBACK_MS * 5);
    expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(1);

    hidden = false;
    visibilityChange?.();
    await flushPromises();
    expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(2);
    expect(agentOrgRunViewStoreTestApi.hasPollingTimer()).toBe(true);

    unsubscribe();
  });

  it("refreshes a retained view immediately when the session is reopened", async () => {
    vi.useFakeTimers();
    mocks.subscribeAgentOrgStateChanges.mockReturnValue(
      mocks.unsubscribeStateChanges
    );
    mocks.getAgentOrgSessionRunView
      .mockResolvedValueOnce(runView("running"))
      .mockResolvedValueOnce(runView("paused"));

    const unsubscribeFirst = subscribeAgentOrgRunView("session-root", vi.fn());
    await flushPromises();
    expect(getAgentOrgRunViewSnapshot("session-root").view?.runStatus).toBe(
      "running"
    );

    unsubscribeFirst();
    const unsubscribeReopened = subscribeAgentOrgRunView(
      "session-root",
      vi.fn()
    );
    expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(2);
    await flushPromises();

    expect(getAgentOrgRunViewSnapshot("session-root").view?.runStatus).toBe(
      "paused"
    );
    unsubscribeReopened();
  });

  it("rejects an older discovery response that resolves after a newer one", async () => {
    vi.useFakeTimers();
    const rootRequest = deferred<ReturnType<typeof runView>>();
    const workerRequest = deferred<ReturnType<typeof runView>>();
    mocks.subscribeAgentOrgStateChanges.mockReturnValue(
      mocks.unsubscribeStateChanges
    );
    mocks.getAgentOrgSessionRunView
      .mockReturnValueOnce(rootRequest.promise)
      .mockReturnValueOnce(workerRequest.promise);

    const unsubscribeRoot = subscribeAgentOrgRunView("session-root", vi.fn());
    const unsubscribeWorker = subscribeAgentOrgRunView(
      "session-worker",
      vi.fn()
    );

    // Unknown sessions initially share one bootstrap request. If the first
    // discovery hangs, the second is released after the bounded join timeout;
    // request ordering must still reject the first request's late result.
    await vi.advanceTimersByTimeAsync(AGENT_ORG_BOOTSTRAP_JOIN_TIMEOUT_MS);
    workerRequest.resolve(runView("idle"));
    await flushPromises();
    rootRequest.resolve(runView("running"));
    await flushPromises();

    expect(getAgentOrgRunViewSnapshot("session-root").view?.runStatus).toBe(
      "idle"
    );
    unsubscribeRoot();
    unsubscribeWorker();
  });

  it("runs one follow-up refresh when a push arrives during an in-flight read", async () => {
    vi.useFakeTimers();
    let backendChangeHandler:
      | ((event: { payload?: unknown }) => void)
      | undefined;
    const inFlight = deferred<ReturnType<typeof runView>>();
    mocks.subscribeAgentOrgStateChanges.mockReturnValue(
      mocks.unsubscribeStateChanges
    );
    mocks.websocketOn.mockImplementation(
      (
        event: string,
        handler: (event: { payload?: unknown; session_id?: unknown }) => void
      ) => {
        if (event === "agent_org:run_changed") {
          backendChangeHandler = handler;
        }
        return mocks.unsubscribeBackendChanges;
      }
    );
    mocks.getAgentOrgSessionRunView
      .mockResolvedValueOnce(runView("running"))
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValueOnce(runView("running"));

    const unsubscribe = subscribeAgentOrgRunView("session-root", vi.fn());
    await flushPromises();

    backendChangeHandler?.({ payload: { orgRunId: "run-1" } });
    await vi.advanceTimersByTimeAsync(AGENT_ORG_RUN_VIEW_PUSH_DEBOUNCE_MS);
    expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(2);

    backendChangeHandler?.({ payload: { orgRunId: "run-1" } });
    await vi.advanceTimersByTimeAsync(AGENT_ORG_RUN_VIEW_PUSH_DEBOUNCE_MS);
    inFlight.resolve(runView("running"));
    await flushPromises();

    expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(3);
    unsubscribe();
  });
});
