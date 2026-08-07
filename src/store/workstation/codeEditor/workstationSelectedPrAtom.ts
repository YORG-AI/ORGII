import { atom } from "jotai";
import { atomFamily } from "jotai-family";

import type {
  GitHubChecksSummary,
  GitHubIssueComment,
  GitHubPrReview,
  GitHubReviewComment,
  PrFile,
  PrReviewEvent,
} from "@src/api/tauri/github";

import {
  DEFAULT_WORKSTATION_REPO_SCOPE,
  workstationRepoScopeKey,
} from "./workstationPrAtom";

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

export const workstationSelectedPrAtomFamily = atomFamily(
  (scopeKey: string) => {
    const scopedAtom = atom<WorkstationSelectedPrState>(initialSelectedPrState);
    scopedAtom.debugLabel = `workstationSelectedPrAtom(${scopeKey})`;
    return scopedAtom;
  }
);

/** Back-compat default-scope singleton (repo-agnostic, no PR). */
export const workstationSelectedPrAtom = workstationSelectedPrAtomFamily(
  `${DEFAULT_WORKSTATION_REPO_SCOPE}:pr:none`
);

/** Active PR-detail sub-tab (Conversation / Commits / Checks / Changes). */
export const workstationPrDetailTabAtomFamily = atomFamily(
  (scopeKey: string) => {
    const scopedAtom = atom<PrDetailTab>("conversation");
    scopedAtom.debugLabel = `workstationPrDetailTabAtom(${scopeKey})`;
    return scopedAtom;
  }
);

export const workstationPrDetailTabAtom = workstationPrDetailTabAtomFamily(
  `${DEFAULT_WORKSTATION_REPO_SCOPE}:pr:none`
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
  refresh: (() => void) | null;
}

const initialPrDetailCallbacks: WorkstationPrDetailCallbacks = {
  addComment: null,
  submitReview: null,
  addInlineComment: null,
  replyInlineComment: null,
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

export const workstationPrDetailCallbackAtom =
  workstationPrDetailCallbackAtomFamily(
    `${DEFAULT_WORKSTATION_REPO_SCOPE}:pr:none`
  );
