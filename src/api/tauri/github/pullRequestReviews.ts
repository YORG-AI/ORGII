/**
 * GitHub API — pull request files, content, reviews, review comments, checks
 */
import { invokeWithAuth } from "./client";
import type { GitHubIssueUser } from "./types";

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
