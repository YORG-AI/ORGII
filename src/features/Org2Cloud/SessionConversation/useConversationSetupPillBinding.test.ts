import { describe, expect, it } from "vitest";

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
      importedFrom,
      rows,
    });

    expect(identity?.rootSessionId).toBe("root-a");
    expect(identity?.setupMemoryKey).toBe(
      JSON.stringify([
        "cloud-conversation-setup",
        "cloud|user-a",
        "org-a",
        "root-a",
        "agent-a",
      ])
    );
    expect(identity?.setupMemoryKey).not.toBe("repo-scope");
  });

  it("does not expose another signed-in account's remembered setup", () => {
    const first = resolveConversationSetupPillIdentity({
      authIdentity: "cloud|user-a",
      importedFrom,
      rows,
    });
    const second = resolveConversationSetupPillIdentity({
      authIdentity: "cloud|user-b",
      importedFrom,
      rows,
    });
    expect(second?.setupMemoryKey).not.toBe(first?.setupMemoryKey);
    expect(
      resolveConversationSetupPillIdentity({
        authIdentity: null,
        importedFrom,
        rows,
      })
    ).toBeNull();
  });
});
