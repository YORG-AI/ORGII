import { describe, expect, it } from "vitest";

import { conversationSetupMemoryKey } from "@src/engines/SessionCore/conversations";

import { resolveConversationSetupPillIdentity } from "./useConversationSetupPillBinding";

describe("conversation setup pill identity", () => {
  const importedFrom = { orgId: "org-a", sourceSessionId: "member-turn" };
  const rows = [
    {
      sourceSessionId: "member-turn",
      forkedFrom: { rootSessionId: "root-a" },
    },
    {
      sourceSessionId: "root-a",
      agentDefinitionId: "agent-a",
    },
  ];

  it("uses the same account/org/root/agent setup tuple as execution", () => {
    const identity = resolveConversationSetupPillIdentity({
      authIdentity: "cloud|user-a",
      cloudEndpoint: "https://cloud.example",
      importedFrom,
      rows,
    });

    expect(identity?.rootSessionId).toBe("root-a");
    expect(identity?.setupMemoryKey).toBe(
      conversationSetupMemoryKey({
        executorScope: identity?.executorScopeKey ?? "",
        rootKey: identity?.rootKey ?? "",
        agentDefinitionId: "agent-a",
      })
    );
    expect(identity?.setupMemoryKey).not.toBe("repo-scope");
  });

  it("does not expose another signed-in account's remembered setup", () => {
    const first = resolveConversationSetupPillIdentity({
      authIdentity: "cloud|user-a",
      cloudEndpoint: "https://cloud.example",
      importedFrom,
      rows,
    });
    const second = resolveConversationSetupPillIdentity({
      authIdentity: "cloud|user-b",
      cloudEndpoint: "https://cloud.example",
      importedFrom,
      rows,
    });
    expect(second?.setupMemoryKey).not.toBe(first?.setupMemoryKey);
    expect(
      resolveConversationSetupPillIdentity({
        authIdentity: null,
        cloudEndpoint: "https://cloud.example",
        importedFrom,
        rows,
      })
    ).toBeNull();
  });
});
