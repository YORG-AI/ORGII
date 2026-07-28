import { describe, expect, it } from "vitest";

import type { GitWorktreeDiffSummary } from "@src/api/http/git/types";

import {
  diffStatsFromSummary,
  extractMainWorktreeDiffSummary,
  filterScopePickerWorktrees,
  formatScopePickerPath,
  mainScopeMatchesQuery,
  readSourceControlScope,
  reconcileSourceControlScope,
  resolveScopeBranchLabel,
  resolveScopeBreadcrumbSegments,
  resolveScopeRepoRoot,
  scopePickerRowLabel,
  scopePickerRowTitle,
  shouldShowScopePickerSearch,
  sortWorktreesByDiffActivity,
  sourceControlScopeStorageKey,
  truncateScopeBreadcrumbLabel,
  worktreeFolderName,
} from "../sourceControlScopePickerHelpers";

function createSummary(
  overrides: Partial<GitWorktreeDiffSummary> = {}
): GitWorktreeDiffSummary {
  return {
    total_files: 3,
    total_additions: 10,
    total_deletions: 4,
    committed_files: 1,
    committed_additions: 2,
    committed_deletions: 1,
    uncommitted_files: 2,
    uncommitted_additions: 8,
    uncommitted_deletions: 3,
    base_ref: "main",
    ...overrides,
  };
}

describe("diffStatsFromSummary", () => {
  it("returns uncommitted additions and deletions for the picker badge", () => {
    expect(diffStatsFromSummary(createSummary())).toEqual({
      additions: 8,
      deletions: 3,
    });
  });

  it("returns null for missing summary", () => {
    expect(diffStatsFromSummary(null)).toBeNull();
    expect(diffStatsFromSummary(undefined)).toBeNull();
  });

  it("returns null when there are no uncommitted changes", () => {
    expect(
      diffStatsFromSummary(
        createSummary({
          uncommitted_files: 0,
          uncommitted_additions: 0,
          uncommitted_deletions: 0,
        })
      )
    ).toBeNull();
  });
});

describe("extractMainWorktreeDiffSummary", () => {
  it("returns diff summary from the main worktree entry", () => {
    const mainSummary = createSummary({
      total_additions: 387,
      total_deletions: 45,
    });
    expect(
      extractMainWorktreeDiffSummary([
        { is_main: false, diff_summary: createSummary({ total_additions: 1 }) },
        { is_main: true, diff_summary: mainSummary },
      ])
    ).toBe(mainSummary);
  });

  it("returns null when no main entry exists", () => {
    expect(
      extractMainWorktreeDiffSummary([
        { is_main: false, diff_summary: createSummary() },
      ])
    ).toBeNull();
  });
});

describe("formatScopePickerPath", () => {
  it("abbreviates paths under the home directory with tilde", () => {
    const home = process.env.HOME;
    if (!home) return;

    expect(
      formatScopePickerPath(`${home}/github/ORGII`).replace(/\\/g, "/")
    ).toBe("~/github/ORGII");
  });
});

describe("sortWorktreesByDiffActivity", () => {
  it("orders worktrees by total diff activity descending", () => {
    const sorted = sortWorktreesByDiffActivity([
      {
        path: "/tmp/low",
        branch: "low",
        diff_summary: createSummary({ total_additions: 1, total_deletions: 0 }),
      },
      {
        path: "/tmp/high",
        branch: "high",
        diff_summary: createSummary({
          total_additions: 100,
          total_deletions: 20,
        }),
      },
    ]);

    expect(sorted.map((entry) => entry.path)).toEqual([
      "/tmp/high",
      "/tmp/low",
    ]);
  });
});

describe("resolveScopeBranchLabel", () => {
  it("prefers the selected worktree branch over the host branch", () => {
    expect(
      resolveScopeBranchLabel("main", {
        branch: "fix/issue-109-worktree-diff-summary",
      })
    ).toBe("fix/issue-109-worktree-diff-summary");
  });

  it("falls back to the host branch when no worktree is selected", () => {
    expect(resolveScopeBranchLabel("main")).toBe("main");
  });
});

describe("sourceControlScopeStorageKey", () => {
  it("normalizes trailing slashes", () => {
    expect(sourceControlScopeStorageKey("/tmp/repo/")).toBe("/tmp/repo");
  });
});

describe("reconcileSourceControlScope", () => {
  it("keeps a worktree scope while the worktree list is still loading", () => {
    expect(
      reconcileSourceControlScope({ kind: "worktree", path: "/tmp/wt" }, [], {
        worktreesReady: false,
      })
    ).toEqual({ kind: "worktree", path: "/tmp/wt" });
  });

  it("falls back to local when the worktree no longer exists", () => {
    expect(
      reconcileSourceControlScope(
        { kind: "worktree", path: "/tmp/missing" },
        [{ path: "/tmp/other" }],
        { worktreesReady: true }
      )
    ).toEqual({ kind: "local" });
  });

  it("matches worktree paths after normalization", () => {
    expect(
      reconcileSourceControlScope(
        { kind: "worktree", path: "/tmp/wt/" },
        [{ path: "/tmp/wt" }],
        { worktreesReady: true }
      )
    ).toEqual({ kind: "worktree", path: "/tmp/wt/" });
  });
});

describe("resolveScopeRepoRoot", () => {
  it("returns the host path for local scope", () => {
    expect(resolveScopeRepoRoot({ kind: "local" }, "/tmp/repo")).toBe(
      "/tmp/repo"
    );
  });

  it("returns the worktree path for worktree scope", () => {
    expect(
      resolveScopeRepoRoot({ kind: "worktree", path: "/tmp/wt" }, "/tmp/repo")
    ).toBe("/tmp/wt");
  });
});

describe("readSourceControlScope", () => {
  it("reads scope by normalized repo path", () => {
    const map = {
      "/tmp/repo": { kind: "worktree" as const, path: "/tmp/wt" },
    };
    expect(readSourceControlScope(map, "/tmp/repo/")).toEqual({
      kind: "worktree",
      path: "/tmp/wt",
    });
  });
});

describe("worktreeFolderName", () => {
  it("returns the last path segment", () => {
    expect(worktreeFolderName("/tmp/orgii/agent-abc")).toBe("agent-abc");
  });

  it("falls back when path is empty", () => {
    expect(worktreeFolderName("")).toBe("worktree");
  });
});

describe("truncateScopeBreadcrumbLabel", () => {
  it("returns the label unchanged when within the limit", () => {
    expect(truncateScopeBreadcrumbLabel("fix/issue-10")).toBe("fix/issue-10");
  });

  it("truncates long labels with an ellipsis", () => {
    const longBranch = "fix/very-long-branch-name-that-overflows";
    expect(truncateScopeBreadcrumbLabel(longBranch)).toBe(
      "fix/very-long-branch-name-t…"
    );
  });
});

describe("resolveScopeBreadcrumbSegments", () => {
  it("shows only the branch for local scope", () => {
    expect(
      resolveScopeBreadcrumbSegments({
        repoName: "ORGII",
        branchLabel: "fix/issue-10",
        scope: { kind: "local" },
      })
    ).toEqual([{ label: "fix/issue-10", tone: "primary" }]);
  });

  it("shows only the branch for worktree scope", () => {
    expect(
      resolveScopeBreadcrumbSegments({
        repoName: "ORGII",
        branchLabel: "fix/issue-173-redo",
        scope: { kind: "worktree", path: "/tmp/orgii/issue-173-redo" },
        selectedWorktreePath: "/tmp/orgii/issue-173-redo",
      })
    ).toEqual([{ label: "fix/issue-173-redo", tone: "primary" }]);
  });

  it("omits worktree folder even when it differs from the branch name", () => {
    expect(
      resolveScopeBreadcrumbSegments({
        repoName: "ORGII",
        branchLabel: "feat/agent-task",
        scope: { kind: "worktree", path: "/tmp/orgii/agent-abc" },
        selectedWorktreePath: "/tmp/orgii/agent-abc",
      })
    ).toEqual([{ label: "feat/agent-task", tone: "primary" }]);
  });

  it("omits orgii-prefixed folder when branch uses slash segments", () => {
    expect(
      resolveScopeBreadcrumbSegments({
        repoName: "ORGII",
        branchLabel: "fix/issue-165-session-pill",
        scope: {
          kind: "worktree",
          path: "/tmp/orgii/orgii-issue-165-fix-session-pill",
        },
        selectedWorktreePath: "/tmp/orgii/orgii-issue-165-fix-session-pill",
      })
    ).toEqual([{ label: "fix/issue-165-session-pill", tone: "primary" }]);
  });

  it("ignores a worktree prefix when scope is local", () => {
    expect(
      resolveScopeBreadcrumbSegments({
        repoName: "ORGII",
        branchLabel: "main",
        scope: { kind: "local" },
        selectedWorktreePath: "/tmp/orgii/agent-abc",
      })
    ).toEqual([{ label: "main", tone: "primary" }]);
  });
});

describe("scopePickerRowLabel", () => {
  it("shows branch only for main checkout (repo context is implicit)", () => {
    expect(scopePickerRowLabel("main", "ORGII", "fix/issue-10")).toBe(
      "fix/issue-10"
    );
  });

  it("falls back to repo name when main checkout has no branch", () => {
    expect(scopePickerRowLabel("main", "ORGII", "")).toBe("ORGII");
  });

  it("prefers branch name for worktree rows", () => {
    expect(
      scopePickerRowLabel(
        "worktree",
        "orgii-issue-161",
        "agent/issue-161-ds-agent"
      )
    ).toBe("agent/issue-161-ds-agent");
  });
});

describe("scopePickerRowTitle", () => {
  it("shows repo path for main checkout tooltip", () => {
    expect(
      scopePickerRowTitle(
        "main",
        "ORGII",
        "fix/issue-10",
        "/Users/junyu/github/ORGII"
      )
    ).toContain("ORGII");
  });

  it("includes path details in the tooltip title", () => {
    expect(
      scopePickerRowTitle(
        "worktree",
        "wt-folder",
        "feat/x",
        "/tmp/orgii/wt-folder"
      )
    ).toContain("wt-folder");
  });
});

describe("scope picker search helpers", () => {
  const worktrees = [
    {
      path: "/tmp/orgii/agent-alpha",
      branch: "feat/alpha",
    },
    {
      path: "/tmp/orgii/agent-beta",
      branch: "fix/beta",
    },
  ];

  it("shows search when there are at least five worktrees", () => {
    expect(shouldShowScopePickerSearch(4)).toBe(false);
    expect(shouldShowScopePickerSearch(5)).toBe(true);
  });

  it("filters worktrees by folder name or branch", () => {
    expect(filterScopePickerWorktrees(worktrees, "alpha")).toEqual([
      worktrees[0],
    ]);
    expect(filterScopePickerWorktrees(worktrees, "fix/beta")).toEqual([
      worktrees[1],
    ]);
  });

  it("matches the main checkout by repo or branch", () => {
    expect(
      mainScopeMatchesQuery("ORGII", "fix/issue-10", "/tmp/orgii", "issue-10")
    ).toBe(true);
    expect(
      mainScopeMatchesQuery("ORGII", "fix/issue-10", "/tmp/orgii", "missing")
    ).toBe(false);
  });
});
