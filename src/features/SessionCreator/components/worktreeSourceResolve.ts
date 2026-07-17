/**
 * Pure helpers for turning a resolved PR base (`worktree_resolve_pr_base`
 * output) into an updated `WorktreeLaunchSource`. Extracted from
 * `WorktreeSourceModal` so the mapping is unit-testable without React.
 */
import type { PrBaseResolution } from "@src/api/tauri/github";
import type { WorktreeLaunchSource } from "@src/store/session/worktreeLaunchSourceAtom";

/**
 * True when the source is a GitHub PR (its `sourceRef` is `pr:<number>`).
 * Issue rows (`issue:<number>`) and non-github kinds return false — they
 * cannot be resolved to a git base and must launch unchanged.
 */
export function isPrSource(source: WorktreeLaunchSource | null): boolean {
  return Boolean(
    source && source.kind === "github" && source.sourceRef?.startsWith("pr:")
  );
}

/** Extract the PR number from a `pr:<number>` sourceRef, or null. */
export function prNumberFromSourceRef(sourceRef?: string): number | null {
  if (!sourceRef?.startsWith("pr:")) return null;
  const raw = sourceRef.slice("pr:".length);
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Fold a resolved PR base into a launch source. The concrete head SHA becomes
 * `resolvedBaseRef` (what launch feeds git); the head branch name — when the
 * resolver surfaced one — becomes the label-friendly `baseBranch` /
 * `branchNameOverride`. Falls back to the source's existing `baseBranch` when
 * the resolver had no branch name (fork PR resolved purely via
 * `refs/pull/<n>/head`).
 */
export function mergeResolvedPrBase(
  source: WorktreeLaunchSource,
  resolution: PrBaseResolution
): WorktreeLaunchSource {
  const branchOverride = resolution.branchNameOverride?.trim() || undefined;
  return {
    ...source,
    resolvedBaseRef: resolution.baseRef,
    ...(branchOverride ? { branchNameOverride: branchOverride } : {}),
    baseBranch: branchOverride ?? source.baseBranch,
  };
}
