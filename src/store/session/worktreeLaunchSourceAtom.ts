/**
 * Worktree launch source atom
 *
 * Captures the source the user chose when configuring an isolated worktree
 * launch. The backend still creates the physical worktree from the session
 * id; this metadata lets the creator UI remember whether the user selected a
 * PR, issue, branch, smart suggestion, or manual name.
 */
import { atom } from "jotai";

export type WorktreeCreateSourceKind = "smart" | "github" | "branch" | "name";

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
}

export const worktreeLaunchSourceAtom = atom<WorktreeLaunchSource | null>(null);
