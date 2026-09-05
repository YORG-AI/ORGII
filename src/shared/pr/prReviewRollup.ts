/**
 * Per-reviewer verdict rollup for a pull request's submitted reviews.
 *
 * GitHub's own sidebar and merge box both answer "where does each reviewer
 * stand?" the same way: the latest review per user wins, except that an
 * approval or change request outranks any later comment-only review. The
 * reviewers rail and the merge-status summary read that rollup, so the rule
 * lives here rather than in either component.
 */
import type { GitHubPrReview } from "@src/api/tauri/github";

export type PrReviewVerdictState =
  | "approved"
  | "changes_requested"
  | "commented";

export interface PrReviewVerdict {
  login: string;
  avatarUrl: string;
  state: PrReviewVerdictState;
}

function isDecisive(state: string): boolean {
  return state === "APPROVED" || state === "CHANGES_REQUESTED";
}

export function latestReviewVerdicts(
  reviews: readonly GitHubPrReview[]
): PrReviewVerdict[] {
  const latest = new Map<string, GitHubPrReview>();
  for (const review of reviews) {
    const login = review.user.login;
    if (!login || review.state === "PENDING") continue;
    const previous = latest.get(login);
    const newer =
      !previous || (review.submitted_at ?? "") >= (previous.submitted_at ?? "");
    if (!previous) {
      latest.set(login, review);
    } else if (isDecisive(review.state)) {
      if (!isDecisive(previous.state) || newer) latest.set(login, review);
    } else if (!isDecisive(previous.state) && newer) {
      latest.set(login, review);
    }
  }

  return [...latest.values()].map((review) => ({
    login: review.user.login,
    avatarUrl: review.user.avatar_url,
    state:
      review.state === "APPROVED"
        ? "approved"
        : review.state === "CHANGES_REQUESTED"
          ? "changes_requested"
          : "commented",
  }));
}

/**
 * Best-effort stand-in for GitHub's `reviewDecision`, which is only present
 * when the GraphQL enrichment succeeded. Branch protection's "review required"
 * state is not derivable from reviews alone, so an un-reviewed pull request
 * reports no decision rather than guessing one.
 */
export function rollupReviewDecision(
  reviews: readonly GitHubPrReview[]
): "APPROVED" | "CHANGES_REQUESTED" | null {
  const verdicts = latestReviewVerdicts(reviews);
  if (verdicts.some((verdict) => verdict.state === "changes_requested")) {
    return "CHANGES_REQUESTED";
  }
  if (verdicts.some((verdict) => verdict.state === "approved")) {
    return "APPROVED";
  }
  return null;
}
