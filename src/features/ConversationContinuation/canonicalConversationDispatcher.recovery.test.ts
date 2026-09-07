import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";

import type { QueuedConversationExecutionMessage } from "@src/engines/SessionCore/conversations/queuedConversationContract";
import {
  QueuedConversationRecoveryPendingError,
  QueuedConversationTurnFailedError,
} from "@src/engines/SessionCore/conversations/queuedConversationContract";

import { dispatchQueuedCanonicalConversation } from "./canonicalConversationDispatcher";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  loadTimeline: vi.fn(),
  continueLocal: vi.fn(),
  recoverLocal: vi.fn(),
  dispatchCloud: vi.fn(),
  authorityLive: vi.fn(() => true),
  cliStatus: vi.fn(
    async (): Promise<{ errorMessage?: string | null } | null> => null
  ),
}));

vi.mock("@src/api/tauri/rpc", () => ({
  rpc: { cli: { status: mocks.cliStatus } },
}));
vi.mock("@src/api/tauri/externalHistory", () => ({
  getImportedHistorySourceBySessionId: vi.fn(() => undefined),
}));
vi.mock(
  "@src/engines/SessionCore/conversations/localConversationExecutionTail",
  () => ({ loadLocalCanonicalConversationTimeline: mocks.loadTimeline })
);
vi.mock(
  "@src/engines/SessionCore/conversations/localConversationContinuation",
  () => ({
    continueLocalConversationAfterTimelineLoad: mocks.continueLocal,
    localConversationRootForSession: (sessionId: string) => ({
      authority: "local-session",
      authorityScope: [],
      conversationId: sessionId,
    }),
    recoverLocalConversationTurn: mocks.recoverLocal,
  })
);
vi.mock(
  "@src/features/Org2Cloud/SessionConversation/cloudConversationQueueAdapter",
  () => ({
    dispatchQueuedCloudConversation: mocks.dispatchCloud,
  })
);
vi.mock("@src/features/Org2Cloud/org2CloudRemoteSessionsAtom", async () => {
  const { atom } = await import("jotai");
  return { org2CloudRemoteSessionsAtom: atom({}) };
});
vi.mock(
  "@src/features/Org2Cloud/SessionConversation/cloudConversationAuthority",
  () => ({ cloudConversationAuthorityIsLive: mocks.authorityLive })
);
vi.mock("@src/store/session", async () => {
  const { atom } = await import("jotai");
  return {
    sessionsAtom: atom([
      { session_id: "source-session", name: "Source" },
      { session_id: "sdeagent-expired", name: "Expired share" },
      {
        session_id: "runner-rejected",
        name: "Runner",
        error_message:
          '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The requested model is not available"}}',
      },
    ]),
  };
});
vi.mock("./externalHistoryContinuation", () => ({
  resolveExternalHistoryContinuation: vi.fn(),
}));

function message(): QueuedConversationExecutionMessage {
  return {
    id: "queue-1",
    turnIntentId: "turn-1",
    sessionId: "source-session",
    content: "continue",
    displayContent: "continue",
    status: "preparing",
    conversationDispatch: {
      kind: "canonical_conversation",
      root: {
        authority: "local-session",
        authorityScope: [],
        conversationId: "source-session",
      },
      target: {
        cliAgentType: "codex",
        accountId: "openai-1",
        model: "gpt-5.6-sol",
      },
    },
  };
}

describe("queued local conversation runner recovery", () => {
  it("loads the verified root plus execution-child timeline at queue head", async () => {
    const canonicalTimeline = [{ id: "root" }, { id: "claude-tail" }];
    mocks.loadTimeline.mockResolvedValueOnce(canonicalTimeline);
    mocks.continueLocal.mockImplementationOnce(async (params) => {
      expect(await params.loadTimeline()).toBe(canonicalTimeline);
    });

    await dispatchQueuedCanonicalConversation(createStore(), message(), {
      onAccepted: vi.fn(),
    });

    expect(mocks.loadTimeline).toHaveBeenCalledWith(
      message().conversationDispatch?.root
    );
  });

  it("keeps recovery pending when a native child's durable runner receipt fails", async () => {
    mocks.order.length = 0;
    mocks.continueLocal.mockImplementation(async (params) => {
      await params.onSessionReady?.("cliagent-child", 7);
    });
    const receiptFailure = new Error("disk temporarily unavailable");
    const onRunnerReady = vi.fn(async () => {
      mocks.order.push("persist");
      throw receiptFailure;
    });

    await expect(
      dispatchQueuedCanonicalConversation(createStore(), message(), {
        onAccepted: vi.fn(),
        onRunnerReady,
      })
    ).rejects.toBeInstanceOf(QueuedConversationRecoveryPendingError);

    expect(mocks.order).toEqual(["persist"]);
    expect(onRunnerReady).toHaveBeenCalledWith("cliagent-child", 7);
  });

  it("runs a Cloud-rooted turn locally once the owner's Cloud root row is gone", async () => {
    mocks.dispatchCloud.mockReset();
    mocks.continueLocal.mockReset();
    mocks.loadTimeline.mockResolvedValue({
      sourceSession: undefined,
      sessions: [],
      timeline: [],
    });
    mocks.continueLocal.mockResolvedValue(undefined);
    mocks.authorityLive.mockReturnValue(false);
    const store = createStore();
    const cloudMessage: QueuedConversationExecutionMessage = {
      ...message(),
      sessionId: "sdeagent-expired",
      conversationDispatch: {
        kind: "canonical_conversation",
        root: {
          authority: "org2-cloud",
          authorityScope: ["https://cloud.example", "org-1"],
          conversationId: "sdeagent-expired",
        },
        target: {
          cliAgentType: "codex",
          accountId: "openai-1",
          model: "gpt-5.6-sol",
        },
        dispatchIdentityKey: "https://cloud.example|user-1",
      },
    };

    await dispatchQueuedCanonicalConversation(store, cloudMessage, {
      onAccepted: vi.fn(),
    });

    expect(mocks.authorityLive).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ session_id: "sdeagent-expired" }),
        target: { orgId: "org-1", sessionId: "sdeagent-expired" },
      })
    );
    expect(mocks.dispatchCloud).not.toHaveBeenCalled();
    expect(mocks.continueLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        root: {
          authority: "local-session",
          authorityScope: [],
          conversationId: "sdeagent-expired",
        },
      })
    );
  });

  it("keeps the Cloud authority while the owner's root row is still listed", async () => {
    mocks.dispatchCloud.mockReset();
    mocks.dispatchCloud.mockResolvedValue(undefined);
    mocks.authorityLive.mockReturnValue(true);
    const store = createStore();
    const cloudMessage: QueuedConversationExecutionMessage = {
      ...message(),
      sessionId: "sdeagent-expired",
      conversationDispatch: {
        kind: "canonical_conversation",
        root: {
          authority: "org2-cloud",
          authorityScope: ["https://cloud.example", "org-1"],
          conversationId: "sdeagent-expired",
        },
        target: {
          cliAgentType: "codex",
          accountId: "openai-1",
          model: "gpt-5.6-sol",
        },
        dispatchIdentityKey: "https://cloud.example|user-1",
      },
    };

    await dispatchQueuedCanonicalConversation(store, cloudMessage, {
      onAccepted: vi.fn(),
    });

    expect(mocks.dispatchCloud).toHaveBeenCalledTimes(1);
  });

  it("holds a definitively failed local turn with the provider's reason", async () => {
    mocks.continueLocal.mockReset();
    mocks.continueLocal.mockResolvedValue({
      sessionId: "runner-rejected",
      terminalStatus: "failed",
      agentTail: [],
    });

    await expect(
      dispatchQueuedCanonicalConversation(createStore(), message(), {
        onAccepted: vi.fn(),
      })
    ).rejects.toMatchObject({
      name: "QueuedConversationTurnFailedError",
      message: "The requested model is not available",
    });
  });

  it("reads the provider's reason from the runner row when the store has none", async () => {
    mocks.continueLocal.mockReset();
    mocks.continueLocal.mockResolvedValue({
      sessionId: "runner-cold",
      terminalStatus: "failed",
      agentTail: [],
    });
    mocks.cliStatus.mockResolvedValueOnce({
      errorMessage:
        '{"type":"error","status":400,"error":{"message":"The model is not supported"}}',
    });

    await expect(
      dispatchQueuedCanonicalConversation(createStore(), message(), {
        onAccepted: vi.fn(),
      })
    ).rejects.toMatchObject({ message: "The model is not supported" });
    expect(mocks.cliStatus).toHaveBeenCalledWith({ sessionId: "runner-cold" });
  });

  it("does not fail a turn that produced a tail before its terminal", async () => {
    mocks.continueLocal.mockReset();
    mocks.continueLocal.mockResolvedValue({
      sessionId: "runner-rejected",
      terminalStatus: "failed",
      agentTail: [{ id: "partial" } as never],
    });

    await expect(
      dispatchQueuedCanonicalConversation(createStore(), message(), {
        onAccepted: vi.fn(),
      })
    ).resolves.toBeUndefined();
    expect(QueuedConversationTurnFailedError).toBeDefined();
  });
});
