import { describe, expect, it } from "vitest";

import type { Session } from "@src/store/session";

import { resolveSessionWorkstationContext } from "./SessionWorkstationRail";

describe("resolveSessionWorkstationContext", () => {
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
          epoch: 1,
          seq: 1,
          count: 10,
        },
      } as Session)
    ).toMatchObject({
      repoName: "ORGII",
      repoPath: undefined,
      branchName: "feat/cloud-session",
      worktreeBranchName: undefined,
      worktreePath: undefined,
    });
  });

  it("uses safe cloud labels before a non-local session has been downloaded", () => {
    expect(
      resolveSessionWorkstationContext(null, {
        repoName: "ORGII",
        branchName: "develop",
        baseBranchName: "main",
        worktreeBranchName: "agent/remote-session",
      })
    ).toMatchObject({
      repoName: "ORGII",
      repoPath: undefined,
      branchName: "develop",
      worktreeBranchName: "remote-session",
      worktreePath: undefined,
    });
  });
});
