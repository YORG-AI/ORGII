import { gitApi } from "@src/api/http/git";
import { getPRLocal, resolvePrWorktreeBase } from "@src/api/tauri/github";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Prepare a local PR branch without changing HEAD or resetting local commits.
 * The caller must then use its normal guarded branch checkout dispatcher.
 */
export async function preparePullRequestBranch({
  repoId,
  repoPath,
  repoFullName,
  remote,
  prNumber,
  isActive,
}: {
  repoId: string;
  repoPath: string;
  repoFullName: string;
  remote: string;
  prNumber: number;
  /** Stop before the next operation if the picker closed or changed scope. */
  isActive: () => boolean;
}): Promise<string | null> {
  const detail = await getPRLocal(repoFullName, prNumber);
  if (!isActive()) return null;
  const head = record(detail.head);
  const headRepo = record(head?.repo);
  const sameRepo =
    typeof headRepo?.full_name === "string" &&
    headRepo.full_name.toLowerCase() === repoFullName.toLowerCase();
  if (typeof head?.ref !== "string" || !head.ref.trim()) {
    throw new Error("Pull request has no head branch");
  }
  // Fork names can collide with unrelated branches on the base repository.
  const branchName = sameRepo ? head.ref : `pr/${prNumber}`;
  const branches = await gitApi.getGitBranches({
    repo_id: repoId,
    repo_path: repoPath,
    include_remote: false,
  });
  if (!isActive()) return null;
  if (!branches) throw new Error("Could not read local branches");
  if (
    branches.branches.some(
      (branch) => branch.name === branchName && branch.branch_type === "local"
    )
  ) {
    return branchName;
  }

  // Always fetch the PR ref. A branch-name fetch can resolve a different
  // same-named branch in the base repo for a fork PR.
  const resolution = await resolvePrWorktreeBase({
    repoPath,
    prNumber,
    remote,
  });
  if (!isActive()) return null;
  const result = await gitApi.gitCreateBranch({
    repo_id: repoId,
    repo_path: repoPath,
    name: branchName,
    start_point: resolution.headSha,
    checkout: false,
  });
  if (!result.success)
    throw new Error(result.error || "Could not create PR branch");
  return isActive() ? branchName : null;
}
