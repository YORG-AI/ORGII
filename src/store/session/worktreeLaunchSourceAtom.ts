/**
 * Worktree launch source atom
 *
 * Captures the source the user chose for a worktree launch. Fresh launches use
 * the source's base ref to create `agent/<session>`; existing-worktree sources
 * carry the registered checkout path to reuse. The selection is also retained
 * for creator labels and launch-payload construction.
 */
import { atom } from "jotai";

export type WorktreeCreateSourceKind =
  | "smart"
  | "github"
  | "branch"
  | "name"
  | "worktree";

export interface WorktreeLaunchSource {
  kind: WorktreeCreateSourceKind;
  label: string;
  /**
   * Human-readable base ref the user picked (branch name, PR head branch,
   * smart base). Kept for labels/UX; may not be locally resolvable on its own
   * for fork PRs.
   */
  baseBranch?: string;
  sourceRef?: string;
  title?: string;
  /**
   * A concrete, git-resolvable commit-ish (typically the PR head SHA) produced
   * by the backend `worktree_resolve_pr_base` command. When present, launch
   * prefers this over `baseBranch` as the isolated worktree's base ref — this
   * is what makes fork / cross-repo PRs (whose head branch does not exist
   * locally) actually drive worktree creation.
   */
  resolvedBaseRef?: string;
  /**
   * The PR head branch name, surfaced by the resolver as a label hint. Purely
   * informational — the worktree is always created on `agent/<session>`.
   */
  branchNameOverride?: string;
  /**
   * Existing registered worktree selected from the Branch tab. When present,
   * launch reuses this checkout instead of creating `agent/<session>`.
   */
  existingWorktreePath?: string;
}

/**
 * A source selection is scoped to the repository it was picked from. Keeping
 * the scope and source in one atom prevents a repo switch from combining an
 * old branch/SHA/worktree path with the newly selected repository.
 */
export interface WorktreeLaunchSelection {
  repoKey: string;
  source: WorktreeLaunchSource;
}

export function resolveWorktreeSelectionRepoKey(
  repoId?: string,
  repoPath?: string
): string | null {
  const id = repoId?.trim();
  if (id) return `id:${id}`;
  const path = repoPath?.trim().replace(/\/+$/, "");
  return path ? `path:${path}` : null;
}

export const worktreeLaunchSelectionAtom = atom<WorktreeLaunchSelection | null>(
  null
);
