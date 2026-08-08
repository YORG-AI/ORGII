//! Worktree Routes
//!
//! Lists git worktrees registered for a repository.

use std::collections::HashMap;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::{
    extract::{Path, Query},
    routing::{delete, get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::error::{GitApiError, GitApiResult};
use crate::extractors::{lookup_repo_path, validate_path};
use crate::types::{
    CreateWorktreeRequest, RemoveWorktreeRequest, WorktreeDiffSummary, WorktreeEntry,
    WorktreeListResponse, WorktreeRemoveResponse,
};

/// Cache TTL for worktree diff summaries. Recomputation is skipped if the
/// HEAD SHA hasn't changed and the entry is younger than this duration.
const DIFF_CACHE_TTL: Duration = Duration::from_secs(5);
const DIFF_CACHE_MAX_ENTRIES: usize = 128;

struct DiffCacheEntry {
    cached_at: Instant,
    summary: Option<WorktreeDiffSummary>,
}

/// `(worktree_path, head_sha)` → cached diff summary.
static DIFF_CACHE: std::sync::OnceLock<Mutex<HashMap<(String, String), DiffCacheEntry>>> =
    std::sync::OnceLock::new();

fn diff_cache() -> &'static Mutex<HashMap<(String, String), DiffCacheEntry>> {
    DIFF_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn insert_diff_cache_entry(
    cache: &mut HashMap<(String, String), DiffCacheEntry>,
    key: (String, String),
    entry: DiffCacheEntry,
) {
    cache.retain(|_, cached| cached.cached_at.elapsed() < DIFF_CACHE_TTL);
    if !cache.contains_key(&key) && cache.len() >= DIFF_CACHE_MAX_ENTRIES {
        if let Some(oldest_key) = cache
            .iter()
            .min_by_key(|(_, cached)| cached.cached_at)
            .map(|(key, _)| key.clone())
        {
            cache.remove(&oldest_key);
        }
    }
    cache.insert(key, entry);
}

pub fn routes() -> Router {
    Router::new()
        .route("/api/git/repo/{repo_id}/worktrees", get(get_worktrees))
        .route("/api/git/repo/{repo_id}/worktrees", post(create_worktree))
        .route("/api/git/repo/{repo_id}/worktrees", delete(remove_worktree))
}

#[derive(Debug, Deserialize, Default)]
pub struct WorktreesQuery {
    path: Option<String>,
    include_diff_summary: Option<bool>,
}

#[utoipa::path(
    get,
    path = "/api/git/repo/{repo_id}/worktrees",
    params(
        ("repo_id" = String, Path, description = "Repository UUID or path"),
        ("path" = Option<String>, Query, description = "Repository file system path"),
        ("include_diff_summary" = Option<bool>, Query, description = "Include expensive worktree diff summaries"),
    ),
    responses(
        (status = 200, description = "List of git worktrees", body = WorktreeListResponse)
    ),
    tag = "worktrees"
)]
pub async fn get_worktrees(
    Path(repo_id): Path<String>,
    Query(query): Query<WorktreesQuery>,
) -> GitApiResult<Json<WorktreeListResponse>> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;
    let entries =
        git::worktree::list_all_worktrees(&repo_path).map_err(GitApiError::from_git_error)?;

    let include_diff_summary = query.include_diff_summary.unwrap_or(false);
    let data = entries
        .into_iter()
        .map(|entry| {
            let diff_summary = if include_diff_summary {
                summarize_worktree_diff(&repo_path, &entry.path, &entry.head_sha)
            } else {
                None
            };
            WorktreeEntry {
                path: entry.path,
                branch: entry.branch,
                head_sha: entry.head_sha,
                is_main: entry.is_main,
                diff_summary,
            }
        })
        .collect();

    Ok(Json(WorktreeListResponse { status: 0, data }))
}

#[utoipa::path(
    post,
    path = "/api/git/repo/{repo_id}/worktrees",
    params(
        ("repo_id" = String, Path, description = "Repository UUID or path"),
        ("path" = Option<String>, Query, description = "Repository file system path"),
    ),
    request_body = CreateWorktreeRequest,
    responses(
        (status = 200, description = "Created git worktree", body = WorktreeRemoveResponse)
    ),
    tag = "worktrees"
)]
pub async fn create_worktree(
    Path(repo_id): Path<String>,
    Query(query): Query<WorktreesQuery>,
    Json(request): Json<CreateWorktreeRequest>,
) -> GitApiResult<Json<WorktreeRemoveResponse>> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;
    let worktree_path = validate_new_worktree_path(&request.worktree_path)?;
    let branch = request.branch.trim().to_string();
    let base_ref = request
        .base_ref
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let created = tokio::task::spawn_blocking(move || {
        git::worktree::create_linked_worktree(
            &repo_path,
            &worktree_path,
            &branch,
            base_ref.as_deref(),
        )
    })
    .await
    .map_err(|err| GitApiError::Internal {
        message: format!("Worktree creation task failed: {err}"),
    })?
    .map_err(GitApiError::from_git_error)?;

    Ok(Json(WorktreeRemoveResponse {
        status: 0,
        data: WorktreeEntry {
            path: created.path,
            branch: created.branch,
            head_sha: created.head_sha,
            is_main: false,
            diff_summary: None,
        },
    }))
}

#[utoipa::path(
    delete,
    path = "/api/git/repo/{repo_id}/worktrees",
    params(
        ("repo_id" = String, Path, description = "Repository UUID or path"),
        ("path" = Option<String>, Query, description = "Repository file system path"),
    ),
    request_body = RemoveWorktreeRequest,
    responses(
        (status = 200, description = "Removed git worktree", body = WorktreeRemoveResponse)
    ),
    tag = "worktrees"
)]
pub async fn remove_worktree(
    Path(repo_id): Path<String>,
    Query(query): Query<WorktreesQuery>,
    Json(request): Json<RemoveWorktreeRequest>,
) -> GitApiResult<Json<WorktreeRemoveResponse>> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;
    let worktree_path = validate_path(&request.worktree_path)?;

    let force = request.force;
    tokio::task::spawn_blocking(move || {
        git::worktree::remove_worktree_path(&repo_path, &worktree_path, force)
    })
    .await
    .map_err(|err| GitApiError::Internal {
        message: format!("Worktree removal task failed: {err}"),
    })?
    .map_err(GitApiError::from_git_error)?;

    Ok(Json(WorktreeRemoveResponse {
        status: 0,
        data: WorktreeEntry {
            path: request.worktree_path,
            branch: String::new(),
            head_sha: String::new(),
            is_main: false,
            diff_summary: None,
        },
    }))
}

fn summarize_worktree_diff(
    _main_repo_path: &FsPath,
    worktree_path: &str,
    head_sha: &str,
) -> Option<WorktreeDiffSummary> {
    let cache_key = (worktree_path.to_string(), head_sha.to_string());

    // Return cached result when HEAD SHA hasn't changed and entry is fresh.
    if let Ok(cache) = diff_cache().lock() {
        if let Some(entry) = cache.get(&cache_key) {
            if entry.cached_at.elapsed() < DIFF_CACHE_TTL {
                return entry.summary.clone();
            }
        }
    }

    let path = PathBuf::from(worktree_path);
    let uncommitted = crate::commands::diff::get_diff_numstat_combined(&path, "HEAD", false).ok();

    let summary = uncommitted.and_then(|uncommitted| {
        let uncommitted_files = uncommitted.files_changed;
        let uncommitted_additions = uncommitted.total_insertions;
        let uncommitted_deletions = uncommitted.total_deletions;

        if is_pathological_worktree_checkout(
            uncommitted_files,
            uncommitted_additions,
            uncommitted_deletions,
        ) {
            return None;
        }

        if uncommitted_files == 0 && uncommitted_additions == 0 && uncommitted_deletions == 0 {
            return None;
        }

        Some(WorktreeDiffSummary {
            total_files: uncommitted_files,
            total_additions: uncommitted_additions,
            total_deletions: uncommitted_deletions,
            committed_files: 0,
            committed_additions: 0,
            committed_deletions: 0,
            uncommitted_files,
            uncommitted_additions,
            uncommitted_deletions,
            base_ref: None,
        })
    });

    if let Ok(mut cache) = diff_cache().lock() {
        insert_diff_cache_entry(
            &mut cache,
            cache_key,
            DiffCacheEntry {
                cached_at: Instant::now(),
                summary: summary.clone(),
            },
        );
    }

    summary
}

/// Detect stale/broken worktrees where the checkout deleted most tracked files on disk.
/// These produce million-line deletion stats that are technically `git diff HEAD` but not
/// meaningful scope-picker signal (common on abandoned agent worktrees).
fn is_pathological_worktree_checkout(files: u32, additions: u32, deletions: u32) -> bool {
    files > 100 && deletions > 100_000 && additions < deletions / 100
}

fn validate_new_worktree_path(path: &str) -> GitApiResult<PathBuf> {
    if path.contains("..") {
        return Err(GitApiError::InvalidPath {
            path: path.to_string(),
            reason: "Path traversal is not allowed".to_string(),
        });
    }
    let target = PathBuf::from(path);
    let Some(parent) = target.parent() else {
        return Err(GitApiError::InvalidPath {
            path: path.to_string(),
            reason: "Worktree path must have a parent directory".to_string(),
        });
    };
    let Some(name) = target.file_name() else {
        return Err(GitApiError::InvalidPath {
            path: path.to_string(),
            reason: "Worktree path must have a directory name".to_string(),
        });
    };
    let parent = validate_path(&parent.to_string_lossy())?;
    Ok(parent.join(name))
}

fn resolve_repo_path(repo_id: &str, query_path: Option<&str>) -> GitApiResult<std::path::PathBuf> {
    if let Some(path) = query_path {
        validate_path(path)
    } else {
        lookup_repo_path(repo_id)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        insert_diff_cache_entry, is_pathological_worktree_checkout, DiffCacheEntry,
        DIFF_CACHE_MAX_ENTRIES,
    };
    use std::collections::HashMap;
    use std::time::Instant;

    #[test]
    fn detects_mass_deletion_checkout_drift() {
        assert!(is_pathological_worktree_checkout(8072, 0, 1_446_726));
    }

    #[test]
    fn accepts_normal_uncommitted_changes() {
        assert!(!is_pathological_worktree_checkout(2, 10, 3));
        assert!(!is_pathological_worktree_checkout(50, 500, 120));
    }

    #[test]
    fn diff_cache_never_exceeds_hard_cap() {
        let mut cache = HashMap::new();
        for index in 0..(DIFF_CACHE_MAX_ENTRIES + 10) {
            insert_diff_cache_entry(
                &mut cache,
                (format!("/worktree/{index}"), format!("sha-{index}")),
                DiffCacheEntry {
                    cached_at: Instant::now(),
                    summary: None,
                },
            );
        }
        assert_eq!(cache.len(), DIFF_CACHE_MAX_ENTRIES);
    }
}
