import { describe, expect, it } from "vitest";

import type { ConversationContinuationRecord } from "./conversationContinuation";
import { decideContinuation } from "./conversationContinuation";

const established: ConversationContinuationRecord = {
  episodeId: "conversation-episode:runner-1",
  continuationSessionId: "runner-1",
  readThroughPlaneSeq: 12,
  established: true,
  agentDefinitionId: "agent-a",
  updatedAt: "2026-08-25T00:00:00Z",
};

describe("decideContinuation", () => {
  it("starts fresh without a persisted episode", () => {
    expect(
      decideContinuation({ record: null, turnIntentId: "intent-1" })
    ).toEqual({ kind: "fresh" });
  });

  it("resumes an established matching episode", () => {
    expect(
      decideContinuation({
        record: established,
        turnIntentId: "intent-2",
        assignedAgentDefinitionId: "agent-a",
      })
    ).toEqual({ kind: "resume", record: established });
  });

  it("rolls when the assigned agent changes", () => {
    expect(
      decideContinuation({
        record: established,
        turnIntentId: "intent-2",
        assignedAgentDefinitionId: "agent-b",
      })
    ).toEqual({ kind: "fresh", rollReason: "assigned_agent_changed" });
  });

  it("rolls when the desired local runtime changes", () => {
    expect(
      decideContinuation({
        record: established,
        turnIntentId: "intent-2",
        assignedAgentDefinitionId: "agent-a",
        runtimeSetupChanged: true,
      })
    ).toEqual({ kind: "fresh", rollReason: "runtime_setup_changed" });
  });

  it("retries only the exact unestablished bootstrap intent", () => {
    const prepared: ConversationContinuationRecord = {
      ...established,
      established: false,
      bootstrapTurnIntentId: "intent-bootstrap",
    };
    expect(
      decideContinuation({
        record: prepared,
        turnIntentId: "intent-bootstrap",
      })
    ).toEqual({ kind: "bootstrap", record: prepared });
    expect(
      decideContinuation({ record: prepared, turnIntentId: "intent-next" })
    ).toEqual({ kind: "fresh", rollReason: "bootstrap_intent_changed" });
  });
});
