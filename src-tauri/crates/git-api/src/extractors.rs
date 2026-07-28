//! Axum Extractors for Git API
//!
//! Custom extractors to reduce boilerplate in route handlers:
//! - RepoPath: Resolves and validates repository paths from requests
//! - ValidatedPath: Ensures paths don't contain traversal attacks

use axum::{
    extract::{FromRequestParts, Path, Query},
    http::request::Parts,
};
use serde::Deserialize;
use std::path::{Path as StdPath, PathBuf};

use super::error::{GitApiError, GitApiResult};

// ============================================
// Path Validation
// ============================================

/// Strip the Windows extended-length path prefix (`\\?\`) that `canonicalize()` adds.
/// Returns the input unchanged on non-Windows or when the prefix is absent.
fn strip_extended_length_prefix(path_str: &str) -> &str {
    path_str.strip_prefix(r"\\?\").unwrap_or(path_str)
}

#[cfg(windows)]
pub(crate) fn has_windows_users_prefix(path_str: &str) -> bool {
    let bytes = path_str.as_bytes();
    bytes.len() >= 9 && bytes[0].is_ascii_alphabetic() && bytes.get(1..9) == Some(br":\Users\")
}

/// Remove platform-specific canonicalization syntax before comparing paths.
fn clean_path(path: &StdPath) -> PathBuf {
    let raw = path.to_string_lossy();
    PathBuf::from(strip_extended_length_prefix(&raw))
}

#[cfg(windows)]
fn path_starts_with(path: &StdPath, root: &StdPath) -> bool {
    let mut path_components = path.components();
    for root_component in root.components() {
        let Some(path_component) = path_components.next() else {
            return false;
        };
        if !path_component
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&root_component.as_os_str().to_string_lossy())
        {
            return false;
        }
    }
    true
}

#[cfg(not(windows))]
fn path_starts_with(path: &StdPath, root: &StdPath) -> bool {
    path.starts_with(root)
}

/// Component-aware containment check for user-authorized repository roots.
/// String-prefix checks are deliberately avoided: a root such as
/// `C:\repo` must not authorize its sibling `C:\repo-private`.
pub(crate) fn is_path_within_roots(path: &StdPath, roots: &[PathBuf]) -> bool {
    let clean = clean_path(path);
    roots.iter().any(|root| {
        let clean_root = clean_path(root);
        path_starts_with(&clean, &clean_root)
    })
}

#[cfg(not(test))]
fn registered_repo_roots() -> Vec<PathBuf> {
    git::repos::repo_db::list_repos()
        .unwrap_or_default()
        .into_iter()
        .map(|repo| PathBuf::from(repo.path))
        .collect()
}

// Unit tests exercise the authorization boundary through
// `is_path_within_roots` without opening or creating the user's sessions DB.
#[cfg(test)]
fn registered_repo_roots() -> Vec<PathBuf> {
    Vec::new()
}

/// Check whether `path` falls under a user-accessible directory.
///
/// Platform rules:
/// - **Unix:** Must be under `/Users`, `/home`, `/tmp`, or macOS temp dirs.
/// - **Windows:** Must be under `<drive>:\Users` or the system temp directory.
/// - **All:** Home, temp, and user-registered repo roots are allowed.
fn is_path_allowed(path: &StdPath) -> bool {
    let mut allowed: Vec<PathBuf> = Vec::new();

    if let Some(home) = dirs::home_dir() {
        allowed.push(home);
    }

    allowed.push(std::env::temp_dir());

    #[cfg(unix)]
    {
        allowed.extend([
            PathBuf::from("/Users"),
            PathBuf::from("/home"),
            PathBuf::from("/tmp"),
            PathBuf::from("/private/tmp"),
            PathBuf::from("/private/var"),
            PathBuf::from("/var/folders"),
        ]);
    }

    #[cfg(windows)]
    {
        let raw = path.to_string_lossy();
        let clean = strip_extended_length_prefix(&raw);
        // Allow <drive>:\Users (e.g. C:\Users, D:\Users)
        if has_windows_users_prefix(clean) {
            return true;
        }
    }

    if is_path_within_roots(path, &allowed) {
        return true;
    }

    // A repo explicitly added by the user is also an authorized filesystem
    // boundary. This is what permits normal Windows layouts such as
    // C:\Repos\ORGII without broadly allowing the whole drive.
    let registered_roots = registered_repo_roots();
    is_path_within_roots(path, &registered_roots)
}

/// Validate that a path is safe and allowed
pub fn validate_path(path: &str) -> GitApiResult<PathBuf> {
    let path_buf = PathBuf::from(path);

    if path.contains("..") {
        return Err(GitApiError::PathTraversal {
            path: path.to_string(),
        });
    }

    let normalized = if path_buf.exists() {
        path_buf
            .canonicalize()
            .map_err(|e| GitApiError::InvalidPath {
                path: path.to_string(),
                reason: e.to_string(),
            })?
    } else {
        path_buf.clone()
    };

    if !is_path_allowed(&normalized) {
        return Err(GitApiError::PathNotAllowed {
            path: path.to_string(),
        });
    }

    Ok(normalized)
}

/// Validate a file path within a repository (relative path)
pub fn validate_file_path(file_path: &str) -> GitApiResult<String> {
    if file_path.contains("..") {
        return Err(GitApiError::PathTraversal {
            path: file_path.to_string(),
        });
    }

    // Disallow absolute paths — Unix `/...` and Windows `C:\...` or `\\...`
    let is_absolute = file_path.starts_with('/')
        || file_path.starts_with('\\')
        || (file_path.len() >= 3
            && file_path.as_bytes()[0].is_ascii_alphabetic()
            && file_path.as_bytes()[1] == b':'
            && (file_path.as_bytes()[2] == b'\\' || file_path.as_bytes()[2] == b'/'));

    if is_absolute {
        return Err(GitApiError::InvalidPath {
            path: file_path.to_string(),
            reason: "File path must be relative to repository root".into(),
        });
    }

    Ok(file_path.to_string())
}

// ============================================
// Query Types
// ============================================

/// Common query parameters for repository operations
#[derive(Debug, Clone, Deserialize, Default)]
pub struct RepoQuery {
    /// Optional direct path to repository (bypasses UUID lookup)
    pub path: Option<String>,
}

// ============================================
// RepoPath Extractor
// ============================================

/// Resolved repository path from request.
///
/// This extractor handles the common pattern of resolving a repository path
/// from either a query parameter or a repo_id path parameter.
///
/// # Usage
/// ```ignore
/// async fn my_handler(
///     RepoPath(repo_path): RepoPath,
/// ) -> Result<Json<MyResponse>, GitApiError> {
///     // repo_path is already validated and resolved
/// }
/// ```
#[derive(Debug, Clone)]
pub struct RepoPath(pub PathBuf);

/// Path parameters for repo routes
#[derive(Debug, Deserialize)]
struct RepoPathParams {
    repo_id: String,
}

impl<S> FromRequestParts<S> for RepoPath
where
    S: Send + Sync,
{
    type Rejection = GitApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        // Try to get query params first. A silent default-empty query
        // would mean a malformed `?path=...` is silently ignored and
        // the request falls through to the repo_id lookup, leaving
        // the caller wondering why their explicit `path` was ignored.
        // Warn so a malformed query is visible in logs.
        let query: Query<RepoQuery> = match Query::try_from_uri(&parts.uri) {
            Ok(q) => q,
            Err(err) => {
                tracing::warn!(
                    uri = %parts.uri,
                    error = %err,
                    "git::RepoPath: query parse failed; falling back to repo_id path lookup"
                );
                Query::default()
            }
        };

        // If path is provided in query, use it directly
        if let Some(ref path) = query.path {
            let validated = validate_path(path)?;
            return Ok(RepoPath(validated));
        }

        // Otherwise, extract repo_id from path and look it up
        let path_params: Path<RepoPathParams> = Path::from_request_parts(parts, state)
            .await
            .map_err(|_| GitApiError::InvalidRequest {
                message: "Missing repo_id in path".into(),
            })?;

        let repo_path = lookup_repo_path(&path_params.repo_id)?;
        Ok(RepoPath(repo_path))
    }
}

// ============================================
// RepoPathWithQuery Extractor
// ============================================

/// RepoPath with additional query parameters preserved.
///
/// Use this when you need both the resolved path and other query params.
#[derive(Debug, Clone)]
pub struct RepoPathWithQuery<Q> {
    pub repo_path: PathBuf,
    pub query: Q,
}

impl<S, Q> FromRequestParts<S> for RepoPathWithQuery<Q>
where
    S: Send + Sync,
    Q: for<'de> Deserialize<'de> + Send + Default,
{
    type Rejection = GitApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        // Same rationale as `RepoPath::from_request_parts`: silent
        // default-empty queries hide malformed query strings from
        // the caller. Warn separately for the typed-Q parse and the
        // base-repo parse so we know which one failed.
        let query: Query<Q> = match Query::try_from_uri(&parts.uri) {
            Ok(q) => q,
            Err(err) => {
                tracing::warn!(
                    uri = %parts.uri,
                    error = %err,
                    "git::RepoPathWithQuery: typed query parse failed; using Q::default()"
                );
                Query::default()
            }
        };

        // Also get the base repo query for path resolution
        let repo_query: Query<RepoQuery> = match Query::try_from_uri(&parts.uri) {
            Ok(q) => q,
            Err(err) => {
                tracing::warn!(
                    uri = %parts.uri,
                    error = %err,
                    "git::RepoPathWithQuery: repo query parse failed; falling back to repo_id"
                );
                Query::default()
            }
        };

        let repo_path = if let Some(ref path) = repo_query.path {
            validate_path(path)?
        } else {
            // Extract repo_id from path
            let path_params: Path<RepoPathParams> = Path::from_request_parts(parts, state)
                .await
                .map_err(|_| GitApiError::InvalidRequest {
                    message: "Missing repo_id in path".into(),
                })?;
            lookup_repo_path(&path_params.repo_id)?
        };

        Ok(RepoPathWithQuery {
            repo_path,
            query: query.0,
        })
    }
}

// ============================================
// Helper Functions
// ============================================

/// Look up repository path from repo_id.
///
/// Resolution order:
/// 1. Watcher state store — fast in-memory lookup for registered repos.
/// 2. DB fallback — covers repos that exist on disk but haven't been registered
///    with the watcher yet.
pub fn lookup_repo_path(repo_id: &str) -> GitApiResult<PathBuf> {
    use git::repos::repo_db;
    use git::watch::REPO_WATCH_MANAGER;

    // 1. Watcher state store (fast path).
    {
        let manager_lock = REPO_WATCH_MANAGER.read();
        if let Some(manager) = manager_lock.as_ref() {
            let states = manager.state_store.get_all_states();
            if let Some(state) = states.get(repo_id) {
                return validate_path(&state.repo_path.to_string_lossy());
            }
        }
    }

    // 2. DB fallback for repos not yet watched.
    if let Ok(Some(record)) = repo_db::get_repo(repo_id) {
        let path = PathBuf::from(&record.path);
        if path.exists() {
            return validate_path(&record.path);
        }
    }

    Err(GitApiError::RepoNotFound {
        repo_id: repo_id.to_string(),
    })
}

/// URL-decode a file path from the URL
pub fn decode_file_path(encoded: &str) -> GitApiResult<String> {
    urlencoding::decode(encoded)
        .map(|s| s.into_owned())
        .map_err(|e| GitApiError::InvalidEncoding {
            message: format!("Invalid file path encoding: {}", e),
        })
}
