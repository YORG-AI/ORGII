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
  type GitHubIssueUser,
  type PrReviewEvent,
  type PullRequestMergeMethod,
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
  listRepoAssigneesLocal,
  mergePRLocal,
  removePRReviewersLocal,
  replyPrReviewCommentLocal,
  requestPRReviewersLocal,
  setPRAutoMergeLocal,
  updatePRDraftStateLocal,
  updatePRStateLocal,
} from "@src/api/tauri/github";
import {
  type CachedPrDetail,
  getCachedPrDetail,
  isPrDetailStale,
  prDetailKey,
  setCachedPrDetail,
  updateCachedPrDetail,
} from "@src/services/git/githubListCache";
import { parseGithubRepoFullName } from "@src/services/git/operations/createPullRequest";
import { readRequestedReviewers } from "@src/shared/pr/prLevelActions";
import {
  type PrIdentity,
  initialSelectedPrState,
  workstationPrDetailCallbackAtomFamily,
  workstationPrScopeKey,
  workstationSelectedPrAtomFamily,
} from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";

type PrDetailBundle = Omit<CachedPrDetail, "cachedAt">;

function upsertById<T extends { id: number }>(items: T[], item: T): T[] {
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
function bumpRequestId(counters: Map<string, number>, key: string): number {
  const next = (counters.get(key) ?? 0) + 1;
  counters.set(key, next);
  return next;
}

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
 * Fetch every detail source for a PR in parallel. The caller writes the
 * snapshot only after confirming this request still owns the visible panel.
 * `getPRLocal` is not individually caught — a hard failure there (auth /
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
function loadBundleDeduped(
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
  const latestRequestedReviewersRef = useRef<GitHubIssueUser[]>([]);
  const latestAuthorLoginRef = useRef<string | null>(null);
  const prActionPendingRef = useRef(false);
  const reviewerCandidatesAttemptedRef = useRef(false);
  const [prActionPending, setPrActionPending] = useState(false);
  const [reviewerCandidates, setReviewerCandidates] = useState<
    GitHubIssueUser[]
  >([]);
  const [loadingReviewerCandidates, setLoadingReviewerCandidates] =
    useState(false);
  const [reviewerCandidatesError, setReviewerCandidatesError] = useState<
    string | null
  >(null);

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

  useEffect(() => {
    reviewerCandidatesAttemptedRef.current = false;
    setReviewerCandidates([]);
    setLoadingReviewerCandidates(false);
    setReviewerCandidatesError(null);
  }, [repoFullName]);

  // Per-PR request-id counters — see `bumpRequestId` above for why this is a
  // Map keyed by PR rather than a single instance-wide counter.
  const requestIdsRef = useRef(new Map<string, number>());

  const applyBundle = useCallback(
    (identity: PrIdentity, bundle: PrDetailBundle) => {
      latestHeadShaRef.current = bundle.headSha;
      latestRequestedReviewersRef.current = readRequestedReviewers(
        bundle.detail
      );
      latestAuthorLoginRef.current = readString(bundle.detail, [
        "user",
        "login",
      ]);
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
    (
      identity: PrIdentity,
      opts?: {
        force?: boolean;
        /**
         * Post-mutation reconciliation: a successful mutation already
         * applied its own optimistic patch, so this always uses the
         * lightweight `refreshing` indicator (never the full-page loading
         * skeleton) and always issues a fresh network request — an
         * in-flight fetch that might be de-duped onto could have been
         * dispatched before the mutation landed server-side.
         */
        reconcile?: boolean;
      }
    ) => {
      if (!repoFullName) return;
      const key = prDetailKey(repoFullName, identity.number);
      const requestId = bumpRequestId(requestIdsRef.current, key);
      const isCurrent = () => requestIdsRef.current.get(key) === requestId;

      if (opts?.reconcile) {
        setSelectedPr((prev) => ({ ...prev, refreshing: true }));
      } else {
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
      }

      void (async () => {
        try {
          const bundle = await loadBundleDeduped(
            repoFullName,
            identity.number,
            {
              bypassDedup: opts?.reconcile,
            }
          );
          if (!mountedRef.current || !isCurrent()) return;
          setCachedPrDetail(key, bundle);
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
      const key = prDetailKey(repoFullName, pr.number);
      bumpRequestId(requestIdsRef.current, key);
      setSelectedPr((prev) => ({
        ...prev,
        refreshing: false,
        submittingComment: true,
      }));
      try {
        const comment = await createIssueCommentLocal(
          repoFullName,
          pr.number,
          body
        );
        updateCachedPrDetail(key, (cached) => ({
          conversation: upsertById(cached.conversation, comment),
        }));
        if (!mountedRef.current) return;
        setSelectedPr((prev) => ({
          ...prev,
          conversation: upsertById(prev.conversation, comment),
          submittingComment: false,
        }));
        // Reconcile in the background: the server response now reflects
        // this comment, so refetching restores every other field
        // (commits/files/checks/headSha) that would otherwise stay stale
        // until the next explicit refresh.
        loadDetail(pr, { reconcile: true });
      } catch {
        if (mountedRef.current) {
          setSelectedPr((prev) => ({ ...prev, submittingComment: false }));
        }
      }
    },
    [repoFullName, pr, setSelectedPr, loadDetail]
  );

  const submitReview = useCallback(
    async (event: PrReviewEvent, body: string) => {
      if (!repoFullName || !pr) return;
      const key = prDetailKey(repoFullName, pr.number);
      bumpRequestId(requestIdsRef.current, key);
      setSelectedPr((prev) => ({
        ...prev,
        refreshing: false,
        submittingReview: true,
      }));
      try {
        const review = await createPrReviewLocal(
          repoFullName,
          pr.number,
          event,
          body || undefined,
          latestHeadShaRef.current ?? undefined
        );
        updateCachedPrDetail(key, (cached) => ({
          reviews: upsertById(cached.reviews, review),
        }));
        if (!mountedRef.current) return;
        setSelectedPr((prev) => ({
          ...prev,
          reviews: upsertById(prev.reviews, review),
          submittingReview: false,
        }));
        loadDetail(pr, { reconcile: true });
      } catch {
        if (mountedRef.current) {
          setSelectedPr((prev) => ({ ...prev, submittingReview: false }));
        }
      }
    },
    [repoFullName, pr, setSelectedPr, loadDetail]
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
      const key = prDetailKey(repoFullName, pr.number);
      bumpRequestId(requestIdsRef.current, key);
      setSelectedPr((prev) => ({
        ...prev,
        refreshing: false,
        submittingInlineComment: true,
      }));
      try {
        const commitId = latestHeadShaRef.current;
        if (!commitId) {
          throw new Error("Missing PR head commit SHA for inline comment.");
        }
        const comment = await createPrReviewCommentLocal(
          repoFullName,
          pr.number,
          { ...params, commitId }
        );
        updateCachedPrDetail(key, (cached) => ({
          reviewComments: upsertById(cached.reviewComments, comment),
        }));
        if (!mountedRef.current) return;
        setSelectedPr((prev) => ({
          ...prev,
          reviewComments: upsertById(prev.reviewComments, comment),
          submittingInlineComment: false,
        }));
        loadDetail(pr, { reconcile: true });
      } catch (err) {
        if (mountedRef.current) {
          setSelectedPr((prev) => ({
            ...prev,
            submittingInlineComment: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      }
    },
    [repoFullName, pr, setSelectedPr, loadDetail]
  );

  const replyInlineComment = useCallback(
    async (commentId: number, body: string) => {
      if (!repoFullName || !pr) return;
      const key = prDetailKey(repoFullName, pr.number);
      bumpRequestId(requestIdsRef.current, key);
      setSelectedPr((prev) => ({
        ...prev,
        refreshing: false,
        submittingInlineComment: true,
      }));
      try {
        const comment = await replyPrReviewCommentLocal(
          repoFullName,
          pr.number,
          commentId,
          body
        );
        updateCachedPrDetail(key, (cached) => ({
          reviewComments: upsertById(cached.reviewComments, comment),
        }));
        if (!mountedRef.current) return;
        setSelectedPr((prev) => ({
          ...prev,
          reviewComments: upsertById(prev.reviewComments, comment),
          submittingInlineComment: false,
        }));
        loadDetail(pr, { reconcile: true });
      } catch (err) {
        if (mountedRef.current) {
          setSelectedPr((prev) => ({
            ...prev,
            submittingInlineComment: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      }
    },
    [repoFullName, pr, setSelectedPr, loadDetail]
  );

  const runPrMutation = useCallback(
    async (mutation: () => Promise<unknown>): Promise<void> => {
      if (!repoFullName || !pr) {
        throw new Error("GitHub repository context is unavailable");
      }
      if (prActionPendingRef.current) {
        throw new Error("Another pull request action is still running");
      }
      prActionPendingRef.current = true;
      setPrActionPending(true);
      setSelectedPr((current) => ({ ...current, error: null }));
      try {
        await mutation();
        loadDetail(pr, { reconcile: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setSelectedPr((current) => ({ ...current, error: message }));
        loadDetail(pr, { reconcile: true });
        throw error;
      } finally {
        prActionPendingRef.current = false;
        setPrActionPending(false);
      }
    },
    [repoFullName, pr, setSelectedPr, loadDetail]
  );

  const mergePullRequest = useCallback(
    async (method: PullRequestMergeMethod): Promise<void> => {
      if (!repoFullName || !pr) {
        throw new Error("GitHub repository context is unavailable");
      }
      await runPrMutation(() =>
        mergePRLocal(
          repoFullName,
          pr.number,
          method,
          latestHeadShaRef.current ?? undefined
        )
      );
    },
    [repoFullName, pr, runPrMutation]
  );

  const setPullRequestAutoMerge = useCallback(
    async (enabled: boolean, method: PullRequestMergeMethod): Promise<void> => {
      if (!repoFullName || !pr) {
        throw new Error("GitHub repository context is unavailable");
      }
      await runPrMutation(() =>
        setPRAutoMergeLocal(
          repoFullName,
          pr.number,
          enabled,
          method,
          latestHeadShaRef.current ?? undefined
        )
      );
    },
    [repoFullName, pr, runPrMutation]
  );

  const updatePullRequestState = useCallback(
    async (state: "open" | "closed"): Promise<void> => {
      if (!repoFullName || !pr) {
        throw new Error("GitHub repository context is unavailable");
      }
      await runPrMutation(() =>
        updatePRStateLocal(repoFullName, pr.number, state)
      );
    },
    [repoFullName, pr, runPrMutation]
  );

  const updatePullRequestDraft = useCallback(
    async (draft: boolean): Promise<void> => {
      if (!repoFullName || !pr) {
        throw new Error("GitHub repository context is unavailable");
      }
      await runPrMutation(() =>
        updatePRDraftStateLocal(repoFullName, pr.number, draft)
      );
    },
    [repoFullName, pr, runPrMutation]
  );

  const updateRequestedReviewers = useCallback(
    async (reviewers: string[]): Promise<void> => {
      if (!repoFullName || !pr) {
        throw new Error("GitHub repository context is unavailable");
      }
      const current = new Map(
        latestRequestedReviewersRef.current.map((reviewer) => [
          reviewer.login.toLowerCase(),
          reviewer.login,
        ])
      );
      const next = new Map(
        reviewers.map((reviewer) => [reviewer.toLowerCase(), reviewer])
      );
      const added = [...next]
        .filter(([normalized]) => !current.has(normalized))
        .map(([, login]) => login);
      const removed = [...current]
        .filter(([normalized]) => !next.has(normalized))
        .map(([, login]) => login);
      if (added.length === 0 && removed.length === 0) return;

      await runPrMutation(async () => {
        if (added.length > 0) {
          await requestPRReviewersLocal(repoFullName, pr.number, added);
        }
        if (removed.length > 0) {
          await removePRReviewersLocal(repoFullName, pr.number, removed);
        }
        latestRequestedReviewersRef.current = reviewers.map((login) => {
          const candidate = reviewerCandidates.find(
            (reviewer) => reviewer.login.toLowerCase() === login.toLowerCase()
          );
          return candidate ?? { login, avatar_url: "" };
        });
      });
    },
    [repoFullName, pr, reviewerCandidates, runPrMutation]
  );

  const loadReviewerCandidates = useCallback(async (): Promise<void> => {
    if (!repoFullName || reviewerCandidatesAttemptedRef.current) return;
    reviewerCandidatesAttemptedRef.current = true;
    setLoadingReviewerCandidates(true);
    setReviewerCandidatesError(null);
    try {
      const authorLogin = latestAuthorLoginRef.current?.toLowerCase();
      const candidates = await listRepoAssigneesLocal(repoFullName);
      setReviewerCandidates(
        candidates.filter(
          (candidate) => candidate.login.toLowerCase() !== authorLogin
        )
      );
    } catch (error) {
      reviewerCandidatesAttemptedRef.current = false;
      setReviewerCandidatesError(
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      setLoadingReviewerCandidates(false);
    }
  }, [repoFullName]);

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
      mergePullRequest,
      setPullRequestAutoMerge,
      updatePullRequestDraft,
      updatePullRequestState,
      updateRequestedReviewers,
      refresh,
    });
  }, [
    addComment,
    submitReview,
    addInlineComment,
    replyInlineComment,
    mergePullRequest,
    setPullRequestAutoMerge,
    updatePullRequestDraft,
    updatePullRequestState,
    updateRequestedReviewers,
    refresh,
    setCallbacks,
  ]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      setSelectedPr((current) => ({
        ...initialSelectedPrState,
        viewState: current.viewState,
      }));
      setCallbacks({
        addComment: null,
        submitReview: null,
        addInlineComment: null,
        replyInlineComment: null,
        mergePullRequest: null,
        setPullRequestAutoMerge: null,
        updatePullRequestDraft: null,
        updatePullRequestState: null,
        updateRequestedReviewers: null,
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
      mergePullRequest,
      setPullRequestAutoMerge,
      updatePullRequestDraft,
      updatePullRequestState,
      updateRequestedReviewers,
      loadReviewerCandidates,
      reviewerCandidates,
      loadingReviewerCandidates,
      reviewerCandidatesError,
      prActionPending,
      refresh,
      latestHeadShaRef,
    }),
    [
      repoFullName,
      addComment,
      submitReview,
      addInlineComment,
      replyInlineComment,
      mergePullRequest,
      setPullRequestAutoMerge,
      updatePullRequestDraft,
      updatePullRequestState,
      updateRequestedReviewers,
      loadReviewerCandidates,
      reviewerCandidates,
      loadingReviewerCandidates,
      reviewerCandidatesError,
      prActionPending,
      refresh,
    ]
  );
}
