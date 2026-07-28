/**
 * useWorkstationPrDetail
 *
 * Loads the full detail for the selected Pull Request — the data behind the
 * GitHub-style Conversation / Commits / Checks / Changes tabs — and publishes
 * it into `workstationSelectedPrAtom` plus action callbacks into
 * `workstationPrDetailCallbackAtom`.
 *
 * Design mirrors `useWorkstationIssues` (repo resolution, cache-seed-then-
 * revalidate, atom publishing, unmount reset). All detail sources are fetched
 * in parallel; a small per-PR snapshot cache provides stale-while-revalidate
 * behavior after a PR is explicitly opened. In-flight requests are
 * de-duplicated by PR.
 */
import { useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getGitRemotes } from "@src/api/http/git/remotes";
import {
  type GitHubChecksSummary,
  type PrReviewEvent,
  createIssueCommentLocal,
  createPrReviewCommentLocal,
  createPrReviewLocal,
  getChecksLocal,
  getPRLocal,
  listIssueCommentsLocal,
  listPRCommitsLocal,
  listPRFilesLocal,
  listPrReviewCommentsLocal,
  listPrReviewsLocal,
  replyPrReviewCommentLocal,
} from "@src/api/tauri/github";
import {
  type CachedPrDetail,
  getCachedPrDetail,
  isPrDetailStale,
  prDetailKey,
  setCachedPrDetail,
} from "@src/services/git/githubListCache";
import { parseGithubRepoFullName } from "@src/services/git/operations/createPullRequest";
import {
  type PrIdentity,
  initialSelectedPrState,
  workstationPrDetailCallbackAtomFamily,
  workstationPrScopeKey,
  workstationSelectedPrAtomFamily,
} from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";

type PrDetailBundle = Omit<CachedPrDetail, "cachedAt">;

function readString(
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
 * Fetch every detail source for a PR in parallel and write the snapshot to the
 * cache. `getPRLocal` is not individually caught — a hard failure there (auth /
 * network) rejects the whole bundle so callers surface an error; the softer
 * sources degrade to empty on their own errors.
 */
async function fetchPrDetailBundle(
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
  setCachedPrDetail(prDetailKey(repoFullName, prNumber), bundle);
  return bundle;
}

// ── In-flight de-duplication ────────────────────────────────────────────────

const inFlight = new Map<string, Promise<PrDetailBundle>>();

function loadBundleDeduped(
  repoFullName: string,
  prNumber: number
): Promise<PrDetailBundle> {
  const key = prDetailKey(repoFullName, prNumber);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = fetchPrDetailBundle(repoFullName, prNumber).finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

export interface UseWorkstationPrDetailOptions {
  repoPath: string;
  repoId?: string;
  /** The PR selected in the sidebar, or null when nothing is selected. */
  pr: PrIdentity | null;
}

export function useWorkstationPrDetail({
  repoPath,
  repoId,
  pr,
}: UseWorkstationPrDetailOptions) {
  const scopeKey = workstationPrScopeKey(repoId, repoPath, pr?.number);
  const setSelectedPr = useSetAtom(workstationSelectedPrAtomFamily(scopeKey));
  const setCallbacks = useSetAtom(
    workstationPrDetailCallbackAtomFamily(scopeKey)
  );

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Freshest PR head SHA, kept in a ref so inline-comment creation can read it
  // without re-subscribing its callback on every atom write.
  const latestHeadShaRef = useRef<string | null>(null);

  // ── Resolve owner/repo from the origin remote ─────────────────────────────
  const [repoFullName, setRepoFullName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!repoPath) {
      setRepoFullName(null);
      return;
    }
    void (async () => {
      try {
        const remotes = await getGitRemotes({
          repo_id: repoId ?? "default",
          repo_path: repoPath,
        });
        const origin = remotes?.remotes?.find((r) => r.name === "origin");
        const full = origin?.url ? parseGithubRepoFullName(origin.url) : null;
        if (!cancelled) setRepoFullName(full ?? null);
      } catch {
        if (!cancelled) setRepoFullName(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoPath, repoId]);

  const requestIdRef = useRef(0);

  const applyBundle = useCallback(
    (identity: PrIdentity, bundle: PrDetailBundle) => {
      latestHeadShaRef.current = bundle.headSha;
      setSelectedPr((prev) => ({
        ...prev,
        identity,
        detail: bundle.detail,
        headSha: bundle.headSha,
        baseRef: bundle.baseRef ?? identity.baseBranch ?? null,
        conversation: bundle.conversation,
        reviews: bundle.reviews,
        reviewComments: bundle.reviewComments,
        commits: bundle.commits,
        files: bundle.files,
        checks: bundle.checks,
        loading: false,
        refreshing: false,
        error: null,
      }));
    },
    [setSelectedPr]
  );

  const loadDetail = useCallback(
    (identity: PrIdentity, opts?: { force?: boolean }) => {
      if (!repoFullName) return;
      const requestId = ++requestIdRef.current;
      const isCurrent = () => requestId === requestIdRef.current;
      const key = prDetailKey(repoFullName, identity.number);
      const cached = getCachedPrDetail(key);

      if (cached && !opts?.force) {
        applyBundle(identity, cached);
        if (!isPrDetailStale(key)) return;
        setSelectedPr((prev) => ({ ...prev, refreshing: true }));
      } else {
        setSelectedPr((prev) => ({
          ...prev,
          ...initialSelectedPrState,
          identity,
          baseRef: identity.baseBranch ?? null,
          loading: true,
        }));
      }

      void (async () => {
        try {
          const bundle = await loadBundleDeduped(repoFullName, identity.number);
          if (!mountedRef.current || !isCurrent()) return;
          applyBundle(identity, bundle);
        } catch (err) {
          if (!mountedRef.current || !isCurrent()) return;
          setSelectedPr((prev) => ({
            ...prev,
            loading: false,
            refreshing: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      })();
    },
    [repoFullName, applyBundle, setSelectedPr]
  );

  // Load whenever the selected PR (or resolved repo) changes.
  useEffect(() => {
    if (!pr || !repoFullName) return;
    loadDetail(pr);
  }, [pr, repoFullName, loadDetail]);

  // ── Mutations ─────────────────────────────────────────────────────────────

  const addComment = useCallback(
    async (body: string) => {
      if (!repoFullName || !pr) return;
      setSelectedPr((prev) => ({ ...prev, submittingComment: true }));
      try {
        const comment = await createIssueCommentLocal(
          repoFullName,
          pr.number,
          body
        );
        if (!mountedRef.current) return;
        setSelectedPr((prev) => ({
          ...prev,
          conversation: [...prev.conversation, comment],
          submittingComment: false,
        }));
      } catch {
        if (mountedRef.current) {
          setSelectedPr((prev) => ({ ...prev, submittingComment: false }));
        }
      }
    },
    [repoFullName, pr, setSelectedPr]
  );

  const submitReview = useCallback(
    async (event: PrReviewEvent, body: string) => {
      if (!repoFullName || !pr) return;
      setSelectedPr((prev) => ({ ...prev, submittingReview: true }));
      try {
        const review = await createPrReviewLocal(
          repoFullName,
          pr.number,
          event,
          body || undefined
        );
        if (!mountedRef.current) return;
        setSelectedPr((prev) => ({
          ...prev,
          reviews: [...prev.reviews, review],
          submittingReview: false,
        }));
      } catch {
        if (mountedRef.current) {
          setSelectedPr((prev) => ({ ...prev, submittingReview: false }));
        }
      }
    },
    [repoFullName, pr, setSelectedPr]
  );

  const addInlineComment = useCallback(
    async (params: {
      body: string;
      path: string;
      line: number;
      side?: "LEFT" | "RIGHT";
      startLine?: number;
      startSide?: "LEFT" | "RIGHT";
    }) => {
      if (!repoFullName || !pr) return;
      const commitId = latestHeadShaRef.current;
      if (!commitId) return;
      const comment = await createPrReviewCommentLocal(
        repoFullName,
        pr.number,
        { ...params, commitId }
      );
      if (!mountedRef.current) return;
      setSelectedPr((prev) => ({
        ...prev,
        reviewComments: [...prev.reviewComments, comment],
      }));
    },
    [repoFullName, pr, setSelectedPr]
  );

  const replyInlineComment = useCallback(
    async (commentId: number, body: string) => {
      if (!repoFullName || !pr) return;
      const comment = await replyPrReviewCommentLocal(
        repoFullName,
        pr.number,
        commentId,
        body
      );
      if (!mountedRef.current) return;
      setSelectedPr((prev) => ({
        ...prev,
        reviewComments: [...prev.reviewComments, comment],
      }));
    },
    [repoFullName, pr, setSelectedPr]
  );

  const refresh = useCallback(() => {
    if (pr) loadDetail(pr, { force: true });
  }, [pr, loadDetail]);

  // Publish callbacks.
  useEffect(() => {
    setCallbacks({
      addComment,
      submitReview,
      addInlineComment,
      replyInlineComment,
      refresh,
    });
  }, [
    addComment,
    submitReview,
    addInlineComment,
    replyInlineComment,
    refresh,
    setCallbacks,
  ]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      setSelectedPr(initialSelectedPrState);
      setCallbacks({
        addComment: null,
        submitReview: null,
        addInlineComment: null,
        replyInlineComment: null,
        refresh: null,
      });
    };
  }, [setSelectedPr, setCallbacks]);

  return useMemo(
    () => ({
      repoFullName,
      addComment,
      submitReview,
      addInlineComment,
      replyInlineComment,
      refresh,
      latestHeadShaRef,
    }),
    [
      repoFullName,
      addComment,
      submitReview,
      addInlineComment,
      replyInlineComment,
      refresh,
    ]
  );
}
