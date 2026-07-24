/**
 * GitHub Local API
 *
 * Calls GitHub API directly from Tauri Rust. Credentials are resolved
 * inside the Rust commands from `connection_token_store` — the frontend
 * no longer passes user IDs or hosted-service tokens.
 *
 * Grouped by concern:
 * - client:              shared `invoke` wrapper + GitHub re-auth error
 * - types:                cross-domain types (mirror Rust-side structs)
 * - repos:                repo listing, network identity, branches, clone
 * - search:               public repository search
 * - pullRequests:         PR create, list, find, get, commits, base resolution
 * - pullRequestReviews:   PR files, content, reviews, review comments, checks
 * - credentials:          git credential resolution, token check, profile
 * - issues:               issues, comments, timeline, labels, collaborators
 */

export { GitHubReAuthError } from "./client";
export * from "./types";
export * from "./repos";
export * from "./search";
export * from "./pullRequests";
export * from "./pullRequestReviews";
export * from "./credentials";
export * from "./issues";
