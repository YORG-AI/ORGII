import { describe, expect, it } from "vitest";

import { conversationExecution } from "../procedures/conversationExecution";
import {
  ConversationExecutionActivateCandidateInput,
  ConversationExecutionAdvanceCheckpointInput,
  ConversationExecutionPrepareCandidateInput,
  ConversationExecutionSnapshotSchema,
  ConversationRunnerPageInput,
} from "../schemas/conversationExecution";

const key = {
  executorScope: '["org2-conversation-executor",1,"local-device",["member"]]',
  conversationRootKey:
    '["org2-conversation-root",1,"external-history",["claude"],"session"]',
};

const checkpoint = {
  sourceCheckpointId: "checkpoint-1",
  sourceCheckpointSha256: "1".repeat(64),
  sourceEventCount: 1,
  sourceTipEventId: "event-1",
};

const profile = {
  runtimeCategory: "cli",
  runtimeId: "claude",
  agentId: "agent-1",
  accountId: "account-1",
  modelId: "model-1",
  workspaceLocator: "/authorized/workspace",
  workspaceFingerprint: "workspace-fingerprint",
  executionProfileFingerprint: "profile-fingerprint",
};

describe("conversation-execution RPC contract", () => {
  it("maps every state transition to a dedicated Tauri command", () => {
    expect(
      Object.values(conversationExecution).map((procedure) => procedure.command)
    ).toEqual([
      "conversation_execution_get",
      "conversation_execution_prepare_candidate",
      "conversation_execution_begin_materialization",
      "conversation_execution_activate_candidate",
      "conversation_execution_abort_candidate",
      "conversation_execution_advance_checkpoint",
      "conversation_execution_retire_active",
      "conversation_execution_mark_runner_terminal",
      "conversation_execution_forget_runner",
      "conversation_execution_list_runner_ids",
      "conversation_execution_list_cleanup_candidates",
      "conversation_execution_import_legacy_runners",
    ]);
  });

  it("keeps ORG2 runner identity separate from provider-native identity", () => {
    const parsed = ConversationExecutionPrepareCandidateInput.parse({
      request: {
        ...key,
        expectedRevision: 0,
        episodeId: "episode-1",
        runnerSessionId: "org2-runner-global-1",
        nativeSessionId: "provider-uuid-1",
        bootstrapIntentId: "turn-1",
        ...checkpoint,
        ...profile,
      },
    });
    expect(parsed.request.runnerSessionId).toBe("org2-runner-global-1");
    expect(parsed.request.nativeSessionId).toBe("provider-uuid-1");
    expect(parsed.request.workspaceLocator).toBe("/authorized/workspace");
  });

  it("rejects negative or unprovable source progress without a sentinel", () => {
    const base = {
      ...key,
      expectedRevision: 2,
      episodeId: "episode-1",
      runnerSessionId: "runner-1",
    };
    expect(() =>
      ConversationExecutionAdvanceCheckpointInput.parse({
        request: {
          ...base,
          sourceCheckpointId: null,
          sourceCheckpointSha256: null,
          sourceEventCount: -1,
          sourceTipEventId: null,
        },
      })
    ).toThrow();
    expect(() =>
      ConversationExecutionAdvanceCheckpointInput.parse({
        request: {
          ...base,
          sourceCheckpointId: null,
          sourceCheckpointSha256: null,
          sourceEventCount: 3,
          sourceTipEventId: "event-3",
        },
      })
    ).toThrow();
  });

  it("requires independent reparse proof and first-real-turn acceptance", () => {
    const request = {
      ...key,
      expectedRevision: 2,
      expectedActiveEpisodeId: null,
      expectedCandidateEpisodeId: "episode-1",
      runnerSessionId: "runner-1",
      nativeSessionId: "native-1",
      bootstrapIntentId: "turn-1",
      verifiedMaterializationSha256: "a".repeat(64),
      activationReceiptId: "accepted-turn-1",
    };
    expect(
      ConversationExecutionActivateCandidateInput.parse({ request }).request
        .activationReceiptId
    ).toBe("accepted-turn-1");
    expect(() =>
      ConversationExecutionActivateCandidateInput.parse({
        request: { ...request, activationReceiptId: "" },
      })
    ).toThrow();
    expect(() =>
      ConversationExecutionActivateCandidateInput.parse({
        request: { ...request, verifiedMaterializationSha256: "not-a-hash" },
      })
    ).toThrow();
  });

  it("validates an active snapshot with explicit cold-boot profile", () => {
    const now = "2026-08-26T00:00:00.000Z";
    const snapshot = ConversationExecutionSnapshotSchema.parse({
      execution: {
        ...key,
        activeEpisodeId: "episode-1",
        candidateEpisodeId: null,
        revision: 3,
        updatedAt: now,
      },
      episodes: [
        {
          ...key,
          episodeId: "episode-1",
          runnerSessionId: "runner-1",
          nativeSessionId: "provider-uuid-1",
          state: "active",
          ...checkpoint,
          ...profile,
          bootstrapIntentId: "turn-1",
          verifiedMaterializationSha256: "b".repeat(64),
          activationReceiptId: "accepted-turn-1",
          supersedesEpisodeId: null,
          rollReason: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    expect(snapshot.episodes[0].runtimeId).toBe("claude");
    expect(snapshot.episodes[0].workspaceLocator).toBe("/authorized/workspace");
  });

  it("bounds runner registry pages", () => {
    expect(
      ConversationRunnerPageInput.parse({
        request: { afterRunnerSessionId: null, limit: 500 },
      }).request.limit
    ).toBe(500);
    expect(() =>
      ConversationRunnerPageInput.parse({ request: { limit: 501 } })
    ).toThrow();
  });
});
