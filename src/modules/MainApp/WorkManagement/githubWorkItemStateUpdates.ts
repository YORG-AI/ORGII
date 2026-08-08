import type { GitHubIssue, OpenPRItem } from "@src/api/tauri/github";

import type {
  RepoIssueState,
  RepoPrState,
} from "./useGitHubWorkItemsLoadLifecycle";

function withoutNumber<T extends { number: number }>(
  items: T[],
  number: number
): T[] {
  return items.filter((item) => item.number !== number);
}

function replaceOrPrepend<T extends { number: number }>(
  items: T[],
  item: T
): T[] {
  const index = items.findIndex(
    (candidate) => candidate.number === item.number
  );
  if (index < 0) return [item, ...items];
  return items.map((candidate, candidateIndex) =>
    candidateIndex === index ? item : candidate
  );
}

export function replaceIssueInRepoState(
  state: RepoIssueState,
  issue: GitHubIssue
): RepoIssueState {
  const openIssues =
    issue.state === "open"
      ? replaceOrPrepend(state.openIssues, issue)
      : withoutNumber(state.openIssues, issue.number);
  const closedIssues =
    issue.state === "closed"
      ? replaceOrPrepend(state.closedIssues, issue)
      : withoutNumber(state.closedIssues, issue.number);
  return { ...state, openIssues, closedIssues };
}

export function replacePrInRepoState(
  state: RepoPrState,
  pullRequest: OpenPRItem
): RepoPrState {
  const openPrs =
    pullRequest.state === "open"
      ? replaceOrPrepend(state.openPrs, pullRequest)
      : withoutNumber(state.openPrs, pullRequest.number);
  const closedPrs =
    pullRequest.state === "closed"
      ? replaceOrPrepend(state.closedPrs, pullRequest)
      : withoutNumber(state.closedPrs, pullRequest.number);
  return { ...state, openPrs, closedPrs };
}
