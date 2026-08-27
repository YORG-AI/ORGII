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
 * in parallel (see `workstationPrDetailFetch`); a small per-PR snapshot cache
 * provides stale-while-revalidate behavior after a PR is explicitly opened.
 * In-flight requests are de-duplicated by PR.
 */
import { useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getGitRemotes } from "@src/api/http/git/remotes";
import type { GitHubIssueUser } from "@src/api/tauri/github";
import {
  getCachedPrDetail,
  isPrDetailStale,
  prDetailKey,
  setCachedPrDetail,
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

import { useWorkstationPrMutations } from "./useWorkstationPrMutations";
import { useWorkstationPrPickerCandidates } from "./useWorkstationPrPickerCandidates";
import {
  type PrDetailBundle,
  loadBundleDeduped,
  readString,
} from "./workstationPrDetailFetch";
import { bumpRequestId } from "./workstationPrHelpers";

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

  const {
    reviewerCandidates,
    assigneeCandidates,
    loadingReviewerCandidates,
    reviewerCandidatesError,
    loadReviewerCandidates,
    labelCandidates,
    loadingLabelCandidates,
    labelCandidatesError,
    loadLabelCandidates,
  } = useWorkstationPrPickerCandidates({ repoFullName, latestAuthorLoginRef });

  // Per-PR request-id counters — see `bumpRequestId` for why this is a Map
  // keyed by PR rather than a single instance-wide counter.
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

  const {
    addComment,
    submitReview,
    addInlineComment,
    replyInlineComment,
    mergePullRequest,
    setPullRequestAutoMerge,
    updatePullRequestState,
    updatePullRequestDraft,
    updateRequestedReviewers,
    updateAssignees,
    updateLabels,
    prActionPending,
  } = useWorkstationPrMutations({
    repoFullName,
    pr,
    setSelectedPr,
    loadDetail,
    mountedRef,
    requestIdsRef,
    latestHeadShaRef,
    latestRequestedReviewersRef,
    reviewerCandidates,
    assigneeCandidates,
    labelCandidates,
  });

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
      updateAssignees,
      updateLabels,
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
    updateAssignees,
    updateLabels,
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
        updateAssignees: null,
        updateLabels: null,
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
      updateAssignees,
      updateLabels,
      loadReviewerCandidates,
      reviewerCandidates,
      assigneeCandidates,
      loadingReviewerCandidates,
      reviewerCandidatesError,
      loadLabelCandidates,
      labelCandidates,
      loadingLabelCandidates,
      labelCandidatesError,
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
      updateAssignees,
      updateLabels,
      loadReviewerCandidates,
      reviewerCandidates,
      assigneeCandidates,
      loadingReviewerCandidates,
      reviewerCandidatesError,
      loadLabelCandidates,
      labelCandidates,
      loadingLabelCandidates,
      labelCandidatesError,
      prActionPending,
      refresh,
    ]
  );
}
