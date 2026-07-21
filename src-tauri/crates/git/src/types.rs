//! Pure-data types for the `git` core module.
//!
//! This module is deliberately free of HTTP/OpenAPI concerns: it does NOT
//! depend on `utoipa`. The `api::git` layer owns parallel `ToSchema`-deriving
//! structs and converts via `From` impls. This keeps the dependency edge
//! pointing api → git (never git → api).

use serde::{Deserialize, Serialize};

/// A single entry in the working-directory file list reported by `git status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkingDirectoryFile {
    pub path: String,
    /// Single-character status code: M, A, D, R, C, U, ?, !
    pub status: String,
    pub staged: bool,
    pub original_path: Option<String>,
}

/// Information about a single git branch (local or remote).
///
/// Pure-data mirror of `git_api::types::GitBranchInfo` without the utoipa
/// `ToSchema` derive. The api layer converts via `From`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchInfo {
    pub name: String,
    pub upstream: Option<String>,
    pub tip_sha: String,
    /// "local" or "remote"
    pub branch_type: String,
    pub ref_name: String,
    pub is_current: bool,
    /// ISO 8601 format
    pub last_commit_date: Option<String>,
}

/// Branch listing for a repository.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchesData {
    pub branches: Vec<BranchInfo>,
    pub current_branch: String,
}
