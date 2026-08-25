import { describe, expect, it, vi } from "vitest";

import type { Org2CloudAuthState } from "../org2CloudAuthAtom";
import {
  type WorkItemConversationTurnDeps,
  type WorkItemConversationTurnRequest,
  WorkItemConversationTurnRequestSchema,
  decideConversationTurnAcceptance,
  handleWorkItemConversationTurnRequest,
} from "./workItemConversationTurnBridge";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@src/api/tauri/rpc", () => ({ rpc: { workRuns: {} } }));
vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../org2CloudCapabilities", () => ({
  getCloudCapabilitiesConfirmed: vi.fn(),
}));
vi.mock("../org2CloudProjectOrgAlias", () => ({
  resolveCloudOrgForProjectOrg: vi.fn(),
}));
vi.mock("./cloudConversationRuntime", () => ({
  getRequiredCloudAccessToken: vi.fn(),
  loadCloudConversationInitialContext: vi.fn(),
  loadCloudConversationPlaneDelta: vi.fn(),
  registerCloudConversationRunner: vi.fn(),
  settleCloudConversationRunner: vi.fn(),
  signalCloudConversationPlane: vi.fn(),
}));
vi.mock("./conversationTurnRunner", () => ({
  runConversationTurn: vi.fn(),
}));

const AUTH = {
  kind: "org2_cloud",
  supabaseUrl: "https://cloud.example",
  supabaseAnonKey: "anon",
  userId: "user-b",
  accessToken: "token",
  refreshToken: "refresh",
  expiresAt: 4_000_000_000,
} satisfies Org2CloudAuthState;

const REQUEST: WorkItemConversationTurnRequest = {
  runId: "run-1",
  dispatchId: "dispatch-1",
  claimToken: "claim-1",
  orgId: "project-org",
  projectSlug: "demo",
  workItemId: "WI-0001",
  workItemTitle: "Probe item",
  assignedAgentId: "agent-assigned",
  rootSessionId: "root-remote",
  preparedRunnerSessionId: "runner-prepared",
  content: "[Work Item Discussion]\n\nplease retry",
  displayText: "💬 please retry",
  discussionCommentIds: ["c1"],
};

type TurnParams = Parameters<WorkItemConversationTurnDeps["runTurn"]>[0];

function makeDeps(
  overrides: Partial<WorkItemConversationTurnDeps> = {}
): WorkItemConversationTurnDeps & {
  calls: string[];
  turnParams: TurnParams[];
} {
  const calls: string[] = [];
  const turnParams: TurnParams[] = [];
  const deps: WorkItemConversationTurnDeps & {
    calls: string[];
    turnParams: TurnParams[];
  } = {
    calls,
    turnParams,
    getAuth: () => AUTH,
    getAccessToken: async () => "token",
    resolveCloudOrg: async () => "cloud-org",
    probeCapabilities: async () => ({
      conversationEvents: true,
      conversationEventsIdempotency: true,
      confirmed: true,
    }),
    accept: async (runId, claimToken) => {
      calls.push(`accept:${runId}:${claimToken}`);
      return claimToken;
    },
    release: async (runId, claimToken) => {
      calls.push(`release:${runId}:${claimToken}`);
      return true;
    },
    nack: async (runId, claimToken, reason) => {
      calls.push(`nack:${runId}:${claimToken}:${reason}`);
      return true;
    },
    prepareRunner: async (
      runId,
      claimToken,
      rootSessionId,
      runnerSessionId
    ) => {
      calls.push(
        `prepare:${runId}:${claimToken}:${rootSessionId}:${runnerSessionId}`
      );
    },
    ackRunner: async (runId, claimToken, rootSessionId, runnerSessionId) => {
      calls.push(
        `ack:${runId}:${claimToken}:${rootSessionId}:${runnerSessionId}`
      );
    },
    lookupRoot: () => ({
      title: "Root session",
      repoScopeKey: "scope-key",
      model: "model-x",
    }),
    loadInitialContext: async () => ({
      timeline: [],
      readThroughPlaneSeq: 5,
    }),
    loadPlaneDelta: async (_orgId, _rootSessionId, afterSeq) => ({
      events: [],
      lastSeq: afterSeq,
    }),
    runTurn: async (params) => {
      turnParams.push(params);
      await params.onRunnerReady?.(
        "runner-1",
        params.turnIntentId ?? "missing",
        params.turnIntentId ?? "missing"
      );
      await params.onTurnAccepted?.(
        "runner-1",
        params.turnIntentId ?? "missing"
      );
      params.onPushed?.();
      return {
        runnerSessionId: "runner-1",
        pushedEventCount: 2,
        turnIntentId: params.turnIntentId ?? "missing",
        terminalStatus: "completed",
      };
    },
    registerRunner: ({ orgId, rootSessionId, runnerSessionId }) => {
      calls.push(`runner:${orgId}:${rootSessionId}:${runnerSessionId}`);
    },
    settleRunner: (rootSessionId, runnerSessionId) => {
      calls.push(`settle:${rootSessionId}:${runnerSessionId}`);
    },
    signalPlane: (orgId) => calls.push(`signal:${orgId}`),
    ...overrides,
  };
  return deps;
}

describe("decideConversationTurnAcceptance", () => {
  it("requires signed-in retry-safe conversation capability", () => {
    expect(
      decideConversationTurnAcceptance({
        signedIn: true,
        cloudOrgId: "cloud-org",
        capabilities: {
          conversationEvents: true,
          conversationEventsIdempotency: true,
          confirmed: true,
        },
      })
    ).toEqual({ accepted: true, cloudOrgId: "cloud-org" });
    expect(
      decideConversationTurnAcceptance({
        signedIn: true,
        cloudOrgId: "cloud-org",
        capabilities: {
          conversationEvents: true,
          conversationEventsIdempotency: false,
          confirmed: true,
        },
      })
    ).toEqual({
      accepted: false,
      reason: "cloud backend lacks retry-safe conversation writes",
    });
  });

  it("abstains while signed out or the cloud alias is absent", () => {
    expect(
      decideConversationTurnAcceptance({
        signedIn: false,
        cloudOrgId: "cloud-org",
        capabilities: null,
      }).accepted
    ).toBe(false);
    expect(
      decideConversationTurnAcceptance({
        signedIn: true,
        cloudOrgId: null,
        capabilities: null,
      }).accepted
    ).toBe(false);
  });
});

describe("handleWorkItemConversationTurnRequest", () => {
  it("prepares, accepts and acknowledges through the shared runner", async () => {
    const deps = makeDeps();

    await expect(
      handleWorkItemConversationTurnRequest(REQUEST, deps)
    ).resolves.toBe("succeeded");
    expect(deps.calls).toEqual([
      "accept:run-1:claim-1",
      "runner:cloud-org:root-remote:runner-1",
      "prepare:run-1:claim-1:root-remote:runner-1",
      "ack:run-1:claim-1:root-remote:runner-1",
      "signal:cloud-org",
      "settle:root-remote:runner-1",
    ]);
    expect(deps.turnParams[0]).toMatchObject({
      orgId: "cloud-org",
      rootSessionId: "root-remote",
      turnIntentId: "run-1",
      requiredRunnerSessionId: "runner-prepared",
      displayText: "💬 please retry",
      agentContent: REQUEST.content,
      conversationTitle: "Root session",
      sourceScopeKey: "scope-key",
      sourceModel: "model-x",
      assignedAgentDefinitionId: "agent-assigned",
      preserveRunnerOnTransportFailure: true,
    });
    expect(deps.turnParams[0].executionScopeKey).toBe(
      JSON.stringify([
        "cloud-conversation-executor",
        "https://cloud.example|user-b",
        "cloud-org",
      ])
    );
  });

  it("does not claim from an incapable window", async () => {
    const signedOut = makeDeps({ getAuth: () => null });
    await expect(
      handleWorkItemConversationTurnRequest(REQUEST, signedOut)
    ).resolves.toBe("declined");
    expect(signedOut.calls).toEqual([]);

    const legacy = makeDeps({
      probeCapabilities: async () => ({
        conversationEvents: true,
        conversationEventsIdempotency: false,
        confirmed: true,
      }),
    });
    await expect(
      handleWorkItemConversationTurnRequest(REQUEST, legacy)
    ).resolves.toBe("declined");
    expect(legacy.calls).toEqual([]);
  });

  it("does not execute when another window wins the Rust claim", async () => {
    const deps = makeDeps({
      accept: async (runId, claimToken) => {
        deps.calls.push(`accept:${runId}:${claimToken}`);
        return null;
      },
    });
    await expect(
      handleWorkItemConversationTurnRequest(REQUEST, deps)
    ).resolves.toBe("not_claimed");
    expect(deps.turnParams).toEqual([]);
  });

  it("nacks failures that occur before transport acceptance", async () => {
    const deps = makeDeps({
      prepareRunner: async () => {
        throw new Error("PM_RUN_ERR:INVALID_TRANSITION");
      },
    });
    await expect(
      handleWorkItemConversationTurnRequest(REQUEST, deps)
    ).resolves.toBe("failed");
    expect(deps.calls).toEqual([
      "accept:run-1:claim-1",
      "runner:cloud-org:root-remote:runner-1",
      "nack:run-1:claim-1:PM_RUN_ERR:INVALID_TRANSITION",
      "settle:root-remote:runner-1",
    ]);
  });

  it("keeps execution alive and releases when ack transport fails", async () => {
    const deps = makeDeps({
      ackRunner: async (runId, claimToken, rootSessionId, runnerSessionId) => {
        deps.calls.push(
          `ack:${runId}:${claimToken}:${rootSessionId}:${runnerSessionId}`
        );
        throw new Error("ack response lost");
      },
    });
    await expect(
      handleWorkItemConversationTurnRequest(REQUEST, deps)
    ).resolves.toBe("succeeded");
    expect(deps.calls).toEqual([
      "accept:run-1:claim-1",
      "runner:cloud-org:root-remote:runner-1",
      "prepare:run-1:claim-1:root-remote:runner-1",
      "ack:run-1:claim-1:root-remote:runner-1",
      "signal:cloud-org",
      "release:run-1:claim-1",
      "settle:root-remote:runner-1",
    ]);
  });

  it("falls back to release when durable nack itself fails", async () => {
    const deps = makeDeps({
      runTurn: async () => {
        throw new Error("network unavailable");
      },
      nack: async (runId, claimToken, reason) => {
        deps.calls.push(`nack:${runId}:${claimToken}:${reason}`);
        throw new Error("nack unavailable");
      },
    });
    await expect(
      handleWorkItemConversationTurnRequest(REQUEST, deps)
    ).resolves.toBe("failed");
    expect(deps.calls).toEqual([
      "accept:run-1:claim-1",
      "nack:run-1:claim-1:network unavailable",
      "release:run-1:claim-1",
    ]);
  });
});

describe("WorkItemConversationTurnRequestSchema", () => {
  it("parses the backend payload and defaults comment ids", () => {
    const parsed = WorkItemConversationTurnRequestSchema.parse({
      runId: "run",
      dispatchId: "dispatch",
      claimToken: "claim",
      orgId: "org",
      workItemId: "WI-1",
      rootSessionId: "root",
      content: "body",
    });
    expect(parsed.discussionCommentIds).toEqual([]);
    expect(parsed.assignedAgentId).toBeUndefined();
  });
});
