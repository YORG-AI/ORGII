/**
 * Branch categorization utilities for GlobalSpotlight
 */
import type { BranchItem } from "../types";

interface CategorizedBranches {
  recent: BranchItem[]; // Top 5 most recent branches (incl. current if eligible)
  worktrees: BranchItem[]; // Branches checked out in a secondary worktree
  default: BranchItem[];
  other: BranchItem[];
}

/**
 * Categorize branches into Recent (top 5), Worktrees, Default, and Other.
 * - Recent: Top 5 most recently updated branches (by commit date)
 * - Worktrees: Branches checked out in a secondary worktree (excluding
 *   Recent; the BranchItem must already carry `worktreePath`)
 * - Default: Branches named "main", "master", "develop", "dev"
 *   (excluding Recent + Worktrees)
 * - Other: All other branches
 *
 * Each branch appears in exactly one bucket — Recent wins over
 * Worktrees, which wins over Default, which wins over Other.
 */
export function categorizeBranches(
  branches: BranchItem[],
  defaultBranchNames: string[] = ["main", "master", "develop", "dev"]
): CategorizedBranches {
  // First, sort all branches by commit date (most recent first)
  const sortedByDate = [...branches].sort((a, b) => {
    // Current branch priority
    if (a.isCurrent && !b.isCurrent) return -1;
    if (!a.isCurrent && b.isCurrent) return 1;

    // Then by commit date
    if (a.lastCommitDate && b.lastCommitDate) {
      return (
        new Date(b.lastCommitDate).getTime() -
        new Date(a.lastCommitDate).getTime()
      );
    }
    if (a.lastCommitDate) return -1;
    if (b.lastCommitDate) return 1;

    return 0;
  });

  // Take top 5 most recent
  const recentBranches = sortedByDate.slice(0, 5);
  const recentBranchNames = new Set(
    recentBranches.map((branch) => branch.name)
  );

  // Categorize remaining branches
  const worktreeBranches: BranchItem[] = [];
  const defaultBranches: BranchItem[] = [];
  const otherBranches: BranchItem[] = [];

  for (const branch of branches) {
    // Skip if already in recent
    if (recentBranchNames.has(branch.name)) {
      continue;
    }

    // Worktree wins over default/other
    if (branch.worktreePath) {
      worktreeBranches.push(branch);
      continue;
    }

    // Check if it's a default branch
    const isDefault = defaultBranchNames.includes(branch.name.toLowerCase());

    if (isDefault) {
      defaultBranches.push(branch);
    } else {
      otherBranches.push(branch);
    }
  }

  // Sort default and other branches
  const sortBranches = (a: BranchItem, b: BranchItem) => {
    // Current branch always first
    if (a.isCurrent && !b.isCurrent) return -1;
    if (!a.isCurrent && b.isCurrent) return 1;

    // Then by commit date (most recent first)
    if (a.lastCommitDate && b.lastCommitDate) {
      return (
        new Date(b.lastCommitDate).getTime() -
        new Date(a.lastCommitDate).getTime()
      );
    }
    if (a.lastCommitDate) return -1;
    if (b.lastCommitDate) return 1;

    // Finally alphabetically
    return a.name.localeCompare(b.name);
  };

  worktreeBranches.sort(sortBranches);
  defaultBranches.sort(sortBranches);
  otherBranches.sort(sortBranches);

  return {
    recent: recentBranches,
    worktrees: worktreeBranches,
    default: defaultBranches,
    other: otherBranches,
  };
}
