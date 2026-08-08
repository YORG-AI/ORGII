export const BRANCH_REMOTE_MUTATION_EVENT = "orgii:git-branch-remote-mutation";

export interface BranchRemoteMutationDetail {
  repoId?: string;
  repoPath?: string;
  branchName?: string;
  reason: "push" | "pull-request-created";
}

/**
 * Announce that GitHub-visible state for a local branch may have changed.
 * Consumers still match repo/branch before refreshing, so a push in another
 * workspace cannot wake every status surface in the app.
 */
export function announceBranchRemoteMutation(
  detail: BranchRemoteMutationDetail
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<BranchRemoteMutationDetail>(BRANCH_REMOTE_MUTATION_EVENT, {
      detail,
    })
  );
}

export function isMatchingBranchRemoteMutation(
  detail: BranchRemoteMutationDetail | undefined,
  target: {
    repoId: string;
    repoPath: string;
    branchName: string;
  }
): boolean {
  if (!detail) return false;
  if (detail.repoId && detail.repoId !== target.repoId) return false;
  if (detail.repoPath && detail.repoPath !== target.repoPath) return false;
  if (detail.branchName && detail.branchName !== target.branchName)
    return false;
  return true;
}
