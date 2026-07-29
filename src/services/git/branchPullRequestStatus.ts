import type {
  GitHubChecksSummary,
  LocalFindPRResponse,
} from "@src/api/tauri/github";

export const BRANCH_PULL_REQUEST_STATUS_TTL_MS = 45_000;
export const BRANCH_PULL_REQUEST_STATUS_CACHE_MAX_ENTRIES = 8;

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

export function branchPullRequestStatusCacheSize(): number {
  return statusCache.size;
}

export function clearBranchPullRequestStatusCache(): void {
  statusCache.clear();
  inFlight.clear();
}
