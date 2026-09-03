import { atom } from "jotai";
import { atomFamily } from "jotai-family";

import type {
  GitHubChecksSummary,
  GitHubIssueComment,
  GitHubPrReview,
  GitHubReviewComment,
  PrFile,
  PrReviewEvent,
  PullRequestMergeMethod,
} from "@src/api/tauri/github";

import { workstationRepoScopeKey } from "./workstationPrAtom";

/**
 * Scope key for the per-PR detail atoms. Unlike the issue side (keyed by repo
 * only), PR detail is keyed by repo **and** PR number so multiple open PR tabs
 * each keep independent, coherent state.
 */
export function workstationPrScopeKey(
  repoId: string | null | undefined,
  repoPath: string | null | undefined,
  prNumber: number | null | undefined
): string {
  return `${workstationRepoScopeKey(repoId, repoPath)}:pr:${prNumber ?? "none"}`;
}

/**
 * Shared state for an open Pull Request detail view (the GitHub-style
 * Conversation / Commits / Checks / Changes tabs). Mirrors the issue-side
 * `workstationSelectedIssueAtom` so external surfaces (PinnedActionsBar,
 * agents, the main pane) can read/act on the PR without prop-drilling.
 *
 * Keyed per repo + PR number via {@link workstationPrScopeKey}, so several PR
 * tabs (Source Control, My Station) can be open at once without clobbering
 * each other's state.
 */
export type PrDetailTab = "conversation" | "commits" | "checks" | "changes";

/** Lightweight PR identity carried from the sidebar selection. */
export interface PrIdentity {
  number: number;
  title: string;
  url: string;
  /** open | closed | merged | draft */
  status: string;
  headBranch: string;
  baseBranch?: string;
}

export interface WorkstationPrDetailViewState {
  activeTab: PrDetailTab;
  conversationDraft: string;
  selectedCommitSha: string | null;
  selectedChangedFilePath: string | null;
}

export const initialPrDetailViewState: WorkstationPrDetailViewState = {
  activeTab: "conversation",
  conversationDraft: "",
  selectedCommitSha: null,
  selectedChangedFilePath: null,
};

export interface WorkstationSelectedPrState {
  /** Small navigation/draft state retained when the rendered surface unmounts. */
  viewState: WorkstationPrDetailViewState;
  identity: PrIdentity | null;
  /** Raw `github_get_pr` JSON (head.sha, additions, changed_files, merged, …). */
  detail: Record<string, unknown> | null;
  /** PR head commit SHA — anchors inline review comments + the checks lookup. */
  headSha: string | null;
  /** Base ref (branch) the PR merges into. */
  baseRef: string | null;
  /** Top-level conversation comments (a PR is an issue in GitHub's REST API). */
  conversation: GitHubIssueComment[];
  reviews: GitHubPrReview[];
  reviewComments: GitHubReviewComment[];
  commits: Record<string, unknown>[];
  files: PrFile[];
  checks: GitHubChecksSummary | null;
  /** Initial load with no cached snapshot to paint from. */
  loading: boolean;
  /** Background revalidation over a cached snapshot. */
  refreshing: boolean;
  error: string | null;
  submittingComment: boolean;
  submittingReview: boolean;
  /** Covers both `addInlineComment` and `replyInlineComment` — the two
   * inline-review-comment mutations never run concurrently in practice. */
  submittingInlineComment: boolean;
}

export const initialSelectedPrState: WorkstationSelectedPrState = {
  viewState: initialPrDetailViewState,
  identity: null,
  detail: null,
  headSha: null,
  baseRef: null,
  conversation: [],
  reviews: [],
  reviewComments: [],
  commits: [],
  files: [],
  checks: null,
  loading: false,
  refreshing: false,
  error: null,
  submittingComment: false,
  submittingReview: false,
  submittingInlineComment: false,
};

export const workstationSelectedPrAtomFamily = atomFamily(
  (scopeKey: string) => {
    const scopedAtom = atom<WorkstationSelectedPrState>(initialSelectedPrState);
    scopedAtom.debugLabel = `workstationSelectedPrAtom(${scopeKey})`;
    return scopedAtom;
  }
);

/** Active PR-detail sub-tab (Conversation / Commits / Checks / Changes). */
export const workstationPrDetailTabAtomFamily = atomFamily(
  (scopeKey: string) => {
    const selectedPrAtom = workstationSelectedPrAtomFamily(scopeKey);
    const scopedAtom = atom(
      (get) => get(selectedPrAtom).viewState.activeTab,
      (get, set, activeTab: PrDetailTab) => {
        const current = get(selectedPrAtom);
        set(selectedPrAtom, {
          ...current,
          viewState: { ...current.viewState, activeTab },
        });
      }
    );
    scopedAtom.debugLabel = `workstationPrDetailTabAtom(${scopeKey})`;
    return scopedAtom;
  }
);

export interface WorkstationPrDetailCallbacks {
  addComment: ((body: string) => Promise<void>) | null;
  submitReview: ((event: PrReviewEvent, body: string) => Promise<void>) | null;
  addInlineComment:
    | ((params: {
        body: string;
        path: string;
        line: number;
        side?: "LEFT" | "RIGHT";
        startLine?: number;
        startSide?: "LEFT" | "RIGHT";
      }) => Promise<void>)
    | null;
  replyInlineComment:
    | ((commentId: number, body: string) => Promise<void>)
    | null;
  mergePullRequest: ((method: PullRequestMergeMethod) => Promise<void>) | null;
  setPullRequestAutoMerge:
    | ((enabled: boolean, method: PullRequestMergeMethod) => Promise<void>)
    | null;
  updatePullRequestDraft: ((draft: boolean) => Promise<void>) | null;
  updatePullRequestState: ((state: "open" | "closed") => Promise<void>) | null;
  updateRequestedReviewers: ((reviewers: string[]) => Promise<void>) | null;
  updateAssignees: ((logins: string[]) => Promise<void>) | null;
  updateLabels: ((names: string[]) => Promise<void>) | null;
  refresh: (() => void) | null;
}

const initialPrDetailCallbacks: WorkstationPrDetailCallbacks = {
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
};

/**
 * Callback atom for actions triggerable from the PR detail panel or external
 * surfaces (agents, PinnedActionsBar). Populated by `useWorkstationPrDetail`.
 */
export const workstationPrDetailCallbackAtomFamily = atomFamily(
  (scopeKey: string) => {
    const scopedAtom = atom<WorkstationPrDetailCallbacks>({
      ...initialPrDetailCallbacks,
    });
    scopedAtom.debugLabel = `workstationPrDetailCallbackAtom(${scopeKey})`;
    return scopedAtom;
  }
);
