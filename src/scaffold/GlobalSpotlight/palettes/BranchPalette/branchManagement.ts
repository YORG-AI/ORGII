import type { BranchItem } from "../../types";

/** Branches that Branch Spotlight can manage directly. */
export function getManageableBranches(branches: BranchItem[]): BranchItem[] {
  return branches.filter((branch) => !branch.isCurrent && !branch.worktreePath);
}
