/**
 * useWorkstationPrMutations
 *
 * Every write path for the selected Pull Request. Each mutation applies an
 * optimistic patch to the cached snapshot and the published atom, then asks
 * `loadDetail` to reconcile against the server. PR-level actions additionally
 * funnel through `runPrMutation`, which serializes them behind a single
 * pending flag.
 */
import type React from "react";
import { useCallback, useRef, useState } from "react";

import {
  type GitHubIssueLabel,
  type GitHubIssueUser,
  type PrReviewEvent,
  type PullRequestMergeMethod,
  createIssueCommentLocal,
  createPrReviewCommentLocal,
  createPrReviewLocal,
  mergePRLocal,
  removePRReviewersLocal,
  replyPrReviewCommentLocal,
  requestPRReviewersLocal,
  setPRAutoMergeLocal,
  updateIssueLocal,
  updatePRDraftStateLocal,
  updatePRStateLocal,
} from "@src/api/tauri/github";
import {
  prDetailKey,
  updateCachedPrDetail,
} from "@src/services/git/githubListCache";
import type {
  PrIdentity,
  WorkstationSelectedPrState,
} from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";

import { bumpRequestId, upsertById } from "./workstationPrHelpers";

export type SetSelectedPr = (
  update: (prev: WorkstationSelectedPrState) => WorkstationSelectedPrState
) => void;

export type LoadPrDetail = (
  identity: PrIdentity,
  opts?: { force?: boolean; reconcile?: boolean }
) => void;

export interface UseWorkstationPrMutationsOptions {
  repoFullName: string | null;
  pr: PrIdentity | null;
  setSelectedPr: SetSelectedPr;
  loadDetail: LoadPrDetail;
  mountedRef: React.MutableRefObject<boolean>;
  requestIdsRef: React.MutableRefObject<Map<string, number>>;
  latestHeadShaRef: React.MutableRefObject<string | null>;
  latestRequestedReviewersRef: React.MutableRefObject<GitHubIssueUser[]>;
  reviewerCandidates: GitHubIssueUser[];
  assigneeCandidates: GitHubIssueUser[];
  labelCandidates: GitHubIssueLabel[];
}

export function useWorkstationPrMutations({
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
}: UseWorkstationPrMutationsOptions) {
  const prActionPendingRef = useRef(false);
  const [prActionPending, setPrActionPending] = useState(false);

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
    [repoFullName, pr, setSelectedPr, loadDetail, mountedRef, requestIdsRef]
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
    [
      repoFullName,
      pr,
      setSelectedPr,
      loadDetail,
      mountedRef,
      requestIdsRef,
      latestHeadShaRef,
    ]
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
    [
      repoFullName,
      pr,
      setSelectedPr,
      loadDetail,
      mountedRef,
      requestIdsRef,
      latestHeadShaRef,
    ]
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
    [repoFullName, pr, setSelectedPr, loadDetail, mountedRef, requestIdsRef]
  );

  const runPrMutation = useCallback(
    async (
      mutation: () => Promise<unknown>,
      /**
       * Detail fields to apply the moment the mutation resolves. The
       * reconciling fetch below is a network round-trip, so without this the
       * rail keeps rendering the pre-mutation reviewers, status, and action
       * labels until it returns. The fetch still corrects anything GitHub
       * resolved differently.
       */
      optimisticDetail?: Record<string, unknown>
    ): Promise<void> => {
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
        if (optimisticDetail) {
          setSelectedPr((current) =>
            current.detail
              ? {
                  ...current,
                  detail: { ...current.detail, ...optimisticDetail },
                }
              : current
          );
        }
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
    [repoFullName, pr, runPrMutation, latestHeadShaRef]
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
    [repoFullName, pr, runPrMutation, latestHeadShaRef]
  );

  const updatePullRequestState = useCallback(
    async (state: "open" | "closed"): Promise<void> => {
      if (!repoFullName || !pr) {
        throw new Error("GitHub repository context is unavailable");
      }
      await runPrMutation(
        () => updatePRStateLocal(repoFullName, pr.number, state),
        { state }
      );
    },
    [repoFullName, pr, runPrMutation]
  );

  const updatePullRequestDraft = useCallback(
    async (draft: boolean): Promise<void> => {
      if (!repoFullName || !pr) {
        throw new Error("GitHub repository context is unavailable");
      }
      await runPrMutation(
        () => updatePRDraftStateLocal(repoFullName, pr.number, draft),
        { draft }
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

      // Resolved up front so the same list seeds both the ref and the
      // optimistic patch that repaints the rail before the refetch lands.
      const nextReviewers = reviewers.map((login) => {
        const candidate = reviewerCandidates.find(
          (reviewer) => reviewer.login.toLowerCase() === login.toLowerCase()
        );
        return candidate ?? { login, avatar_url: "" };
      });

      await runPrMutation(
        async () => {
          if (added.length > 0) {
            await requestPRReviewersLocal(repoFullName, pr.number, added);
          }
          if (removed.length > 0) {
            await removePRReviewersLocal(repoFullName, pr.number, removed);
          }
          latestRequestedReviewersRef.current = nextReviewers;
        },
        { requested_reviewers: nextReviewers }
      );
    },

    [
      repoFullName,
      pr,
      reviewerCandidates,
      runPrMutation,
      latestRequestedReviewersRef,
    ]
  );

  /**
   * GitHub models pull requests as issues for assignee and label writes, so
   * both go through the issue update endpoint with the PR's number.
   */
  const updateAssignees = useCallback(
    async (logins: string[]): Promise<void> => {
      if (!repoFullName || !pr) {
        throw new Error("GitHub repository context is unavailable");
      }
      const nextAssignees = logins.map((login) => {
        const candidate = assigneeCandidates.find(
          (assignee) => assignee.login.toLowerCase() === login.toLowerCase()
        );
        return candidate ?? { login, avatar_url: "" };
      });
      await runPrMutation(
        () => updateIssueLocal(repoFullName, pr.number, { assignees: logins }),
        { assignees: nextAssignees }
      );
    },
    [repoFullName, pr, assigneeCandidates, runPrMutation]
  );

  const updateLabels = useCallback(
    async (names: string[]): Promise<void> => {
      if (!repoFullName || !pr) {
        throw new Error("GitHub repository context is unavailable");
      }
      const nextLabels = names.map((name) => {
        const candidate = labelCandidates.find(
          (label) => label.name.toLowerCase() === name.toLowerCase()
        );
        return candidate ?? { name, color: "" };
      });
      await runPrMutation(
        () => updateIssueLocal(repoFullName, pr.number, { labels: names }),
        { labels: nextLabels }
      );
    },
    [repoFullName, pr, labelCandidates, runPrMutation]
  );

  return {
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
  };
}
