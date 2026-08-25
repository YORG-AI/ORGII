import { describe, expect, it } from "vitest";

import {
  continuationRuntimeFingerprint,
  conversationSetupChangesRuntime,
  conversationSetupRuntimeFingerprint,
  isRunnableConversationSetup,
  resolveCloudConversationExecutionIdentity,
} from "./conversationExecutionIdentity";
import type { ConversationContinuationRecord } from "./conversationExecutionStore";

const continuation: ConversationContinuationRecord = {
  episodeId: "episode-a",
  continuationSessionId: "runner-a",
  readThroughPlaneSeq: 4,
  established: true,
  agentDefinitionId: "agent-a",
  cliAgentType: "codex",
  accountId: "account-a",
  model: "gpt-a",
  workspaceRepoPath: "/repo/a",
  updatedAt: "2026-08-25T00:00:00Z",
};

describe("cloud conversation execution identity", () => {
  it("resolves transport, executor, execution, and setup keys from one tuple", () => {
    const identity = resolveCloudConversationExecutionIdentity({
      authIdentity: "https://cloud.example|user-a",
      cloudOrgId: "org-a",
      rootSessionId: "root-a",
      assignedAgentDefinitionId: "agent-a",
    });

    expect(identity).toEqual({
      authIdentity: "https://cloud.example|user-a",
      cloudOrgId: "org-a",
      rootSessionId: "root-a",
      assignedAgentDefinitionId: "agent-a",
      planeKey: "org-a:root-a",
      executorScopeKey: JSON.stringify([
        "cloud-conversation-executor",
        "https://cloud.example|user-a",
        "org-a",
      ]),
      executionKey: JSON.stringify([
        JSON.stringify([
          "cloud-conversation-executor",
          "https://cloud.example|user-a",
          "org-a",
        ]),
        "root-a",
      ]),
      setupMemoryKey: JSON.stringify([
        "cloud-conversation-setup",
        "https://cloud.example|user-a",
        "org-a",
        "root-a",
        "agent-a",
      ]),
    });
  });

  it("isolates setup by account, org, root, and assigned agent", () => {
    const base = {
      authIdentity: "cloud|user-a",
      cloudOrgId: "org-a",
      rootSessionId: "root-a",
      assignedAgentDefinitionId: "agent-a",
    };
    const key = resolveCloudConversationExecutionIdentity(base).setupMemoryKey;
    for (const changed of [
      { ...base, authIdentity: "cloud|user-b" },
      { ...base, cloudOrgId: "org-b" },
      { ...base, rootSessionId: "root-b" },
      { ...base, assignedAgentDefinitionId: "agent-b" },
    ]) {
      expect(
        resolveCloudConversationExecutionIdentity(changed).setupMemoryKey
      ).not.toBe(key);
    }
  });

  it("rejects incomplete execution identities", () => {
    expect(() =>
      resolveCloudConversationExecutionIdentity({
        authIdentity: "",
        cloudOrgId: "org-a",
        rootSessionId: "root-a",
      })
    ).toThrow("auth identity");
  });
});

describe("conversation runtime fingerprint", () => {
  const matchingSetup = {
    workspaceRepoPath: "/repo/a",
    execution: {
      agentDefinitionId: "agent-a",
      cliAgentType: "codex" as const,
      accountId: "account-a",
      model: "gpt-a",
    },
  };

  it("matches the exact runtime used to launch an episode", () => {
    expect(conversationSetupRuntimeFingerprint(matchingSetup)).toBe(
      continuationRuntimeFingerprint(continuation)
    );
    expect(conversationSetupChangesRuntime(continuation, matchingSetup)).toBe(
      false
    );
  });

  it.each([
    ["agent", { execution: { agentDefinitionId: "agent-b" } }],
    ["runtime", { execution: { cliAgentType: "claude_code" as const } }],
    ["account", { execution: { accountId: "account-b" } }],
    ["model", { execution: { model: "gpt-b" } }],
    ["workspace", { workspaceRepoPath: "/repo/b" }],
  ])("rolls for a changed %s", (_label, override) => {
    const setup = {
      ...matchingSetup,
      ...override,
      execution: {
        ...matchingSetup.execution,
        ...("execution" in override ? override.execution : {}),
      },
    };
    expect(conversationSetupChangesRuntime(continuation, setup)).toBe(true);
  });

  it("requires an explicit account for a remembered External CLI", () => {
    expect(
      isRunnableConversationSetup({
        workspaceRepoPath: null,
        execution: {
          agentDefinitionId: "agent-a",
          cliAgentType: "codex",
        },
      })
    ).toBe(false);
    expect(isRunnableConversationSetup(matchingSetup)).toBe(true);
  });
});
