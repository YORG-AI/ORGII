/**
 * Git Operations — barrel export for all operation modules
 */
export type { GitOperationResult, RepoContext } from "./types";
export { setRepoContext, getRepoContext } from "./types";

export * as commitOps from "./commitOps";
export * as branchOps from "./branchOps";
export * as mergeOps from "./mergeOps";
export * as remoteOps from "./remoteOps";
export {
  createPullRequest,
  parseGithubRepoFullName,
} from "./createPullRequest";
export type {
  CreatePullRequestParams,
  CreatePullRequestResult,
} from "./createPullRequest";

export {
  fetchIssues,
  fetchIssue,
  createIssue,
  updateIssue,
  closeIssue,
  reopenIssue,
  addIssueComment,
  fetchIssueTimeline,
  issueCommentToTimelineItem,
  fetchRepoLabels,
  fetchRepoAssignees,
} from "./githubIssues";
export type {
  IssueResult,
  GitHubIssue,
  GitHubIssueComment,
  GitHubIssueLabel,
  GitHubIssueUser,
  GitHubIssueListResponse,
  GitHubIssueTimelineItem,
} from "./githubIssues";
