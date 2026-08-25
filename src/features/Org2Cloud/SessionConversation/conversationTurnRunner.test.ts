import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { SessionService } from "@src/engines/SessionCore/services/SessionService";
import { sendReservedTurn } from "@src/engines/SessionCore/services/TurnDispatchService";
import { requestForkSessionSetup } from "@src/features/TeamCollaboration/forkSession";
import {
  clearForkSetupMemory,
  loadForkSetupMemory,
} from "@src/features/TeamCollaboration/forkSetupMemory";

import type { CloudConversationEvent } from "../org2CloudConversationEventsClient";
import {
  loadContinuation,
  loadContinuationLineage,
  saveContinuation,
} from "./conversationContinuation";
import {
  CONVERSATION_TURN_LOCK_UNAVAILABLE,
  type RunConversationTurnParams,
  runConversationTurn,
  withConversationTurnLock,
} from "./conversationTurnRunner";

const { state } = vi.hoisted(() => ({
  state: {
    generation: 0,
    persistedBatches: [] as SessionEvent[][],
    pushes: [] as Array<{ kind: "user" | "tail"; turnId: string }>,
    pushLastSeqs: [] as number[],
    tailEventIds: [] as string[][],
    sent: [] as Record<string, unknown>[],
    rejectNextSend: false,
    cleaned: [] as string[],
    terminalStatus: "completed" as "completed" | "failed" | "cancelled",
  },
}));

vi.mock("@src/components/Message", () => ({
  default: { info: vi.fn(), error: vi.fn() },
}));
vi.mock("@src/engines/SessionCore/sync/authoritativeSessionEvents", () => ({
  loadAuthoritativeSessionEvents: vi.fn(async () => ({
    events: state.persistedBatches.shift() ?? [],
    source: "event_store",
  })),
}));
vi.mock("@src/engines/SessionCore/services/SessionService", () => ({
  SessionService: {
    create: vi.fn(async () => ({ sessionId: "fresh-runner" })),
  },
}));
vi.mock("@src/engines/SessionCore/services/TurnDispatchService", () => ({
  reserveTurnDispatch: vi.fn(
    (input: { sessionId: string; turnIntentId: string }) => ({
      ...input,
      generation: ++state.generation,
      optimisticSource: "dispatch",
    })
  ),
  sendReservedTurn: vi.fn(async (input: Record<string, unknown>) => {
    state.sent.push(input);
    if (state.rejectNextSend) {
      state.rejectNextSend = false;
      throw new Error("session cannot accept turns");
    }
    return { ...(input.dispatch as object), accepted: true };
  }),
  waitForTurnOutcome: vi.fn(async (dispatch: Record<string, unknown>) => ({
    ...dispatch,
    status: state.terminalStatus,
    at: 1,
  })),
}));
vi.mock("@src/engines/SessionCore/sync/adapters/shared/eventFactories", () => ({
  mintTurnIntentId: () => "intent-1",
}));
vi.mock("@src/features/TeamCollaboration/forkSession", () => ({
  requestForkSessionSetup: vi.fn(async () => ({
    workspaceRepoPath: "/repo",
    execution: {
      agentDefinitionId: "agent-a",
      accountId: "account-a",
      model: "model-a",
    },
  })),
}));
vi.mock("@src/features/TeamCollaboration/forkSetupMemory", () => ({
  loadForkSetupMemory: vi.fn(() => null),
  saveForkSetupMemory: vi.fn(),
  clearForkSetupMemory: vi.fn(),
}));
vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@src/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("./conversationRunnerSessions", () => ({
  conversationRunnerKey: (scope: string, root: string) =>
    JSON.stringify([scope, root]),
  registerConversationRunner: vi.fn(),
  markConversationRunnerTerminal: vi.fn(),
  cleanupRetiredConversationRunners: vi.fn(async () => undefined),
  cleanupConversationRunnerBestEffort: vi.fn(async (sessionId: string) => {
    state.cleaned.push(sessionId);
  }),
}));
vi.mock("../org2CloudConversationEventsClient", () => ({
  boundConversationEventForPush: (event: SessionEvent) => event,
  pushConversationEvents: vi.fn(
    async (_token: string, input: { turnId: string }) => {
      state.pushes.push({ kind: "user", turnId: input.turnId });
      const lastSeq = state.pushLastSeqs.shift() ?? 1;
      return { firstSeq: lastSeq, lastSeq };
    }
  ),
  pushConversationEventsChunked: vi.fn(
    async (
      _token: string,
      input: { turnId: string; events: SessionEvent[] }
    ) => {
      state.pushes.push({ kind: "tail", turnId: input.turnId });
      state.tailEventIds.push(input.events.map((event) => event.id));
      const lastSeq = state.pushLastSeqs.shift() ?? 2;
      return { firstSeq: lastSeq, lastSeq };
    }
  ),
}));

function fakeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function event(
  id: string,
  source: "user" | "assistant" | "system",
  text: string,
  turnIntentId?: string
): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId: "runner",
    createdAt: "2026-08-25T00:00:00.000Z",
    source,
    displayText: text,
    result: turnIntentId ? { turnIntentId } : {},
  } as SessionEvent;
}

function row(
  seq: number,
  turnId: string,
  authorDisplayName: string,
  text: string
): CloudConversationEvent {
  return {
    id: `plane-${seq}`,
    rootSessionId: "root",
    authorUserId: authorDisplayName.toLowerCase(),
    authorDisplayName,
    turnId,
    seq,
    event: event(`plane-event-${seq}`, "user", text, turnId),
    createdAt: "2026-08-25T00:00:00.000Z",
  };
}

function params(
  overrides: Partial<RunConversationTurnParams> = {}
): RunConversationTurnParams {
  return {
    getAccessToken: async () => "token",
    orgId: "org",
    rootSessionId: "root",
    executionRootKey: "root",
    conversationTitle: "Conversation",
    displayText: "new request",
    executionScopeKey: "scope",
    loadInitialContext: async () => ({
      timeline: [event("history", "assistant", "root answer")],
      readThroughPlaneSeq: 12,
    }),
    loadPlaneDelta: async (afterSeq) => ({ events: [], lastSeq: afterSeq }),
    ...overrides,
  };
}

let storageBackup: PropertyDescriptor | undefined;
let locksBackup: PropertyDescriptor | undefined;

beforeEach(() => {
  state.generation = 0;
  state.persistedBatches = [];
  state.pushes = [];
  state.pushLastSeqs = [];
  state.tailEventIds = [];
  state.sent = [];
  state.rejectNextSend = false;
  state.cleaned = [];
  state.terminalStatus = "completed";
  storageBackup = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: fakeStorage(),
  });
  locksBackup = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (
        _name: string,
        _options: LockOptions,
        callback: () => Promise<unknown>
      ) => callback(),
    } as unknown as LockManager,
  });
  vi.clearAllMocks();
});

afterEach(() => {
  if (storageBackup) {
    Object.defineProperty(globalThis, "localStorage", storageBackup);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
  if (locksBackup) {
    Object.defineProperty(navigator, "locks", locksBackup);
  } else {
    Reflect.deleteProperty(navigator, "locks");
  }
});

describe("conversation turn continuation", () => {
  it("fails closed in a browser without a cross-window lock", async () => {
    Reflect.deleteProperty(navigator, "locks");
    const run = vi.fn(async () => "never");
    await expect(withConversationTurnLock("root", run)).rejects.toThrow(
      CONVERSATION_TURN_LOCK_UNAVAILABLE
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("creates one idle runner and persists the verified initial cursor", async () => {
    state.persistedBatches = [
      [
        event("user-1", "user", "new request", "intent-1"),
        event("agent-1", "assistant", "answer"),
      ],
    ];
    const onRunnerReady = vi.fn();
    const onTurnAccepted = vi.fn();

    const result = await runConversationTurn(
      params({ onRunnerReady, onTurnAccepted })
    );

    expect(result).toMatchObject({
      runnerSessionId: "fresh-runner",
      turnIntentId: "intent-1",
      terminalStatus: "completed",
    });
    expect(SessionService.create).toHaveBeenCalledWith(
      expect.objectContaining({ task: "" })
    );
    expect(sendReservedTurn).toHaveBeenCalledTimes(1);
    expect(state.sent[0].content).toContain("Assistant: root answer");
    expect(onRunnerReady).toHaveBeenCalledWith(
      "fresh-runner",
      "intent-1",
      "intent-1"
    );
    expect(onTurnAccepted).toHaveBeenCalledWith("fresh-runner", "intent-1");
    expect(onRunnerReady.mock.invocationCallOrder[0]).toBeLessThan(
      onTurnAccepted.mock.invocationCallOrder[0]
    );
    expect(loadContinuation("scope", "root")).toMatchObject({
      continuationSessionId: "fresh-runner",
      established: true,
      readThroughPlaneSeq: 12,
    });
    expect(state.pushes).toEqual([
      { kind: "user", turnId: "intent-1" },
      { kind: "tail", turnId: "intent-1" },
    ]);
  });

  it("does not acknowledge an accepted turn after continuation storage loss", async () => {
    const onTurnAccepted = vi.fn();
    const onTransportAccepted = vi.fn();

    await expect(
      runConversationTurn(
        params({
          onRunnerReady: () => {
            Object.defineProperty(globalThis, "localStorage", {
              configurable: true,
              value: fakeStorage(),
            });
          },
          onTransportAccepted,
          onTurnAccepted,
        })
      )
    ).rejects.toThrow("continuation acceptance could not be persisted");

    expect(onTransportAccepted).toHaveBeenCalledWith(
      "fresh-runner",
      "intent-1"
    );
    expect(onTurnAccepted).not.toHaveBeenCalled();
    expect(state.cleaned).toEqual([]);
  });

  it("deletes a new runner when durable prepare cannot be persisted", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: null,
    });

    await expect(runConversationTurn(params())).rejects.toThrow(
      "conversation execution storage unavailable"
    );

    expect(sendReservedTurn).not.toHaveBeenCalled();
    expect(state.cleaned).toEqual(["fresh-runner"]);
  });

  it("reuses the runner, injects only new foreign rows, and advances the cursor", async () => {
    saveContinuation("scope", "root", {
      continuationSessionId: "runner-live",
      readThroughPlaneSeq: 55,
      established: true,
      agentDefinitionId: "agent-a",
    });
    state.persistedBatches = [
      [
        event("old-user", "user", "prior", "own-prior"),
        event("old-agent", "assistant", "prior answer"),
      ],
      [
        event("old-user", "user", "prior", "own-prior"),
        event("old-agent", "assistant", "prior answer"),
        event("user-2", "user", "new request", "intent-2"),
        event("agent-2", "assistant", "fresh answer"),
      ],
    ];
    const loadInitialContext = vi.fn();
    const loadPlaneDelta = vi.fn(async () => ({
      events: [
        row(56, "own-prior", "Vince", "duplicate local turn"),
        row(57, "alice-turn", "Alice", "note from Alice"),
      ],
      lastSeq: 57,
    }));
    state.pushLastSeqs = [58, 59];

    const result = await runConversationTurn(
      params({
        turnIntentId: "intent-2",
        loadInitialContext,
        loadPlaneDelta,
      })
    );

    expect(result.runnerSessionId).toBe("runner-live");
    expect(SessionService.create).not.toHaveBeenCalled();
    expect(loadInitialContext).not.toHaveBeenCalled();
    expect(loadPlaneDelta).toHaveBeenCalledWith(55);
    expect(state.sent[0].content).toContain("Alice: note from Alice");
    expect(state.sent[0].content).not.toContain("duplicate local turn");
    expect(loadContinuation("scope", "root")?.readThroughPlaneSeq).toBe(59);
  });

  it("rolls a rejected resume to fresh without publishing the user twice", async () => {
    saveContinuation("scope", "root", {
      continuationSessionId: "runner-dead",
      readThroughPlaneSeq: 10,
      established: true,
      agentDefinitionId: "agent-a",
    });
    state.rejectNextSend = true;
    state.persistedBatches = [
      [],
      [
        event("user-1", "user", "new request", "intent-1"),
        event("agent-1", "assistant", "recovered answer"),
      ],
    ];

    const result = await runConversationTurn(params());

    expect(result.runnerSessionId).toBe("fresh-runner");
    expect(sendReservedTurn).toHaveBeenCalledTimes(2);
    expect(SessionService.create).toHaveBeenCalledTimes(1);
    expect(state.pushes.filter((push) => push.kind === "user")).toHaveLength(1);
    expect(state.cleaned).toContain("runner-dead");
  });

  it("rolls at the next serialized turn when desired runtime setup changes", async () => {
    saveContinuation("scope", "root", {
      continuationSessionId: "runner-old-runtime",
      readThroughPlaneSeq: 10,
      established: true,
      agentDefinitionId: "agent-a",
      cliAgentType: "codex",
      accountId: "account-a",
      model: "model-a",
      workspaceRepoPath: "/repo-a",
    });
    vi.mocked(loadForkSetupMemory).mockReturnValueOnce({
      workspaceRepoPath: "/repo-b",
      execution: {
        agentDefinitionId: "agent-a",
        cliAgentType: "codex",
        accountId: "account-b",
        model: "model-b",
      },
    });
    state.persistedBatches = [
      [],
      [
        event("user-1", "user", "new request", "intent-1"),
        event("agent-1", "assistant", "new runtime answer"),
      ],
    ];

    const result = await runConversationTurn(
      params({ setupMemoryKey: "canonical-setup" })
    );

    expect(result.runnerSessionId).toBe("fresh-runner");
    expect(state.cleaned).toContain("runner-old-runtime");
    expect(SessionService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: "/repo-b",
        cliAgentType: "codex",
        accountId: "account-b",
        model: "model-b",
      })
    );
    expect(loadContinuationLineage("scope", "root")?.episodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          continuationSessionId: "runner-old-runtime",
          state: "retired",
          rollReason: "runtime_setup_changed",
        }),
      ])
    );
  });

  it("keeps a durably prepared resume on transport ambiguity", async () => {
    saveContinuation("scope", "root", {
      continuationSessionId: "runner-prepared",
      readThroughPlaneSeq: 10,
      established: true,
      agentDefinitionId: "agent-a",
    });
    state.rejectNextSend = true;

    await expect(
      runConversationTurn(params({ preserveRunnerOnTransportFailure: true }))
    ).rejects.toThrow("session cannot accept turns");

    expect(SessionService.create).not.toHaveBeenCalled();
    expect(state.cleaned).not.toContain("runner-prepared");
    expect(loadContinuation("scope", "root")).toMatchObject({
      continuationSessionId: "runner-prepared",
      established: true,
    });
  });

  it("rejects a durable redelivery that cannot recover its exact prepared runner", async () => {
    saveContinuation("scope", "root", {
      continuationSessionId: "runner-other",
      readThroughPlaneSeq: 10,
      established: true,
      agentDefinitionId: "agent-a",
    });

    await expect(
      runConversationTurn(
        params({ requiredRunnerSessionId: "runner-prepared" })
      )
    ).rejects.toThrow(
      "requires prepared runner runner-prepared; local continuation is runner-other"
    );

    expect(SessionService.create).not.toHaveBeenCalled();
    expect(sendReservedTurn).not.toHaveBeenCalled();
    expect(state.pushes).toEqual([]);
  });

  it("never rolls an exact prepared runner when its execution fingerprint differs", async () => {
    saveContinuation("scope", "root", {
      continuationSessionId: "runner-prepared",
      readThroughPlaneSeq: 10,
      established: true,
      agentDefinitionId: "agent-old",
    });

    await expect(
      runConversationTurn(
        params({
          requiredRunnerSessionId: "runner-prepared",
          assignedAgentDefinitionId: "agent-new",
        })
      )
    ).rejects.toThrow(
      "prepared runner runner-prepared is incompatible: assigned_agent_changed"
    );

    expect(SessionService.create).not.toHaveBeenCalled();
    expect(state.cleaned).toEqual([]);
    expect(loadContinuation("scope", "root")?.continuationSessionId).toBe(
      "runner-prepared"
    );
  });

  it("keeps a fresh prepared runner recoverable when its first send is ambiguous", async () => {
    state.rejectNextSend = true;
    const onTurnAccepted = vi.fn();

    await expect(
      runConversationTurn(
        params({
          preserveRunnerOnTransportFailure: true,
          onTurnAccepted,
        })
      )
    ).rejects.toThrow("session cannot accept turns");

    expect(onTurnAccepted).not.toHaveBeenCalled();
    expect(state.cleaned).not.toContain("fresh-runner");
    expect(loadContinuation("scope", "root")).toMatchObject({
      continuationSessionId: "fresh-runner",
      established: false,
      bootstrapTurnIntentId: "intent-1",
    });
  });

  it("deletes an unestablished runner before accepting a different intent", async () => {
    saveContinuation("scope", "root", {
      continuationSessionId: "runner-pending",
      readThroughPlaneSeq: 0,
      established: false,
      bootstrapTurnIntentId: "intent-old",
      agentDefinitionId: "agent-a",
    });
    state.persistedBatches = [
      [
        event("user-1", "user", "new request", "intent-new"),
        event("agent-1", "assistant", "answer"),
      ],
    ];

    await runConversationTurn(params({ turnIntentId: "intent-new" }));

    expect(state.cleaned).toContain("runner-pending");
    expect(SessionService.create).toHaveBeenCalledTimes(1);
    expect(loadContinuation("scope", "root")).toMatchObject({
      continuationSessionId: "fresh-runner",
      established: true,
    });
  });

  it("creates a managed External CLI through the same continuation path", async () => {
    vi.mocked(requestForkSessionSetup).mockResolvedValueOnce({
      workspaceRepoPath: "/repo",
      execution: {
        agentDefinitionId: "agent-a",
        cliAgentType: "codex",
        accountId: "codex-account",
      },
    });
    state.persistedBatches = [
      [],
      [
        event("native-user-1", "user", "new request"),
        event("agent-1", "assistant", "answer"),
      ],
    ];

    await runConversationTurn(params({ assignedAgentDefinitionId: "agent-a" }));

    expect(requestForkSessionSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        allowCliRuntime: true,
        lockSourceAgent: true,
        sourceAgentDefinitionId: "agent-a",
      })
    );
    expect(SessionService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "",
        cliAgentType: "codex",
        accountId: "codex-account",
        agentDefinitionId: "agent-a",
      })
    );
    expect(loadContinuation("scope", "root")).toMatchObject({
      continuationSessionId: "fresh-runner",
      cliAgentType: "codex",
      accountId: "codex-account",
      agentDefinitionId: "agent-a",
    });
    expect(state.tailEventIds).toEqual([["agent-1"]]);
  });

  it("resumes a native-transcript CLI by authoritative snapshot delta", async () => {
    saveContinuation("scope", "root", {
      continuationSessionId: "cliagent-runner-live",
      readThroughPlaneSeq: 20,
      established: true,
      agentDefinitionId: "agent-a",
      cliAgentType: "codex",
      accountId: "codex-account",
    });
    const previous = [
      event("native-user-1", "user", "first request"),
      event("native-agent-1", "assistant", "first answer"),
    ];
    state.persistedBatches = [
      previous,
      [
        ...previous,
        event("native-user-2", "user", "second request"),
        event("native-tool-2", "system", "tool output"),
        event("native-agent-2", "assistant", "second answer"),
      ],
    ];
    state.pushLastSeqs = [21, 24];

    const result = await runConversationTurn(
      params({
        turnIntentId: "intent-2",
        loadPlaneDelta: async () => ({ events: [], lastSeq: 20 }),
      })
    );

    expect(result.runnerSessionId).toBe("cliagent-runner-live");
    expect(SessionService.create).not.toHaveBeenCalled();
    expect(state.tailEventIds).toEqual([["native-tool-2", "native-agent-2"]]);
    expect(loadContinuation("scope", "root")?.readThroughPlaneSeq).toBe(24);
  });

  it("rereads a completed CLI transcript until its agent tail is visible", async () => {
    vi.mocked(requestForkSessionSetup).mockResolvedValueOnce({
      workspaceRepoPath: "/repo",
      execution: {
        agentDefinitionId: "agent-a",
        cliAgentType: "codex",
        accountId: "codex-account",
      },
    });
    const nativeUser = event("native-user-1", "user", "new request");
    state.persistedBatches = [
      [],
      [nativeUser],
      [nativeUser, event("native-agent-1", "assistant", "answer")],
    ];

    const result = await runConversationTurn(params());

    expect(result.terminalStatus).toBe("completed");
    expect(state.tailEventIds).toEqual([["native-agent-1"]]);
  });

  it("discards a remembered CLI setup that predates explicit account binding", async () => {
    vi.mocked(loadForkSetupMemory).mockReturnValueOnce({
      workspaceRepoPath: "/old-repo",
      execution: {
        agentDefinitionId: "agent-a",
        cliAgentType: "codex",
      },
    });
    vi.mocked(requestForkSessionSetup).mockResolvedValueOnce({
      workspaceRepoPath: "/repo",
      execution: {
        agentDefinitionId: "agent-a",
        cliAgentType: "codex",
        accountId: "codex-account",
      },
    });
    state.persistedBatches = [
      [],
      [
        event("native-user-1", "user", "new request"),
        event("agent-1", "assistant", "answer"),
      ],
    ];

    await runConversationTurn(params({ sourceScopeKey: "scope" }));

    expect(clearForkSetupMemory).toHaveBeenCalledWith("scope");
    expect(requestForkSessionSetup).toHaveBeenCalledTimes(1);
    expect(SessionService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        cliAgentType: "codex",
        accountId: "codex-account",
      })
    );
  });

  it("clears and cleans a failed execution episode", async () => {
    state.terminalStatus = "failed";
    state.persistedBatches = [
      [
        event("user-1", "user", "new request", "intent-1"),
        event("agent-1", "assistant", "partial answer"),
      ],
    ];

    const result = await runConversationTurn(params());

    expect(result.terminalStatus).toBe("failed");
    expect(loadContinuation("scope", "root")).toBeNull();
    expect(state.cleaned).toContain("fresh-runner");
  });
});
