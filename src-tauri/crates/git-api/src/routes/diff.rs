//! Diff Routes
//!
//! File diffs, blame, content, and commit diffs

use axum::{
    extract::{Path, Query},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::commands;
use crate::error::{GitApiError, GitApiResult};
use crate::extractors::{decode_file_path, lookup_repo_path, validate_path};
use crate::types::*;

pub fn routes() -> Router {
    Router::new()
        // File content
        .route(
            "/api/git/repo/{repo_id}/file/content",
            get(get_file_content),
        )
        // Diff endpoints
        .route("/api/git/repo/{repo_id}/file/diff", get(get_file_diff))
        .route(
            "/api/git/repo/{repo_id}/files/diff",
            post(get_batch_file_diffs),
        )
        .route("/api/git/repo/{repo_id}/diff/staged", get(get_staged_diff))
        .route(
            "/api/git/repo/{repo_id}/diff/summary",
            get(get_diff_summary),
        )
        .route(
            "/api/git/repo/{repo_id}/diff/numstat",
            get(get_diff_numstat),
        )
        .route(
            "/api/git/repo/{repo_id}/diff/numstat-combined",
            get(get_diff_numstat_combined),
        )
        .route(
            "/api/git/repo/{repo_id}/commits/{commit_sha}/diff",
            get(get_commit_diff),
        )
        // Blame
        .route("/api/git/repo/{repo_id}/blame/{*file_path}", get(get_blame))
}

// ============================================
// Query Types
// ============================================

#[derive(Debug, Deserialize, Default)]
pub struct FileContentQuery {
    path: Option<String>,
    file_path: String,
    #[serde(rename = "ref", default = "default_ref")]
    git_ref: String,
}

fn default_ref() -> String {
    "HEAD".to_string()
}

#[derive(Debug, Deserialize, Default)]
pub struct FileDiffQuery {
    path: Option<String>,
    file_path: String,
    from_ref: Option<String>,
    to_ref: Option<String>,
    context_lines: Option<u32>,
}

#[derive(Debug, Deserialize, Default)]
pub struct StagedDiffQuery {
    path: Option<String>,
    context_lines: Option<u32>,
}

#[derive(Debug, Deserialize, Default)]
pub struct DiffSummaryQuery {
    path: Option<String>,
    from_ref: String,
    to_ref: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct DiffNumstatQuery {
    path: Option<String>,
    from_ref: Option<String>,
    to_ref: Option<String>,
    staged_only: Option<bool>,
}

#[derive(Debug, Deserialize, Default)]
pub struct CommitDiffQuery {
    path: Option<String>,
    context_lines: Option<u32>,
    parent_index: Option<usize>,
}

#[derive(Debug, Deserialize, Default)]
pub struct BlameQuery {
    path: Option<String>,
    #[serde(rename = "ref")]
    git_ref: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct BatchDiffQuery {
    path: Option<String>,
}

// ============================================
// Handlers
// ============================================

/// Get file content at ref
#[utoipa::path(
    get,
    path = "/api/git/repo/{repo_id}/file/content",
    params(
        ("repo_id" = String, Path, description = "Repository UUID or name"),
        ("path" = Option<String>, Query, description = "Repository file system path"),
        ("file_path" = String, Query, description = "File path relative to repository root"),
        ("ref" = String, Query, description = "Git ref (commit SHA, branch, tag, HEAD)"),
    ),
    responses(
        (status = 200, description = "File content", body = FileContentResponse)
    ),
    tag = "files"
)]
pub async fn get_file_content(
    Path(repo_id): Path<String>,
    Query(query): Query<FileContentQuery>,
) -> GitApiResult<Json<FileContentResponse>> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;

    let result = commands::get_file_content(&repo_path, &query.file_path, &query.git_ref)
        .map_err(|message| map_file_content_error(&query.file_path, &query.git_ref, message))?;

    Ok(Json(FileContentResponse {
        status: 0,
        data: result,
    }))
}

/// Get single file diff
#[utoipa::path(
    get,
    path = "/api/git/repo/{repo_id}/file/diff",
    params(
        ("repo_id" = String, Path, description = "Repository UUID or name"),
        ("path" = Option<String>, Query, description = "Repository file system path"),
        ("file_path" = String, Query, description = "File path relative to repository root"),
        ("from_ref" = Option<String>, Query, description = "Base ref (default: HEAD)"),
        ("to_ref" = Option<String>, Query, description = "Target ref (default: WORKING)"),
        ("context_lines" = Option<u32>, Query, description = "Context lines (default: 3)"),
    ),
    responses(
        (status = 200, description = "File diff", body = FileDiffResponse)
    ),
    tag = "diff"
)]
pub async fn get_file_diff(
    Path(repo_id): Path<String>,
    Query(query): Query<FileDiffQuery>,
) -> GitApiResult<Json<FileDiffResponse>> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;

    let from_ref = query.from_ref.as_deref().unwrap_or("HEAD");
    let to_ref = query.to_ref.as_deref();
    let context_lines = query.context_lines.unwrap_or(3);

    let result = commands::get_file_diff(
        &repo_path,
        &query.file_path,
        from_ref,
        to_ref,
        context_lines,
    )
    .map_err(GitApiError::from_git_error)?;

    Ok(Json(FileDiffResponse {
        status: 0,
        data: result,
    }))
}

/// Get batch file diffs
#[utoipa::path(
    post,
    path = "/api/git/repo/{repo_id}/files/diff",
    params(
        ("repo_id" = String, Path, description = "Repository UUID or name"),
        ("path" = Option<String>, Query, description = "Repository file system path"),
    ),
    request_body = BatchFileDiffRequest,
    responses(
        (status = 200, description = "Batch file diffs", body = BatchFileDiffResponse)
    ),
    tag = "diff"
)]
pub async fn get_batch_file_diffs(
    Path(repo_id): Path<String>,
    Query(query): Query<BatchDiffQuery>,
    Json(req): Json<BatchFileDiffRequest>,
) -> GitApiResult<Json<BatchFileDiffResponse>> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;

    let from_ref = req.from_ref.as_deref().unwrap_or("HEAD");
    let to_ref = req.to_ref.as_deref();
    let context_lines = req.context_lines.unwrap_or(3);

    let result = commands::get_batch_file_diffs(
        &repo_path,
        &req.file_paths,
        req.original_paths.as_ref(),
        from_ref,
        to_ref,
        context_lines,
    )
    .map_err(GitApiError::from_git_error)?;

    Ok(Json(BatchFileDiffResponse {
        status: 0,
        data: result,
    }))
}

/// Get staged changes diff
#[utoipa::path(
    get,
    path = "/api/git/repo/{repo_id}/diff/staged",
    params(
        ("repo_id" = String, Path, description = "Repository UUID or name"),
        ("path" = Option<String>, Query, description = "Repository file system path"),
        ("context_lines" = Option<u32>, Query, description = "Context lines (default: 3)"),
    ),
    responses(
        (status = 200, description = "Staged changes diff", body = BatchFileDiffResponse)
    ),
    tag = "diff"
)]
pub async fn get_staged_diff(
    Path(repo_id): Path<String>,
    Query(query): Query<StagedDiffQuery>,
) -> GitApiResult<Json<BatchFileDiffResponse>> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;

    let context_lines = query.context_lines.unwrap_or(3);

    let result = commands::get_staged_diff(&repo_path, context_lines)
        .map_err(GitApiError::from_git_error)?;

    Ok(Json(BatchFileDiffResponse {
        status: 0,
        data: result,
    }))
}

/// Get diff summary (stats only)
#[utoipa::path(
    get,
    path = "/api/git/repo/{repo_id}/diff/summary",
    params(
        ("repo_id" = String, Path, description = "Repository UUID or name"),
        ("path" = Option<String>, Query, description = "Repository file system path"),
        ("from_ref" = String, Query, description = "Base ref"),
        ("to_ref" = Option<String>, Query, description = "Target ref (default: WORKING)"),
    ),
    responses(
        (status = 200, description = "Diff statistics", body = GitDiffStats)
    ),
    tag = "diff"
)]
pub async fn get_diff_summary(
    Path(repo_id): Path<String>,
    Query(query): Query<DiffSummaryQuery>,
) -> GitApiResult<Json<serde_json::Value>> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;

    let result = commands::get_diff_summary(&repo_path, &query.from_ref, query.to_ref.as_deref())
        .map_err(GitApiError::from_git_error)?;

    Ok(Json(serde_json::json!({
        "status": 0,
        "data": result
    })))
}

/// Get per-file diff numstat (insertions/deletions without content)
pub async fn get_diff_numstat(
    Path(repo_id): Path<String>,
    Query(query): Query<DiffNumstatQuery>,
) -> GitApiResult<Json<serde_json::Value>> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;
    let from_ref = query.from_ref.as_deref().unwrap_or("HEAD");
    let staged_only = query.staged_only.unwrap_or(false);

    let result = commands::get_diff_numstat(
        &repo_path,
        from_ref,
        query.to_ref.as_deref(),
        staged_only,
        false,
    )
    .map_err(GitApiError::from_git_error)?;

    Ok(Json(serde_json::json!({
        "status": 0,
        "data": result
    })))
}

#[derive(Debug, Deserialize, Default)]
pub struct DiffNumstatCombinedQuery {
    path: Option<String>,
    from_ref: Option<String>,
    /// When true, untracked (new) files count toward the totals. Defaults to
    /// false so existing callers keep their tracked-only behavior.
    include_untracked: Option<bool>,
}

/// Get combined per-file diff numstat for both staged and unstaged changes.
/// Merges results in Rust to avoid 2 separate IPC calls from frontend.
pub async fn get_diff_numstat_combined(
    Path(repo_id): Path<String>,
    Query(query): Query<DiffNumstatCombinedQuery>,
) -> GitApiResult<Json<serde_json::Value>> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;
    let from_ref = query.from_ref.as_deref().unwrap_or("HEAD");
    let include_untracked = query.include_untracked.unwrap_or(false);

    let result = commands::get_diff_numstat_combined(&repo_path, from_ref, include_untracked)
        .map_err(GitApiError::from_git_error)?;

    Ok(Json(serde_json::json!({
        "status": 0,
        "data": result
    })))
}

/// Get commit diff
#[utoipa::path(
    get,
    path = "/api/git/repo/{repo_id}/commits/{commit_sha}/diff",
    params(
        ("repo_id" = String, Path, description = "Repository UUID or name"),
        ("commit_sha" = String, Path, description = "Commit SHA"),
        ("path" = Option<String>, Query, description = "Repository file system path"),
        ("context_lines" = Option<u32>, Query, description = "Context lines (default: 3)"),
        ("parent_index" = Option<usize>, Query, description = "Merge parent index to diff against (default: first parent)"),
    ),
    responses(
        (status = 200, description = "Commit diff", body = CommitDiffResponse)
    ),
    tag = "diff"
)]
pub async fn get_commit_diff(
    Path((repo_id, commit_sha)): Path<(String, String)>,
    Query(query): Query<CommitDiffQuery>,
) -> GitApiResult<Json<CommitDiffResponse>> {
    let query_path = query.path.as_deref();
    let repo_path = resolve_repo_path(&repo_id, query_path)?;

    log::info!(
        "[GitAPI] commit_diff_route repo_id={} query_path={:?} resolved_repo_path={} commit_sha={} parent_index={:?}",
        repo_id,
        query_path,
        repo_path.display(),
        commit_sha,
        query.parent_index
    );

    let context_lines = query.context_lines.unwrap_or(3);
    let result = commands::get_commit_diff(&repo_path, &commit_sha, query.parent_index, context_lines)
        .map_err(|message| {
            log::warn!(
                "[GitAPI] commit_diff_route_failed repo_id={} query_path={:?} resolved_repo_path={} commit_sha={} error={}",
                repo_id,
                query_path,
                repo_path.display(),
                commit_sha,
                message
            );
            map_commit_diff_error(&commit_sha, message)
        })?;

    Ok(Json(CommitDiffResponse {
        status: 0,
        data: result,
    }))
}

/// Get git blame for file
#[utoipa::path(
    get,
    path = "/api/git/repo/{repo_id}/blame/{file_path}",
    params(
        ("repo_id" = String, Path, description = "Repository UUID or name"),
        ("file_path" = String, Path, description = "File path (URL encoded)"),
        ("path" = Option<String>, Query, description = "Repository file system path"),
        ("ref" = Option<String>, Query, description = "Git ref (default: HEAD)"),
    ),
    responses(
        (status = 200, description = "Blame information", body = BlameResponse)
    ),
    tag = "blame"
)]
pub async fn get_blame(
    Path((repo_id, file_path)): Path<(String, String)>,
    Query(query): Query<BlameQuery>,
) -> GitApiResult<Json<BlameResponse>> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;

    // URL decode the file path
    let decoded_file_path = decode_file_path(&file_path)?;

    let result = commands::get_blame(&repo_path, &decoded_file_path, query.git_ref.as_deref())
        .map_err(GitApiError::from_git_error)?;

    Ok(Json(BlameResponse {
        status: 0,
        data: result,
    }))
}

// ============================================
// Helper
// ============================================

fn resolve_repo_path(repo_id: &str, query_path: Option<&str>) -> GitApiResult<std::path::PathBuf> {
    if let Some(path) = query_path {
        validate_path(path)
    } else {
        lookup_repo_path(repo_id)
    }
}

pub(crate) fn map_commit_diff_error(commit_sha: &str, message: String) -> GitApiError {
    if message.contains("Failed to resolve commit") {
        return GitApiError::CommitNotFound {
            sha: commit_sha.to_string(),
        };
    }
    if message.contains("Failed to get parent") || message.contains("parent index") {
        return GitApiError::InvalidRequest {
            message: format!(
                "Invalid merge parent selection for {}: {}",
                commit_sha, message
            ),
        };
    }
    GitApiError::from_git_error(message)
}

pub(crate) fn map_file_content_error(
    file_path: &str,
    git_ref: &str,
    message: String,
) -> GitApiError {
    if message.contains("Failed to resolve ref") {
        return GitApiError::InvalidRef {
            git_ref: git_ref.to_string(),
        };
    }
    if message.contains("Failed to get commit") {
        return GitApiError::CommitNotFound {
            sha: git_ref.to_string(),
        };
    }
    if message.contains("Failed to get blob") {
        return GitApiError::FileNotFoundAtRef {
            file_path: file_path.to_string(),
            git_ref: git_ref.to_string(),
        };
    }
    GitApiError::from_git_error(message)
}

#[cfg(test)]
#[path = "tests/diff_tests.rs"]
mod tests;
