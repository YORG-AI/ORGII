import { describe, expect, it } from "vitest";

import type { BranchItem } from "../../../types";
import { getManageableBranches } from "../branchManagement";

describe("getManageableBranches", () => {
  it("returns only non-current branches that are not checked out in worktrees", () => {
    const branches: BranchItem[] = [
      { name: "main", isCurrent: true, isRemote: false },
      { name: "feature/plain", isCurrent: false, isRemote: false },
      {
        name: "feature/worktree",
        isCurrent: false,
        isRemote: false,
        worktreePath: "/tmp/feature-worktree",
      },
    ];

    expect(getManageableBranches(branches)).toEqual([
      { name: "feature/plain", isCurrent: false, isRemote: false },
    ]);
  });
});
