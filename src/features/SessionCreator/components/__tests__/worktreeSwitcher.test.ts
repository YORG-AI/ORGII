import { describe, expect, it } from "vitest";

import type { GitWorktreeEntry } from "@src/api/http/git";

import {
  getWorktreeName,
  normalizeWorktreePath,
} from "../SessionInfoLine/worktreeSwitcher";

function worktree(path: string, isMain = false): GitWorktreeEntry {
  return {
    path,
    branch: isMain ? "develop" : "feat/worktree-switcher",
    head_sha: "1234567890abcdef",
    is_main: isMain,
  };
}

describe("worktree switcher helpers", () => {
  it("normalizes file URLs and trailing slashes for path matching", () => {
    expect(normalizeWorktreePath("file:///repo/main///")).toBe("/repo/main");
    expect(normalizeWorktreePath("/repo/main/")).toBe("/repo/main");
  });

  it("uses the worktree directory name as its compact label", () => {
    expect(getWorktreeName(worktree("/repo/worktrees/issue-332"))).toBe(
      "issue-332"
    );
  });

  it("keeps the main checkout path distinguishable from linked worktrees", () => {
    expect(getWorktreeName(worktree("/repo/ORG2", true))).toBe("ORG2");
    expect(getWorktreeName(worktree("/repo/worktrees/ORG2-fix"))).toBe(
      "ORG2-fix"
    );
  });
});
