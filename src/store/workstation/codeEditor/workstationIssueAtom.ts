import { atom } from "jotai";
import { atomFamily } from "jotai-family";

import type {
  GitHubIssue,
  GitHubIssueTimelineItem,
} from "@src/api/tauri/github";

import { DEFAULT_WORKSTATION_REPO_SCOPE } from "./workstationPrAtom";

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
