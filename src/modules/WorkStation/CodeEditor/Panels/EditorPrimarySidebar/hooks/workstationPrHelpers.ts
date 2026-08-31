import { normalizePrStatus } from "@src/shared/pr/prStatus";

const WORKSTATION_PR_STORAGE_PREFIX = "orgii.workstation.pr";

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
