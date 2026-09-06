import { beforeEach, describe, expect, it, vi } from "vitest";

import { projectNativeConversationItems } from "@src/engines/SessionCore/conversations/nativeConversationMaterializer";
import {
  QueuedConversationRecoveryPendingError,
  QueuedConversationTurnClosedError,
} from "@src/engines/SessionCore/conversations/queuedConversationContract";
import { Org2CloudConversationError } from "@src/features/Org2Cloud/org2CloudConversationEventsClient";

import {
  buildPushedUserEvent,
  runConversationTurn,
} from "./conversationTurnRunner";

const mocks = vi.hoisted(() => ({
  continueLocalConversation: vi.fn(),
}));

vi.mock(
  "@src/engines/SessionCore/conversations/localConversationContinuation",
  async (importOriginal) => ({
    ...(await importOriginal()),
    continueLocalConversation: mocks.continueLocalConversation,
  })
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.continueLocalConversation.mockImplementation(async (params) => {
    params.onSessionReady?.("cliagent-owner", 3);
    return {
      sessionId: "cliagent-owner",
      terminalStatus: "completed",
      agentTail: [],
    };
  });
});

describe("buildPushedUserEvent", () => {
  it("keeps visible text separate from the exact agent-facing native content", () => {
    const event = buildPushedUserEvent(
      "Use my review skill",
      "<skill>review instructions</skill>\nUse my review skill",
      ["data:image/png;base64,AAAA"],
      "2026-08-26T00:00:00.000Z",
      "turn-1"
    );

    expect(event.displayText).toBe("Use my review skill");
    expect(projectNativeConversationItems([event])).toEqual([
      expect.objectContaining({
        kind: "message",
        role: "user",
        text: "<skill>review instructions</skill>\nUse my review skill",
        images: ["data:image/png;base64,AAAA"],
      }),
    ]);
  });
});

describe("runConversationTurn", () => {
  it("binds a fresh hidden runner during preparation, then exposes its exact native prefix", async () => {
    const onRunnerReady = vi.fn();
    const publishTail = vi.fn();
    mocks.continueLocalConversation.mockImplementationOnce(async (params) => {
      await params.onSessionPreparing?.("cliagent-fresh");
      await params.onSessionReady?.("cliagent-fresh", 7);
      return {
        sessionId: "cliagent-fresh",
        terminalStatus: "completed",
        agentTail: [],
      };
    });

    const result = await runConversationTurn({
      root: {
        authority: "org2-cloud",
        authorityScope: ["https://cloud.example", "org-1"],
        conversationId: "shared-root",
      },
      conversationTitle: "Shared conversation",
      displayText: "continue",
      timeline: [],
      target: {
        cliAgentType: "codex",
        accountId: "acct-codex",
        model: "gpt-5.6-sol",
      },
      turnIntentId: "turn-fresh",
      onRunnerReady,
      publishTail,
    });

    expect(onRunnerReady.mock.calls).toEqual([
      ["cliagent-fresh", "turn-fresh", Number.MAX_SAFE_INTEGER],
      ["cliagent-fresh", "turn-fresh", 7],
    ]);
    expect(result).toEqual(
      expect.objectContaining({
        terminalStatus: "completed",
      })
    );
  });

  it("reuses an owner's local native root while publishing to the shared plane", async () => {
    const executionRoot = {
      authority: "local-session",
      authorityScope: [],
      conversationId: "cliagent-owner",
    } as const;

    await runConversationTurn({
      root: executionRoot,
      conversationTitle: "Shared conversation",
      displayText: "continue",
      timeline: [],
      target: {
        cliAgentType: "codex",
        accountId: "acct-codex",
        model: "gpt-5.6-sol",
      },
      turnIntentId: "turn-owner",
      publishTail: vi.fn(),
    });

    expect(mocks.continueLocalConversation).toHaveBeenCalledWith(
      expect.objectContaining({ root: executionRoot })
    );
  });

  it("publishes a non-portable transcript error when execution fails after the user row", async () => {
    const failure = new Error("native materialization failed");
    const publishTail = vi.fn().mockResolvedValue(undefined);
    mocks.continueLocalConversation.mockImplementationOnce(async () => {
      throw failure;
    });

    await expect(
      runConversationTurn({
        root: {
          authority: "org2-cloud",
          authorityScope: ["https://cloud.example", "org-1"],
          conversationId: "shared-root",
        },
        conversationTitle: "Shared conversation",
        displayText: "continue",
        timeline: [],
        target: {
          cliAgentType: "codex",
          accountId: "acct-codex",
          model: "gpt-5.6-sol",
        },
        turnIntentId: "turn-failed",
        publishTail,
      })
    ).rejects.toBeInstanceOf(QueuedConversationTurnClosedError);

    expect(publishTail).toHaveBeenCalledOnce();
    const [failureTurnId, failureEvents] = publishTail.mock.calls[0] ?? [];
    expect(failureTurnId).toBe("turn-failed");
    expect(failureEvents).toEqual([
      expect.objectContaining({
        source: "system",
        displayVariant: "error",
        displayStatus: "failed",
        result: expect.objectContaining({
          error: "native materialization failed",
        }),
      }),
    ]);
    expect(projectNativeConversationItems(failureEvents)).toEqual([]);
  });

  it("retains recovery ownership when a pre-accept failure cannot publish", async () => {
    mocks.continueLocalConversation.mockRejectedValueOnce(
      new Error("native materialization failed")
    );

    await expect(
      runConversationTurn({
        root: {
          authority: "org2-cloud",
          authorityScope: ["https://cloud.example", "org-1"],
          conversationId: "shared-root",
        },
        conversationTitle: "Shared conversation",
        displayText: "continue",
        timeline: [],
        target: {
          cliAgentType: "codex",
          accountId: "acct-codex",
          model: "gpt-5.6-sol",
        },
        turnIntentId: "turn-publish-retry",
        publishTail: vi
          .fn()
          .mockRejectedValue(
            new Org2CloudConversationError("temporary upstream failure", 503)
          ),
      })
    ).rejects.toBeInstanceOf(QueuedConversationRecoveryPendingError);
  });

  it("closes a failed turn after one definitive 4xx terminal-publication rejection", async () => {
    mocks.continueLocalConversation.mockRejectedValueOnce(
      new Error("native materialization failed")
    );
    const publishTail = vi
      .fn()
      .mockRejectedValue(new Org2CloudConversationError("ORG2_FORBIDDEN", 403));

    await expect(
      runConversationTurn({
        root: {
          authority: "org2-cloud",
          authorityScope: ["https://cloud.example", "org-1"],
          conversationId: "shared-root",
        },
        conversationTitle: "Shared conversation",
        displayText: "continue",
        timeline: [],
        target: {
          cliAgentType: "codex",
          accountId: "acct-codex",
          model: "gpt-5.6-sol",
        },
        turnIntentId: "turn-terminal-4xx",
        publishTail,
      })
    ).rejects.toBeInstanceOf(QueuedConversationTurnClosedError);

    expect(publishTail).toHaveBeenCalledOnce();
    expect(mocks.continueLocalConversation).toHaveBeenCalledOnce();
  });

  it("keeps a transient local continuation failure retryable without publishing a terminal", async () => {
    const publishTail = vi.fn();
    const pending = new QueuedConversationRecoveryPendingError(
      "native transcript is still settling"
    );
    mocks.continueLocalConversation.mockRejectedValueOnce(pending);

    await expect(
      runConversationTurn({
        root: {
          authority: "org2-cloud",
          authorityScope: ["https://cloud.example", "org-1"],
          conversationId: "shared-root",
        },
        conversationTitle: "Shared conversation",
        displayText: "continue",
        timeline: [],
        target: {
          cliAgentType: "codex",
          accountId: "acct-codex",
          model: "gpt-5.6-sol",
        },
        turnIntentId: "turn-transient",
        publishTail,
      })
    ).rejects.toBe(pending);

    expect(publishTail).not.toHaveBeenCalled();
  });
});
