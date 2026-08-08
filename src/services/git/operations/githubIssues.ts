/**
 * Agent-callable orchestration functions for GitHub Issues.
 * These wrap the low-level Tauri IPC calls with repo context resolution
 * and error normalization. Credentials are resolved Rust-side from the
 * centralized connection token store — no auth params needed here.
 */
import {
  createIssueCommentLocal,
  createIssueLocal,
  getIssueLocal,
  listIssueTimelineLocal,
  listIssuesLocal,
  listRepoAssigneesLocal,
  listRepoLabelsLocal,
  updateIssueLocal,
} from "@src/api/tauri/github";
import type {
  GitHubIssue,
  GitHubIssueComment,
  GitHubIssueLabel,
  GitHubIssueListResponse,
  GitHubIssueTimelineItem,
  GitHubIssueUser,
} from "@src/api/tauri/github";

import { parseGithubRepoFullName } from "./createPullRequest";

// Re-export types for consumers
export type {
  GitHubIssue,
  GitHubIssueComment,
  GitHubIssueLabel,
  GitHubIssueListResponse,
  GitHubIssueTimelineItem,
  GitHubIssueUser,
};

export type IssueResult<T> =
  | { data: T; error?: never }
  | { data?: never; error: string };

function resolveRepoName(remoteUrl: string): string | null {
  return parseGithubRepoFullName(remoteUrl);
}

export async function fetchIssues(
  remoteUrl: string,
  opts?: {
    state?: "open" | "closed" | "all";
    labels?: string;
    page?: number;
    perPage?: number;
  }
): Promise<IssueResult<GitHubIssueListResponse>> {
  try {
    const repoFullName = resolveRepoName(remoteUrl);
    if (!repoFullName) return { error: "not_authenticated" };
    const data = await listIssuesLocal(repoFullName, opts);
    return { data };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function fetchIssue(
  remoteUrl: string,
  issueNumber: number
): Promise<IssueResult<GitHubIssue>> {
  try {
    const repoFullName = resolveRepoName(remoteUrl);
    if (!repoFullName) return { error: "not_authenticated" };
    const data = await getIssueLocal(repoFullName, issueNumber);
    return { data };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function createIssue(params: {
  remoteUrl: string;
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}): Promise<IssueResult<GitHubIssue>> {
  try {
    const repoFullName = resolveRepoName(params.remoteUrl);
    if (!repoFullName) return { error: "not_authenticated" };
    const data = await createIssueLocal(
      repoFullName,
      params.title,
      params.body,
      params.labels,
      params.assignees
    );
    return { data };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function closeIssue(params: {
  remoteUrl: string;
  issueNumber: number;
  reason?: "completed" | "not_planned";
}): Promise<IssueResult<GitHubIssue>> {
  try {
    const repoFullName = resolveRepoName(params.remoteUrl);
    if (!repoFullName) return { error: "not_authenticated" };
    const data = await updateIssueLocal(repoFullName, params.issueNumber, {
      state: "closed",
      stateReason: params.reason ?? "completed",
    });
    return { data };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function reopenIssue(params: {
  remoteUrl: string;
  issueNumber: number;
}): Promise<IssueResult<GitHubIssue>> {
  try {
    const repoFullName = resolveRepoName(params.remoteUrl);
    if (!repoFullName) return { error: "not_authenticated" };
    const data = await updateIssueLocal(repoFullName, params.issueNumber, {
      state: "open",
    });
    return { data };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function addIssueComment(params: {
  remoteUrl: string;
  issueNumber: number;
  body: string;
}): Promise<IssueResult<GitHubIssueComment>> {
  try {
    const repoFullName = resolveRepoName(params.remoteUrl);
    if (!repoFullName) return { error: "not_authenticated" };
    const data = await createIssueCommentLocal(
      repoFullName,
      params.issueNumber,
      params.body
    );
    return { data };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function fetchIssueTimeline(params: {
  remoteUrl: string;
  issueNumber: number;
}): Promise<IssueResult<GitHubIssueTimelineItem[]>> {
  try {
    const repoFullName = resolveRepoName(params.remoteUrl);
    if (!repoFullName) return { error: "not_authenticated" };
    const data = await listIssueTimelineLocal(repoFullName, params.issueNumber);
    return { data };
  } catch (e) {
    return { error: String(e) };
  }
}

export function issueCommentToTimelineItem(
  comment: GitHubIssueComment
): GitHubIssueTimelineItem {
  return {
    id: comment.id,
    event: "commented",
    created_at: comment.created_at,
    actor: comment.user,
    body: comment.body,
    html_url: comment.html_url,
    assignee: null,
    label: null,
    milestone: null,
    rename: null,
    source: null,
    commit_id: null,
    lock_reason: null,
  };
}

export async function updateIssue(params: {
  remoteUrl: string;
  issueNumber: number;
  updates: {
    title?: string;
    body?: string;
    state?: "open" | "closed";
    stateReason?: "completed" | "not_planned";
    labels?: string[];
    assignees?: string[];
  };
}): Promise<IssueResult<GitHubIssue>> {
  try {
    const repoFullName = resolveRepoName(params.remoteUrl);
    if (!repoFullName) return { error: "not_authenticated" };
    const data = await updateIssueLocal(
      repoFullName,
      params.issueNumber,
      params.updates
    );
    return { data };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function fetchRepoLabels(
  remoteUrl: string
): Promise<IssueResult<GitHubIssueLabel[]>> {
  try {
    const repoFullName = resolveRepoName(remoteUrl);
    if (!repoFullName) return { error: "not_authenticated" };
    const data = await listRepoLabelsLocal(repoFullName);
    return { data };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function fetchRepoAssignees(
  remoteUrl: string
): Promise<IssueResult<GitHubIssueUser[]>> {
  try {
    const repoFullName = resolveRepoName(remoteUrl);
    if (!repoFullName) return { error: "not_authenticated" };
    const data = await listRepoAssigneesLocal(repoFullName);
    return { data };
  } catch (e) {
    return { error: String(e) };
  }
}
