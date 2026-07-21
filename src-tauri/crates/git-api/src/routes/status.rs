//! Status Routes
//!
//! Repository status, ahead/behind, default branch, local commits

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::{
    extract::{Path, Query},
    routing::get,
    Json, Router,
};
use serde::Deserialize;

use crate::error::{GitApiError, GitApiResult};
use crate::extractors::{lookup_repo_path, validate_path, RepoQuery};
use crate::types::*;
use git::watch::git_status::refresh_git_status_sync;

/// Cache TTL for git status responses. Avoids redundant subprocess spawns when
/// the frontend polls rapidly while the tab is visible.
const STATUS_CACHE_TTL: Duration = Duration::from_secs(2);

/// Hard cap on cached repos. The key includes a SHA and an index fingerprint,
/// so without a bound the map gained a permanent entry per commit and per
/// staging operation for the lifetime of the process.
const STATUS_CACHE_MAX_ENTRIES: usize = 64;

struct StatusCacheEntry {
    cached_at: Instant,
    response: GitStatusResponse,
}

/// `(repo_path_string, head_sha, index_fingerprint)` → cached status response.
///
/// HEAD SHA alone is NOT sufficient: staging, unstaging and discarding all
/// leave HEAD untouched, so a key of `(path, sha)` served pre-mutation status
/// for the whole TTL window after any of them. The index fingerprint
/// (`.git/index` mtime + size) changes on those operations and restores
/// correctness for them.
type StatusCacheKey = (String, String, String);

static STATUS_CACHE: std::sync::OnceLock<Mutex<HashMap<StatusCacheKey, StatusCacheEntry>>> =
    std::sync::OnceLock::new();

fn status_cache() -> &'static Mutex<HashMap<StatusCacheKey, StatusCacheEntry>> {
    STATUS_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Fingerprint `.git/index` without spawning a process. Returns an empty
/// string when the index is unreadable, which simply makes the key stable.
fn read_index_fingerprint(git_dir: &std::path::Path) -> String {
    let Ok(meta) = std::fs::metadata(git_dir.join("index")) else {
        return String::new();
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|delta| delta.as_nanos())
        .unwrap_or(0);
    format!("{}:{}", mtime, meta.len())
}

/// Build the cache key for a repo, or `None` when HEAD cannot be resolved.
fn status_cache_key(repo_path_str: &str, git_dir: &std::path::Path) -> Option<StatusCacheKey> {
    let head_sha = read_head_sha_cheap(git_dir)?;
    Some((
        repo_path_str.to_string(),
        head_sha,
        read_index_fingerprint(git_dir),
    ))
}

/// Drop expired entries, then trim to the size cap if still over.
fn prune_status_cache(cache: &mut HashMap<StatusCacheKey, StatusCacheEntry>) {
    cache.retain(|_, entry| entry.cached_at.elapsed() < STATUS_CACHE_TTL);

    while cache.len() > STATUS_CACHE_MAX_ENTRIES {
        let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, entry)| entry.cached_at)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        cache.remove(&oldest);
    }
}

/// Read `.git/HEAD` and resolve it to the commit SHA without spawning any
/// process. Returns `None` if the repo layout is unexpected.
fn read_head_sha_cheap(git_dir: &std::path::Path) -> Option<String> {
    let head_contents = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head_contents = head_contents.trim();

    if let Some(ref_path) = head_contents.strip_prefix("ref: ") {
        // Packed-refs fallback: try loose ref first, then packed-refs
        let loose = git_dir.join(ref_path);
        if let Ok(sha) = std::fs::read_to_string(&loose) {
            return Some(sha.trim().to_string());
        }
        // Try packed-refs
        let packed = std::fs::read_to_string(git_dir.join("packed-refs")).ok()?;
        for line in packed.lines() {
            if line.starts_with('#') {
                continue;
            }
            let mut parts = line.splitn(2, ' ');
            if let (Some(sha), Some(name)) = (parts.next(), parts.next()) {
                if name == ref_path {
                    return Some(sha.to_string());
                }
            }
        }
        None
    } else if head_contents.len() == 40 || head_contents.len() == 64 {
        // Detached HEAD — the content IS the SHA
        Some(head_contents.to_string())
    } else {
        None
    }
}

pub fn routes() -> Router {
    Router::new()
        .route("/api/git/repo/{repo_id}/status", get(get_status))
        .route(
            "/api/git/repo/{repo_id}/ahead-behind",
            get(get_ahead_behind),
        )
        .route(
            "/api/git/repo/{repo_id}/default-branch",
            get(get_default_branch),
        )
        .route(
            "/api/git/repo/{repo_id}/local-commits",
            get(get_local_commits),
        )
}

// ============================================
// Query Types
// ============================================

#[derive(Debug, Deserialize, Default)]
pub struct StatusQuery {
    #[allow(dead_code)]
    include_untracked: Option<bool>,
    path: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct DefaultBranchQuery {
    path: Option<String>,
    remote: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct LocalCommitsQuery {
    path: Option<String>,
    branch: Option<String>,
}

// ============================================
// Handlers
// ============================================

/// Get repository status
#[utoipa::path(
    get,
    path = "/api/git/repo/{repo_id}/status",
    params(
        ("repo_id" = String, Path, description = "Repository UUID or name"),
        ("path" = Option<String>, Query, description = "Repository file system path"),
    ),
    responses(
        (status = 200, description = "Git status retrieved successfully", body = GitStatusResponse),
        (status = 400, description = "Git error occurred")
    ),
    tag = "status"
)]
pub async fn get_status(
    Path(repo_id): Path<String>,
    Query(query): Query<StatusQuery>,
) -> GitApiResult<Json<GitStatusResponse>> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;

    // A tracked folder the user created directly (never `git init`'d) has no
    // `.git`. Running `git status` on it fails with "not a git repository",
    // which the frontend would otherwise surface as a recurring error popup.
    // Treat the absence of `.git` as a benign, first-class "no git" state
    // (HTTP 200, `exists: false`) so the UI can render it cleanly instead of
    // entering an infinite error-retry loop. Real git failures (corrupt repo,
    // permission errors) still propagate through the error path below.
    let git_dir = repo_path.join(".git");
    if !git_dir.exists() {
        return Ok(Json(GitStatusResponse {
            status: 0,
            data: GitStatus {
                current_branch: String::new(),
                current_upstream_branch: None,
                current_tip: String::new(),
                branch_ahead_behind: None,
                exists: false,
                merge_head_found: false,
                squash_msg_found: false,
                rebase_in_progress: false,
                cherry_pick_in_progress: false,
                working_directory: WorkingDirectory {
                    files: Vec::new(),
                    staged_count: 0,
                    unstaged_count: 0,
                    untracked_count: 0,
                },
                do_conflicted_files_exist: false,
            },
        }));
    }

    // Cache lookup: fingerprint HEAD and the index cheaply (no subprocess) and
    // skip the full git-status computation if nothing has changed within the
    // TTL window.
    let repo_path_str = repo_path.to_string_lossy().to_string();
    if let Some(cache_key) = status_cache_key(&repo_path_str, &git_dir) {
        if let Ok(cache) = status_cache().lock() {
            if let Some(entry) = cache.get(&cache_key) {
                if entry.cached_at.elapsed() < STATUS_CACHE_TTL {
                    return Ok(Json(entry.response.clone()));
                }
            }
        }
    }

    let rust_status = refresh_git_status_sync(&repo_path).map_err(GitApiError::from_git_error)?;

    // `refresh_git_status_sync` already ran `git status --porcelain=v2 -b` and
    // parsed the branch header, the counts, AND the full file list — see its
    // own "ONE git call to get everything" comment. Deriving the remaining
    // fields from that result instead of re-querying drops three subprocesses
    // per uncached request:
    //   - `git status --porcelain=v2` (get_detailed_file_status_sync)
    //   - `git rev-parse --abbrev-ref HEAD`      \ get_upstream_branch, whose
    //   - `git rev-parse --abbrev-ref <b>@{u}`   / result is the `# branch.upstream`
    //                                              header we already parsed.
    // It also avoids a second `git ls-files` sweep per untracked directory and
    // a second libgit2 rename-detection pass over untracked content.
    let files: Vec<crate::types::WorkingDirectoryFile> =
        git::watch::git_status::collapse_to_working_directory_files(&rust_status.files)
            .into_iter()
            .map(Into::into)
            .collect();

    let current_upstream_branch = rust_status.current_upstream_branch.clone();

    // Check for merge/rebase/cherry-pick state
    let merge_head_found = git_dir.join("MERGE_HEAD").exists();
    let squash_msg_found = git_dir.join("SQUASH_MSG").exists();
    let rebase_in_progress =
        git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists();
    let cherry_pick_in_progress = git_dir.join("CHERRY_PICK_HEAD").exists();

    let has_conflicted_files = rust_status.conflicted > 0 || files.iter().any(|f| f.status == "U");

    let status = GitStatus {
        current_branch: rust_status.branch,
        current_upstream_branch,
        current_tip: rust_status.last_commit_hash,
        branch_ahead_behind: Some(AheadBehind {
            ahead: rust_status.ahead,
            behind: rust_status.behind,
        }),
        exists: true,
        merge_head_found,
        squash_msg_found,
        rebase_in_progress,
        cherry_pick_in_progress,
        working_directory: WorkingDirectory {
            files,
            staged_count: rust_status.staged,
            unstaged_count: rust_status.unstaged,
            untracked_count: rust_status.untracked,
        },
        do_conflicted_files_exist: has_conflicted_files,
    };

    let response = GitStatusResponse {
        status: 0,
        data: status,
    };

    // Populate the cache so rapid back-to-back polls within the TTL window are free.
    if let Some(cache_key) = status_cache_key(&repo_path_str, &git_dir) {
        if let Ok(mut cache) = status_cache().lock() {
            cache.insert(
                cache_key,
                StatusCacheEntry {
                    cached_at: Instant::now(),
                    response: response.clone(),
                },
            );
            prune_status_cache(&mut cache);
        }
    }

    Ok(Json(response))
}

/// Get ahead/behind counts
#[utoipa::path(
    get,
    path = "/api/git/repo/{repo_id}/ahead-behind",
    params(
        ("repo_id" = String, Path, description = "Repository UUID or name"),
        ("path" = Option<String>, Query, description = "Repository file system path"),
    ),
    responses(
        (status = 200, description = "Ahead/behind counts retrieved", body = AheadBehindResponse)
    ),
    tag = "status"
)]
pub async fn get_ahead_behind(
    Path(repo_id): Path<String>,
    Query(query): Query<RepoQuery>,
) -> GitApiResult<Json<AheadBehindResponse>> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;

    let rust_status = refresh_git_status_sync(&repo_path).map_err(GitApiError::from_git_error)?;

    Ok(Json(AheadBehindResponse {
        status: 0,
        data: AheadBehind {
            ahead: rust_status.ahead,
            behind: rust_status.behind,
        },
    }))
}

/// Get default branch
#[utoipa::path(
    get,
    path = "/api/git/repo/{repo_id}/default-branch",
    params(
        ("repo_id" = String, Path, description = "Repository ID"),
        ("path" = Option<String>, Query, description = "Repository path"),
        ("remote" = Option<String>, Query, description = "Remote name"),
    ),
    responses(
        (status = 200, description = "Default branch name")
    ),
    tag = "branches"
)]
pub async fn get_default_branch(
    Path(repo_id): Path<String>,
    Query(query): Query<DefaultBranchQuery>,
) -> GitApiResult<Json<serde_json::Value>> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;

    let branch = crate::commands::get_default_branch(&repo_path, query.remote.as_deref())
        .map_err(GitApiError::from_git_error)?;

    Ok(Json(serde_json::json!({
        "status": 0,
        "data": { "name": branch }
    })))
}

/// Get local (unpushed) commits
#[utoipa::path(
    get,
    path = "/api/git/repo/{repo_id}/local-commits",
    params(
        ("repo_id" = String, Path, description = "Repository ID"),
        ("path" = Option<String>, Query, description = "Repository path"),
        ("branch" = Option<String>, Query, description = "Branch name"),
    ),
    responses(
        (status = 200, description = "Local commits", body = CommitsResponse)
    ),
    tag = "commits"
)]
pub async fn get_local_commits(
    Path(repo_id): Path<String>,
    Query(query): Query<LocalCommitsQuery>,
) -> GitApiResult<Json<CommitsResponse>> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;

    let commits_data = crate::commands::get_local_commits(&repo_path, query.branch.as_deref())
        .map_err(GitApiError::from_git_error)?;

    Ok(Json(CommitsResponse {
        status: 0,
        data: commits_data,
    }))
}

// ============================================
// Helper
// ============================================

/// Resolve repository path from query param or repo_id lookup
fn resolve_repo_path(repo_id: &str, query_path: Option<&str>) -> GitApiResult<std::path::PathBuf> {
    if let Some(path) = query_path {
        validate_path(path)
    } else {
        lookup_repo_path(repo_id)
    }
}
