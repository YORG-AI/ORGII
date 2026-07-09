/**
 * In-memory, repo-keyed LRU cache for GitHub list data (issues + PRs).
 *
 * Lives at module scope so it survives workspace switches within the same
 * app session. Stale-while-revalidate: callers receive cached data instantly
 * and kick off a background refresh when the TTL has expired.
 *
 * Limits (chosen to bound memory while covering the typical "last two
 * workspaces" use-case):
 *   MAX_REPOS   — 2  (LRU eviction — oldest-accessed repo is dropped)
 *   MAX_ISSUES  — 200 per repo per section (open / closed)
 *   MAX_PRS     — 100 per repo
 *   TTL         — 5 minutes
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

const MAX_REPOS = 2;
const MAX_ISSUES_PER_SECTION = 200;
const MAX_PRS = 100;
/** Distinct PR detail snapshots retained (LRU across all repos). */
const MAX_PR_DETAILS = 20;
const TTL_MS = 5 * 60 * 1000;

export interface CachedIssues {
  openIssues: GitHubIssue[];
  closedIssues: GitHubIssue[];
  cachedAt: number;
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

function hydrate<T>(storageKey: string, cache: Map<string, T>): void {
  const store = safeLocalStorage();
  if (!store) return;
  try {
    const raw = store.getItem(storageKey);
    if (!raw) return;
    const entries = JSON.parse(raw) as [string, T][];
    if (!Array.isArray(entries)) return;
    for (const [key, value] of entries) cache.set(key, value);
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

hydrate(STORAGE_KEY_ISSUES, issueCache);
hydrate(STORAGE_KEY_PRS, prCache);

// ── Issues ────────────────────────────────────────────────────────────────────

export function getCachedIssues(repoKey: string): CachedIssues | null {
  return lruGet(issueCache, repoKey);
}

export function isIssueCacheStale(repoKey: string): boolean {
  const entry = issueCache.get(repoKey);
  if (!entry) return true;
  return Date.now() - entry.cachedAt > TTL_MS;
}

export function updateCachedOpenIssues(
  repoKey: string,
  openIssues: GitHubIssue[]
) {
  const existing = lruGet(issueCache, repoKey);
  lruSet(issueCache, repoKey, {
    openIssues: openIssues.slice(0, MAX_ISSUES_PER_SECTION),
    closedIssues: existing?.closedIssues ?? [],
    cachedAt: Date.now(),
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
    cachedAt: Date.now(),
  });
  persist(STORAGE_KEY_ISSUES, issueCache);
}

// ── Pull Requests ─────────────────────────────────────────────────────────────

export function getCachedPrs(repoKey: string): CachedPrs | null {
  return lruGet(prCache, repoKey);
}

export function isPrCacheStale(repoKey: string): boolean {
  const entry = prCache.get(repoKey);
  if (!entry) return true;
  return Date.now() - entry.cachedAt > TTL_MS;
}

export function setCachedPrs(repoKey: string, prs: OpenPRItem[]) {
  lruSet(prCache, repoKey, {
    prs: prs.slice(0, MAX_PRS),
    cachedAt: Date.now(),
  });
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
  return Date.now() - entry.cachedAt > TTL_MS;
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
