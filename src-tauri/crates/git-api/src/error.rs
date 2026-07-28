//! Git API Error Types
//!
//! Standardized error handling using thiserror for the Git HTTP API.
//! Provides structured errors with proper HTTP status codes.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use thiserror::Error;
use utoipa::ToSchema;

/// Git API errors with proper categorization
#[derive(Error, Debug)]
pub enum GitApiError {
    // ============================================
    // Repository Errors
    // ============================================
    #[error("Repository not found: {repo_id}")]
    RepoNotFound { repo_id: String },

    #[error("Repository path not found: {path}")]
    RepoPathNotFound { path: PathBuf },

    #[error("Not a git repository: {path}")]
    NotAGitRepo { path: PathBuf },

    #[error("Repo watch manager not initialized")]
    WatchManagerNotInitialized,

    // ============================================
    // Path Validation Errors
    // ============================================
    #[error("Invalid path: {reason}")]
    InvalidPath { path: String, reason: String },

    #[error("Path traversal detected: {path}")]
    PathTraversal { path: String },

    #[error("Path outside allowed directories: {path}")]
    PathNotAllowed { path: String },

    // ============================================
    // Git Operation Errors
    // ============================================
    #[error("Git operation failed: {message}")]
    GitOperation { message: String },

    #[error("Branch not found: {branch}")]
    BranchNotFound { branch: String },

    #[error("Commit not found: {sha}")]
    CommitNotFound { sha: String },

    #[error("File not found at ref: {file_path} @ {git_ref}")]
    FileNotFoundAtRef { file_path: String, git_ref: String },

    #[error("Merge conflict: {message}")]
    MergeConflict { message: String, files: Vec<String> },

    #[error("Nothing to commit")]
    NothingToCommit,

    #[error("Uncommitted changes would be overwritten")]
    UncommittedChanges { files: Vec<String> },

    // ============================================
    // Remote Operation Errors
    // ============================================
    #[error("Remote not found: {remote}")]
    RemoteNotFound { remote: String },

    #[error("Authentication failed for remote: {remote}")]
    AuthenticationFailed { remote: String },

    #[error("Push rejected (non-fast-forward): {message}")]
    NonFastForward { message: String },

    #[error("Network error: {message}")]
    NetworkError { message: String },

    // ============================================
    // Input Validation Errors
    // ============================================
    #[error("Invalid request: {message}")]
    InvalidRequest { message: String },

    #[error("Invalid file path encoding: {message}")]
    InvalidEncoding { message: String },

    #[error("Invalid git ref: {git_ref}")]
    InvalidRef { git_ref: String },

    // ============================================
    // Internal Errors
    // ============================================
    #[error("Internal error: {message}")]
    Internal { message: String },

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Git command timed out")]
    Timeout,
}

impl GitApiError {
    /// Get the HTTP status code for this error
    pub fn status_code(&self) -> StatusCode {
        match self {
            // 400 Bad Request
            GitApiError::InvalidPath { .. }
            | GitApiError::InvalidRequest { .. }
            | GitApiError::InvalidEncoding { .. }
            | GitApiError::InvalidRef { .. }
            | GitApiError::NothingToCommit => StatusCode::BAD_REQUEST,

            // 401 Unauthorized
            GitApiError::AuthenticationFailed { .. } => StatusCode::UNAUTHORIZED,

            // 403 Forbidden
            GitApiError::PathTraversal { .. } | GitApiError::PathNotAllowed { .. } => {
                StatusCode::FORBIDDEN
            }

            // 404 Not Found
            GitApiError::RepoNotFound { .. }
            | GitApiError::RepoPathNotFound { .. }
            | GitApiError::NotAGitRepo { .. }
            | GitApiError::BranchNotFound { .. }
            | GitApiError::CommitNotFound { .. }
            | GitApiError::FileNotFoundAtRef { .. }
            | GitApiError::RemoteNotFound { .. } => StatusCode::NOT_FOUND,

            // 409 Conflict
            GitApiError::MergeConflict { .. }
            | GitApiError::NonFastForward { .. }
            | GitApiError::UncommittedChanges { .. } => StatusCode::CONFLICT,

            // 503 Service Unavailable
            GitApiError::NetworkError { .. } | GitApiError::Timeout => {
                StatusCode::SERVICE_UNAVAILABLE
            }

            // 500 Internal Server Error
            GitApiError::GitOperation { .. }
            | GitApiError::WatchManagerNotInitialized
            | GitApiError::Internal { .. }
            | GitApiError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    /// Get a machine-readable error type string
    pub fn error_type(&self) -> &'static str {
        match self {
            GitApiError::RepoNotFound { .. } => "repo_not_found",
            GitApiError::RepoPathNotFound { .. } => "repo_path_not_found",
            GitApiError::NotAGitRepo { .. } => "not_a_git_repo",
            GitApiError::WatchManagerNotInitialized => "watch_manager_not_initialized",
            GitApiError::InvalidPath { .. } => "invalid_path",
            GitApiError::PathTraversal { .. } => "path_traversal",
            GitApiError::PathNotAllowed { .. } => "path_not_allowed",
            GitApiError::GitOperation { .. } => "git_operation_failed",
            GitApiError::BranchNotFound { .. } => "branch_not_found",
            GitApiError::CommitNotFound { .. } => "commit_not_found",
            GitApiError::FileNotFoundAtRef { .. } => "file_not_found",
            GitApiError::MergeConflict { .. } => "merge_conflict",
            GitApiError::NothingToCommit => "nothing_to_commit",
            GitApiError::UncommittedChanges { .. } => "uncommitted_changes",
            GitApiError::RemoteNotFound { .. } => "remote_not_found",
            GitApiError::AuthenticationFailed { .. } => "authentication_failed",
            GitApiError::NonFastForward { .. } => "non_fast_forward",
            GitApiError::NetworkError { .. } => "network_error",
            GitApiError::InvalidRequest { .. } => "invalid_request",
            GitApiError::InvalidEncoding { .. } => "invalid_encoding",
            GitApiError::InvalidRef { .. } => "invalid_ref",
            GitApiError::Internal { .. } => "internal_error",
            GitApiError::Io(_) => "io_error",
            GitApiError::Timeout => "timeout",
        }
    }

    /// Create from a generic git error message (for backward compatibility)
    pub fn from_git_error(message: impl Into<String>) -> Self {
        let msg = message.into();
        let normalized = msg.to_ascii_lowercase();

        // Parse known error patterns
        if normalized.contains("not a git repository") {
            return GitApiError::NotAGitRepo {
                path: PathBuf::from("unknown"),
            };
        }
        if normalized.contains("nothing to commit") {
            return GitApiError::NothingToCommit;
        }
        if normalized.contains("non-fast-forward") || normalized.contains("rejected") {
            return GitApiError::NonFastForward { message: msg };
        }
        if normalized.contains("authentication failed")
            || normalized.contains("could not read username")
        {
            return GitApiError::AuthenticationFailed {
                remote: "origin".into(),
            };
        }
        if normalized.contains("could not resolve host")
            || normalized.contains("connection refused")
        {
            return GitApiError::NetworkError { message: msg };
        }

        GitApiError::GitOperation { message: msg }
    }
}

impl IntoResponse for GitApiError {
    fn into_response(self) -> Response {
        let status = self.status_code();
        let error_type = self.error_type();
        let message = self.to_string();

        // Include additional details for certain errors
        let details = match &self {
            GitApiError::MergeConflict { files, .. } => {
                Some(serde_json::json!({ "conflicted_files": files }))
            }
            GitApiError::UncommittedChanges { files } => {
                Some(serde_json::json!({ "affected_files": files }))
            }
            _ => None,
        };

        let body = serde_json::json!({
            "error": message,
            "error_type": error_type,
            "details": details,
        });

        (status, Json(body)).into_response()
    }
}

/// Result type alias for Git API operations
pub type GitApiResult<T> = Result<T, GitApiError>;

/// Lightweight HTTP error envelope for non-Git routes hosted on the same
/// axum router (currently `routes/file.rs`'s blob/stage endpoints, which
/// shell out via `Command` rather than going through `git2`).
///
/// Local copy so `git_api` has no back-edge into the `app` crate. The
/// sibling `api_search` crate carries its own `error::ApiError` for the
/// search routes; both types serialize to the same `{ error, error_type }`
/// JSON shape.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ApiError {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_type: Option<String>,
}

impl ApiError {
    pub fn new(error: impl Into<String>) -> Self {
        Self {
            error: error.into(),
            error_type: None,
        }
    }

    pub fn with_type(error: impl Into<String>, error_type: impl Into<String>) -> Self {
        Self {
            error: error.into(),
            error_type: Some(error_type.into()),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(self)).into_response()
    }
}
