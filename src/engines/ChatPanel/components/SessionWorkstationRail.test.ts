import { describe, expect, it } from "vitest";

import type { Session } from "@src/store/session";

import { resolveSessionWorkstationContext } from "./SessionWorkstationRail";

describe("resolveSessionWorkstationContext", () => {
  it.each([
    ["codex", "Codex"],
    ["claude_code", "Claude"],
    ["opencode", "OpenCode"],
  ] as const)(
    "shows the persisted %s CLI as the session harness",
    (cliAgentType, expectedName) => {
      const context = resolveSessionWorkstationContext({
        session_id: `cliagent-${cliAgentType}`,
        cliAgentType,
      } as Session);

      expect(context.agentHarness?.name).toBe(expectedName);
    }
  );

  it("shows native agent sessions as the ORG2 harness", () => {
    const context = resolveSessionWorkstationContext({
      session_id: "sdeagent-native-session",
      agentDefinitionId: "builtin:sde",
      model: "claude-sonnet-5",
    } as Session);

    expect(context.agentHarness?.name).toBe("ORG2");
  });

  it("uses imported source identity for the original harness", () => {
    const context = resolveSessionWorkstationContext({
      session_id: "imported-codex-session",
      importedFrom: {
        orgId: "org-1",
        sourceSessionId: "codexapp-source-session",
        ownerMemberId: "member-1",
        epoch: 1,
        seq: 1,
        count: 1,
        externalHistorySource: "codex_app",
      },
    } as Session);

    expect(context.agentHarness?.name).toBe("Codex");
  });

  it("moves repository and branch context into the workstation rail", () => {
    expect(
      resolveSessionWorkstationContext({
        repoPath: "/workspace/ORGII",
        branch: "feat/header-spacing",
      } as Session)
    ).toMatchObject({
      repoName: "ORGII",
      repoPath: "/workspace/ORGII",
      branchName: "feat/header-spacing",
    });
  });

  it("keeps the session branch and worktree branch as separate details", () => {
    expect(
      resolveSessionWorkstationContext({
        repoPath: "/workspace/ORGII",
        branch: "develop",
        worktreePath: "/workspace/.worktrees/header-spacing",
        worktreeBranch: "feat/header-spacing",
      } as Session)
    ).toMatchObject({
      repoName: "ORGII",
      branchName: "develop",
      repoPath: "/workspace/.worktrees/header-spacing",
      worktreeBranchName: "feat/header-spacing",
      worktreePath: "/workspace/.worktrees/header-spacing",
    });
  });

  it("shows a worktree folder even when its branch metadata is absent", () => {
    expect(
      resolveSessionWorkstationContext({
        repoPath: "/workspace/ORGII",
        baseBranch: "develop",
        worktreePath: "/workspace/.worktrees/header-spacing",
      } as Session)
    ).toMatchObject({
      branchName: "develop",
      worktreeBranchName: "header-spacing",
      worktreePath: "/workspace/.worktrees/header-spacing",
    });
  });

  it("keeps Project work-item identity in the rail context", () => {
    expect(
      resolveSessionWorkstationContext({
        orgId: "cloud:org-749",
        productMode: "project",
        projectSlug: "orgii",
        workItemId: "WORK-42",
      } as Session)
    ).toMatchObject({
      orgId: "org-749",
      projectSlug: "orgii",
      workItemId: "WORK-42",
    });
  });

  it("keeps a standalone Project work item clickable without a project slug", () => {
    expect(
      resolveSessionWorkstationContext({
        orgId: "cloud:org-749",
        productMode: "project",
        workItemId: "WI-0081",
      } as Session)
    ).toEqual({
      branchName: undefined,
      environmentKind: "local",
      orgId: "org-749",
      projectSlug: undefined,
      repoName: undefined,
      repoPath: undefined,
      worktreeBranchName: undefined,
      worktreePath: undefined,
      workItemId: "WI-0081",
    });
  });

  it("never resolves an owner's cloud path as a local Git workspace", () => {
    expect(
      resolveSessionWorkstationContext({
        repoPath: "/owner/machine/ORGII",
        branch: "feat/cloud-session",
        importedFrom: {
          orgId: "org-1",
          sourceSessionId: "remote-session-1",
          sourceEndpointUrl: "https://cloud.example.com",
          ownerMemberId: "member-alice",
          ownerDisplayName: "Alice",
          ownerAvatarUrl: "https://example.com/alice.png",
          epoch: 1,
          seq: 1,
          count: 10,
        },
      } as Session)
    ).toMatchObject({
      environmentKind: "cloud",
      repoName: "ORGII",
      repoPath: undefined,
      branchName: "feat/cloud-session",
      worktreeBranchName: undefined,
      worktreePath: undefined,
      owner: {
        identityId: "member-alice",
        displayName: "Alice",
        avatarUrl: "https://example.com/alice.png",
      },
    });
  });

  it("uses safe cloud labels before a non-local session has been downloaded", () => {
    expect(
      resolveSessionWorkstationContext(
        null,
        {
          repoName: "ORGII",
          branchName: "develop",
          baseBranchName: "main",
          worktreeBranchName: "agent/remote-session",
        },
        {
          identityId: "user-alice",
          displayName: "Alice",
          avatarUrl: "https://example.com/alice.png",
        }
      )
    ).toMatchObject({
      environmentKind: "cloud",
      repoName: "ORGII",
      repoPath: undefined,
      branchName: "develop",
      worktreeBranchName: "remote-session",
      worktreePath: undefined,
      owner: {
        identityId: "user-alice",
        displayName: "Alice",
        avatarUrl: "https://example.com/alice.png",
      },
    });
  });

  it("prefers current sidebar owner presentation during a replay refresh", () => {
    expect(
      resolveSessionWorkstationContext(
        {
          importedFrom: {
            ownerMemberId: "member-alice",
            ownerDisplayName: "Old Alice",
            ownerAvatarUrl: "https://example.com/old-alice.png",
          },
        } as Session,
        { repoName: "ORGII" },
        {
          identityId: "user-alice",
          displayName: "Alice",
          avatarUrl: "https://example.com/alice.png",
        }
      ).owner
    ).toEqual({
      identityId: "user-alice",
      displayName: "Alice",
      avatarUrl: "https://example.com/alice.png",
    });
  });

  it("resolves no environment kind without a session or cloud identity", () => {
    expect(resolveSessionWorkstationContext(null, undefined)).toMatchObject({
      environmentKind: undefined,
    });
  });
});
