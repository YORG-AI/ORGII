import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AgentOrgRunView,
  getAgentOrgSessionRunView,
} from "@src/api/tauri/agent/orgTasks";

import {
  AGENT_ORG_RUN_VIEW_FALLBACK_MS,
  agentOrgRunViewStoreTestApi,
} from "./agentOrgRunViewStore";

vi.mock("@src/api/tauri/agent/orgTasks", () => ({
  getAgentOrgSessionRunView: vi.fn(),
  subscribeAgentOrgStateChanges: vi.fn(() => () => undefined),
}));

vi.mock("@src/api/realtime/codeEditorWebSocket", () => ({
  getCodeEditorWebSocket: () => ({ on: () => () => undefined }),
}));

const mockedGetRunView = vi.mocked(getAgentOrgSessionRunView);
const agentOrgRunViewPollingTestApi = agentOrgRunViewStoreTestApi;

function runView(): AgentOrgRunView {
  return {
    context: {
      runId: "run-1",
      orgId: "org-1",
      orgName: "Test Org",
      orgRole: "team",
      coordinatorAgentId: "coord-agent",
      coordinatorName: "Coordinator",
      coordinatorRole: "lead",
      members: [
        { memberId: "m1", name: "Alice", role: "worker", agentId: "alice" },
        { memberId: "m2", name: "Bob", role: "worker", agentId: "bob" },
      ],
      hierarchyMode: "flat",
      planApprovalPolicy: "coordinator",
      rootSessionId: "root-session",
    },
    runStatus: "running",
    runPhase: "members_working",
    currentMemberId: "coordinator",
    members: [
      {
        memberId: "m1",
        name: "Alice",
        role: "worker",
        agentId: "alice",
        isCoordinator: false,
        sessionRuntime: {
          sessionId: "alice-session",
          status: "idle",
          updatedAt: "2026-07-16T00:00:00Z",
        },
        unreadInboxCount: 0,
        inboxActivityCount: 0,
        activeTaskCount: 0,
        pendingTaskCount: 0,
        inProgressTaskCount: 0,
        completedTaskCount: 0,
      },
      {
        memberId: "m2",
        name: "Bob",
        role: "worker",
        agentId: "bob",
        isCoordinator: false,
        sessionRuntime: {
          sessionId: "bob-session",
          status: "idle",
          updatedAt: "2026-07-16T00:00:00Z",
        },
        unreadInboxCount: 0,
        inboxActivityCount: 0,
        activeTaskCount: 0,
        pendingTaskCount: 0,
        inProgressTaskCount: 0,
        completedTaskCount: 0,
      },
    ],
    tasks: [],
    taskOverview: {
      total: 0,
      pending: 0,
      inProgress: 0,
      completed: 0,
      corrupt: 0,
      visible: 0,
      truncated: false,
    },
    inbox: [],
    unreadInboxCount: 0,
    pendingPlanApprovals: [],
  };
}

describe("Agent Org run-view polling coordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    agentOrgRunViewPollingTestApi.reset();
    mockedGetRunView.mockReset();
  });

  afterEach(() => {
    agentOrgRunViewPollingTestApi.reset();
    vi.useRealTimers();
  });

  it("shares one run poller while preserving caller-specific currentMemberId", async () => {
    mockedGetRunView.mockResolvedValue(runView());
    const unsubscribeRoot = agentOrgRunViewPollingTestApi.subscribe(
      "root-session",
      () => undefined
    );
    await vi.waitFor(() => expect(mockedGetRunView).toHaveBeenCalledTimes(1));

    const unsubscribeAlice = agentOrgRunViewPollingTestApi.subscribe(
      "alice-session",
      () => undefined
    );
    const unsubscribeBob = agentOrgRunViewPollingTestApi.subscribe(
      "bob-session",
      () => undefined
    );

    expect(mockedGetRunView).toHaveBeenCalledTimes(1);
    expect(
      agentOrgRunViewPollingTestApi.getSnapshot("root-session").view
        ?.currentMemberId
    ).toBe("coordinator");
    expect(
      agentOrgRunViewPollingTestApi.getSnapshot("alice-session").view
        ?.currentMemberId
    ).toBe("m1");
    expect(
      agentOrgRunViewPollingTestApi.getSnapshot("bob-session").view
        ?.currentMemberId
    ).toBe("m2");

    unsubscribeBob();
    unsubscribeAlice();
    unsubscribeRoot();
  });

  it("preserves the bounded-description signal in shared Run View snapshots", async () => {
    const compactView = runView();
    compactView.tasks = [
      {
        id: "task-1",
        orgRunId: "run-1",
        subject: "Compact task",
        description: "bounded preview",
        descriptionTruncated: true,
        owner: "m1",
        status: "pending",
        blocks: [],
        blockedBy: [],
        executionMode: "build",
        createdAt: "2026-07-16T00:00:00Z",
        updatedAt: "2026-07-16T00:00:00Z",
      },
    ];
    mockedGetRunView.mockResolvedValue(compactView);

    const unsubscribeRoot = agentOrgRunViewPollingTestApi.subscribe(
      "root-session",
      () => undefined
    );
    await vi.waitFor(() => expect(mockedGetRunView).toHaveBeenCalledTimes(1));
    const unsubscribeAlice = agentOrgRunViewPollingTestApi.subscribe(
      "alice-session",
      () => undefined
    );

    expect(
      agentOrgRunViewPollingTestApi.getSnapshot("alice-session").view?.tasks[0]
        .descriptionTruncated
    ).toBe(true);

    unsubscribeAlice();
    unsubscribeRoot();
  });

  it("keeps a shared member snapshot referentially stable before subscribe", async () => {
    mockedGetRunView.mockResolvedValue(runView());
    const unsubscribeRoot = agentOrgRunViewPollingTestApi.subscribe(
      "root-session",
      () => undefined
    );
    await vi.waitFor(() => expect(mockedGetRunView).toHaveBeenCalledTimes(1));

    // React's useSyncExternalStore reads getSnapshot before it subscribes. A
    // member can already borrow the root session's Run projection at that
    // point, and repeated reads must return the exact same object identity.
    const first = agentOrgRunViewPollingTestApi.getSnapshot("alice-session");
    const second = agentOrgRunViewPollingTestApi.getSnapshot("alice-session");
    expect(second).toBe(first);
    expect(first.view?.currentMemberId).toBe("m1");

    const unsubscribeAlice = agentOrgRunViewPollingTestApi.subscribe(
      "alice-session",
      () => undefined
    );
    expect(agentOrgRunViewPollingTestApi.getSnapshot("alice-session")).toBe(
      first
    );
    expect(mockedGetRunView).toHaveBeenCalledTimes(1);

    unsubscribeAlice();
    unsubscribeRoot();
  });

  it("evicts a getSnapshot-only generation when React never subscribes", async () => {
    agentOrgRunViewPollingTestApi.getSnapshot("abandoned-render-session");
    expect(
      agentOrgRunViewPollingTestApi.hasEntry("abandoned-render-session")
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(
      agentOrgRunViewPollingTestApi.hasEntry("abandoned-render-session")
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(
      agentOrgRunViewPollingTestApi.hasEntry("abandoned-render-session")
    ).toBe(false);
  });

  it("ignores a late IPC response from an evicted cache generation", async () => {
    let resolveRequest: ((view: AgentOrgRunView) => void) | undefined;
    mockedGetRunView.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        })
    );

    const unsubscribe = agentOrgRunViewPollingTestApi.subscribe(
      "root-session",
      () => undefined
    );
    // Capture the shared in-flight request so the test can await its late
    // completion without creating a replacement cache entry after eviction.
    const inFlight = agentOrgRunViewPollingTestApi.refresh("root-session");
    expect(mockedGetRunView).toHaveBeenCalledTimes(1);

    unsubscribe();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(agentOrgRunViewPollingTestApi.hasEntry("root-session")).toBe(false);

    resolveRequest?.(runView());
    await inFlight;

    expect(agentOrgRunViewPollingTestApi.hasEntry("root-session")).toBe(false);
    expect(agentOrgRunViewPollingTestApi.ownerSessionId("run-1")).toBeNull();
  });

  it("coalesces same-session subscribers before the first response", async () => {
    let resolveRequest: ((view: AgentOrgRunView) => void) | undefined;
    mockedGetRunView.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        })
    );

    const unsubscribeFirst = agentOrgRunViewPollingTestApi.subscribe(
      "root-session",
      () => undefined
    );
    const unsubscribeSecond = agentOrgRunViewPollingTestApi.subscribe(
      "root-session",
      () => undefined
    );

    expect(mockedGetRunView).toHaveBeenCalledTimes(1);
    resolveRequest?.(runView());
    await vi.waitFor(() =>
      expect(
        agentOrgRunViewPollingTestApi.getSnapshot("root-session").view
      ).not.toBeNull()
    );

    unsubscribeSecond();
    unsubscribeFirst();
  });

  it("coalesces root and member subscribers during run-id bootstrap", async () => {
    let resolveRequest: ((view: AgentOrgRunView) => void) | undefined;
    mockedGetRunView.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        })
    );

    const unsubscribeRoot = agentOrgRunViewPollingTestApi.subscribe(
      "root-session",
      () => undefined
    );
    const unsubscribeAlice = agentOrgRunViewPollingTestApi.subscribe(
      "alice-session",
      () => undefined
    );
    const unsubscribeBob = agentOrgRunViewPollingTestApi.subscribe(
      "bob-session",
      () => undefined
    );

    expect(mockedGetRunView).toHaveBeenCalledTimes(1);
    resolveRequest?.(runView());
    await vi.waitFor(() =>
      expect(
        agentOrgRunViewPollingTestApi.getSnapshot("bob-session").view
      ).not.toBeNull()
    );
    expect(mockedGetRunView).toHaveBeenCalledTimes(1);

    unsubscribeBob();
    unsubscribeAlice();
    unsubscribeRoot();
  });

  it("releases an unrelated bootstrap when the global owner hangs", async () => {
    mockedGetRunView.mockImplementation((sessionId) => {
      if (sessionId === "stuck-session") {
        return new Promise<AgentOrgRunView | null>(() => undefined);
      }
      return Promise.resolve(null);
    });

    const unsubscribeStuck = agentOrgRunViewPollingTestApi.subscribe(
      "stuck-session",
      () => undefined
    );
    const unsubscribeOther = agentOrgRunViewPollingTestApi.subscribe(
      "unrelated-session",
      () => undefined
    );
    expect(mockedGetRunView).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(mockedGetRunView).toHaveBeenCalledTimes(2));
    expect(mockedGetRunView).toHaveBeenLastCalledWith("unrelated-session");

    unsubscribeOther();
    unsubscribeStuck();
  });

  it("moves polling to another member when the current owner fails", async () => {
    mockedGetRunView
      .mockResolvedValueOnce(runView())
      .mockRejectedValueOnce(new Error("session disappeared"))
      .mockResolvedValue(runView());
    const unsubscribeRoot = agentOrgRunViewPollingTestApi.subscribe(
      "root-session",
      () => undefined
    );
    await vi.waitFor(() => expect(mockedGetRunView).toHaveBeenCalledTimes(1));
    const unsubscribeAlice = agentOrgRunViewPollingTestApi.subscribe(
      "alice-session",
      () => undefined
    );

    await agentOrgRunViewPollingTestApi.refresh("root-session");
    expect(mockedGetRunView).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(AGENT_ORG_RUN_VIEW_FALLBACK_MS);
    await vi.waitFor(() => expect(mockedGetRunView).toHaveBeenCalledTimes(3));
    expect(mockedGetRunView).toHaveBeenLastCalledWith("alice-session");

    unsubscribeAlice();
    unsubscribeRoot();
  });

  it("clears every cached member view when all live sessions return no run", async () => {
    mockedGetRunView.mockResolvedValueOnce(runView()).mockResolvedValue(null);
    const unsubscribeRoot = agentOrgRunViewPollingTestApi.subscribe(
      "root-session",
      () => undefined
    );
    await vi.waitFor(() => expect(mockedGetRunView).toHaveBeenCalledTimes(1));
    const unsubscribeAlice = agentOrgRunViewPollingTestApi.subscribe(
      "alice-session",
      () => undefined
    );

    await agentOrgRunViewPollingTestApi.refresh("root-session");
    await vi.waitFor(() => expect(mockedGetRunView).toHaveBeenCalledTimes(3));
    expect(
      agentOrgRunViewPollingTestApi.getSnapshot("root-session").view
    ).toBeNull();
    expect(
      agentOrgRunViewPollingTestApi.getSnapshot("alice-session").view
    ).toBeNull();

    unsubscribeAlice();
    unsubscribeRoot();
  });
});
