/**
 * GitHub API — issues (types + CRUD, comments, timeline, labels,
 * collaborators)
 */
import { invokeWithAuth } from "./client";
import type { GitHubIssueUser } from "./types";

export interface GitHubIssueLabel {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface GitHubIssue {
  /** GitHub's database ID, used by mutations such as close-as-duplicate. */
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason: "completed" | "not_planned" | "duplicate" | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  user: GitHubIssueUser;
  labels: GitHubIssueLabel[];
  assignees: GitHubIssueUser[];
  comments: number;
  /** Number of open or closed PRs linked through GitHub's issue development metadata. */
  linked_pull_requests_count?: number;
  milestone: string | null;
}

export interface GitHubIssueComment {
  id: number;
  body: string;
  user: GitHubIssueUser;
  created_at: string;
  updated_at: string;
  html_url: string;
}

export interface GitHubIssueTimelineLabel {
  name: string;
  color: string;
}

export interface GitHubIssueTimelineRename {
  from: string;
  to: string;
}

export interface GitHubIssueTimelineSource {
  number: number;
  title: string;
  html_url: string;
  state: string;
  is_pull_request: boolean;
}

/** Stable frontend shape for GitHub's event-specific issue timeline payloads. */
export interface GitHubIssueTimelineItem {
  id: number | null;
  event: string;
  created_at: string | null;
  actor: GitHubIssueUser | null;
  body: string | null;
  html_url: string | null;
  assignee: GitHubIssueUser | null;
  label: GitHubIssueTimelineLabel | null;
  milestone: string | null;
  rename: GitHubIssueTimelineRename | null;
  source: GitHubIssueTimelineSource | null;
  commit_id: string | null;
  lock_reason: string | null;
}

export interface GitHubIssueListResponse {
  issues: GitHubIssue[];
  total_count: number;
  has_more: boolean;
  next_page: number | null;
}

export async function listIssuesLocal(
  repoFullName: string,
  opts?: {
    state?: "open" | "closed" | "all";
    labels?: string;
    page?: number;
    perPage?: number;
    includeLinkedPullRequests?: boolean;
  }
): Promise<GitHubIssueListResponse> {
  return invokeWithAuth<GitHubIssueListResponse>("github_list_issues", {
    repoFullName,
    state: opts?.state ?? "open",
    labels: opts?.labels ?? null,
    page: opts?.page ?? 1,
    perPage: opts?.perPage ?? null,
    includeLinkedPullRequests: opts?.includeLinkedPullRequests ?? true,
  });
}

export async function getIssueLocal(
  repoFullName: string,
  issueNumber: number
): Promise<GitHubIssue> {
  return invokeWithAuth<GitHubIssue>("github_get_issue", {
    repoFullName,
    issueNumber,
  });
}

export async function createIssueLocal(
  repoFullName: string,
  title: string,
  body?: string,
  labels?: string[],
  assignees?: string[]
): Promise<GitHubIssue> {
  return invokeWithAuth<GitHubIssue>("github_create_issue", {
    repoFullName,
    title,
    body: body ?? null,
    labels: labels ?? null,
    assignees: assignees ?? null,
  });
}

export async function updateIssueLocal(
  repoFullName: string,
  issueNumber: number,
  updates: {
    title?: string;
    body?: string;
    state?: "open" | "closed";
    stateReason?: "completed" | "not_planned" | "duplicate";
    /** Database ID of the canonical issue when closing as a duplicate. */
    duplicateIssueId?: number;
    labels?: string[];
    assignees?: string[];
  }
): Promise<GitHubIssue> {
  return invokeWithAuth<GitHubIssue>("github_update_issue", {
    repoFullName,
    issueNumber,
    title: updates.title ?? null,
    body: updates.body ?? null,
    state: updates.state ?? null,
    stateReason: updates.stateReason ?? null,
    duplicateIssueId: updates.duplicateIssueId ?? null,
    labels: updates.labels ?? null,
    assignees: updates.assignees ?? null,
  });
}

export async function listIssueCommentsLocal(
  repoFullName: string,
  issueNumber: number
): Promise<GitHubIssueComment[]> {
  return invokeWithAuth<GitHubIssueComment[]>("github_list_issue_comments", {
    repoFullName,
    issueNumber,
  });
}

export async function listIssueTimelineLocal(
  repoFullName: string,
  issueNumber: number
): Promise<GitHubIssueTimelineItem[]> {
  return invokeWithAuth<GitHubIssueTimelineItem[]>(
    "github_list_issue_timeline",
    {
      repoFullName,
      issueNumber,
    }
  );
}

export async function createIssueCommentLocal(
  repoFullName: string,
  issueNumber: number,
  body: string
): Promise<GitHubIssueComment> {
  return invokeWithAuth<GitHubIssueComment>("github_create_issue_comment", {
    repoFullName,
    issueNumber,
    body,
  });
}

export async function listRepoLabelsLocal(
  repoFullName: string
): Promise<GitHubIssueLabel[]> {
  return invokeWithAuth<GitHubIssueLabel[]>("github_list_repo_labels", {
    repoFullName,
  });
}

export async function listRepoAssigneesLocal(
  repoFullName: string
): Promise<GitHubIssueUser[]> {
  return invokeWithAuth<GitHubIssueUser[]>("github_list_repo_assignees", {
    repoFullName,
  });
}
