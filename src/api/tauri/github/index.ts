/**
 * GitHub Local API
 *
 * Calls GitHub API directly from Tauri Rust. Credentials are resolved
 * inside the Rust commands from `connection_token_store` — the frontend
 * no longer passes user IDs or hosted-service tokens.
 */
import { invoke } from "@tauri-apps/api/core";

import { appendPullRequestAttributionFooter } from "@src/services/git/operations/commitAttribution";

/**
 * Thrown when the active Git connection is missing or rejected (401) and
 * the user must re-authorize via the Connections wizard.
 */
export class GitHubReAuthError extends Error {
  constructor() {
    super("GitHub re-authorization required");
    this.name = "GitHubReAuthError";
  }
}

async function invokeWithAuth<T>(
  command: string,
  args: Record<string, unknown>
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (err: unknown) {
    const msg = String(err);
    if (msg.includes("GitHubReAuthRequired")) {
      throw new GitHubReAuthError();
    }
    throw err;
  }
}

// ============================================
// Types (mirror Rust-side structs)
// ============================================

export interface LocalGitHubRepo {
  id: number;
  full_name: string;
  name: string;
  private: boolean;
  description: string | null;
  html_url: string;
  default_branch: string;
  language: string | null;
  stargazers_count: number;
  updated_at: string;
}

export interface LocalGitHubBranch {
  name: string;
  sha: string;
  protected: boolean;
}

export interface LocalPRResponse {
  number: number;
  url: string;
}

export interface LocalFindPRResponse {
  number: number;
  url: string;
  state: string;
}

export interface GitHubGitCredential {
  username: string;
  token: string;
  repo_full_name: string;
}

/** Generic Git credential resolved from `connection_token_store`. */
export interface GitCredential {
  connection_id: string;
  username: string;
  token: string;
  source: string;
}

export interface ProfileData {
  user: Record<string, unknown>;
  repos: Record<string, unknown>[];
  languages: { language: string; bytes: number; percentage: number }[];
  commit_history: { year: number; total_commits: number }[];
  top_repos: Record<string, unknown>[];
}

export interface GhCliCredential {
  username: string;
  token: string;
}

export interface SshKeyInfo {
  filename: string;
  key_type: string;
  comment: string;
}

export interface CredentialHelperInfo {
  helper: string;
  username: string | null;
  token: string | null;
}

export interface DetectedGitHubCredentials {
  gh_cli: GhCliCredential | null;
  ssh_keys: SshKeyInfo[];
  credential_helper: CredentialHelperInfo | null;
  git_credentials_has_github: boolean;
}

// ============================================
// API Functions
// ============================================

export async function listReposLocal(
  page?: number,
  perPage?: number
): Promise<LocalGitHubRepo[]> {
  return invokeWithAuth<LocalGitHubRepo[]>("github_list_repos", {
    page: page ?? null,
    perPage: perPage ?? null,
  });
}

// ============================================
// GitHub Search Types & API
// ============================================

export interface SearchRepo {
  id: number;
  full_name: string;
  name: string;
  owner_login: string;
  owner_avatar_url: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  description: string | null;
  html_url: string;
  clone_url: string;
  default_branch: string;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  license: string | null;
  topics: string[];
  updated_at: string;
}

export type RepoSearchSort = "best_match" | "stars" | "forks" | "updated";

export interface RepoSearchResponse {
  items: SearchRepo[];
  total_count: number;
  incomplete_results: boolean;
  /**
   * Whether the request reused the user's connection token. `false`
   * means we hit the unauthenticated 10 req/min rate limit; the
   * Explore page warns the user when this is false.
   */
  authenticated: boolean;
}

/**
 * Search GitHub public repositories. Reuses the user's token when
 * available, falls back to unauthenticated requests otherwise.
 * Note: this command intentionally does not use `invokeWithAuth` —
 * unauthenticated mode is a valid response, not a re-auth condition.
 */
export async function searchReposLocal(
  query: string,
  opts?: { sort?: RepoSearchSort; page?: number; perPage?: number }
): Promise<RepoSearchResponse> {
  return invoke<RepoSearchResponse>("github_search_repos", {
    query,
    sort: opts?.sort ?? null,
    page: opts?.page ?? null,
    perPage: opts?.perPage ?? null,
  });
}

export async function listBranchesLocal(
  repoFullName: string
): Promise<LocalGitHubBranch[]> {
  return invokeWithAuth<LocalGitHubBranch[]>("github_list_branches", {
    repoFullName,
  });
}

export async function createBranchLocal(
  repoFullName: string,
  branchName: string,
  fromSha: string
): Promise<string> {
  return invokeWithAuth<string>("github_create_branch", {
    repoFullName,
    branchName,
    fromSha,
  });
}

export async function createPRLocal(
  repoFullName: string,
  title: string,
  head: string,
  base: string,
  body?: string,
  draft?: boolean
): Promise<LocalPRResponse> {
  return invokeWithAuth<LocalPRResponse>("github_create_pr", {
    repoFullName,
    title,
    head,
    base,
    body: appendPullRequestAttributionFooter(body),
    draft: draft ?? null,
  });
}

export interface OpenPRItem {
  number: number;
  url: string;
  title: string;
  state: string;
  head_branch: string;
  base_branch: string;
  draft: boolean;
  created_at: string;
  updated_at: string;
}

export async function listOpenPRsLocal(
  repoFullName: string,
  perPage?: number
): Promise<OpenPRItem[]> {
  return invokeWithAuth<OpenPRItem[]>("github_list_open_prs", {
    repoFullName,
    perPage: perPage ?? null,
  });
}

export async function findPullRequestLocal(
  repoFullName: string,
  headBranch: string
): Promise<LocalFindPRResponse | null> {
  return invokeWithAuth<LocalFindPRResponse | null>(
    "github_find_pull_request",
    {
      repoFullName,
      headBranch,
    }
  );
}

export async function getPRLocal(
  repoFullName: string,
  prNumber: number
): Promise<Record<string, unknown>> {
  return invokeWithAuth<Record<string, unknown>>("github_get_pr", {
    repoFullName,
    prNumber,
  });
}

export async function listPRCommitsLocal(
  repoFullName: string,
  prNumber: number
): Promise<Record<string, unknown>[]> {
  const data = await invokeWithAuth<unknown>("github_list_pr_commits", {
    repoFullName,
    prNumber,
  });
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

export async function cloneRepoLocal(
  repoFullName: string,
  targetDir: string,
  branch?: string
): Promise<string> {
  return invokeWithAuth<string>("github_clone_repo", {
    repoFullName,
    targetDir,
    branch: branch ?? null,
  });
}

/**
 * GitHub-flavored credential lookup. Returns the active token paired
 * with the inferred `owner/repo` for the given remote, or `null` when
 * the remote is not a GitHub URL or no credential is on file.
 */
export async function getGitHubGitCredentialForRemote(
  remoteUrl: string
): Promise<GitHubGitCredential | null> {
  return invoke<GitHubGitCredential | null>(
    "github_git_credential_for_remote",
    { remoteUrl }
  );
}

/**
 * Generic Git credential lookup against `connection_token_store`. Returns
 * `null` for SSH-only remotes (handled by the system `git` config) or
 * when no HTTPS credential is on file.
 */
export async function getGitCredentialForRemote(
  remoteUrl: string
): Promise<GitCredential | null> {
  return invoke<GitCredential | null>("git_credential_for_remote", {
    remoteUrl,
  });
}

export async function checkTokenLocal(): Promise<boolean> {
  return invokeWithAuth<boolean>("github_check_token", {});
}

export async function fetchProfileLocal(): Promise<ProfileData> {
  return invokeWithAuth<ProfileData>("github_fetch_profile", {});
}

export async function detectGitHubCredentials(): Promise<DetectedGitHubCredentials> {
  return invoke<DetectedGitHubCredentials>("detect_github_credentials");
}

// ============================================
// GitHub Issues Types
// ============================================

export interface GitHubIssueLabel {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface GitHubIssueUser {
  login: string;
  avatar_url: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason: "completed" | "not_planned" | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  user: GitHubIssueUser;
  labels: GitHubIssueLabel[];
  assignees: GitHubIssueUser[];
  comments: number;
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

export interface GitHubIssueListResponse {
  issues: GitHubIssue[];
  total_count: number;
  has_more: boolean;
  next_page: number | null;
}

// ============================================
// GitHub Issues API Functions
// ============================================

export async function listIssuesLocal(
  repoFullName: string,
  opts?: {
    state?: "open" | "closed" | "all";
    labels?: string;
    page?: number;
    perPage?: number;
  }
): Promise<GitHubIssueListResponse> {
  return invokeWithAuth<GitHubIssueListResponse>("github_list_issues", {
    repoFullName,
    state: opts?.state ?? "open",
    labels: opts?.labels ?? null,
    page: opts?.page ?? 1,
    perPage: opts?.perPage ?? null,
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
    stateReason?: "completed" | "not_planned";
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

export async function listRepoCollaboratorsLocal(
  repoFullName: string
): Promise<GitHubIssueUser[]> {
  return invokeWithAuth<GitHubIssueUser[]>("github_list_repo_collaborators", {
    repoFullName,
  });
}
