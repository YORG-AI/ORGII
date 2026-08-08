/**
 * CI check-state derivation shared by every surface that renders GitHub
 * checks — the PR detail panel and the status-bar CI menu.
 *
 * `github_get_checks` returns two shapes for the same head commit (modern
 * check-runs and legacy commit statuses). Both surfaces need the same
 * per-check verdict and the same notion of "everything has reported", so the
 * mapping lives here instead of being re-derived per component.
 */
import type {
  GitHubCheckRun,
  GitHubChecksSummary,
  GitHubStatusContext,
} from "@src/api/tauri/github";

export type CiCheckState = "success" | "failure" | "pending" | "neutral";

export function checkRunState(run: GitHubCheckRun): CiCheckState {
  if (run.status !== "completed") return "pending";
  switch (run.conclusion) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
    case "action_required":
    case "cancelled":
    case "startup_failure":
      return "failure";
    case "neutral":
    case "skipped":
    case "stale":
      return "neutral";
    default:
      // `completed` without a conclusion — GitHub still owes us a verdict.
      return "pending";
  }
}

export function statusContextState(status: GitHubStatusContext): CiCheckState {
  switch (status.state) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    case "pending":
      return "pending";
    default:
      return "neutral";
  }
}

export interface CiCheckItem {
  key: string;
  /** Check name on its own — callers decide whether to qualify it. */
  name: string;
  /** Reporting app ("GitHub Actions"), or null for legacy commit statuses. */
  appName: string | null;
  description: string | null;
  state: CiCheckState;
  detailsUrl: string | null;
  /** ISO timestamp, or null for legacy commit statuses (no timing reported). */
  startedAt: string | null;
  completedAt: string | null;
}

/**
 * Flattens check-runs and commit statuses into one list, preserving the order
 * GitHub returned them in (runs first, then statuses) so callers that render a
 * flat list keep the API's ordering.
 */
export function flattenChecks(
  summary: GitHubChecksSummary | null
): CiCheckItem[] {
  if (!summary) return [];

  const items: CiCheckItem[] = summary.check_runs.map((run) => ({
    key: `run-${run.id}`,
    name: run.name,
    appName: run.app_name,
    description: run.output_title,
    state: checkRunState(run),
    detailsUrl: run.details_url,
    startedAt: run.started_at,
    completedAt: run.completed_at,
  }));

  for (const status of summary.statuses) {
    items.push({
      key: `status-${status.context}`,
      name: status.context,
      appName: null,
      description: status.description,
      state: statusContextState(status),
      detailsUrl: status.target_url,
      startedAt: null,
      completedAt: null,
    });
  }

  return items;
}

export interface CiCheckCounts {
  total: number;
  success: number;
  failure: number;
  pending: number;
  neutral: number;
}

export function countCheckStates(items: CiCheckItem[]): CiCheckCounts {
  const counts: CiCheckCounts = {
    total: items.length,
    success: 0,
    failure: 0,
    pending: 0,
    neutral: 0,
  };
  for (const item of items) {
    counts[item.state] += 1;
  }
  return counts;
}

/**
 * True once every reported check has a final verdict — nothing else can change
 * without a new push.
 *
 * Deliberately structural rather than reading `summary.state`: the server-side
 * roll-up short-circuits to `failure` while other runs are still in flight, and
 * the CI menu keeps those rows live until they actually finish.
 *
 * An empty summary is *not* settled — CI may simply not have registered its
 * runs yet, which the poll schedule handles with a bounded grace period.
 */
export function areChecksSettled(summary: GitHubChecksSummary | null): boolean {
  if (!summary) return false;
  const items = flattenChecks(summary);
  if (items.length === 0) return false;
  return items.every((item) => item.state !== "pending");
}
