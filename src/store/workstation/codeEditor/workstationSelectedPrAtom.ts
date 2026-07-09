import { atom } from "jotai";

import type {
  GitHubChecksSummary,
  GitHubIssueComment,
  GitHubPrReview,
  GitHubReviewComment,
  PrFile,
  PrReviewEvent,
} from "@src/api/tauri/github";

/**
 * Shared state for the currently-open Pull Request detail view (the GitHub-style
 * Conversation / Commits / Checks / Changes tabs rendered in the Source Control
 * main pane). Mirrors the issue-side `workstationSelectedIssueAtom` so external
 * surfaces (PinnedActionsBar, agents, the main pane) can read/act on the PR
 * without prop-drilling.
 *
 * TODO(multi-panel): single global atom, same limitation documented in
 * `workstationPrAtom.ts` — migrate to an `atomFamily` keyed by `repoId` when
 * multiple workstation panels can be open at once.
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

export interface WorkstationSelectedPrState {
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
}

export const initialSelectedPrState: WorkstationSelectedPrState = {
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
};

export const workstationSelectedPrAtom = atom<WorkstationSelectedPrState>(
  initialSelectedPrState
);
workstationSelectedPrAtom.debugLabel = "workstationSelectedPrAtom";

/** Active PR-detail sub-tab (Conversation / Commits / Checks / Changes). */
export const workstationPrDetailTabAtom = atom<PrDetailTab>("conversation");
workstationPrDetailTabAtom.debugLabel = "workstationPrDetailTabAtom";

/**
 * Callback atom for actions triggerable from the PR detail panel or external
 * surfaces (agents, PinnedActionsBar). Populated by `useWorkstationPrDetail`.
 */
export const workstationPrDetailCallbackAtom = atom<{
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
  refresh: (() => void) | null;
}>({
  addComment: null,
  submitReview: null,
  addInlineComment: null,
  replyInlineComment: null,
  refresh: null,
});
workstationPrDetailCallbackAtom.debugLabel = "workstationPrDetailCallbackAtom";
