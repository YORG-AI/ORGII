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

export type PullRequestListState = "open" | "closed";

export async function listPRsLocal(
  repoFullName: string,
  state: PullRequestListState,
  perPage?: number
): Promise<OpenPRItem[]> {
  return invokeWithAuth<OpenPRItem[]>("github_list_prs", {
    repoFullName,
    state,
    perPage: perPage ?? null,
  });
}

export async function listOpenPRsLocal(
  repoFullName: string,
  perPage?: number
): Promise<OpenPRItem[]> {
  return listPRsLocal(repoFullName, "open", perPage);
}

/**
 * Which fetch strategy the backend used to resolve a PR head into a SHA.
 * Mirrors the Rust `PrBaseSource` enum (serialized camelCase).
 */
export type PrBaseSource = "branch" | "pullRef";

/**
 * Result of resolving a GitHub PR into a git-resolvable base ref. Mirrors the
 * Rust `PrBaseResolution`.
 */
export interface PrBaseResolution {
  /** Git-resolvable commit-ish (PR head SHA) for `git worktree add … <base>`. */
  baseRef: string;
  /** PR head commit SHA (identical to `baseRef`). */
  headSha: string;
  /** PR head branch name, when known — a label hint, not a git base. */
  branchNameOverride: string | null;
  /** `refs/remotes/<remote>/<base>` when a base branch was supplied. */
  compareBaseRef: string | null;
  /** `branch` = same-repo head fetch, `pullRef` = fork / `refs/pull/<n>/head`. */
  source: PrBaseSource;
}

/**
 * Resolve a GitHub PR (including fork / cross-repo PRs) into a concrete,
 * git-resolvable base ref by fetching its head into the local repo.
 *
 * Tries `git fetch <remote> <headBranch>` first, falling back to
 * `git fetch <remote> refs/pull/<prNumber>/head` for fork PRs whose head
 * branch is not on the base remote. Returns the head SHA as `baseRef`, ready
 * to feed the isolated-worktree launch path.
 */
export async function resolvePrWorktreeBase(params: {
  repoPath: string;
  prNumber: number;
  remote?: string;
  headBranch?: string;
  baseBranch?: string;
}): Promise<PrBaseResolution> {
  return invoke<PrBaseResolution>("worktree_resolve_pr_base", {
    repoPath: params.repoPath,
    prNumber: params.prNumber,
    remote: params.remote ?? null,
    headBranch: params.headBranch ?? null,
    baseBranch: params.baseBranch ?? null,
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

// ============================================
// Pull Request files, reviews, review comments, checks
// ============================================

/** One changed file in a PR, from `GET /repos/{repo}/pulls/{n}/files`. */
export interface PrFile {
  filename: string;
  /** added | modified | removed | renamed | copied | changed | unchanged */
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
  /** Unified-diff hunks for this file (absent for binary / very large files). */
  patch?: string;
  previous_filename?: string;
  blob_url?: string;
}

export async function listPRFilesLocal(
  repoFullName: string,
  prNumber: number
): Promise<PrFile[]> {
  const data = await invokeWithAuth<unknown>("github_list_pr_files", {
    repoFullName,
    prNumber,
  });
  if (!Array.isArray(data)) return [];
  return (data as Record<string, unknown>[]).map((f) => ({
    filename: String(f.filename ?? ""),
    status: String(f.status ?? "modified"),
    additions: Number(f.additions ?? 0),
    deletions: Number(f.deletions ?? 0),
    changes: Number(f.changes ?? 0),
    sha: String(f.sha ?? ""),
    patch: typeof f.patch === "string" ? f.patch : undefined,
    previous_filename:
      typeof f.previous_filename === "string" ? f.previous_filename : undefined,
    blob_url: typeof f.blob_url === "string" ? f.blob_url : undefined,
  }));
}

/** A file's raw content at a ref (mirrors the Rust `GitHubFileContent`). */
export interface GitHubFileContent {
  content: string;
  is_binary: boolean;
  truncated: boolean;
}

/**
 * Fetch a file's raw content at a commit SHA via the GitHub Contents API.
 * Used by the PR "Files changed" viewer to diff base vs head content without a
 * local clone — the diff auto-loads (no "Fetch PR" step).
 */
export async function getContentLocal(
  repoFullName: string,
  path: string,
  gitRef: string
): Promise<GitHubFileContent> {
  return invokeWithAuth<GitHubFileContent>("github_get_content", {
    repoFullName,
    path,
    gitRef,
  });
}

/** A submitted PR review (mirrors the Rust `GitHubPrReview`). */
export interface GitHubPrReview {
  id: number;
  user: GitHubIssueUser;
  body: string;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING */
  state: string;
  submitted_at: string | null;
  commit_id: string | null;
  html_url: string;
}

/** An inline review comment anchored to a file + line (mirrors Rust). */
export interface GitHubReviewComment {
  id: number;
  body: string;
  user: GitHubIssueUser;
  path: string;
  /** LEFT (pre-image) | RIGHT (post-image) */
  side: string | null;
  line: number | null;
  original_line: number | null;
  start_line: number | null;
  start_side: string | null;
  commit_id: string;
  diff_hunk: string;
  in_reply_to_id: number | null;
  pull_request_review_id: number | null;
  created_at: string;
  updated_at: string;
  html_url: string;
}

export interface GitHubCheckRun {
  id: number;
  name: string;
  /** queued | in_progress | completed */
  status: string;
  /** success | failure | neutral | cancelled | timed_out | action_required | skipped | stale */
  conclusion: string | null;
  details_url: string | null;
  started_at: string | null;
  completed_at: string | null;
  output_title: string | null;
  app_name: string | null;
}

export interface GitHubStatusContext {
  context: string;
  /** success | pending | failure | error */
  state: string;
  description: string | null;
  target_url: string | null;
  avatar_url: string | null;
}

export interface GitHubChecksSummary {
  sha: string;
  check_runs: GitHubCheckRun[];
  statuses: GitHubStatusContext[];
  /** success | pending | failure — rolled up across runs + statuses. */
  state: string;
}

export type PrReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export async function listPrReviewsLocal(
  repoFullName: string,
  prNumber: number
): Promise<GitHubPrReview[]> {
  return invokeWithAuth<GitHubPrReview[]>("github_list_pr_reviews", {
    repoFullName,
    prNumber,
  });
}

export async function listPrReviewCommentsLocal(
  repoFullName: string,
  prNumber: number
): Promise<GitHubReviewComment[]> {
  return invokeWithAuth<GitHubReviewComment[]>(
    "github_list_pr_review_comments",
    { repoFullName, prNumber }
  );
}

export async function createPrReviewLocal(
  repoFullName: string,
  prNumber: number,
  event: PrReviewEvent,
  body?: string,
  commitId?: string
): Promise<GitHubPrReview> {
  return invokeWithAuth<GitHubPrReview>("github_create_pr_review", {
    repoFullName,
    prNumber,
    event,
    body: body ?? null,
    commitId: commitId ?? null,
  });
}

export async function createPrReviewCommentLocal(
  repoFullName: string,
  prNumber: number,
  params: {
    body: string;
    commitId: string;
    path: string;
    line: number;
    side?: "LEFT" | "RIGHT";
    startLine?: number;
    startSide?: "LEFT" | "RIGHT";
  }
): Promise<GitHubReviewComment> {
  return invokeWithAuth<GitHubReviewComment>(
    "github_create_pr_review_comment",
    {
      repoFullName,
      prNumber,
      body: params.body,
      commitId: params.commitId,
      path: params.path,
      line: params.line,
      side: params.side ?? null,
      startLine: params.startLine ?? null,
      startSide: params.startSide ?? null,
    }
  );
}

export async function replyPrReviewCommentLocal(
  repoFullName: string,
  prNumber: number,
  commentId: number,
  body: string
): Promise<GitHubReviewComment> {
  return invokeWithAuth<GitHubReviewComment>("github_reply_pr_review_comment", {
    repoFullName,
    prNumber,
    commentId,
    body,
  });
}

export async function getChecksLocal(
  repoFullName: string,
  gitRef: string
): Promise<GitHubChecksSummary> {
  return invokeWithAuth<GitHubChecksSummary>("github_get_checks", {
    repoFullName,
    gitRef,
  });
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
