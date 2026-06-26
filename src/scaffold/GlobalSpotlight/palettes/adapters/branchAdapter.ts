/**
 * Branch Adapter
 *
 * Converts BranchItem domain objects into SpotlightItem format.
 * Shared across BranchSelector and the main spotlight.
 */
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import { ICONS } from "../../config";
import type { BranchItem, SpotlightItem } from "../../types";

export interface BuildBranchItemOptions {
  currentBranchName?: string;
  onAction: (branch: BranchItem) => void;
  /** Prefix for item IDs */
  idPrefix?: string;
}

/**
 * Converts a single BranchItem to a SpotlightItem (main spotlight variant).
 * Uses a more descriptive desc with branch type + last commit.
 */
export function buildBranchSpotlightItem(
  branch: BranchItem,
  options: BuildBranchItemOptions
): SpotlightItem {
  const { onAction, idPrefix = "branch-" } = options;

  const branchType = branch.isCurrent
    ? "Current branch"
    : branch.isRemote
      ? "Remote"
      : "Local";
  const lastCommit = branch.lastCommitDate
    ? formatRelativeTime(branch.lastCommitDate, "short")
    : "";
  const desc = lastCommit ? `${branchType} · ${lastCommit}` : branchType;

  return {
    id: `${idPrefix}${branch.name}`,
    label: branch.name,
    desc,
    icon: branch.worktreePath ? ICONS.worktree : ICONS.branch,
    type: "branch" as const,
    statusType: branch.isCurrent ? ("ongoing" as const) : undefined,
    data: { ...branch },
    action: () => onAction(branch),
  };
}

/**
 * Converts an array of BranchItems to SpotlightItems.
 */
export function buildBranchSpotlightItems(
  branches: BranchItem[],
  options: BuildBranchItemOptions
): SpotlightItem[] {
  return branches.map((branch) => buildBranchSpotlightItem(branch, options));
}
