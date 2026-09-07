import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  QueuedConversationRecoveryBlockedError,
  QueuedConversationRecoveryPendingError,
} from "@src/engines/SessionCore/conversations/queuedConversationContract";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  CONVERSATION_TURN_ID_ARG,
  continueLocalConversation,
  continueLocalConversationAfterTimelineLoad,
  conversationExecutionParentId,
  loadLocalConversationExecutionTargets,
  localConversationRootForSession,
  parseConversationExecutionParentId,
  recoverLocalConversationTurn,
} from "./localConversationContinuation";

const mocks = vi.hoisted(() => ({
  getAgentSession: vi.fn(),
  cliStatus: vi.fn(),
  cliWaitForTurnTerminal: vi.fn(),
  turnIntentStatus: vi.fn(),
  invokeTauri: vi.fn(),
  create: vi.fn(),
  sendMessage: vi.fn(),
  appendEvents: vi.fn(),
  updateEvent: vi.fn(),
  setEvents: vi.fn(),
  mergeEvents: vi.fn(),
  setStreaming: vi.fn(),
  removeEvents: vi.fn(),
  removeSyntheticUserInputs: vi.fn(),
  getStoredEvents: vi.fn(),
  getLatestSnapshot: vi.fn(),
  subscribeSession: vi.fn(),
  loadEvents: vi.fn(),
  reconcileNative: vi.fn(),
  recoverNativeAfterMismatch: vi.fn(),
  materialize: vi.fn(),
  synchronize: vi.fn(),
  publishTurnIntentDispatch: vi.fn(),
  getTerminal: vi.fn(),
  markTerminal: vi.fn(),
  beginOptimistic: vi.fn(),
  failOptimistic: vi.fn(),
  storeGet: vi.fn(),
  storeSet: vi.fn(),
}));

vi.mock("@src/api/tauri/agent", () => ({ getSession: mocks.getAgentSession }));
vi.mock("@src/api/tauri/rpc", () => ({
  rpc: {
    cli: {
      status: mocks.cliStatus,
    },
    sessionCore: {
      turnIntents: {
        waitForTerminal: mocks.cliWaitForTurnTerminal,
        status: mocks.turnIntentStatus,
      },
    },
  },
}));
vi.mock("@src/util/platform/tauri/init", () => ({
  invokeTauri: mocks.invokeTauri,
}));
vi.mock("@src/engines/SessionCore/services/SessionService", () => ({
  SessionService: { create: mocks.create, sendMessage: mocks.sendMessage },
}));
vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    append: mocks.appendEvents,
    updateById: mocks.updateEvent,
    set: mocks.setEvents,
    mergeEvents: mocks.mergeEvents,
    setStreaming: mocks.setStreaming,
    removeByIdPrefix: mocks.removeEvents,
    removeSyntheticUserInputEvents: mocks.removeSyntheticUserInputs,
    getEvents: mocks.getStoredEvents,
    getLatestSessionSnapshot: mocks.getLatestSnapshot,
    subscribeSession: mocks.subscribeSession,
  },
}));
vi.mock("@src/engines/SessionCore/sync/authoritativeSessionEvents", () => ({
  loadAuthoritativeSessionEvents: mocks.loadEvents,
}));
vi.mock("@src/engines/SessionCore/sync/nativeTranscriptReconcile", () => ({
  reconcileNativeTranscript: mocks.reconcileNative,
  recoverNativeTranscriptAfterMismatch: mocks.recoverNativeAfterMismatch,
}));
vi.mock("./nativeConversationMaterializer", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./nativeConversationMaterializer")
  >()),
  materializeNativeConversation: mocks.materialize,
  synchronizeNativeConversation: mocks.synchronize,
}));
vi.mock("@src/engines/SessionCore/control/turnLifecycle", async () => {
  const { atom } = await import("jotai");
  return {
    beginTurnDispatch: vi.fn(() => 3),
    confirmTurnRunning: vi.fn(),
    getLastTurnTerminal: mocks.getTerminal,
    markTurnTerminal: mocks.markTerminal,
    toTurnTerminalStatus: (status: string) =>
      status === "failed" || status === "error" || status === "timeout"
        ? "failed"
        : status === "cancelled" || status === "abandoned"
          ? "cancelled"
          : "completed",
    turnLifecycleSignalAtom: atom(0),
  };
});
vi.mock("@src/engines/SessionCore/control/optimisticTurnStatus", () => ({
  beginOptimisticTurn: mocks.beginOptimistic,
  failOptimisticTurn: mocks.failOptimistic,
}));
vi.mock("@src/engines/SessionCore/control/turnIntentDispatchLifecycle", () => ({
  publishTurnIntentDispatch: mocks.publishTurnIntentDispatch,
}));
vi.mock("@src/util/core/state/instrumentedStore", () => ({
  getInstrumentedStore: () => ({
    get: mocks.storeGet,
    set: mocks.storeSet,
    sub: vi.fn(() => () => undefined),
  }),
}));

function event(
  id: string,
  source: SessionEvent["source"],
  text: string,
  options: { turnId?: string; sessionId?: string } = {}
): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId: options.sessionId ?? "root",
    createdAt: "2026-08-26T00:00:00.000Z",
    functionName: source === "user" ? "user_message" : "assistant",
    uiCanonical: source === "user" ? "user_message" : "agent_message",
    actionType: source === "user" ? "raw" : "assistant",
    args: options.turnId ? { [CONVERSATION_TURN_ID_ARG]: options.turnId } : {},
    result: { message: { content: text, role: source }, content: text },
    source,
    displayText: text,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    payloadRefs: [],
  } as SessionEvent;
}

function attemptTailEvent(
  kind: "assistant" | "thinking" | "tool" | "plan" | "failure",
  sessionId: string,
  turnId: string
): SessionEvent {
  const base = event(`${kind}-${turnId}`, "assistant", `${kind} side effect`, {
    sessionId,
    turnId,
  });
  switch (kind) {
    case "assistant":
      return base;
    case "thinking":
      return {
        ...base,
        functionName: "llm_thinking",
        uiCanonical: "thinking",
        actionType: "llm_thinking_delta",
        displayVariant: "thinking",
      };
    case "tool":
      return {
        ...base,
        functionName: "read_file",
        uiCanonical: "read_file",
        actionType: "tool_call",
        displayVariant: "tool_call",
        callId: `call-${turnId}`,
        args: { path: "/repo/README.md" },
        result: { status: "running", call_id: `call-${turnId}` },
      };
    case "plan":
      return {
        ...base,
        functionName: "plan_update",
        uiCanonical: "plan_update",
        actionType: "plan_update",
        displayVariant: "plan",
      };
    case "failure":
      return {
        ...base,
        functionName: "error",
        uiCanonical: "error",
        actionType: "error",
        displayStatus: "failed",
        displayVariant: "error",
        result: { error: "network connection failed", success: false },
      };
  }
}

const root = {
  authority: "org2-cloud",
  authorityScope: ["org-1"],
  conversationId: "root-1",
};
const target = {
  agentDefinitionId: "builtin:sde",
  accountId: "account-1",
  model: "model-1",
  workspaceRepoPath: "/repo",
};
const codexTarget = {
  cliAgentType: "codex",
  accountId: "account-1",
  model: "model-1",
  workspaceRepoPath: "/repo",
};

let childEvents: SessionEvent[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  // A blocked preparation never consumes queued one-shot transport mocks.
  // Do not let those implementations leak into the next test's send.
  mocks.sendMessage.mockReset();
  childEvents = [];
  mocks.invokeTauri.mockResolvedValue([]);
  mocks.create.mockResolvedValue({ sessionId: "agentsession-child" });
  mocks.loadEvents.mockImplementation(async () => ({
    events: childEvents,
    source: "native_store",
  }));
  mocks.reconcileNative.mockImplementation(async (sessionId: string) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return mocks
      .loadEvents(sessionId)
      .then((result: { events: SessionEvent[] }) => result.events);
  });
  mocks.recoverNativeAfterMismatch.mockImplementation(
    async (
      sessionId: string,
      initialEvents: SessionEvent[],
      isRecovered: (events: readonly SessionEvent[]) => boolean
    ) => {
      let events = initialEvents;
      for (let attempt = 0; attempt < 2 && !isRecovered(events); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        events = await mocks
          .loadEvents(sessionId)
          .then((result: { events: SessionEvent[] }) => result.events);
      }
      return events;
    }
  );
  mocks.materialize.mockImplementation(async ({ sessionId, timeline }) => {
    childEvents = (timeline as SessionEvent[]).map((item) => ({
      ...item,
      sessionId,
    }));
    return {
      events: childEvents,
      receipt: { nativeSessionId: sessionId, itemCount: childEvents.length },
    };
  });
  mocks.synchronize.mockImplementation(async ({ sessionId, timeline }) => {
    childEvents = (timeline as SessionEvent[]).map((item) => ({
      ...item,
      sessionId,
    }));
    return {
      events: childEvents,
      receipt: { nativeSessionId: sessionId, itemCount: childEvents.length },
    };
  });
  mocks.appendEvents.mockResolvedValue(undefined);
  mocks.updateEvent.mockResolvedValue(true);
  mocks.setEvents.mockResolvedValue(undefined);
  mocks.mergeEvents.mockResolvedValue(undefined);
  mocks.setStreaming.mockResolvedValue(undefined);
  mocks.removeEvents.mockResolvedValue(1);
  mocks.removeSyntheticUserInputs.mockResolvedValue(1);
  mocks.getStoredEvents.mockImplementation(async () => childEvents);
  mocks.getLatestSnapshot.mockReturnValue(null);
  mocks.subscribeSession.mockReturnValue(() => undefined);
  mocks.storeGet.mockReturnValue(null);
  mocks.sendMessage.mockImplementation(
    async ({ sessionId, content, turnIntentId }) => {
      childEvents = [
        ...childEvents,
        event(`user-${turnIntentId}`, "user", content, {
          sessionId,
          turnId: turnIntentId,
        }),
        event(`answer-${turnIntentId}`, "assistant", "native answer", {
          sessionId,
          turnId: turnIntentId,
        }),
      ];
    }
  );
  mocks.getTerminal.mockReturnValue({
    generation: 3,
    status: "completed",
    at: Date.now() + 1_000,
  });
  mocks.cliWaitForTurnTerminal.mockImplementation(
    async ({ sessionId, turnIntentId }) => ({
      sessionId,
      turnIntentId,
      status: "completed",
      updatedAt: "2026-08-29T00:01:00.000Z",
    })
  );
  mocks.turnIntentStatus.mockResolvedValue(null);
});

function mockCompatibleCliEpisode(
  sessionId: string,
  cliAgentType: "codex" | "claude_code",
  timeline: SessionEvent[]
): void {
  childEvents = timeline;
  mocks.invokeTauri.mockResolvedValue([
    { sessionId, updatedAt: "2026-08-26T01:00:00Z" },
  ]);
  mocks.cliStatus.mockResolvedValue({
    status: "completed",
    updatedAt: "2026-08-26T01:00:00Z",
    repoPath: "/repo",
    accountId: "account-1",
    model: "model-1",
    cliAgentType,
  });
}

describe("durable execution target hydration", () => {
  it("restores the newest hidden continuation child without an in-memory roster", async () => {
    const localRoot = {
      authority: "local-session",
      authorityScope: [],
      conversationId: "sdeagent-canonical-root",
    } as const;
    const parentSessionId = conversationExecutionParentId(localRoot);
    mocks.invokeTauri.mockImplementation(async (command, args) => {
      expect(command).toBe("es_get_child_sessions");
      expect(args).toEqual({ parentSessionId });
      return [
        {
          sessionId: "cliagent-latest-codex",
          updatedAt: "2026-09-05T09:00:00.000Z",
        },
      ];
    });
    mocks.getAgentSession.mockResolvedValue({
      agentDefinitionId: "builtin:sde",
      accountId: "sde-account",
      model: "sde-model",
      workspacePath: "/repo",
      updatedAt: "2026-09-05T08:00:00.000Z",
    });
    mocks.cliStatus.mockResolvedValue({
      cliAgentType: "codex",
      accountId: "codex-account",
      model: "gpt-5.6-sol",
      repoPath: "/repo",
      updatedAt: "2026-09-05T09:00:00.000Z",
    });

    await expect(
      loadLocalConversationExecutionTargets(localRoot)
    ).resolves.toEqual([
      {
        sessionId: "cliagent-latest-codex",
        updatedAt: "2026-09-05T09:00:00.000Z",
        target: {
          cliAgentType: "codex",
          accountId: "codex-account",
          model: "gpt-5.6-sol",
          workspaceRepoPath: "/repo",
        },
      },
      {
        sessionId: "sdeagent-canonical-root",
        updatedAt: "2026-09-05T08:00:00.000Z",
        target: {
          agentDefinitionId: "builtin:sde",
          accountId: "sde-account",
          model: "sde-model",
          workspaceRepoPath: "/repo",
        },
      },
    ]);
  });

  it("keeps earlier runtime pairs available after multiple provider switches", async () => {
    mocks.invokeTauri.mockResolvedValue([
      {
        sessionId: "cliagent-codex-return",
        updatedAt: "2026-09-05T11:00:00.000Z",
      },
      {
        sessionId: "cliagent-claude",
        updatedAt: "2026-09-05T10:00:00.000Z",
      },
      {
        sessionId: "cliagent-codex-first",
        updatedAt: "2026-09-05T09:00:00.000Z",
      },
    ]);
    mocks.cliStatus.mockImplementation(async ({ sessionId }) => ({
      cliAgentType: sessionId.includes("claude") ? "claude_code" : "codex",
      accountId: sessionId.includes("claude") ? "anthropic-1" : "openai-1",
      model: sessionId.includes("claude") ? "sonnet" : "gpt-5.6-sol",
      repoPath: "/repo",
      updatedAt:
        sessionId === "cliagent-codex-return"
          ? "2026-09-05T11:00:00.000Z"
          : sessionId === "cliagent-claude"
            ? "2026-09-05T10:00:00.000Z"
            : "2026-09-05T09:00:00.000Z",
    }));

    const executions = await loadLocalConversationExecutionTargets(root);

    expect(executions.map(({ sessionId }) => sessionId)).toEqual([
      "cliagent-codex-return",
      "cliagent-claude",
      "cliagent-codex-first",
    ]);
    expect(executions.map(({ target }) => target.cliAgentType)).toEqual([
      "codex",
      "claude_code",
      "codex",
    ]);
  });
});

describe("local native conversation continuation", () => {
  it("uses a provider-neutral, non-secret durable parent identity", () => {
    expect(conversationExecutionParentId(root)).toBe(
      '["org2-conversation",1,"org2-cloud",["org-1"],"root-1"]'
    );
  });

  it("round-trips the durable parent id and promotes runnable local roots", () => {
    const localRoot = localConversationRootForSession(
      "cliagent-local-claude",
      "claude_code"
    );
    expect(localRoot).toEqual({
      authority: "local-session",
      authorityScope: [],
      conversationId: "cliagent-local-claude",
    });
    expect(
      parseConversationExecutionParentId(
        conversationExecutionParentId(localRoot!)
      )
    ).toEqual(localRoot);
    expect(
      localConversationRootForSession("cliagent-cursor", "cursor_cli")
    ).toEqual({
      authority: "local-session",
      authorityScope: [],
      conversationId: "cliagent-cursor",
    });
    expect(
      localConversationRootForSession(
        "cliagent-lightweight-row",
        undefined,
        undefined
      )
    ).toEqual({
      authority: "local-session",
      authorityScope: [],
      conversationId: "cliagent-lightweight-row",
    });
    expect(
      localConversationRootForSession(
        "sdeagent-local-native",
        undefined,
        "builtin:sde"
      )
    ).toEqual({
      authority: "local-session",
      authorityScope: [],
      conversationId: "sdeagent-local-native",
    });
    expect(
      localConversationRootForSession(
        "sdeagent-read-only",
        undefined,
        undefined
      )
    ).toBeNull();
    expect(parseConversationExecutionParentId("not-json")).toBeNull();
  });

  it("keeps a failed user row when a fresh episode cannot load its timeline", async () => {
    const error = new Error("canonical timeline unavailable");

    await expect(
      continueLocalConversationAfterTimelineLoad({
        root,
        title: "Shared",
        loadTimeline: async () => {
          throw error;
        },
        displayText: "switch runtime now",
        target,
        turnIntentId: "turn-load-failure",
      })
    ).rejects.toThrow(error.message);

    expect(mocks.removeEvents).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.updateEvent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ displayStatus: "failed" }),
      "agentsession-child"
    );
    expect(mocks.markTerminal).toHaveBeenCalledWith(
      "agentsession-child",
      "failed",
      expect.any(Object)
    );
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("reveals the first imported execution before loading a large timeline", async () => {
    const order: string[] = [];
    mocks.create.mockImplementationOnce(async () => {
      order.push("created");
      return { sessionId: "agentsession-child" };
    });

    await continueLocalConversationAfterTimelineLoad({
      root: {
        authority: "imported-history",
        authorityScope: ["codex_app"],
        conversationId: "codexapp-source-1",
      },
      title: "Imported continuation",
      loadTimeline: async () => {
        order.push("timeline");
        return [event("u1", "user", "original question")];
      },
      displayText: "new request",
      target,
      turnIntentId: "turn-eager",
      onSessionPreparing: () => {
        order.push("visible");
      },
    });

    expect(order.slice(0, 3)).toEqual(["created", "visible", "timeline"]);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("keeps a materialized child recoverable when its runner receipt cannot persist", async () => {
    const timeline = [event("u1", "user", "original question")];
    const receiptFailure = new QueuedConversationRecoveryPendingError(
      "runner receipt unavailable"
    );

    await expect(
      continueLocalConversation({
        root,
        title: "Shared",
        timeline,
        displayText: "continue after receipt recovery",
        target,
        turnIntentId: "turn-runner-receipt",
        onSessionReady: () => {
          throw receiptFailure;
        },
      })
    ).rejects.toBe(receiptFailure);

    expect(mocks.materialize).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.updateEvent).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ displayStatus: "failed" }),
      "agentsession-child"
    );

    // A restarted queue discovers the already-materialized native child by
    // canonical parent and resumes the same turn instead of creating another.
    mocks.invokeTauri.mockResolvedValue([
      {
        sessionId: "agentsession-child",
        updatedAt: "2026-08-26T01:00:00.000Z",
      },
    ]);
    mocks.getAgentSession.mockResolvedValue({
      status: "completed",
      updatedAt: "2026-08-26T01:00:00.000Z",
      workspacePath: "/repo",
      accountId: "account-1",
      model: "model-1",
      agentDefinitionId: "builtin:sde",
    });

    await expect(
      continueLocalConversation({
        root,
        title: "Shared",
        timeline,
        displayText: "continue after receipt recovery",
        target,
        turnIntentId: "turn-runner-receipt",
      })
    ).resolves.toEqual(
      expect.objectContaining({ sessionId: "agentsession-child" })
    );

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.synchronize).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("surfaces accepted-turn receipt failures as recovery-pending", async () => {
    const persistError = new Error("queue store locked");

    await expect(
      continueLocalConversation({
        root,
        title: "Shared",
        timeline: [event("u1", "user", "original question")],
        displayText: "run exactly once",
        target,
        turnIntentId: "turn-accepted-receipt",
        onTurnAccepted: () => {
          throw persistError;
        },
      })
    ).rejects.toMatchObject({
      name: "QueuedConversationRecoveryPendingError",
      message: expect.stringContaining("queue store locked"),
    });

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.cliWaitForTurnTerminal).not.toHaveBeenCalled();
    expect(mocks.updateEvent).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ displayStatus: "failed" }),
      "agentsession-child"
    );
  });

  it("adopts a durable accepted runner through the shared turn-intent lifecycle", async () => {
    const history = [event("u1", "user", "original question")];
    const currentUser = event("canonical-current", "user", "continue", {
      turnId: "turn-recover-adopted",
    });
    childEvents = [
      ...history.map((item) => ({ ...item, sessionId: "agentsession-child" })),
      event("native-current", "user", "continue", {
        sessionId: "agentsession-child",
        turnId: "turn-recover-adopted",
      }),
      event("native-answer", "assistant", "recovered answer", {
        sessionId: "agentsession-child",
        turnId: "turn-recover-adopted",
      }),
    ];
    mocks.invokeTauri.mockResolvedValue([
      {
        sessionId: "agentsession-child",
        updatedAt: "2026-08-30T00:00:00.000Z",
      },
    ]);
    mocks.getAgentSession.mockResolvedValue({
      status: "completed",
      updatedAt: "2026-08-30T00:00:00.000Z",
      workspacePath: "/repo",
      accountId: "account-1",
      model: "model-1",
      agentDefinitionId: "builtin:sde",
    });
    mocks.turnIntentStatus.mockResolvedValue({
      sessionId: "agentsession-child",
      turnIntentId: "turn-recover-adopted",
      status: "completed",
      updatedAt: "2026-08-30T00:00:01.000Z",
    });

    const result = await recoverLocalConversationTurn({
      root,
      title: "Shared",
      timeline: [...history, currentUser],
      displayText: "continue",
      target,
      turnIntentId: "turn-recover-adopted",
      runnerSessionId: "agentsession-child",
    });

    expect(result).toMatchObject({
      sessionId: "agentsession-child",
      terminalStatus: "completed",
      agentTail: [expect.objectContaining({ id: "native-answer" })],
    });
    expect(mocks.publishTurnIntentDispatch).toHaveBeenCalledWith(
      "turn-recover-adopted",
      { sessionId: "agentsession-child", generation: 3 }
    );
    expect(mocks.beginOptimistic).toHaveBeenCalledWith(
      "agentsession-child",
      "dispatch"
    );
    expect(mocks.markTerminal).toHaveBeenCalledWith(
      "agentsession-child",
      "completed",
      { generation: 3 }
    );
    expect(mocks.reconcileNative).toHaveBeenCalledWith("agentsession-child", {
      preserveInterruptedSuffix: false,
    });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("restores provider acceptance before validating a restarted runner", async () => {
    mocks.turnIntentStatus.mockResolvedValue({
      sessionId: "agentsession-missing",
      turnIntentId: "turn-recover-receipt",
      status: "running",
      updatedAt: "2026-08-30T00:00:01.000Z",
    });
    // Candidate discovery no longer contains the accepted runner. Recovery is
    // blocked for inspection, but the durable backend receipt must still move
    // the frontend owner across the irreversible acceptance boundary first.
    mocks.invokeTauri.mockResolvedValue([]);
    const onBeforeTurnDispatch = vi.fn();
    const onTurnAccepted = vi.fn();

    await expect(
      recoverLocalConversationTurn({
        root,
        title: "Shared",
        timeline: [event("u1", "user", "original question")],
        displayText: "continue",
        target,
        turnIntentId: "turn-recover-receipt",
        runnerSessionId: "agentsession-missing",
        onBeforeTurnDispatch,
        onTurnAccepted,
      })
    ).rejects.toBeInstanceOf(QueuedConversationRecoveryBlockedError);

    expect(onTurnAccepted).toHaveBeenCalledOnce();
    expect(onTurnAccepted).toHaveBeenCalledWith("agentsession-missing");
    expect(onBeforeTurnDispatch).toHaveBeenCalledWith("agentsession-missing");
    expect(onBeforeTurnDispatch.mock.invocationCallOrder[0]).toBeLessThan(
      onTurnAccepted.mock.invocationCallOrder[0]!
    );
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("does not open a second source lifecycle when target launch fails", async () => {
    mocks.create.mockRejectedValueOnce(new Error("OAuth refresh rejected"));

    await expect(
      continueLocalConversationAfterTimelineLoad({
        root,
        title: "Shared",
        loadTimeline: async () => [
          event("u1", "user", "previous question"),
          event("a1", "assistant", "previous answer"),
        ],
        displayText: "switch to Claude",
        target,
        turnIntentId: "turn-launch-failure",
      })
    ).rejects.toThrow("OAuth refresh rejected");

    expect(mocks.removeEvents).not.toHaveBeenCalled();
    expect(mocks.updateEvent).not.toHaveBeenCalled();
    expect(mocks.markTerminal).not.toHaveBeenCalled();
    expect(mocks.materialize).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("materializes native history, then sends only the new request", async () => {
    mocks.storeGet.mockReturnValue("agentsession-child");
    const history = [
      event("u1", "user", "original question"),
      event("a1", "assistant", "original answer"),
    ];
    const queuedUser = event("queued-u2", "user", "new request", {
      turnId: "turn-1",
    });
    queuedUser.displayStatus = "pending";
    queuedUser.result = {
      ...queuedUser.result,
      turnIntentId: "turn-1",
      deliveryStatus: "pending",
    };
    const timeline = [...history, queuedUser];
    const agentContent =
      "<orgii_provider_context>internal</orgii_provider_context>\n\nnew request";
    const result = await continueLocalConversation({
      root,
      title: "Shared",
      timeline,
      displayText: "new request",
      agentContent,
      target,
      turnIntentId: "turn-1",
    });

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "",
        parentSessionId: conversationExecutionParentId(root),
      })
    );
    expect(mocks.materialize).toHaveBeenCalledWith({
      sessionId: "agentsession-child",
      timeline: history,
    });
    expect(mocks.setEvents).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: agentContent,
        displayText: "new request",
      })
    );
    expect(mocks.appendEvents).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          sessionId: "agentsession-child",
          source: "user",
          displayText: "new request",
          result: expect.objectContaining({
            syntheticUserInput: true,
            turnIntentId: "turn-1",
          }),
        }),
      ],
      "agentsession-child"
    );
    expect(result).toMatchObject({
      sessionId: "agentsession-child",
      agentTail: [expect.objectContaining({ displayText: "native answer" })],
    });
  });

  it("crosses the caller acceptance boundary immediately before provider dispatch", async () => {
    const order: string[] = [];
    mocks.sendMessage.mockImplementationOnce(async () => {
      order.push("provider");
      childEvents = [
        ...childEvents,
        event("user-boundary", "user", "continue", {
          sessionId: "agentsession-child",
          turnId: "turn-boundary",
        }),
        event("answer-boundary", "assistant", "done", {
          sessionId: "agentsession-child",
          turnId: "turn-boundary",
        }),
      ];
    });

    await continueLocalConversation({
      root,
      title: "Shared",
      timeline: [event("u1", "user", "original question")],
      displayText: "continue",
      target,
      turnIntentId: "turn-boundary",
      onBeforeTurnDispatch: () => {
        order.push("accepted");
      },
    });

    expect(order).toEqual(["accepted", "provider"]);
  });

  it("binds a created episode to the planning footer before materialization", async () => {
    const order: string[] = [];
    mocks.setEvents.mockImplementationOnce(async () => {
      order.push("projection");
    });
    mocks.beginOptimistic.mockImplementation(() => {
      order.push("optimistic");
    });
    mocks.appendEvents.mockImplementationOnce(async () => {
      order.push("user");
    });
    mocks.sendMessage.mockImplementationOnce(
      async ({ sessionId, displayText, turnIntentId }) => {
        order.push("send");
        childEvents = [
          ...childEvents,
          event(`user-${turnIntentId}`, "user", displayText, {
            sessionId,
            turnId: turnIntentId,
          }),
          event(`answer-${turnIntentId}`, "assistant", "native answer", {
            sessionId,
            turnId: turnIntentId,
          }),
        ];
      }
    );

    await continueLocalConversation({
      root,
      title: "Shared",
      timeline: [event("u1", "user", "original question")],
      displayText: "new request",
      target: {
        cliAgentType: "codex",
        accountId: "codex-account",
        model: "codex-model",
        workspaceRepoPath: "/repo",
      },
      turnIntentId: "turn-reveal-before-send",
      onSessionPreparing: () => {
        order.push("preparing");
      },
      onSessionReady: () => {
        order.push("ready");
      },
    });

    expect(order).toEqual([
      "optimistic",
      "user",
      "preparing",
      "optimistic",
      "projection",
      "ready",
      "send",
    ]);
  });

  it("leaves context recovery to the native runtime and waits for its accepted anchor", async () => {
    const timeline = [
      event("u1", "user", "canonical question"),
      event("a1", "assistant", "canonical answer"),
    ];
    const parentSessionId = conversationExecutionParentId(root);
    const children = [
      {
        sessionId: "cliagent-exhausted",
        updatedAt: "2026-08-29T00:00:00.000Z",
      },
    ];
    mocks.invokeTauri.mockImplementation(async (command, args) => {
      if (command === "es_get_child_sessions") {
        expect(args).toEqual({ parentSessionId });
        return children;
      }
      return true;
    });
    mocks.cliStatus.mockResolvedValue({
      status: "completed",
      updatedAt: "2026-08-29T00:00:00.000Z",
      cliAgentType: "codex",
      accountId: "codex-account",
      model: "codex-model",
      repoPath: "/repo",
    });
    mocks.loadEvents.mockResolvedValue({
      events: timeline,
      source: "native_store",
    });
    mocks.getTerminal.mockReturnValue({
      generation: 3,
      status: "failed",
      at: Date.now() + 1_000,
    });
    mocks.cliWaitForTurnTerminal.mockImplementation(
      async ({ sessionId, turnIntentId }) => ({
        sessionId,
        turnIntentId,
        status: "failed",
        updatedAt: "2026-08-29T00:03:00.000Z",
      })
    );
    mocks.sendMessage.mockResolvedValue(undefined);

    await expect(
      continueLocalConversation({
        root,
        title: "Canonical rollover",
        timeline,
        displayText: "retry me once",
        target: {
          cliAgentType: "codex",
          accountId: "codex-account",
          model: "codex-model",
          workspaceRepoPath: "/repo",
        },
        turnIntentId: "turn-context-rollover",
      })
    ).rejects.toBeInstanceOf(QueuedConversationRecoveryPendingError);

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "cliagent-exhausted",
        allowNativeContextRecovery: true,
      })
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.materialize).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each(["assistant", "thinking", "tool", "plan", "failure"] as const)(
    "does not rebuild a failed attempt after $kind output",
    async (kind) => {
      const timeline = [
        event("u1", "user", "canonical question"),
        event("a1", "assistant", "canonical answer"),
      ];
      mocks.invokeTauri.mockImplementation(async (command) =>
        command === "es_get_child_sessions"
          ? [
              {
                sessionId: "cliagent-partial",
                updatedAt: "2026-08-29T00:00:00.000Z",
              },
            ]
          : true
      );
      let statusReads = 0;
      mocks.cliStatus.mockImplementation(async () => {
        statusReads += 1;
        return statusReads === 1
          ? {
              status: "completed",
              updatedAt: "2026-08-29T00:00:00.000Z",
              cliAgentType: "codex",
              accountId: "codex-account",
              model: "codex-model",
              repoPath: "/repo",
            }
          : {
              status: "failed",
              updatedAt: "2026-08-29T00:01:00.000Z",
            };
      });
      mocks.loadEvents.mockImplementation(async () => ({
        events: childEvents.length > 0 ? childEvents : timeline,
        source: "native_store",
      }));
      mocks.getTerminal.mockReturnValue({
        generation: 3,
        status: "failed",
        at: Date.now() + 1_000,
      });
      mocks.cliWaitForTurnTerminal.mockImplementation(
        async ({ sessionId, turnIntentId }) => ({
          sessionId,
          turnIntentId,
          status: "failed",
          updatedAt: "2026-08-29T00:02:00.000Z",
        })
      );
      mocks.sendMessage.mockImplementationOnce(
        async ({ sessionId, displayText, turnIntentId }) => {
          childEvents = [
            ...timeline.map((item) => ({ ...item, sessionId })),
            event(`user-${turnIntentId}`, "user", displayText, {
              sessionId,
              turnId: turnIntentId,
            }),
            attemptTailEvent(kind, sessionId, turnIntentId),
          ];
        }
      );

      const result = await continueLocalConversation({
        root,
        title: "Unsafe rollover",
        timeline,
        displayText: "do not replay this",
        target: {
          cliAgentType: "codex",
          accountId: "codex-account",
          model: "codex-model",
          workspaceRepoPath: "/repo",
        },
        turnIntentId: `turn-partial-${kind}`,
      });

      expect(result).toMatchObject({
        sessionId: "cliagent-partial",
        terminalStatus: "failed",
        agentTail: [
          expect.objectContaining({
            displayText: `${kind} side effect`,
          }),
        ],
      });
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.materialize).not.toHaveBeenCalled();
      expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    }
  );

  it("anchors on EventStore identity when the native transcript cannot carry it", async () => {
    mocks.sendMessage.mockImplementationOnce(
      async ({ sessionId, displayText, turnIntentId }) => {
        const providerUser = event(
          `provider-user-${turnIntentId}`,
          "user",
          displayText,
          { sessionId }
        );
        childEvents = [
          ...childEvents,
          providerUser,
          event(
            `provider-answer-${turnIntentId}`,
            "assistant",
            "native answer",
            {
              sessionId,
            }
          ),
        ];
      }
    );
    mocks.getStoredEvents.mockImplementationOnce(async () =>
      childEvents.map((item) =>
        item.id === "provider-user-turn-result-anchor"
          ? {
              ...item,
              result: {
                ...item.result,
                turnIntentId: "turn-result-anchor",
              },
            }
          : item
      )
    );

    const result = await continueLocalConversation({
      root,
      title: "Shared",
      timeline: [event("u1", "user", "original question")],
      displayText: "new request",
      target,
      turnIntentId: "turn-result-anchor",
    });

    expect(result.agentTail).toEqual([
      expect.objectContaining({
        id: "provider-answer-turn-result-anchor",
        displayText: "native answer",
      }),
    ]);
  });

  it("anchors a provider-native suffix on the exact normalized agent payload", async () => {
    let nativeEvents: SessionEvent[] = [];
    const agentContent = "runtime bridge\r\n\r\nnew request";
    mocks.getLatestSnapshot.mockImplementation(() => ({
      // The rendered EventStore can remain on the pre-turn projection while
      // Codex/Claude have already flushed the completed native transcript.
      chatEvents: childEvents,
    }));
    mocks.sendMessage.mockImplementationOnce(async ({ sessionId, content }) => {
      nativeEvents = [
        ...childEvents,
        event("native-user", "user", content.replace(/\r\n?/g, "\n"), {
          sessionId,
        }),
        event("native-answer", "assistant", "native suffix answer", {
          sessionId,
        }),
      ];
    });
    mocks.loadEvents.mockImplementation(async () => ({
      events: nativeEvents.length > 0 ? nativeEvents : childEvents,
      source: "native_store",
    }));

    const result = await continueLocalConversation({
      root,
      title: "Shared",
      timeline: [event("u1", "user", "original question")],
      displayText: "new request",
      agentContent,
      target,
      turnIntentId: "turn-provider-native-suffix",
    });

    expect(result.agentTail).toEqual([
      expect.objectContaining({
        id: "native-answer",
        displayText: "native suffix answer",
      }),
    ]);
    expect(mocks.reconcileNative).toHaveBeenCalledWith("agentsession-child", {
      preserveInterruptedSuffix: false,
    });
    expect(mocks.recoverNativeAfterMismatch).not.toHaveBeenCalled();
    expect(mocks.loadEvents).toHaveBeenCalledTimes(1);
  });

  it("never treats a provider-added text prefix as the current user anchor", async () => {
    vi.useFakeTimers();
    try {
      let nativeEvents: SessionEvent[] = [];
      mocks.getLatestSnapshot.mockImplementation(() => ({
        chatEvents: childEvents,
      }));
      mocks.sendMessage.mockImplementationOnce(async ({ sessionId }) => {
        nativeEvents = [
          ...childEvents,
          event("wrong-native-user", "user", "provider prefix\n\nnew request", {
            sessionId,
          }),
          event("wrong-native-answer", "assistant", "must not be captured", {
            sessionId,
          }),
        ];
      });
      mocks.loadEvents.mockImplementation(async () => ({
        events: nativeEvents.length > 0 ? nativeEvents : childEvents,
        source: "native_store",
      }));

      const continuation = continueLocalConversation({
        root,
        title: "Shared",
        timeline: [event("u1", "user", "original question")],
        displayText: "new request",
        target,
        turnIntentId: "turn-exact-native-anchor",
      });
      const rejected = expect(continuation).rejects.toThrow(
        "missing its native transcript anchor"
      );
      // Let create/materialize/send reach the transcript-settle loop before
      // advancing its backoff timers.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (mocks.sendMessage.mock.calls.length > 0) break;
        await Promise.resolve();
      }
      expect(mocks.sendMessage).toHaveBeenCalledOnce();
      await vi.runAllTimersAsync();
      await rejected;
      expect(mocks.recoverNativeAfterMismatch).toHaveBeenCalledOnce();
      expect(mocks.mergeEvents).not.toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: "wrong-native-answer" }),
        ]),
        "agentsession-child"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses image identity rather than empty text as an image-only fallback", async () => {
    let nativeEvents: SessionEvent[] = [];
    const image = "data:image/png;base64,AAAA";
    mocks.getLatestSnapshot.mockImplementation(() => ({
      chatEvents: childEvents,
    }));
    mocks.sendMessage.mockImplementationOnce(async ({ sessionId }) => {
      const nativeUser = event("native-image-user", "user", "", { sessionId });
      nativeUser.result = { ...nativeUser.result, images: [image] };
      nativeEvents = [
        ...childEvents,
        nativeUser,
        event("native-image-answer", "assistant", "image answer", {
          sessionId,
        }),
      ];
    });
    mocks.loadEvents.mockImplementation(async () => ({
      events: nativeEvents.length > 0 ? nativeEvents : childEvents,
      source: "native_store",
    }));

    const result = await continueLocalConversation({
      root,
      title: "Shared",
      timeline: [event("u1", "user", "original question")],
      displayText: "",
      imageDataUrls: [image],
      target,
      turnIntentId: "turn-image-only-anchor",
    });

    expect(result.agentTail).toEqual([
      expect.objectContaining({ id: "native-image-answer" }),
    ]);
  });

  it("leaves fresh terminal ownership with the lifecycle coordinator", async () => {
    mocks.getTerminal.mockReturnValue(null);
    mocks.getAgentSession.mockResolvedValue({ status: "completed" });

    const result = await continueLocalConversation({
      root,
      title: "Durable terminal",
      timeline: [event("u1", "user", "original question")],
      displayText: "continue",
      target,
      turnIntentId: "turn-durable-terminal",
    });

    expect(result.terminalStatus).toBe("completed");
    expect(mocks.markTerminal).not.toHaveBeenCalled();
  });

  it("waits for an exact CLI turn in Rust when background timers are throttled", async () => {
    mocks.getTerminal.mockReturnValue(null);
    mocks.create.mockResolvedValue({ sessionId: "cliagent-hidden-child" });
    mocks.cliStatus.mockResolvedValue(null);

    const result = await continueLocalConversation({
      root,
      title: "Hidden CLI continuation",
      timeline: [event("u1", "user", "original question")],
      displayText: "continue in background",
      target: {
        cliAgentType: "codex",
        accountId: "codex-account",
        model: "gpt-5.6-sol",
        workspaceRepoPath: "/repo",
      },
      turnIntentId: "turn-hidden-cli",
    });

    expect(result.terminalStatus).toBe("completed");
    expect(mocks.cliWaitForTurnTerminal).toHaveBeenCalledWith({
      sessionId: "cliagent-hidden-child",
      turnIntentId: "turn-hidden-cli",
      timeoutMs: expect.any(Number),
    });
  });

  it("reopens the exact durable long poll while the turn intent is still running", async () => {
    mocks.getTerminal.mockReturnValue(null);
    mocks.cliWaitForTurnTerminal
      .mockRejectedValueOnce(new Error("bounded wait elapsed"))
      .mockResolvedValueOnce({
        sessionId: "agentsession-child",
        turnIntentId: "turn-native-backoff",
        status: "completed",
        updatedAt: "2026-08-29T00:02:00.000Z",
      });
    mocks.turnIntentStatus.mockResolvedValueOnce({
      sessionId: "agentsession-child",
      turnIntentId: "turn-native-backoff",
      status: "running",
      updatedAt: "2026-08-29T00:01:00.000Z",
    });

    await expect(
      continueLocalConversation({
        root,
        title: "Native agent continuation",
        timeline: [event("u1", "user", "original question")],
        displayText: "continue without hot polling",
        target,
        turnIntentId: "turn-native-backoff",
      })
    ).resolves.toMatchObject({ terminalStatus: "completed" });

    expect(mocks.cliWaitForTurnTerminal).toHaveBeenCalledTimes(2);
    expect(mocks.turnIntentStatus).toHaveBeenCalledOnce();
    expect(mocks.getAgentSession).not.toHaveBeenCalled();
  });

  it("does not let a replayed CLI terminal finish the next exact turn", async () => {
    mocks.create.mockResolvedValue({ sessionId: "cliagent-reused-terminal" });
    mocks.cliStatus.mockResolvedValue({
      status: "completed",
      updatedAt: "2026-08-29T00:02:00.000Z",
    });
    mocks.getTerminal.mockReturnValue({
      generation: 3,
      status: "completed",
      at: Date.now() + 10_000,
    });
    let resolveExactTurn!: (value: {
      sessionId: string;
      turnIntentId: string;
      status: string;
      updatedAt: string;
    }) => void;
    mocks.cliWaitForTurnTerminal.mockReturnValue(
      new Promise((resolve) => {
        resolveExactTurn = resolve;
      })
    );

    let settled = false;
    const pending = continueLocalConversation({
      root,
      title: "Ignore stale CLI terminal",
      timeline: [event("u1", "user", "original question")],
      displayText: "continue after the old terminal",
      target: {
        cliAgentType: "claude_code",
        accountId: "claude-account",
        model: "claude-opus-5",
        workspaceRepoPath: "/repo",
      },
      turnIntentId: "turn-after-replayed-terminal",
    });
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    await vi.waitFor(() =>
      expect(mocks.cliWaitForTurnTerminal).toHaveBeenCalled()
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    resolveExactTurn({
      sessionId: "cliagent-reused-terminal",
      turnIntentId: "turn-after-replayed-terminal",
      status: "completed",
      updatedAt: "2026-08-29T00:03:00.000Z",
    });
    await expect(pending).resolves.toMatchObject({
      terminalStatus: "completed",
    });
  });

  it("joins the single native transcript reconciler", async () => {
    mocks.getLatestSnapshot.mockImplementation(() => ({
      chatEvents: childEvents,
    }));

    const result = await continueLocalConversation({
      root,
      title: "Shared",
      timeline: [event("u1", "user", "original question")],
      displayText: "new request",
      target,
      turnIntentId: "turn-window-anchor",
    });

    expect(result.agentTail).toEqual([
      expect.objectContaining({ displayText: "native answer" }),
    ]);
    expect(mocks.reconcileNative).toHaveBeenCalledWith("agentsession-child", {
      preserveInterruptedSuffix: false,
    });
    expect(mocks.getLatestSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadEvents).toHaveBeenCalledTimes(1);
  });

  it("waits for the terminal assistant instead of publishing an empty tail", async () => {
    mocks.getLatestSnapshot.mockImplementation(() => ({
      chatEvents: childEvents,
    }));
    mocks.sendMessage.mockImplementationOnce(
      async ({ sessionId, displayText, turnIntentId }) => {
        childEvents = [
          ...childEvents,
          event(`user-${turnIntentId}`, "user", displayText, {
            sessionId,
            turnId: turnIntentId,
          }),
        ];
        setTimeout(() => {
          childEvents = [
            ...childEvents,
            event(`answer-${turnIntentId}`, "assistant", "late native answer", {
              sessionId,
              turnId: turnIntentId,
            }),
          ];
        }, 20);
      }
    );

    const result = await continueLocalConversation({
      root,
      title: "Shared",
      timeline: [event("u1", "user", "original question")],
      displayText: "new request",
      target,
      turnIntentId: "turn-late-tail",
    });

    expect(result.agentTail).toEqual([
      expect.objectContaining({ displayText: "late native answer" }),
    ]);
  });

  it("backs off full reads while a hidden native transcript settles", async () => {
    mocks.sendMessage.mockImplementationOnce(
      async ({ sessionId, displayText, turnIntentId }) => {
        childEvents = [
          ...childEvents,
          event(`user-${turnIntentId}`, "user", displayText, {
            sessionId,
            turnId: turnIntentId,
          }),
        ];
        setTimeout(() => {
          childEvents = [
            ...childEvents,
            event(`answer-${turnIntentId}`, "assistant", "late hidden answer", {
              sessionId,
              turnId: turnIntentId,
            }),
          ];
        }, 20);
      }
    );

    const result = await continueLocalConversation({
      root,
      title: "Hidden shared",
      timeline: [event("u1", "user", "original question")],
      displayText: "new hidden request",
      target,
      turnIntentId: "turn-hidden-late-tail",
    });

    expect(result.agentTail).toEqual([
      expect.objectContaining({ displayText: "late hidden answer" }),
    ]);
    expect(mocks.getStoredEvents.mock.calls.length).toBeLessThanOrEqual(3);
    expect(mocks.loadEvents.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("treats an explicitly cancelled user-only turn as a durable empty-tail boundary", async () => {
    mocks.getTerminal.mockReturnValue({
      generation: 3,
      status: "cancelled",
      at: Date.now() + 1_000,
    });
    mocks.cliWaitForTurnTerminal.mockResolvedValueOnce({
      sessionId: "agentsession-child",
      turnIntentId: "turn-user-only-cancelled",
      status: "cancelled",
      updatedAt: "2026-08-29T00:01:00.000Z",
    });
    mocks.sendMessage.mockImplementationOnce(
      async ({ sessionId, displayText, turnIntentId }) => {
        childEvents = [
          ...childEvents,
          event(`user-${turnIntentId}`, "user", displayText, {
            sessionId,
            turnId: turnIntentId,
          }),
        ];
      }
    );

    const result = await continueLocalConversation({
      root,
      title: "Interrupted",
      timeline: [event("u1", "user", "original question")],
      displayText: "start a long task",
      target,
      turnIntentId: "turn-user-only-cancelled",
    });

    expect(result).toMatchObject({
      terminalStatus: "cancelled",
      agentTail: [],
    });
    expect(mocks.markTerminal).not.toHaveBeenCalled();
  });

  it("keeps an interrupted turn recovery-pending until its native user anchor converges", async () => {
    mocks.getTerminal.mockReturnValue({
      generation: 3,
      status: "cancelled",
      at: Date.now() + 1_000,
    });
    mocks.cliWaitForTurnTerminal.mockResolvedValueOnce({
      sessionId: "agentsession-child",
      turnIntentId: "turn-cancelled-before-anchor",
      status: "cancelled",
      updatedAt: "2026-08-29T00:01:00.000Z",
    });
    // The provider accepted the send but its native transcript has not exposed
    // even the current user item yet. This is not the same as a user-only
    // interrupted turn, whose matching anchor makes resolveSettledTail return
    // a durable empty array.
    mocks.sendMessage.mockResolvedValueOnce(undefined);

    await expect(
      continueLocalConversation({
        root,
        title: "Interrupted before transcript flush",
        timeline: [event("u1", "user", "original question")],
        displayText: "start a long task",
        target,
        turnIntentId: "turn-cancelled-before-anchor",
      })
    ).rejects.toBeInstanceOf(QueuedConversationRecoveryPendingError);

    expect(mocks.markTerminal).not.toHaveBeenCalled();
  });

  it("settles an interrupted turn the provider closed before recording its prompt", async () => {
    mocks.getTerminal.mockReturnValue({
      generation: 3,
      status: "cancelled",
      at: Date.now() + 1_000,
    });
    mocks.cliWaitForTurnTerminal.mockResolvedValueOnce({
      sessionId: "agentsession-child",
      turnIntentId: "turn-cancelled-before-prompt",
      status: "cancelled",
      updatedAt: "2026-08-29T00:01:00.000Z",
    });
    // Stop reached Codex two seconds after task start: the rollout gained
    // `task_started` and `turn_aborted` but never the user message. No user
    // anchor can converge later, so this must not stay recovery-pending.
    mocks.sendMessage.mockImplementationOnce(async ({ sessionId }) => {
      const lifecycle = (id: string, actionType: string): SessionEvent =>
        ({
          ...event(id, "assistant", "", { sessionId }),
          functionName: actionType,
          uiCanonical: actionType,
          actionType,
          result: {},
          displayText: actionType,
        }) as SessionEvent;
      childEvents = [
        ...childEvents,
        lifecycle("lifecycle-start", "task_start"),
        lifecycle("lifecycle-aborted", "task_failed"),
      ];
    });

    const result = await continueLocalConversation({
      root,
      title: "Interrupted before prompt flush",
      timeline: [event("u1", "user", "original question")],
      displayText: "start a long task",
      target,
      turnIntentId: "turn-cancelled-before-prompt",
    });

    expect(result).toMatchObject({
      terminalStatus: "cancelled",
      agentTail: [],
    });
    expect(mocks.markTerminal).not.toHaveBeenCalled();
  });

  it("rebuilds a same-provider import from canonical events", async () => {
    const timeline = [event("u1", "user", "provider-owned history")];
    await continueLocalConversation({
      root: {
        authority: "imported-history",
        authorityScope: ["claude_code"],
        conversationId: "claudecodeapp-source",
      },
      title: "Claude source",
      timeline,
      displayText: "continue",
      target: {
        cliAgentType: "claude_code",
        accountId: "claude-local",
        model: "claude-opus-5",
        workspaceRepoPath: "/repo",
      },
      turnIntentId: "turn-adopt",
    });

    expect(mocks.materialize).toHaveBeenCalledWith({
      sessionId: "agentsession-child",
      timeline,
    });
  });

  it("rebuilds canonical events through the ambient local Claude CLI", async () => {
    const timeline = [event("u1", "user", "provider-owned history")];
    await continueLocalConversation({
      root: {
        authority: "imported-history",
        authorityScope: ["claude_code"],
        conversationId: "claudecodeapp-ambient",
      },
      title: "Claude source",
      timeline,
      displayText: "continue locally",
      target: {
        cliAgentType: "claude_code",
        workspaceRepoPath: "/repo",
      },
      turnIntentId: "turn-ambient",
    });

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        cliAgentType: "claude_code",
        accountId: undefined,
        model: undefined,
      })
    );
    expect(mocks.materialize).toHaveBeenCalledWith({
      sessionId: "agentsession-child",
      timeline,
    });
    // A hidden/background continuation must not replace the visible Session's
    // pending optimistic row. Only a foreground preparation may bridge the
    // rescue slot across a Session switch.
    expect(
      mocks.storeSet.mock.calls.some(
        ([, value]) =>
          value &&
          typeof value === "object" &&
          "displayText" in (value as Record<string, unknown>)
      )
    ).toBe(false);
  });

  it("resumes an exact native transcript without rematerializing it", async () => {
    const timeline = [event("u1", "user", "same native history")];
    childEvents = timeline.map((item) => ({
      ...item,
      sessionId: "agentsession-existing",
    }));
    mocks.invokeTauri.mockResolvedValue([
      {
        sessionId: "agentsession-existing",
        updatedAt: "2026-08-26T01:00:00.000Z",
      },
    ]);
    mocks.getAgentSession.mockResolvedValue({
      status: "completed",
      updatedAt: "2026-08-26T01:00:00.000Z",
      workspacePath: "/repo",
      accountId: "account-1",
      model: "model-1",
      agentDefinitionId: "builtin:sde",
    });

    await continueLocalConversation({
      root,
      title: "Shared",
      timeline,
      displayText: "resume natively",
      target,
      turnIntentId: "turn-2",
    });

    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.materialize).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "resume natively" })
    );
    // Preparation appends immediately; dispatch idempotently restores the
    // exact same event id in case native synchronization replaced projection.
    expect(mocks.appendEvents).toHaveBeenCalledTimes(2);
    expect(mocks.appendEvents).toHaveBeenNthCalledWith(
      1,
      [expect.objectContaining({ sessionId: "agentsession-existing" })],
      "agentsession-existing"
    );
    expect(mocks.appendEvents).toHaveBeenNthCalledWith(
      2,
      [expect.objectContaining({ sessionId: "agentsession-existing" })],
      "agentsession-existing"
    );
  });

  it("shows the ordinary optimistic turn before synchronizing a reused episode", async () => {
    const order: string[] = [];
    const timeline = [event("u1", "user", "same native history")];
    childEvents = timeline.map((item) => ({
      ...item,
      sessionId: "agentsession-existing",
    }));
    mocks.invokeTauri.mockResolvedValue([
      {
        sessionId: "agentsession-existing",
        updatedAt: "2026-08-26T01:00:00.000Z",
      },
    ]);
    mocks.getAgentSession.mockResolvedValue({
      status: "completed",
      updatedAt: "2026-08-26T01:00:00.000Z",
      workspacePath: "/repo",
      accountId: "account-1",
      model: "model-1",
      agentDefinitionId: "builtin:sde",
    });
    mocks.beginOptimistic.mockImplementation(() => {
      order.push("optimistic");
    });
    mocks.appendEvents.mockImplementationOnce(async () => {
      order.push("user");
    });
    mocks.synchronize.mockImplementationOnce(async () => {
      order.push("synchronize");
      return {
        events: childEvents,
        receipt: {
          nativeSessionId: "agentsession-existing",
          itemCount: childEvents.length,
        },
      };
    });
    mocks.sendMessage.mockImplementationOnce(
      async ({ sessionId, displayText, turnIntentId }) => {
        order.push("send");
        childEvents = [
          ...childEvents,
          event(`user-${turnIntentId}`, "user", displayText, {
            sessionId,
            turnId: turnIntentId,
          }),
          event(`answer-${turnIntentId}`, "assistant", "native answer", {
            sessionId,
            turnId: turnIntentId,
          }),
        ];
      }
    );

    await continueLocalConversation({
      root,
      title: "Shared",
      timeline,
      displayText: "resume after a large delta",
      target,
      turnIntentId: "turn-visible-before-sync",
      onSessionPreparing: () => {
        order.push("preparing");
      },
      onSessionReady: () => {
        order.push("ready");
      },
    });

    expect(order).toEqual([
      "optimistic",
      "user",
      "preparing",
      "optimistic",
      "synchronize",
      "ready",
      "send",
    ]);
  });

  it("keeps one failed user row when reused-episode synchronization fails", async () => {
    const timeline = [event("u1", "user", "same native history")];
    childEvents = timeline.map((item) => ({
      ...item,
      sessionId: "agentsession-existing",
    }));
    mocks.invokeTauri.mockResolvedValue([
      {
        sessionId: "agentsession-existing",
        updatedAt: "2026-08-26T01:00:00.000Z",
      },
    ]);
    mocks.getAgentSession.mockResolvedValue({
      status: "completed",
      updatedAt: "2026-08-26T01:00:00.000Z",
      workspacePath: "/repo",
      accountId: "account-1",
      model: "model-1",
      agentDefinitionId: "builtin:sde",
    });
    mocks.synchronize.mockRejectedValueOnce(
      new Error("native transcript synchronization failed")
    );

    await expect(
      continueLocalConversation({
        root,
        title: "Shared",
        timeline,
        displayText: "resume after a large delta",
        target,
        turnIntentId: "turn-sync-failed",
      })
    ).rejects.toThrow("native transcript synchronization failed");

    const optimisticUserEvent = mocks.appendEvents.mock.calls[0]?.[0]?.[0];
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.failOptimistic).toHaveBeenCalledOnce();
    expect(mocks.markTerminal).toHaveBeenCalledOnce();
    expect(mocks.updateEvent).toHaveBeenCalledWith(
      optimisticUserEvent.id,
      expect.objectContaining({ displayStatus: "failed" }),
      "agentsession-existing"
    );
  });

  it("keeps one native episode when only the per-turn model changes", async () => {
    const timeline = [event("u1", "user", "same native history")];
    childEvents = timeline.map((item) => ({
      ...item,
      sessionId: "agentsession-existing",
    }));
    mocks.invokeTauri.mockResolvedValue([
      {
        sessionId: "agentsession-existing",
        updatedAt: "2026-08-26T01:00:00.000Z",
      },
    ]);
    mocks.getAgentSession.mockResolvedValue({
      status: "completed",
      updatedAt: "2026-08-26T01:00:00.000Z",
      workspacePath: "/repo",
      accountId: "account-1",
      model: "model-before-switch",
      agentDefinitionId: "builtin:sde",
    });

    const result = await continueLocalConversation({
      root,
      title: "Shared",
      timeline,
      displayText: "continue with another model",
      target: { ...target, model: "model-after-switch" },
      turnIntentId: "turn-model-switch",
    });

    expect(result).toMatchObject({
      sessionId: "agentsession-existing",
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agentsession-existing",
        model: "model-after-switch",
      })
    );
  });

  it("reuses one episode across the macOS /tmp filesystem alias", async () => {
    const timeline = [event("u1", "user", "same native history")];
    childEvents = timeline.map((item) => ({
      ...item,
      sessionId: "agentsession-existing",
    }));
    mocks.invokeTauri.mockResolvedValue([
      {
        sessionId: "agentsession-existing",
        updatedAt: "2026-08-26T01:00:00.000Z",
      },
    ]);
    mocks.getAgentSession.mockResolvedValue({
      status: "completed",
      updatedAt: "2026-08-26T01:00:00.000Z",
      workspacePath: "/private/tmp/orgii-e2e-workspace-repo",
      accountId: "account-1",
      model: "model-1",
      agentDefinitionId: "builtin:sde",
    });

    const result = await continueLocalConversation({
      root,
      title: "Shared",
      timeline,
      displayText: "continue in the same workspace",
      target: {
        ...target,
        workspaceRepoPath: "/tmp/orgii-e2e-workspace-repo",
      },
      turnIntentId: "turn-path-alias",
    });

    expect(result).toMatchObject({
      sessionId: "agentsession-existing",
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("inherits an existing episode workspace while automatic resolution is pending", async () => {
    const timeline = [event("u1", "user", "same native history")];
    childEvents = timeline.map((item) => ({
      ...item,
      sessionId: "agentsession-existing",
    }));
    mocks.invokeTauri.mockResolvedValue([
      {
        sessionId: "agentsession-existing",
        updatedAt: "2026-08-26T01:00:00.000Z",
      },
    ]);
    mocks.getAgentSession.mockResolvedValue({
      status: "completed",
      updatedAt: "2026-08-26T01:00:00.000Z",
      workspacePath: "/local/checkout",
      accountId: "account-1",
      model: "model-1",
      agentDefinitionId: "builtin:sde",
    });

    const result = await continueLocalConversation({
      root,
      title: "Shared",
      timeline,
      displayText: "continue before workspace hydration finishes",
      target: { ...target, workspaceRepoPath: null },
      turnIntentId: "turn-auto-workspace",
    });

    expect(result).toMatchObject({
      sessionId: "agentsession-existing",
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("does not replace unique native history when shared history diverged", async () => {
    childEvents = [
      event("old", "user", "old", { sessionId: "agentsession-old" }),
    ];
    mocks.invokeTauri.mockResolvedValue([
      { sessionId: "agentsession-old", updatedAt: "2026-08-26T01:00:00Z" },
    ]);
    mocks.getAgentSession.mockResolvedValue({
      status: "completed",
      updatedAt: "2026-08-26T01:00:00Z",
      workspacePath: "/repo",
      accountId: "account-1",
      model: "model-1",
      agentDefinitionId: "builtin:sde",
    });
    const timeline = [event("new", "user", "teammate added context")];

    await expect(
      continueLocalConversation({
        root,
        title: "Shared",
        timeline,
        displayText: "continue",
        target,
        turnIntentId: "turn-3",
      })
    ).rejects.toBeInstanceOf(QueuedConversationRecoveryBlockedError);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.materialize).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("appends canonical role history natively before resuming one episode", async () => {
    const existing = event("u1", "user", "existing", {
      sessionId: "cliagent-existing",
    });
    childEvents = [existing];
    mocks.invokeTauri.mockResolvedValue([
      {
        sessionId: "cliagent-existing",
        updatedAt: "2026-08-26T01:00:00Z",
      },
    ]);
    mocks.cliStatus.mockResolvedValue({
      status: "completed",
      updatedAt: "2026-08-26T01:00:00Z",
      repoPath: "/repo",
      accountId: "account-1",
      model: "model-1",
      cliAgentType: "codex",
    });
    const timeline = [existing, event("a1", "assistant", "remote answer")];

    await continueLocalConversation({
      root,
      title: "Shared",
      timeline,
      displayText: "continue after remote turn",
      target: {
        cliAgentType: "codex",
        accountId: "account-1",
        model: "model-1",
        workspaceRepoPath: "/repo",
      },
      turnIntentId: "turn-native-delta",
    });

    expect(mocks.synchronize).toHaveBeenCalledWith({
      sessionId: "cliagent-existing",
      timeline,
    });
    expect(mocks.mergeEvents).toHaveBeenCalledWith(
      [expect.objectContaining({ displayText: "remote answer" })],
      "cliagent-existing"
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("fails closed when native resume fails", async () => {
    const timeline = [event("u1", "user", "same native history")];
    childEvents = timeline;
    mocks.invokeTauri.mockResolvedValue([
      { sessionId: "agentsession-existing", updatedAt: "2026-08-26T01:00:00Z" },
    ]);
    mocks.getAgentSession.mockResolvedValue({
      status: "completed",
      updatedAt: "2026-08-26T01:00:00Z",
      workspacePath: "/repo",
      accountId: "account-1",
      model: "model-1",
      agentDefinitionId: "builtin:sde",
    });
    mocks.sendMessage.mockRejectedValueOnce(new Error("native id vanished"));

    await expect(
      continueLocalConversation({
        root,
        title: "Shared",
        timeline,
        displayText: "continue",
        target,
        turnIntentId: "turn-4",
      })
    ).rejects.toThrow("native id vanished");
    expect(mocks.create).not.toHaveBeenCalled();
    const failedUserEvent = mocks.appendEvents.mock.calls.at(-1)?.[0]?.[0];
    expect(mocks.removeEvents).not.toHaveBeenCalled();
    expect(mocks.updateEvent).toHaveBeenCalledWith(
      failedUserEvent.id,
      expect.objectContaining({ displayStatus: "failed" }),
      "agentsession-existing"
    );
  });

  it("rebuilds a busy Codex native episode and retries the same turn once", async () => {
    const existingSessionId = "cliagent-codex-owned-by-app";
    const initialTimeline = [
      event("u1", "user", "inspect the repository", {
        sessionId: existingSessionId,
      }),
    ];
    const refreshedTimeline = [
      ...initialTimeline,
      event("a1", "assistant", "I inspected it", {
        sessionId: existingSessionId,
      }),
    ];
    mockCompatibleCliEpisode(existingSessionId, "codex", initialTimeline);
    const loadTimeline = vi
      .fn()
      .mockResolvedValueOnce(initialTimeline)
      .mockResolvedValueOnce(refreshedTimeline);
    mocks.sendMessage.mockRejectedValueOnce(
      new Error(
        "JSON-RPC -32600 thread/resume failed: thread already has an active writer"
      )
    );
    const preparing: string[] = [];
    const ready: string[] = [];
    const beforeDispatch: string[] = [];

    const result = await continueLocalConversationAfterTimelineLoad({
      root,
      title: "Shared",
      loadTimeline,
      displayText: "continue without duplicating my message",
      target: codexTarget,
      turnIntentId: "turn-active-writer",
      onSessionPreparing: (sessionId) => {
        preparing.push(sessionId);
      },
      onSessionReady: (sessionId) => {
        ready.push(sessionId);
      },
      onBeforeTurnDispatch: (sessionId) => {
        beforeDispatch.push(sessionId);
      },
    });

    expect(result).toMatchObject({ sessionId: "agentsession-child" });
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(mocks.sendMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: existingSessionId,
        content: "continue without duplicating my message",
        turnIntentId: "turn-active-writer",
        clientMessageId: "conversation-turn:turn-active-writer",
      })
    );
    expect(mocks.sendMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: "agentsession-child",
        content: "continue without duplicating my message",
        turnIntentId: "turn-active-writer",
        clientMessageId: "conversation-turn:turn-active-writer",
      })
    );
    expect(mocks.removeSyntheticUserInputs).toHaveBeenCalledOnce();
    expect(mocks.removeSyntheticUserInputs).toHaveBeenCalledWith(
      existingSessionId,
      {
        matchingContents: [],
        matchingTurnIntentIds: ["turn-active-writer"],
      }
    );
    expect(mocks.materialize).toHaveBeenCalledOnce();
    expect(mocks.materialize).toHaveBeenCalledWith({
      sessionId: "agentsession-child",
      timeline: refreshedTimeline,
    });
    expect(loadTimeline).toHaveBeenCalledTimes(2);
    expect(preparing).toEqual([existingSessionId, "agentsession-child"]);
    expect(ready).toEqual([existingSessionId, "agentsession-child"]);
    expect(beforeDispatch).toEqual([existingSessionId, "agentsession-child"]);
  });

  it.each([
    "native=293 canonical=292 (provider transcript is longer than the canonical conversation)",
    "native=292 canonical=293 (assistant output differs)",
  ])(
    "retains a failed intent instead of silently rebuilding divergent history: %s",
    async (mismatch) => {
      const existingSessionId = "cliagent-codex-diverged";
      const timeline = [
        event("u1", "user", "inspect the repository", {
          sessionId: existingSessionId,
        }),
      ];
      mockCompatibleCliEpisode(existingSessionId, "codex", timeline);
      mocks.synchronize.mockRejectedValueOnce(
        new Error(
          `provider-native transcript is not a semantic prefix of the canonical conversation: ${mismatch}`
        )
      );

      await expect(
        continueLocalConversationAfterTimelineLoad({
          root,
          title: "Shared",
          loadTimeline: async () => timeline,
          displayText: "continue after the plane lost a row",
          target: codexTarget,
          turnIntentId: "turn-diverged",
        })
      ).rejects.toThrow("is not a semantic prefix");

      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.materialize).not.toHaveBeenCalled();
      expect(mocks.sendMessage).not.toHaveBeenCalled();
      expect(mocks.removeSyntheticUserInputs).not.toHaveBeenCalled();
      expect(mocks.failOptimistic).toHaveBeenCalled();
    }
  );

  it("does not retry a rebuilt Codex episode more than once", async () => {
    const existingSessionId = "cliagent-codex-owned-by-app";
    const timeline = [
      event("u1", "user", "same native history", {
        sessionId: existingSessionId,
      }),
    ];
    mockCompatibleCliEpisode(existingSessionId, "codex", timeline);
    mocks.sendMessage.mockRejectedValue(
      new Error(
        "JSON-RPC -32600 thread/resume failed: thread already has an active writer"
      )
    );

    await expect(
      continueLocalConversation({
        root,
        title: "Shared",
        timeline,
        displayText: "retry exactly once",
        target: codexTarget,
        turnIntentId: "turn-active-writer-bounded",
      })
    ).rejects.toThrow("already has an active writer");

    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.materialize).toHaveBeenCalledOnce();
    expect(mocks.removeSyntheticUserInputs).toHaveBeenCalledOnce();
  });

  it("does not treat another runtime's active-writer text as a Codex lock", async () => {
    const existingSessionId = "cliagent-claude-existing";
    const timeline = [
      event("u1", "user", "same native history", {
        sessionId: existingSessionId,
      }),
    ];
    mockCompatibleCliEpisode(existingSessionId, "claude_code", timeline);
    mocks.sendMessage.mockRejectedValueOnce(
      new Error(
        "JSON-RPC -32600 thread/resume failed: thread already has an active writer"
      )
    );

    await expect(
      continueLocalConversation({
        root,
        title: "Shared",
        timeline,
        displayText: "do not rebuild Claude",
        target: {
          cliAgentType: "claude_code",
          accountId: "account-1",
          model: "model-1",
          workspaceRepoPath: "/repo",
        },
        turnIntentId: "turn-claude-active-writer-text",
      })
    ).rejects.toThrow("already has an active writer");

    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.materialize).not.toHaveBeenCalled();
    expect(mocks.removeSyntheticUserInputs).not.toHaveBeenCalled();
  });

  it("reuses an earlier direct Codex child after a direct Claude child becomes the frontier", async () => {
    const localRoot = {
      authority: "local-session",
      authorityScope: [],
      conversationId: "sdeagent-canonical-root",
    } as const;
    const parentSessionId = conversationExecutionParentId(localRoot);
    const codexSessionId = "cliagent-earlier-codex-child";
    const claudeSessionId = "cliagent-latest-claude-child";
    const canonical = [
      event("codex-u1", "user", "start in Codex", {
        sessionId: codexSessionId,
      }),
      event("codex-a1", "assistant", "Codex answer", {
        sessionId: codexSessionId,
      }),
      event("claude-u2", "user", "continue in Claude", {
        sessionId: claudeSessionId,
      }),
      event("claude-a2", "assistant", "Claude answer", {
        sessionId: claudeSessionId,
      }),
    ];
    mocks.invokeTauri.mockImplementation(async (command, args) => {
      expect(command).toBe("es_get_child_sessions");
      expect(args).toEqual({ parentSessionId });
      return [
        {
          sessionId: claudeSessionId,
          updatedAt: "2026-09-05T08:40:00.000Z",
        },
        {
          sessionId: codexSessionId,
          updatedAt: "2026-09-05T08:00:00.000Z",
        },
      ];
    });
    mocks.getAgentSession.mockResolvedValue({
      status: "completed",
      updatedAt: "2026-09-05T07:00:00.000Z",
      agentDefinitionId: "builtin:sde",
      accountId: "codex-account",
      model: "codex-model",
      workspacePath: "/repo",
    });
    mocks.cliStatus.mockImplementation(async ({ sessionId }) => ({
      status: "completed",
      updatedAt:
        sessionId === claudeSessionId
          ? "2026-09-05T08:40:00.000Z"
          : "2026-09-05T08:00:00.000Z",
      cliAgentType: sessionId === claudeSessionId ? "claude_code" : "codex",
      accountId:
        sessionId === claudeSessionId ? "claude-account" : "codex-account",
      model: sessionId === claudeSessionId ? "claude-model" : "codex-model",
      repoPath: "/repo",
    }));
    let codexEvents = canonical.slice(0, 2);
    mocks.loadEvents.mockImplementation(async (sessionId) => ({
      events: sessionId === codexSessionId ? codexEvents : [],
      source: "native_store",
    }));
    mocks.synchronize.mockImplementation(async ({ sessionId, timeline }) => {
      codexEvents = (timeline as SessionEvent[]).map((item) => ({
        ...item,
        sessionId,
      }));
      return {
        events: codexEvents,
        receipt: { nativeSessionId: sessionId, itemCount: codexEvents.length },
      };
    });
    mocks.sendMessage.mockImplementationOnce(
      async ({ sessionId, content, turnIntentId }) => {
        codexEvents = [
          ...codexEvents,
          event(`user-${turnIntentId}`, "user", content, {
            sessionId,
            turnId: turnIntentId,
          }),
          event(`answer-${turnIntentId}`, "assistant", "native answer", {
            sessionId,
            turnId: turnIntentId,
          }),
        ];
      }
    );

    const result = await continueLocalConversationAfterTimelineLoad({
      root: localRoot,
      title: "Runtime round trip",
      loadTimeline: async () => canonical,
      displayText: "return to Codex",
      target: {
        cliAgentType: "codex",
        accountId: "codex-account",
        model: "codex-model",
        workspaceRepoPath: "/repo",
      },
      turnIntentId: "codex-return",
    });

    expect(result).toMatchObject({ sessionId: codexSessionId });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.materialize).not.toHaveBeenCalled();
    expect(mocks.synchronize).toHaveBeenCalledWith({
      sessionId: codexSessionId,
      timeline: canonical,
    });
    expect(mocks.cliStatus).toHaveBeenCalledWith({
      sessionId: claudeSessionId,
    });
    expect(mocks.cliStatus).toHaveBeenCalledWith({ sessionId: codexSessionId });
    expect(mocks.loadEvents).toHaveBeenCalledWith(codexSessionId);
    expect(mocks.loadEvents).not.toHaveBeenCalledWith(claudeSessionId);
  });

  it("reuses an earlier Codex child whose native tool call ids were rewritten", async () => {
    const localRoot = {
      authority: "local-session",
      authorityScope: [],
      conversationId: "sdeagent-canonical-root",
    } as const;
    const parentSessionId = conversationExecutionParentId(localRoot);
    const codexSessionId = "cliagent-earlier-codex-child";
    const claudeSessionId = "cliagent-latest-claude-child";
    const toolEvent = (callId: string, sessionId: string): SessionEvent =>
      ({
        ...event("codex-t1", "assistant", "read README", { sessionId }),
        functionName: "read_file",
        uiCanonical: "read_file",
        actionType: "tool_call",
        displayVariant: "tool_call",
        callId,
        args: { path: "/repo/README.md" },
        result: { status: "completed", call_id: callId, output: "# ORG2" },
      }) as SessionEvent;
    const canonical = [
      event("codex-u1", "user", "start in Codex", {
        sessionId: codexSessionId,
      }),
      toolEvent("sdeagent-canonical-root:tool:1", codexSessionId),
      event("codex-a1", "assistant", "Codex answer", {
        sessionId: codexSessionId,
      }),
      event("claude-u2", "user", "continue in Claude", {
        sessionId: claudeSessionId,
      }),
      event("claude-a2", "assistant", "Claude answer", {
        sessionId: claudeSessionId,
      }),
    ];
    let codexEvents: SessionEvent[] = [
      canonical[0],
      toolEvent("call_9d1f4e0c6b7a4c0e8a3f2b1d5e6f7a80", codexSessionId),
      canonical[2],
    ];
    mocks.invokeTauri.mockImplementation(async (command, args) => {
      expect(command).toBe("es_get_child_sessions");
      expect(args).toEqual({ parentSessionId });
      return [
        {
          sessionId: claudeSessionId,
          updatedAt: "2026-09-05T08:40:00.000Z",
        },
        {
          sessionId: codexSessionId,
          updatedAt: "2026-09-05T08:00:00.000Z",
        },
      ];
    });
    mocks.getAgentSession.mockResolvedValue({
      status: "completed",
      updatedAt: "2026-09-05T07:00:00.000Z",
      agentDefinitionId: "builtin:sde",
      accountId: "codex-account",
      model: "codex-model",
      workspacePath: "/repo",
    });
    mocks.cliStatus.mockImplementation(async ({ sessionId }) => ({
      status: "completed",
      updatedAt:
        sessionId === claudeSessionId
          ? "2026-09-05T08:40:00.000Z"
          : "2026-09-05T08:00:00.000Z",
      cliAgentType: sessionId === claudeSessionId ? "claude_code" : "codex",
      accountId:
        sessionId === claudeSessionId ? "claude-account" : "codex-account",
      model: sessionId === claudeSessionId ? "claude-model" : "codex-model",
      repoPath: "/repo",
    }));
    mocks.loadEvents.mockImplementation(async (sessionId) => ({
      events: sessionId === codexSessionId ? codexEvents : [],
      source: "native_store",
    }));
    mocks.synchronize.mockImplementation(async ({ sessionId, timeline }) => {
      codexEvents = (timeline as SessionEvent[]).map((item) => ({
        ...item,
        sessionId,
      }));
      return {
        events: codexEvents,
        receipt: { nativeSessionId: sessionId, itemCount: codexEvents.length },
      };
    });
    mocks.sendMessage.mockImplementationOnce(
      async ({ sessionId, content, turnIntentId }) => {
        codexEvents = [
          ...codexEvents,
          event(`user-${turnIntentId}`, "user", content, {
            sessionId,
            turnId: turnIntentId,
          }),
          event(`answer-${turnIntentId}`, "assistant", "native answer", {
            sessionId,
            turnId: turnIntentId,
          }),
        ];
      }
    );

    const result = await continueLocalConversationAfterTimelineLoad({
      root: localRoot,
      title: "Runtime round trip with rewritten call ids",
      loadTimeline: async () => canonical,
      displayText: "return to Codex",
      target: {
        cliAgentType: "codex",
        accountId: "codex-account",
        model: "codex-model",
        workspaceRepoPath: "/repo",
      },
      turnIntentId: "codex-return-rewritten",
    });

    expect(result).toMatchObject({ sessionId: codexSessionId });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.materialize).not.toHaveBeenCalled();
  });

  it("does not bypass unpublished native history by selecting an older UUID on Retry", async () => {
    const canonical = [
      event("u1", "user", "first question"),
      event("a1", "assistant", "first answer"),
      event("u2", "user", "second question"),
      event("a2", "assistant", "second answer"),
    ];
    const eventsBySession = new Map<string, SessionEvent[]>([
      [
        "agentsession-future",
        [
          ...canonical,
          event("future", "assistant", "not in canonical history", {
            sessionId: "agentsession-future",
          }),
        ],
      ],
      ["agentsession-prefix", canonical.slice(0, 2)],
    ]);
    mocks.invokeTauri.mockResolvedValue([
      {
        sessionId: "agentsession-future",
        updatedAt: "2026-09-05T09:00:00.000Z",
      },
      {
        sessionId: "agentsession-prefix",
        updatedAt: "2026-09-05T08:00:00.000Z",
      },
    ]);
    mocks.getAgentSession.mockImplementation(async (sessionId) => ({
      status: "completed",
      updatedAt:
        sessionId === "agentsession-future"
          ? "2026-09-05T09:00:00.000Z"
          : "2026-09-05T08:00:00.000Z",
      workspacePath: "/repo",
      accountId: "account-1",
      model: "model-1",
      agentDefinitionId: "builtin:sde",
    }));
    mocks.loadEvents.mockImplementation(async (sessionId) => ({
      events: eventsBySession.get(sessionId) ?? [],
      source: "native_store",
    }));
    mocks.synchronize.mockImplementation(async ({ sessionId, timeline }) => {
      const synchronized = (timeline as SessionEvent[]).map((item) => ({
        ...item,
        sessionId,
      }));
      eventsBySession.set(sessionId, synchronized);
      return {
        events: synchronized,
        receipt: {
          nativeSessionId: sessionId,
          itemCount: synchronized.length,
        },
      };
    });
    mocks.sendMessage.mockImplementationOnce(
      async ({ sessionId, content, turnIntentId }) => {
        const current = eventsBySession.get(sessionId) ?? [];
        eventsBySession.set(sessionId, [
          ...current,
          event(`user-${turnIntentId}`, "user", content, {
            sessionId,
            turnId: turnIntentId,
          }),
          event(`answer-${turnIntentId}`, "assistant", "native answer", {
            sessionId,
            turnId: turnIntentId,
          }),
        ]);
      }
    );

    const retry = () =>
      continueLocalConversation({
        root,
        title: "Shared",
        timeline: canonical,
        displayText: "continue safely",
        target,
        turnIntentId: "turn-prefix-selection",
      });

    await expect(retry()).rejects.toBeInstanceOf(
      QueuedConversationRecoveryBlockedError
    );
    await expect(retry()).rejects.toBeInstanceOf(
      QueuedConversationRecoveryBlockedError
    );
    expect(mocks.synchronize).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("marks a fresh native episode failed when its first resume send is rejected", async () => {
    mocks.sendMessage.mockRejectedValueOnce(
      new Error("provider rejected native id")
    );

    await expect(
      continueLocalConversation({
        root,
        title: "Shared",
        timeline: [event("u1", "user", "native history")],
        displayText: "continue",
        target,
        turnIntentId: "turn-fresh-failure",
      })
    ).rejects.toThrow("provider rejected native id");
    expect(mocks.markTerminal).toHaveBeenCalledWith(
      "agentsession-child",
      "failed",
      { generation: 3 }
    );
    const failedUserEvent = mocks.appendEvents.mock.calls.at(-1)?.[0]?.[0];
    expect(mocks.removeEvents).not.toHaveBeenCalled();
    expect(mocks.updateEvent).toHaveBeenCalledWith(
      failedUserEvent.id,
      expect.objectContaining({ displayStatus: "failed" }),
      "agentsession-child"
    );
  });

  it("rejects a CLI target without a native writer contract", async () => {
    await expect(
      continueLocalConversation({
        root,
        title: "Shared",
        timeline: [],
        displayText: "continue",
        target: {
          cliAgentType: "kiro",
          accountId: "account-1",
          model: "model-1",
          workspaceRepoPath: "/repo",
        },
        turnIntentId: "turn-5",
      })
    ).rejects.toThrow("cannot materialize");
  });

  it("reuses the original Claude UUID after a Claude to Codex to Claude round trip", async () => {
    const localRoot = {
      authority: "local-session",
      authorityScope: [],
      conversationId: "cliagent-claude-root",
    } as const;
    const parentSessionId = conversationExecutionParentId(localRoot);
    const eventsBySession = new Map<string, SessionEvent[]>([
      [
        localRoot.conversationId,
        [
          event("root-u1", "user", "remember this native history", {
            sessionId: localRoot.conversationId,
          }),
          event("root-a1", "assistant", "remembered", {
            sessionId: localRoot.conversationId,
          }),
        ],
      ],
    ]);
    const children: Array<{ sessionId: string; updatedAt: string }> = [];
    mocks.invokeTauri.mockImplementation(async (command, args) => {
      expect(args).toEqual({ parentSessionId });
      return children;
    });
    mocks.cliStatus.mockImplementation(async ({ sessionId }) => {
      if (sessionId === localRoot.conversationId) {
        return {
          status: "completed",
          updatedAt: "2026-08-28T03:00:00.000Z",
          cliAgentType: "claude_code",
          accountId: "claude-account",
          model: "claude-model",
          repoPath: "/repo",
        };
      }
      return {
        status: "completed",
        updatedAt: "2026-08-28T04:00:00.000Z",
        cliAgentType: "codex",
        accountId: "codex-account",
        model: "codex-model",
        repoPath: "/repo",
      };
    });
    mocks.loadEvents.mockImplementation(async (sessionId) => ({
      events: eventsBySession.get(sessionId) ?? [],
      source: "native_store",
    }));
    let creationCount = 0;
    mocks.create.mockImplementation(async () => {
      creationCount += 1;
      const sessionId =
        creationCount === 1 ? "cliagent-codex-child" : "cliagent-claude-return";
      children.push({
        sessionId,
        updatedAt:
          creationCount === 1
            ? "2026-08-28T04:00:00.000Z"
            : "2026-08-28T05:00:00.000Z",
      });
      return { sessionId };
    });
    mocks.materialize.mockImplementation(async ({ sessionId, timeline }) => {
      const materialized = (timeline as SessionEvent[]).map((item) => ({
        ...item,
        sessionId,
      }));
      eventsBySession.set(sessionId, materialized);
      return {
        events: materialized,
        receipt: { nativeSessionId: sessionId, itemCount: materialized.length },
      };
    });
    mocks.synchronize.mockImplementation(async ({ sessionId, timeline }) => {
      const synchronized = (timeline as SessionEvent[]).map((item) => ({
        ...item,
        sessionId,
      }));
      eventsBySession.set(sessionId, synchronized);
      return {
        events: synchronized,
        receipt: {
          nativeSessionId: sessionId,
          itemCount: synchronized.length,
        },
      };
    });
    const sentInto: string[] = [];
    mocks.sendMessage.mockImplementation(
      async ({ sessionId, displayText, turnIntentId }) => {
        sentInto.push(sessionId);
        const current = eventsBySession.get(sessionId) ?? [];
        eventsBySession.set(sessionId, [
          ...current,
          event(`user-${turnIntentId}`, "user", displayText, {
            sessionId,
            turnId: turnIntentId,
          }),
          event(`answer-${turnIntentId}`, "assistant", "native answer", {
            sessionId,
            turnId: turnIntentId,
          }),
        ]);
      }
    );

    const claudeTarget = {
      cliAgentType: "claude_code",
      accountId: "claude-account",
      model: "claude-model",
      workspaceRepoPath: "/repo",
    };
    const first = await continueLocalConversation({
      root: localRoot,
      title: "Round trip",
      timeline: eventsBySession.get(localRoot.conversationId)!,
      displayText: "first Claude turn",
      target: claudeTarget,
      turnIntentId: "cc-first",
    });
    expect(first).toMatchObject({
      sessionId: localRoot.conversationId,
    });

    const middle = await continueLocalConversation({
      root: localRoot,
      title: "Round trip",
      timeline: eventsBySession.get(localRoot.conversationId)!,
      displayText: "Codex middle turn",
      target: {
        cliAgentType: "codex",
        accountId: "codex-account",
        model: "codex-model",
        workspaceRepoPath: "/repo",
      },
      turnIntentId: "codex-middle",
    });
    expect(middle).toMatchObject({
      sessionId: "cliagent-codex-child",
    });

    const last = await continueLocalConversation({
      root: localRoot,
      title: "Round trip",
      timeline: eventsBySession.get("cliagent-codex-child")!,
      displayText: "return to Claude",
      target: claudeTarget,
      turnIntentId: "cc-return",
    });
    expect(last).toMatchObject({
      sessionId: localRoot.conversationId,
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(sentInto).toEqual([
      localRoot.conversationId,
      "cliagent-codex-child",
      localRoot.conversationId,
    ]);
    expect(eventsBySession.get(localRoot.conversationId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ displayText: "Codex middle turn" }),
      ])
    );
  });
});
