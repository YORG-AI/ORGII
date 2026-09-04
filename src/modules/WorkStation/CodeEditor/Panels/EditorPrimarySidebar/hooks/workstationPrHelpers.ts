import { normalizePrStatus } from "@src/shared/pr/prStatus";

const WORKSTATION_PR_STORAGE_PREFIX = "orgii.workstation.pr";

/**
 * How many remembered branch -> PR links survive.
 *
 * The key space is repo x branch, and branches are unbounded: every feature
 * branch and worktree a user has ever pushed leaves a key behind. Nothing
 * removed them, so the prefix grew for the life of the profile. `updatedAt`
 * already rides along in each record, so the oldest links are the ones to drop.
 */
export const MAX_STORED_WORKSTATION_PRS = 64;

export interface WorkstationPrRecord {
  url: string;
  status?: string;
  updatedAt: number;
}

export interface WorkstationPrEligibilityInput {
  branch?: string;
  defaultBranch: string;
  hasUpstream: boolean;
  uncommittedCount: number;
}

export interface FilterablePullRequest {
  number: number;
  title: string;
}

export function filterPullRequestsByQuery<T extends FilterablePullRequest>(
  pullRequests: T[],
  query: string
): T[] {
  if (!query.trim()) return pullRequests;
  const q = query.trim().toLowerCase();
  return pullRequests.filter(
    (pullRequest) =>
      pullRequest.title.toLowerCase().includes(q) ||
      String(pullRequest.number).includes(q) ||
      `#${pullRequest.number}`.includes(q)
  );
}

export function buildWorkstationPrStorageKey(
  repoPath: string,
  branch: string
): string {
  const safeRepoPath = repoPath.replace(/\\/g, "/");
  return `${WORKSTATION_PR_STORAGE_PREFIX}:${safeRepoPath}:${branch}`;
}

export function getStoredWorkstationPr(
  repoPath: string,
  branch: string
): WorkstationPrRecord | null {
  if (!repoPath || !branch) return null;
  try {
    const raw = localStorage.getItem(
      buildWorkstationPrStorageKey(repoPath, branch)
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkstationPrRecord;
    if (!parsed?.url) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Drop the least-recently-updated stored PR links beyond the cap.
 *
 * Exported for the regression test; callers should just use
 * {@link setStoredWorkstationPr}, which prunes on every write. Writes happen
 * once per branch/PR association, so the full-prefix scan is not on a hot path.
 */
export function pruneStoredWorkstationPrs(
  maxEntries: number = MAX_STORED_WORKSTATION_PRS
): void {
  const stored: Array<{ key: string; updatedAt: number }> = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(`${WORKSTATION_PR_STORAGE_PREFIX}:`)) continue;
    let updatedAt = 0;
    try {
      const parsed = JSON.parse(
        localStorage.getItem(key) ?? "{}"
      ) as WorkstationPrRecord;
      updatedAt = parsed?.updatedAt ?? 0;
    } catch {
      // Unparseable: leave updatedAt at 0 so it sorts oldest and is swept.
    }
    stored.push({ key, updatedAt });
  }
  if (stored.length <= maxEntries) return;
  stored.sort((left, right) => left.updatedAt - right.updatedAt);
  for (const { key } of stored.slice(0, stored.length - maxEntries)) {
    localStorage.removeItem(key);
  }
}

export function setStoredWorkstationPr(
  repoPath: string,
  branch: string,
  record: Pick<WorkstationPrRecord, "url" | "status">
): void {
  if (!repoPath || !branch || !record.url) return;
  const payload: WorkstationPrRecord = {
    url: record.url,
    status: record.status,
    updatedAt: Date.now(),
  };
  localStorage.setItem(
    buildWorkstationPrStorageKey(repoPath, branch),
    JSON.stringify(payload)
  );
  pruneStoredWorkstationPrs();
}

export function isWorkstationPrEligible(
  input: WorkstationPrEligibilityInput
): boolean {
  const { branch, defaultBranch, hasUpstream, uncommittedCount } = input;
  if (!branch || !hasUpstream) return false;
  if (branch === defaultBranch) return false;
  if (uncommittedCount > 0) return false;
  return true;
}

export function shouldAutoCreateWorkstationPr(options: {
  autoCreatePr: boolean;
  eligible: boolean;
  prUrl?: string;
  isCreating: boolean;
}): boolean {
  const { autoCreatePr, eligible, prUrl, isCreating } = options;
  return autoCreatePr && eligible && !prUrl && !isCreating;
}

export function formatWorkstationPrTitle(
  branch: string,
  commitMessage?: string
): string {
  const trimmedCommit = commitMessage?.trim();
  if (trimmedCommit) {
    const firstLine = trimmedCommit.split("\n")[0]?.trim();
    if (firstLine) return firstLine;
  }
  return branch;
}

/**
 * Normalize a remote PR state string for storage / comparison.
 *
 * Thin wrapper over the shared {@link normalizePrStatus} that preserves this
 * call site's contract of returning `undefined` for a missing state (used to
 * distinguish "no PR" from "PR with unknown state").
 */
export function normalizePullRequestStatus(
  state?: string | null
): string | undefined {
  if (!state) return undefined;
  return normalizePrStatus({ state });
}

export function upsertById<T extends { id: number }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

/**
 * Per-PR request-id counters, keyed by `prDetailKey(repoFullName, prNumber)`.
 * Scoping the guard per PR (instead of one counter per hook instance) means
 * switching PR A -> B -> A only supersedes in-flight work for the PR that
 * actually changed; an unrelated in-flight load for A keeps its result.
 */
export function bumpRequestId(
  counters: Map<string, number>,
  key: string
): number {
  const next = (counters.get(key) ?? 0) + 1;
  counters.set(key, next);
  return next;
}
