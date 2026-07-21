/**
 * In-memory, repo-keyed LRU cache for GitHub list data (issues + PRs).
 *
 * Lives at module scope so it survives workspace switches within the same
 * app session. Stale-while-revalidate: callers receive cached data instantly
 * and kick off a background refresh when the TTL has expired.
 *
 * Limits (chosen to bound memory while covering a small set of recent
 * workspaces):
 *   MAX_REPOS   — 4  (LRU eviction — oldest-accessed repo is dropped)
 *   MAX_ISSUES  — 200 per repo per section (open / closed)
 *   MAX_PR_LISTS — 8 repo/state combinations
 *   MAX_PRS      — 100 per repo/state list
 *   TTL          — 10 minutes
 */
import type {
  GitHubChecksSummary,
  GitHubIssue,
  GitHubIssueComment,
  GitHubPrReview,
  GitHubReviewComment,
  OpenPRItem,
  PrFile,
} from "@src/api/tauri/github";

const MAX_REPOS = 4;
const MAX_ISSUES_PER_SECTION = 200;
const MAX_PRS = 100;
const MAX_PR_LISTS = 8;
/** Distinct PR detail snapshots retained (LRU across all repos). */
const MAX_PR_DETAILS = 4;
export const GITHUB_LIST_CACHE_TTL_MS = 10 * 60 * 1000;

export interface CachedIssues {
  openIssues: GitHubIssue[];
  closedIssues: GitHubIssue[];
  openCachedAt: number | null;
  closedCachedAt: number | null;
}

export interface CachedPrs {
  prs: OpenPRItem[];
  cachedAt: number;
}

/** Full PR-detail snapshot for the tabbed detail view (Conversation/Commits/
 * Checks/Changes). Keyed by `${repoFullName}#${prNumber}`. */
export interface CachedPrDetail {
  detail: Record<string, unknown> | null;
  headSha: string | null;
  baseRef: string | null;
  conversation: GitHubIssueComment[];
  reviews: GitHubPrReview[];
  reviewComments: GitHubReviewComment[];
  commits: Record<string, unknown>[];
  files: PrFile[];
  checks: GitHubChecksSummary | null;
  cachedAt: number;
}

// JS Maps iterate in insertion order, so delete+reinsert = LRU promotion.
function lruGet<T>(cache: Map<string, T>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  // Promote to most-recently-used by reinserting at the end
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function lruSet<T>(
  cache: Map<string, T>,
  key: string,
  value: T,
  maxSize: number = MAX_REPOS
): void {
  if (cache.has(key)) {
    cache.delete(key); // remove before reinserting to update order
  } else if (cache.size >= maxSize) {
    // Evict least-recently-used (first key in insertion order)
    cache.delete(cache.keys().next().value as string);
  }
  cache.set(key, value);
}

const issueCache = new Map<string, CachedIssues>();
const prCache = new Map<string, CachedPrs>();
const inFlightListRequests = new Map<string, Promise<unknown>>();

/**
 * Reuses an in-flight list request across remounts and removes it on settle.
 * This prevents rapid tab switches from duplicating GitHub calls without
 * retaining completed promises or installing a cleanup timer.
 */
export function coalesceGitHubListRequest<T>(
  key: string,
  requestFactory: () => Promise<T>
): Promise<T> {
  const existing = inFlightListRequests.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const request = requestFactory().finally(() => {
    if (inFlightListRequests.get(key) === request) {
      inFlightListRequests.delete(key);
    }
  });
  inFlightListRequests.set(key, request);
  return request;
}

// ── Disk persistence (survive app restart) ──────────────────────────────────
//
// The list caches (issues + PRs) are persisted to the webview's localStorage so
// a cold start paints the last-seen lists instantly, then revalidates. The
// revalidation is cheap because the Rust client sends `If-None-Match` and gets
// a `304 Not Modified` back when nothing changed. Only the bounded list caches
// are persisted (not the heavier per-PR detail cache).

const STORAGE_KEY_ISSUES = "orgii.ghcache.issues.v1";
const STORAGE_KEY_PRS = "orgii.ghcache.prs.v1";

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function hydrate<T>(
  storageKey: string,
  cache: Map<string, T>,
  maxSize: number
): void {
  const store = safeLocalStorage();
  if (!store) return;
  try {
    const raw = store.getItem(storageKey);
    if (!raw) return;
    const entries = JSON.parse(raw) as [string, T][];
    if (!Array.isArray(entries)) return;
    for (const [key, value] of entries) {
      lruSet(cache, key, value, maxSize);
    }
  } catch {
    // Corrupt/legacy payload — ignore and start fresh.
  }
}

function persist<T>(storageKey: string, cache: Map<string, T>): void {
  const store = safeLocalStorage();
  if (!store) return;
  try {
    store.setItem(storageKey, JSON.stringify(Array.from(cache.entries())));
  } catch {
    // Quota exceeded or serialization failure — the in-memory cache still works.
  }
}

hydrate(STORAGE_KEY_ISSUES, issueCache, MAX_REPOS);
hydrate(STORAGE_KEY_PRS, prCache, MAX_PR_LISTS);

// ── Issues ────────────────────────────────────────────────────────────────────

export function getCachedIssues(repoKey: string): CachedIssues | null {
  return lruGet(issueCache, repoKey);
}

export type CachedIssueState = "open" | "closed";

export function isIssueCacheStale(
  repoKey: string,
  state: CachedIssueState = "open"
): boolean {
  const entry = issueCache.get(repoKey);
  if (!entry) return true;
  const cachedAt = state === "open" ? entry.openCachedAt : entry.closedCachedAt;
  return (
    typeof cachedAt !== "number" ||
    Date.now() - cachedAt > GITHUB_LIST_CACHE_TTL_MS
  );
}

export function updateCachedOpenIssues(
  repoKey: string,
  openIssues: GitHubIssue[]
) {
  const existing = lruGet(issueCache, repoKey);
  lruSet(issueCache, repoKey, {
    openIssues: openIssues.slice(0, MAX_ISSUES_PER_SECTION),
    closedIssues: existing?.closedIssues ?? [],
    openCachedAt: Date.now(),
    closedCachedAt: existing?.closedCachedAt ?? null,
  });
  persist(STORAGE_KEY_ISSUES, issueCache);
}

export function updateCachedClosedIssues(
  repoKey: string,
  closedIssues: GitHubIssue[]
) {
  const existing = lruGet(issueCache, repoKey);
  lruSet(issueCache, repoKey, {
    openIssues: existing?.openIssues ?? [],
    closedIssues: closedIssues.slice(0, MAX_ISSUES_PER_SECTION),
    openCachedAt: existing?.openCachedAt ?? null,
    closedCachedAt: Date.now(),
  });
  persist(STORAGE_KEY_ISSUES, issueCache);
}

// ── Pull Requests ─────────────────────────────────────────────────────────────

export type CachedPrState = "open" | "closed";

function prCacheKey(repoKey: string, state: CachedPrState): string {
  return state === "open" ? repoKey : `${repoKey}:closed`;
}

export function getCachedPrs(
  repoKey: string,
  state: CachedPrState = "open"
): CachedPrs | null {
  return lruGet(prCache, prCacheKey(repoKey, state));
}

export function isPrCacheStale(
  repoKey: string,
  state: CachedPrState = "open"
): boolean {
  const entry = prCache.get(prCacheKey(repoKey, state));
  if (!entry) return true;
  return Date.now() - entry.cachedAt > GITHUB_LIST_CACHE_TTL_MS;
}

export function setCachedPrs(
  repoKey: string,
  prs: OpenPRItem[],
  state: CachedPrState = "open"
) {
  lruSet(
    prCache,
    prCacheKey(repoKey, state),
    {
      prs: prs.slice(0, MAX_PRS),
      cachedAt: Date.now(),
    },
    MAX_PR_LISTS
  );
  persist(STORAGE_KEY_PRS, prCache);
}

// ── Pull Request detail ─────────────────────────────────────────────────────

const prDetailCache = new Map<string, CachedPrDetail>();

/** Cache key for a PR detail snapshot. */
export function prDetailKey(repoFullName: string, prNumber: number): string {
  return `${repoFullName}#${prNumber}`;
}

export function getCachedPrDetail(key: string): CachedPrDetail | null {
  return lruGet(prDetailCache, key);
}

export function isPrDetailStale(key: string): boolean {
  const entry = prDetailCache.get(key);
  if (!entry) return true;
  return Date.now() - entry.cachedAt > GITHUB_LIST_CACHE_TTL_MS;
}

export function setCachedPrDetail(
  key: string,
  detail: Omit<CachedPrDetail, "cachedAt">
) {
  lruSet(
    prDetailCache,
    key,
    { ...detail, cachedAt: Date.now() },
    MAX_PR_DETAILS
  );
}
