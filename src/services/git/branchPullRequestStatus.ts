import type {
  GitHubChecksSummary,
  LocalFindPRResponse,
} from "@src/api/tauri/github";
import { areChecksSettled } from "@src/services/git/ciCheckState";

export const BRANCH_PULL_REQUEST_STATUS_TTL_MS = 45_000;
export const BRANCH_PULL_REQUEST_STATUS_CACHE_MAX_ENTRIES = 8;

/** First poll delay while checks are still running. */
export const BRANCH_CI_POLL_BASE_MS = 15_000;
/** Ceiling for the running-checks backoff. */
export const BRANCH_CI_POLL_MAX_MS = 60_000;
/** Delay between the bounded retries taken when a PR reports no checks yet. */
export const BRANCH_CI_EMPTY_POLL_MS = 30_000;
/** How many times to re-ask before accepting that a PR simply has no CI. */
export const BRANCH_CI_EMPTY_POLL_MAX_ATTEMPTS = 3;
/**
 * Slow safety refresh after a terminal/no-PR result. Push and PR creation
 * normally invalidate immediately; this bounded fallback covers remote-only
 * changes and missed events without keeping the fast CI loop alive forever.
 */
export const BRANCH_CI_SAFETY_POLL_MS = 5 * 60_000;

export interface BranchPullRequestStatusSnapshot {
  pr: LocalFindPRResponse | null;
  checks: GitHubChecksSummary | null;
  checksUnavailable: boolean;
}

interface BranchPullRequestStatusCacheEntry extends BranchPullRequestStatusSnapshot {
  fetchedAt: number;
}

export type BranchCiStatus =
  | "checking"
  | "success"
  | "pending"
  | "failure"
  | "none"
  | "unavailable";

const statusCache = new Map<string, BranchPullRequestStatusCacheEntry>();
const inFlight = new Map<string, Promise<BranchPullRequestStatusSnapshot>>();

export function buildBranchPullRequestStatusKey({
  authScope,
  branchName,
  repoFullName,
}: {
  authScope: string;
  branchName: string;
  repoFullName: string;
}): string {
  return `github.com|${authScope}|${repoFullName}|${branchName}`;
}

export function buildGitHubCompareUrl(
  repoFullName: string,
  baseBranch: string,
  headBranch: string
): string {
  const repoUrl = `https://github.com/${repoFullName}`;
  if (!baseBranch || !headBranch || baseBranch === headBranch) {
    return `${repoUrl}/compare`;
  }
  return `${repoUrl}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(headBranch)}`;
}

export function getCachedBranchPullRequestStatus(
  key: string
): BranchPullRequestStatusCacheEntry | null {
  const entry = statusCache.get(key);
  if (!entry) return null;
  statusCache.delete(key);
  statusCache.set(key, entry);
  return entry;
}

export function isBranchPullRequestStatusFresh(
  entry: BranchPullRequestStatusCacheEntry | null,
  now: number = Date.now()
): boolean {
  return (
    entry !== null && now - entry.fetchedAt < BRANCH_PULL_REQUEST_STATUS_TTL_MS
  );
}

export function setCachedBranchPullRequestStatus(
  key: string,
  snapshot: BranchPullRequestStatusSnapshot,
  fetchedAt: number = Date.now()
): void {
  statusCache.delete(key);
  statusCache.set(key, { ...snapshot, fetchedAt });
  while (statusCache.size > BRANCH_PULL_REQUEST_STATUS_CACHE_MAX_ENTRIES) {
    const oldest = statusCache.keys().next().value;
    if (oldest === undefined) break;
    statusCache.delete(oldest);
  }
}

export function evictOtherBranchPullRequestStatusIdentities({
  activeAuthScope,
  repoFullName,
}: {
  activeAuthScope: string;
  repoFullName: string;
}): void {
  const prefix = "github.com|";
  const repoMarker = `|${repoFullName}|`;
  for (const key of statusCache.keys()) {
    if (
      key.startsWith(prefix) &&
      key.includes(repoMarker) &&
      !key.startsWith(`${prefix}${activeAuthScope}|`)
    ) {
      statusCache.delete(key);
    }
  }
}

export function loadBranchPullRequestStatusCoalesced(
  key: string,
  loader: () => Promise<BranchPullRequestStatusSnapshot>
): Promise<BranchPullRequestStatusSnapshot> {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const request = loader().finally(() => {
    if (inFlight.get(key) === request) inFlight.delete(key);
  });
  inFlight.set(key, request);
  return request;
}

export function resolveBranchCiStatus({
  checks,
  checksUnavailable,
  loading,
  pr,
}: BranchPullRequestStatusSnapshot & {
  loading: boolean;
}): BranchCiStatus | null {
  if (!pr) return null;
  if (loading && !checks) return "checking";
  if (checksUnavailable || !checks) return "unavailable";
  if (checks.check_runs.length === 0 && checks.statuses.length === 0) {
    return "none";
  }
  switch (checks.state) {
    case "success":
      return "success";
    case "failure":
      return "failure";
    default:
      return "pending";
  }
}

/**
 * Delay before the next branch-CI poll.
 *
 * Tracing a branch's CI the way GitHub Desktop does, without its polling cost:
 * we ask quickly only while something can still change. Once every run has
 * reported — or there is no PR yet — the schedule cools to a five-minute
 * safety refresh. Local pushes and PR creation trigger immediate invalidation,
 * so the safety timer is for remote-only changes and missed events.
 *
 * @param attempt Consecutive polls already scheduled for this head commit.
 *   Callers reset it whenever the head SHA changes, so a new push restarts at
 *   the fast interval.
 */
export function nextBranchCiPollDelayMs({
  attempt,
  checks,
  checksUnavailable,
  pr,
}: BranchPullRequestStatusSnapshot & { attempt: number }): number | null {
  if (!pr || checksUnavailable || !checks) return BRANCH_CI_SAFETY_POLL_MS;

  if (checks.check_runs.length === 0 && checks.statuses.length === 0) {
    // CI may not have registered its runs yet; give it a bounded grace period
    // rather than polling an un-CI'd repository forever.
    return attempt < BRANCH_CI_EMPTY_POLL_MAX_ATTEMPTS
      ? BRANCH_CI_EMPTY_POLL_MS
      : BRANCH_CI_SAFETY_POLL_MS;
  }

  if (areChecksSettled(checks)) return BRANCH_CI_SAFETY_POLL_MS;

  return Math.min(BRANCH_CI_POLL_BASE_MS * 2 ** attempt, BRANCH_CI_POLL_MAX_MS);
}

export function branchPullRequestStatusCacheSize(): number {
  return statusCache.size;
}

export function clearBranchPullRequestStatusCache(): void {
  statusCache.clear();
  inFlight.clear();
}
