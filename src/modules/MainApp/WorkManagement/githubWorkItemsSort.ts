import type { ManagedGitHubItem } from "./githubManagedItemModel";

export interface GitHubWorkItemsSort {
  column: "id" | "updated";
  order: "ascend" | "descend";
}

/** GitHub Issues open with the largest issue number first. */
export const DEFAULT_GITHUB_ISSUES_SORT = {
  column: "id",
  order: "descend",
} as const satisfies GitHubWorkItemsSort;

/** GitHub PRs open with the largest pull-request number first. */
export const DEFAULT_GITHUB_PULL_REQUESTS_SORT = {
  column: "id",
  order: "descend",
} as const satisfies GitHubWorkItemsSort;

export function compareManagedGitHubItems(
  left: ManagedGitHubItem,
  right: ManagedGitHubItem,
  sort: GitHubWorkItemsSort
): number {
  const primaryComparison =
    sort.column === "updated"
      ? left.updatedAt.localeCompare(right.updatedAt)
      : left.id - right.id;
  if (primaryComparison !== 0) {
    return sort.order === "descend" ? -primaryComparison : primaryComparison;
  }

  // Keep equal timestamps deterministic while preserving the default visual
  // expectation that larger issue/PR numbers come first.
  const idComparison = right.id - left.id;
  if (idComparison !== 0) return idComparison;
  return left.repo.localeCompare(right.repo);
}

export function sortManagedGitHubItems(
  items: readonly ManagedGitHubItem[],
  sort: GitHubWorkItemsSort
): ManagedGitHubItem[] {
  return [...items].sort((left, right) =>
    compareManagedGitHubItems(left, right, sort)
  );
}
