/**
 * workstationPrDetailFetch
 *
 * React-free fetch layer behind `useWorkstationPrDetail`: parallel loading of
 * every PR detail source plus the module-level in-flight de-duplication map.
 *
 * The `inFlight` map below is deliberately module-level state — it must exist
 * exactly once in the process, or concurrent panels stop coalescing onto a
 * single request. Do not re-export or duplicate it.
 */
import {
  type GitHubChecksSummary,
  getChecksLocal,
  getPRLocal,
  listIssueCommentsLocal,
  listPRCommitsLocal,
  listPRFilesLocal,
  listPrReviewCommentsLocal,
  listPrReviewsLocal,
} from "@src/api/tauri/github";
import {
  type CachedPrDetail,
  prDetailKey,
} from "@src/services/git/githubListCache";

export type PrDetailBundle = Omit<CachedPrDetail, "cachedAt">;

export function readString(
  source: Record<string, unknown> | null,
  path: string[]
): string | null {
  let cursor: unknown = source;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object") return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "string" ? cursor : null;
}

/**
 * Fetch every detail source for a PR in parallel. The caller writes the
 * snapshot only after confirming this request still owns the visible panel.
 * `getPRLocal` is not individually caught — a hard failure there (auth /
 * network) rejects the whole bundle so callers surface an error; the softer
 * sources degrade to empty on their own errors.
 */
export async function fetchPrDetailBundle(
  repoFullName: string,
  prNumber: number
): Promise<PrDetailBundle> {
  const [detail, conversation, reviews, reviewComments, commits, files] =
    await Promise.all([
      getPRLocal(repoFullName, prNumber),
      listIssueCommentsLocal(repoFullName, prNumber).catch(() => []),
      listPrReviewsLocal(repoFullName, prNumber).catch(() => []),
      listPrReviewCommentsLocal(repoFullName, prNumber).catch(() => []),
      listPRCommitsLocal(repoFullName, prNumber).catch(() => []),
      listPRFilesLocal(repoFullName, prNumber).catch(() => []),
    ]);

  const headSha = readString(detail, ["head", "sha"]);
  const baseRef = readString(detail, ["base", "ref"]);

  let checks: GitHubChecksSummary | null = null;
  if (headSha) {
    checks = await getChecksLocal(repoFullName, headSha).catch(() => null);
  }

  const bundle: PrDetailBundle = {
    detail,
    headSha,
    baseRef,
    conversation,
    reviews,
    reviewComments,
    commits,
    files,
    checks,
  };
  return bundle;
}

// ── In-flight de-duplication ────────────────────────────────────────────────

const inFlight = new Map<string, Promise<PrDetailBundle>>();

/**
 * Fetch a PR detail bundle, de-duplicating concurrent callers for the same
 * PR onto a single in-flight request.
 *
 * `bypassDedup` starts a genuinely fresh request even if one is already in
 * flight, and installs it as the new in-flight entry (future callers coalesce
 * onto it instead). This is used by post-mutation reconciliation: an
 * already-in-flight fetch may have been dispatched *before* the mutation
 * landed server-side, so reusing it would silently apply pre-mutation data.
 * The superseded promise still resolves for its original caller — it just no
 * longer owns the `inFlight` slot, so it won't be handed to new callers and
 * its `finally` no-ops instead of deleting the fresher entry.
 */
export function loadBundleDeduped(
  repoFullName: string,
  prNumber: number,
  opts?: { bypassDedup?: boolean }
): Promise<PrDetailBundle> {
  const key = prDetailKey(repoFullName, prNumber);
  if (!opts?.bypassDedup) {
    const existing = inFlight.get(key);
    if (existing) return existing;
  }
  const promise = fetchPrDetailBundle(repoFullName, prNumber).finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}
