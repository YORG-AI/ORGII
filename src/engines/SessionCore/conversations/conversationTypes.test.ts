import { describe, expect, it } from "vitest";

import {
  isConversationRootLocator,
  isLocalConversationTarget,
} from "./conversationTypes";

describe("isLocalConversationTarget", () => {
  it("accepts native CLI and ORG2 agent targets", () => {
    expect(
      isLocalConversationTarget({
        cliAgentType: "claude_code",
        accountId: "anthropic-1",
        model: "opus",
        workspaceRepoPath: "/repo",
      })
    ).toBe(true);
    expect(
      isLocalConversationTarget({
        agentDefinitionId: "agent-1",
        accountId: "account-1",
        model: "model-1",
      })
    ).toBe(true);
  });

  it("rejects malformed durable queue targets", () => {
    expect(isLocalConversationTarget({})).toBe(false);
    expect(isLocalConversationTarget({ cliAgentType: "" })).toBe(false);
    expect(
      isLocalConversationTarget({
        cliAgentType: "codex",
        agentDefinitionId: "agent-1",
      })
    ).toBe(false);
    expect(
      isLocalConversationTarget({
        agentDefinitionId: "agent-1",
        accountId: "account-1",
      })
    ).toBe(false);
    expect(
      isLocalConversationTarget({
        cliAgentType: "codex",
        workspaceRepoPath: 42,
      })
    ).toBe(false);
    expect(
      isLocalConversationTarget({
        cliAgentType: "claude_code",
        accountId: "",
      })
    ).toBe(false);
    expect(
      isLocalConversationTarget({
        cliAgentType: "codex",
        model: "",
      })
    ).toBe(false);
  });
});

describe("isConversationRootLocator", () => {
  it("rejects identities whose serialized form aliases another root", () => {
    expect(
      isConversationRootLocator({
        authority: "local-session",
        authorityScope: [],
        conversationId: "root-1",
      })
    ).toBe(true);
    expect(
      isConversationRootLocator({
        authority: " local-session ",
        authorityScope: [],
        conversationId: "root-1",
      })
    ).toBe(false);
    expect(
      isConversationRootLocator({
        authority: "org2-cloud",
        authorityScope: [" org-1"],
        conversationId: "root-1",
      })
    ).toBe(false);
  });
});
