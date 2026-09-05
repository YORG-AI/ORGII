/**
 * GitHub merge-box status summary for a pull request.
 *
 * GitHub answers "can this merge?" with a headline verdict over a short list
 * of conditions — checks, review decision, conflicts, auto-merge — and the PR
 * detail rail shows the same thing above its merge button. This module owns
 * the verdict only: every row is an identifier plus a tone, so the renderer
 * decides wording and the logic stays language-free and directly testable.
 */
import type {
  GitHubChecksSummary,
  GitHubPrReview,
} from "@src/api/tauri/github";
import {
  type CiCheckCounts,
  countCheckStates,
  flattenChecks,
} from "@src/services/git/ciCheckState";

import { resolvePullRequestDetailStatus } from "./prLevelActions";
import { isDirectMergeAvailable, readPrMergeSignals } from "./prMergeSignals";
import { rollupReviewDecision } from "./prReviewRollup";

/** Shared with `CiCheckState` so both render through the same state icon. */
export type PrMergeStatusTone = "success" | "failure" | "pending" | "neutral";

export type PrMergeHeadlineKind =
  | "ableToMerge"
  | "blocked"
  | "conflicts"
  | "queued"
  | "draft"
  | "merged"
  | "closed"
  | "checking";

export type PrMergeStatusRowKind =
  | "checksPassed"
  | "checksFailing"
  | "checksRunning"
  | "checksSkipped"
  | "checksNone"
  | "reviewApproved"
  | "reviewRequired"
  | "reviewChangesRequested"
  | "noConflicts"
  | "hasConflicts"
  | "outOfDate"
  | "checkingConflicts"
  | "autoMergeEnabled"
  | "inMergeQueue";

export interface PrMergeStatusRow {
  kind: PrMergeStatusRowKind;
  tone: PrMergeStatusTone;
  /** Populated for the check rows, which name a count in their label. */
  count?: number;
  /** True when the row opens the checks panel — only when checks exist. */
  expandable?: boolean;
}

export interface PrMergeStatusSummary {
  headline: PrMergeHeadlineKind;
  headlineTone: PrMergeStatusTone;
  rows: PrMergeStatusRow[];
  /** Rolled-up check counts, so the panel trigger can label itself. */
  checkCounts: CiCheckCounts;
}

/**
 * Merge states GitHub reports for a branch that merges cleanly. `blocked` and
 * `unstable` describe policy and check outcomes — both are surfaced by their
 * own rows — so neither means the branch has conflicts.
 */
const CONFLICT_FREE_MERGE_STATES = new Set([
  "clean",
  "blocked",
  "unstable",
  "has_hooks",
  "draft",
]);

function summarizeChecks(counts: CiCheckCounts): PrMergeStatusRow | null {
  if (counts.total === 0) return null;
  if (counts.failure > 0) {
    return {
      kind: "checksFailing",
      tone: "failure",
      count: counts.failure,
      expandable: true,
    };
  }
  if (counts.pending > 0) {
    return {
      kind: "checksRunning",
      tone: "pending",
      count: counts.pending,
      expandable: true,
    };
  }
  if (counts.success > 0) {
    // Nothing failed and nothing is still running, so the row reports the
    // verdict rather than a count — skipped runs do not dilute a green head.
    return { kind: "checksPassed", tone: "success", expandable: true };
  }
  return {
    kind: "checksSkipped",
    tone: "neutral",
    count: counts.neutral,
    expandable: true,
  };
}

function summarizeReview(decision: string | null): PrMergeStatusRow | null {
  switch (decision) {
    case "APPROVED":
      return { kind: "reviewApproved", tone: "success" };
    case "CHANGES_REQUESTED":
      return { kind: "reviewChangesRequested", tone: "failure" };
    case "REVIEW_REQUIRED":
      return { kind: "reviewRequired", tone: "pending" };
    default:
      return null;
  }
}

export function summarizePullRequestMergeStatus({
  checks,
  detail,
  fallbackStatus,
  reviews,
}: {
  checks: GitHubChecksSummary | null;
  detail: Record<string, unknown> | null;
  fallbackStatus: string;
  reviews: readonly GitHubPrReview[];
}): PrMergeStatusSummary {
  const status = resolvePullRequestDetailStatus(detail, fallbackStatus);
  const signals = readPrMergeSignals(detail);
  const checkCounts = countCheckStates(flattenChecks(checks));
  const decision = signals.reviewDecision ?? rollupReviewDecision(reviews);
  const mergeAvailable = isDirectMergeAvailable({ checks, signals, status });
  const openLike = status === "open" || status === "draft";

  const rows: PrMergeStatusRow[] = [];

  const checksRow = summarizeChecks(checkCounts);
  if (checksRow) {
    rows.push(checksRow);
  } else if (checks) {
    // The head commit was read and nothing reported — a real answer, not a
    // gap, so it earns a row rather than silently leaving the list short.
    rows.push({ kind: "checksNone", tone: "neutral" });
  }

  if (openLike) {
    const reviewRow = summarizeReview(decision);
    if (reviewRow) rows.push(reviewRow);

    if (signals.hasConflicts) {
      rows.push({ kind: "hasConflicts", tone: "failure" });
    } else if (signals.behind) {
      rows.push({ kind: "outOfDate", tone: "pending" });
    } else if (
      signals.mergeable === true ||
      (signals.mergeableState !== null &&
        CONFLICT_FREE_MERGE_STATES.has(signals.mergeableState))
    ) {
      rows.push({ kind: "noConflicts", tone: "success" });
    } else {
      // GitHub computes mergeability asynchronously; until it answers, the
      // honest report is that the answer is still being computed.
      rows.push({ kind: "checkingConflicts", tone: "pending" });
    }

    if (signals.inMergeQueue) {
      rows.push({ kind: "inMergeQueue", tone: "pending" });
    } else if (signals.autoMergeEnabled) {
      rows.push({ kind: "autoMergeEnabled", tone: "pending" });
    }
  }

  const blockedTone: PrMergeStatusTone =
    checkCounts.failure > 0 || decision === "CHANGES_REQUESTED"
      ? "failure"
      : "pending";

  const headline: PrMergeHeadlineKind =
    status === "merged"
      ? "merged"
      : status === "closed"
        ? "closed"
        : status === "draft"
          ? "draft"
          : signals.inMergeQueue
            ? "queued"
            : signals.hasConflicts
              ? "conflicts"
              : mergeAvailable
                ? "ableToMerge"
                : !signals.hasMergeMetadata && !checks
                  ? "checking"
                  : "blocked";

  const headlineTone: PrMergeStatusTone =
    headline === "ableToMerge"
      ? "success"
      : headline === "merged"
        ? "success"
        : headline === "conflicts"
          ? "failure"
          : headline === "blocked"
            ? blockedTone
            : headline === "queued" || headline === "checking"
              ? "pending"
              : "neutral";

  return { headline, headlineTone, rows, checkCounts };
}
