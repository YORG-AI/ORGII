/**
 * Merge-relevant readers over the raw GitHub pull-request detail payload.
 *
 * `github_get_pull_request` returns the REST body enriched with GraphQL-only
 * merge metadata (`merge_state_status`, `review_decision`, and the merge-queue
 * flags — see `pulls/detail.rs`). The merge action presentation and the
 * merge-status summary both answer "can this merge, and what is stopping it?"
 * from those same fields, so the reading, the REST/GraphQL precedence, and the
 * mergeability verdict live here once instead of being re-derived per surface.
 */
import type { GitHubChecksSummary } from "@src/api/tauri/github";

export function readRecord(
  source: Record<string, unknown> | null,
  key: string
): Record<string, unknown> | null {
  const value = source?.[key];
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function readBoolean(
  source: Record<string, unknown> | null,
  key: string
): boolean | null {
  const value = source?.[key];
  return typeof value === "boolean" ? value : null;
}

export function readString(
  source: Record<string, unknown> | null,
  key: string
): string | null {
  const value = source?.[key];
  return typeof value === "string" ? value : null;
}

export interface PrMergeSignals {
  /** An auto-merge request is already recorded on the pull request. */
  autoMergeEnabled: boolean;
  /** The base repository permits auto-merge (assumed when unreported). */
  autoMergeAllowed: boolean;
  mergeQueueRequired: boolean;
  inMergeQueue: boolean;
  /** GraphQL `reviewDecision`, upper-cased, or null when GitHub reported none. */
  reviewDecision: string | null;
  mergeable: boolean | null;
  /**
   * Normalized merge state. GraphQL `mergeStateStatus` reports DIRTY reliably
   * while REST mergeability can stay unknown during GitHub's asynchronous
   * mergeability calculation, so GraphQL wins unless it says `unknown`.
   */
  mergeableState: string | null;
  /** GitHub has reported some mergeability verdict, however stale. */
  hasMergeMetadata: boolean;
  hasConflicts: boolean;
  /** Branch protection or an out-of-date base blocks the merge button. */
  policyBlocked: boolean;
  behind: boolean;
  unstable: boolean;
}

export function readPrMergeSignals(
  detail: Record<string, unknown> | null
): PrMergeSignals {
  const baseRepo = readRecord(readRecord(detail, "base"), "repo");
  const mergeable = readBoolean(detail, "mergeable");
  const restMergeableState =
    readString(detail, "mergeable_state")?.toLowerCase() ?? null;
  const graphqlMergeState =
    readString(detail, "merge_state_status")?.toLowerCase() ?? null;
  const mergeableState =
    graphqlMergeState && graphqlMergeState !== "unknown"
      ? graphqlMergeState
      : restMergeableState;

  return {
    autoMergeEnabled: readRecord(detail, "auto_merge") !== null,
    autoMergeAllowed: readBoolean(baseRepo, "allow_auto_merge") !== false,
    mergeQueueRequired: readBoolean(detail, "merge_queue_required") === true,
    inMergeQueue: readBoolean(detail, "is_in_merge_queue") === true,
    reviewDecision:
      readString(detail, "review_decision")?.toUpperCase() ?? null,
    mergeable,
    mergeableState,
    hasMergeMetadata: mergeable !== null || mergeableState !== null,
    hasConflicts: mergeable === false || mergeableState === "dirty",
    policyBlocked: mergeableState === "blocked" || mergeableState === "behind",
    behind: mergeableState === "behind",
    unstable: mergeableState === "unstable",
  };
}

/**
 * Whether GitHub would accept a merge right now.
 *
 * Without merge metadata the head commit's rolled-up check state is the only
 * evidence available, so a fully green head is treated as mergeable rather
 * than locking the button until GitHub finishes its calculation.
 */
export function isDirectMergeAvailable({
  checks,
  signals,
  status,
}: {
  checks: GitHubChecksSummary | null;
  signals: PrMergeSignals;
  status: string;
}): boolean {
  return (
    status === "open" &&
    !signals.mergeQueueRequired &&
    !signals.hasConflicts &&
    !signals.policyBlocked &&
    (signals.mergeable === true ||
      signals.mergeableState === "clean" ||
      (!signals.hasMergeMetadata && checks?.state === "success"))
  );
}
