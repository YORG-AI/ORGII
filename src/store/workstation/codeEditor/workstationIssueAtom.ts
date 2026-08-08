import { atom } from "jotai";
import { atomFamily } from "jotai-family";

import type {
  GitHubIssue,
  GitHubIssueTimelineItem,
} from "@src/api/tauri/github";

import {
  DEFAULT_WORKSTATION_REPO_SCOPE,
  workstationRepoScopeKey,
} from "./workstationPrAtom";

export type IssueFilterState = "open" | "closed" | "all";

export interface WorkstationIssueListState {
  issues: GitHubIssue[];
  loading: boolean;
  error: string | null;
  filter: IssueFilterState;
  labelFilter: string;
  searchQuery: string;
  page: number;
  hasMore: boolean;
}

export interface WorkstationSelectedIssueState {
  /** Auth + repository + issue identity that owns this snapshot. */
  resourceKey?: string | null;
  issue: GitHubIssue | null;
  timeline: GitHubIssueTimelineItem[];
  loading: boolean;
  timelineLoading: boolean;
  error: string | null;
  submittingComment: boolean;
}

const initialListState: WorkstationIssueListState = {
  issues: [],
  loading: false,
  error: null,
  filter: "open",
  labelFilter: "",
  searchQuery: "",
  page: 1,
  hasMore: false,
};

const initialSelectedState: WorkstationSelectedIssueState = {
  resourceKey: null,
  issue: null,
  timeline: [],
  loading: false,
  timelineLoading: false,
  error: null,
  submittingComment: false,
};

export const workstationIssueListAtomFamily = atomFamily((scopeKey: string) => {
  const scopedAtom = atom<WorkstationIssueListState>({
    ...initialListState,
    issues: [],
  });
  scopedAtom.debugLabel = `workstationIssueListAtom(${scopeKey})`;
  return scopedAtom;
});

export const workstationIssueListAtom = workstationIssueListAtomFamily(
  DEFAULT_WORKSTATION_REPO_SCOPE
);

export const workstationSelectedIssueAtomFamily = atomFamily(
  (scopeKey: string) => {
    const scopedAtom = atom<WorkstationSelectedIssueState>({
      ...initialSelectedState,
      timeline: [],
    });
    scopedAtom.debugLabel = `workstationSelectedIssueAtom(${scopeKey})`;
    return scopedAtom;
  }
);

export const workstationSelectedIssueAtom = workstationSelectedIssueAtomFamily(
  DEFAULT_WORKSTATION_REPO_SCOPE
);

export function workstationIssueDetailScopeKey(
  repoPath: string,
  issueNumber: number
): string {
  return `${workstationRepoScopeKey(undefined, repoPath)}:issue:${issueNumber}`;
}

export type WorkstationIssueCallbacks = {
  openNewIssueForm: (() => void) | null;
  closeIssue: ((number: number) => Promise<void>) | null;
  reopenIssue: ((number: number) => Promise<void>) | null;
  addComment: ((number: number, body: string) => Promise<void>) | null;
  refreshIssues: (() => void) | null;
};

const initialIssueCallbacks: WorkstationIssueCallbacks = {
  openNewIssueForm: null,
  closeIssue: null,
  reopenIssue: null,
  addComment: null,
  refreshIssues: null,
};

// Callback atom for actions triggerable from PinnedActionsBar, agents, or the
// github-issue-detail tab rendered in the main pane.
export const workstationIssueCallbackAtomFamily = atomFamily(
  (scopeKey: string) => {
    const scopedAtom = atom<WorkstationIssueCallbacks>({
      ...initialIssueCallbacks,
    });
    scopedAtom.debugLabel = `workstationIssueCallbackAtom(${scopeKey})`;
    return scopedAtom;
  }
);

export const workstationIssueCallbackAtom = workstationIssueCallbackAtomFamily(
  DEFAULT_WORKSTATION_REPO_SCOPE
);

const retainedIssueDetailScopes = new Map<string, number>();

/**
 * Retain an explicit issue-detail scope while a rendered consumer is mounted.
 * The final release removes the atom-family entries immediately; bounded warm
 * remount data belongs to the GitHub detail coordinator rather than this
 * unbounded primitive-key atom family.
 */
export function retainWorkstationIssueDetailScope(
  scopeKey: string,
  options: { evictOnFinalRelease?: boolean } = {}
): () => boolean {
  retainedIssueDetailScopes.set(
    scopeKey,
    (retainedIssueDetailScopes.get(scopeKey) ?? 0) + 1
  );
  let released = false;
  return () => {
    if (released) return false;
    released = true;
    const remaining = (retainedIssueDetailScopes.get(scopeKey) ?? 1) - 1;
    if (remaining > 0) {
      retainedIssueDetailScopes.set(scopeKey, remaining);
      return false;
    }
    retainedIssueDetailScopes.delete(scopeKey);
    if (options.evictOnFinalRelease !== false) {
      workstationSelectedIssueAtomFamily.remove(scopeKey);
    }
    return true;
  };
}

export function getRetainedIssueDetailScopeCount(): number {
  return retainedIssueDetailScopes.size;
}
