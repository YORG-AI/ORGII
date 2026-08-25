// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  conversationExecutionKey,
  conversationExecutorScopeKey,
  conversationRootKey,
  conversationSetupMemoryKey,
  resolveImportedConversationExecutionIdentity,
  resolveLocalSessionExecutionIdentity,
} from "./conversationIdentity";

describe("provider-neutral conversation identity", () => {
  it("uses the same core key shape for local, imported, and remote roots", () => {
    const local = conversationRootKey({
      authority: "local-session",
      authorityScope: [],
      conversationId: "session-1",
    });
    const imported = conversationRootKey({
      authority: "external-history",
      authorityScope: ["claude_code"],
      conversationId: "claude-session-1",
    });
    const remote = conversationRootKey({
      authority: "remote-conversation",
      authorityScope: ["deployment-a", "org-a"],
      conversationId: "shared-root-1",
    });

    for (const key of [local, imported, remote]) {
      expect(JSON.parse(key)).toEqual([
        "org2-conversation-root",
        1,
        expect.any(String),
        expect.any(Array),
        expect.any(String),
      ]);
    }
    expect(new Set([local, imported, remote])).toHaveProperty("size", 3);
  });

  it("does not make Work Items, models, workspaces, or agents root identity", () => {
    const root = conversationRootKey({
      authority: "external-history",
      authorityScope: ["codex_app"],
      conversationId: "rollout-1",
    });
    const executor = conversationExecutorScopeKey({
      authority: "local-device",
      authorityScope: [],
    });

    expect(conversationExecutionKey(executor, root)).toBe(
      conversationExecutionKey(executor, root)
    );
    expect(
      conversationSetupMemoryKey({
        executorScope: executor,
        rootKey: root,
        agentDefinitionId: "agent-a",
      })
    ).not.toBe(
      conversationSetupMemoryKey({
        executorScope: executor,
        rootKey: root,
        agentDefinitionId: "agent-b",
      })
    );
  });

  it("isolates source authorities and local executor principals", () => {
    const claude = conversationRootKey({
      authority: "external-history",
      authorityScope: ["claude_code"],
      conversationId: "same-native-id",
    });
    const codex = conversationRootKey({
      authority: "external-history",
      authorityScope: ["codex_app"],
      conversationId: "same-native-id",
    });
    const alice = conversationExecutorScopeKey({
      authority: "remote-account",
      authorityScope: ["alice", "org-a"],
    });
    const bob = conversationExecutorScopeKey({
      authority: "remote-account",
      authorityScope: ["bob", "org-a"],
    });

    expect(claude).not.toBe(codex);
    expect(conversationExecutionKey(alice, claude)).not.toBe(
      conversationExecutionKey(bob, claude)
    );
  });

  it("rejects ambiguous empty or unbounded identity parts", () => {
    expect(() =>
      conversationRootKey({
        authority: "",
        authorityScope: [],
        conversationId: "root",
      })
    ).toThrow("root authority is required");
    expect(() =>
      conversationRootKey({
        authority: "source",
        authorityScope: Array.from({ length: 17 }, (_, index) => `${index}`),
        conversationId: "root",
      })
    ).toThrow("too many parts");
  });

  it("resolves a manual imported session without Cloud or a Work Item", () => {
    const imported = resolveImportedConversationExecutionIdentity({
      sourceKind: "claude_code",
      sourceSessionId: "claudecodeapp-native-session",
      agentDefinitionId: "local-agent",
    });
    const local = resolveLocalSessionExecutionIdentity({
      sessionId: "normal-local-session",
      agentDefinitionId: "local-agent",
    });

    expect(JSON.parse(imported.rootKey).slice(0, 3)).toEqual([
      "org2-conversation-root",
      1,
      "external-history",
    ]);
    expect(JSON.parse(imported.executorScopeKey)).toEqual(
      JSON.parse(local.executorScopeKey)
    );
    expect(imported.executionKey).not.toBe(local.executionKey);
    expect(imported.setupMemoryKey).toContain("local-agent");
  });
});
