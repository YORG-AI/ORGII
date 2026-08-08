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
      branchName: "feat/header-spacing",
    });
  });

  it("prefers a session worktree branch", () => {
    expect(
      resolveSessionWorkstationContext({
        repoPath: "/workspace/ORGII",
        branch: "develop",
        worktreePath: "/workspace/.worktrees/header-spacing",
        worktreeBranch: "feat/header-spacing",
      } as Session)
    ).toMatchObject({
      repoName: "ORGII",
      branchName: "feat/header-spacing",
    });
  });

  it("keeps Project work-item identity in the rail context", () => {
    expect(
      resolveSessionWorkstationContext({
        productMode: "project",
        projectSlug: "orgii",
        workItemId: "WORK-42",
      } as Session)
    ).toMatchObject({
      projectSlug: "orgii",
      workItemId: "WORK-42",
    });
  });
});
