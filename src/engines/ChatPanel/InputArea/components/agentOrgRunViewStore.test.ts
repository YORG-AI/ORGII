import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_ORG_BOOTSTRAP_JOIN_TIMEOUT_MS,
  AGENT_ORG_RUN_VIEW_FALLBACK_MS,
  AGENT_ORG_RUN_VIEW_PUSH_DEBOUNCE_MS,
  agentOrgRunViewStoreTestApi,
  getAgentOrgRunViewSnapshot,
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
  runStatus: "running" | "paused" | "completed",
  interventionResumeAfter?: string
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
      hierarchyMode: "flat",
      rootSessionId: "session-root",
    },
    runStatus,
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
        intervention: interventionResumeAfter
          ? {
              orgRunId: "run-1",
              memberId: "worker",
              agentId: "agent-worker",
              sessionId: "session-worker",
              status: "user_intervention",
              enteredAt: "2026-07-17T00:00:00Z",
              lastUserActivityAt: "2026-07-17T00:00:00Z",
              resumeAfter: interventionResumeAfter,
            }
          : null,
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
});

describe("Agent Org run-view store", () => {
  it("shares one fallback per run, coalesces pushes, and stops terminal runs", async () => {
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
      .mockResolvedValueOnce(runView("completed"));

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
    workerRequest.resolve(runView("completed"));
    await flushPromises();
    rootRequest.resolve(runView("running"));
    await flushPromises();

    expect(getAgentOrgRunViewSnapshot("session-root").view?.runStatus).toBe(
      "completed"
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

  it("refreshes once when an intervention TTL expires", async () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 5_000).toISOString();
    mocks.subscribeAgentOrgStateChanges.mockReturnValue(
      mocks.unsubscribeStateChanges
    );
    mocks.getAgentOrgSessionRunView
      .mockResolvedValueOnce(runView("running", expiresAt))
      .mockResolvedValueOnce(runView("running"));

    const unsubscribe = subscribeAgentOrgRunView("session-root", vi.fn());
    await flushPromises();
    expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(AGENT_ORG_RUN_VIEW_PUSH_DEBOUNCE_MS);
    await flushPromises();

    expect(mocks.getAgentOrgSessionRunView).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
