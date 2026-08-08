//! Remote Routes
//!
//! Remote operations: list, add, update, delete, push, pull, fetch

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    routing::{delete, get, post, put},
    Json, Router,
};
use serde::Deserialize;

use crate::commands;
use crate::error::{GitApiError, GitApiResult};
use crate::extractors::{lookup_repo_path, validate_path};
use crate::types::*;

pub fn routes() -> Router {
    Router::new()
        .route("/api/git/repo/{repo_id}/remotes", get(get_remotes))
        .route("/api/git/repo/{repo_id}/remotes", post(add_remote))
        .route(
            "/api/git/repo/{repo_id}/remotes/{remote_name}",
            put(update_remote),
        )
        .route(
            "/api/git/repo/{repo_id}/remotes/{remote_name}",
            delete(delete_remote),
        )
        .route("/api/git/repo/{repo_id}/push", post(push))
        .route("/api/git/repo/{repo_id}/pull", post(pull))
        .route("/api/git/repo/{repo_id}/fetch", post(fetch))
        .route(
            "/api/git/repo/{repo_id}/credentials/fill",
            post(fill_credentials),
        )
        // Streaming endpoints
        .route(
            "/api/git/repo/{repo_id}/push/stream",
            get(commands::streaming::push_stream),
        )
        .route(
            "/api/git/repo/{repo_id}/pull/stream",
            get(commands::streaming::pull_stream),
        )
        .route(
            "/api/git/repo/{repo_id}/fetch/stream",
            get(commands::streaming::fetch_stream),
        )
}

// ============================================
// Query Types
// ============================================

#[derive(Debug, Deserialize, Default)]
pub struct RemotesQuery {
    path: Option<String>,
}

// ============================================
// Handlers
// ============================================

/// List all remotes
#[utoipa::path(
    get,
    path = "/api/git/repo/{repo_id}/remotes",
    params(
        ("repo_id" = String, Path, description = "Repository ID"),
        ("path" = Option<String>, Query, description = "Repository path"),
    ),
    responses(
        (status = 200, description = "List of remotes", body = RemotesResponse)
    ),
    tag = "remotes"
)]
pub async fn get_remotes(
    Path(repo_id): Path<String>,
    Query(query): Query<RemotesQuery>,
) -> GitApiResult<Json<RemotesResponse>> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;

    let remotes = commands::list_remotes(&repo_path).map_err(GitApiError::from_git_error)?;

    Ok(Json(RemotesResponse {
        status: 0,
        data: GitRemotesData { remotes },
    }))
}

/// Add a remote
#[utoipa::path(
    post,
    path = "/api/git/repo/{repo_id}/remotes",
    params(
        ("repo_id" = String, Path, description = "Repository ID"),
        ("path" = Option<String>, Query, description = "Repository path"),
    ),
    request_body = AddRemoteRequest,
    responses(
        (status = 200, description = "Remote added", body = RemoteInfoResponse)
    ),
    tag = "remotes"
)]
pub async fn add_remote(
    Path(repo_id): Path<String>,
    Query(query): Query<RemotesQuery>,
    Json(req): Json<AddRemoteRequest>,
) -> GitApiResult<Json<RemoteInfoResponse>> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;

    let remote = commands::add_remote(&repo_path, &req.name, &req.url)
        .map_err(GitApiError::from_git_error)?;

    Ok(Json(RemoteInfoResponse {
        status: 0,
        data: remote,
    }))
}

/// Update a remote
#[utoipa::path(
    put,
    path = "/api/git/repo/{repo_id}/remotes/{remote_name}",
    params(
        ("repo_id" = String, Path, description = "Repository ID"),
        ("remote_name" = String, Path, description = "Remote name"),
        ("path" = Option<String>, Query, description = "Repository path"),
    ),
    request_body = UpdateRemoteRequest,
    responses(
        (status = 200, description = "Remote updated", body = RemoteInfoResponse)
    ),
    tag = "remotes"
)]
pub async fn update_remote(
    Path((repo_id, remote_name)): Path<(String, String)>,
    Query(query): Query<RemotesQuery>,
    Json(req): Json<UpdateRemoteRequest>,
) -> GitApiResult<Json<RemoteInfoResponse>> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;

    let remote = commands::update_remote(&repo_path, &remote_name, &req.url)
        .map_err(GitApiError::from_git_error)?;

    Ok(Json(RemoteInfoResponse {
        status: 0,
        data: remote,
    }))
}

/// Delete a remote
#[utoipa::path(
    delete,
    path = "/api/git/repo/{repo_id}/remotes/{remote_name}",
    params(
        ("repo_id" = String, Path, description = "Repository ID"),
        ("remote_name" = String, Path, description = "Remote name"),
        ("path" = Option<String>, Query, description = "Repository path"),
    ),
    responses(
        (status = 204, description = "Remote deleted")
    ),
    tag = "remotes"
)]
pub async fn delete_remote(
    Path((repo_id, remote_name)): Path<(String, String)>,
    Query(query): Query<RemotesQuery>,
) -> GitApiResult<StatusCode> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;

    commands::delete_remote(&repo_path, &remote_name).map_err(GitApiError::from_git_error)?;

    Ok(StatusCode::NO_CONTENT)
}

/// Push to remote
#[utoipa::path(
    post,
    path = "/api/git/repo/{repo_id}/push",
    params(
        ("repo_id" = String, Path, description = "Repository UUID or name"),
        ("path" = Option<String>, Query, description = "Repository file system path"),
    ),
    request_body = PushRequest,
    responses(
        (status = 200, description = "Push completed successfully", body = GitPushResult)
    ),
    tag = "remotes"
)]
pub async fn push(
    Path(repo_id): Path<String>,
    Query(query): Query<RemotesQuery>,
    Json(req): Json<PushRequest>,
) -> GitApiResult<Json<serde_json::Value>> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;

    let result = commands::push_to_remote(&repo_path, &req).map_err(GitApiError::from_git_error)?;

    Ok(Json(serde_json::json!({
        "status": 0,
        "data": result
    })))
}

/// Pull from remote
#[utoipa::path(
    post,
    path = "/api/git/repo/{repo_id}/pull",
    params(
        ("repo_id" = String, Path, description = "Repository UUID or name"),
        ("path" = Option<String>, Query, description = "Repository file system path"),
    ),
    request_body = PullRequest,
    responses(
        (status = 200, description = "Pull completed", body = GitPullResult)
    ),
    tag = "remotes"
)]
pub async fn pull(
    Path(repo_id): Path<String>,
    Query(query): Query<RemotesQuery>,
    Json(req): Json<PullRequest>,
) -> GitApiResult<Json<serde_json::Value>> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;

    let result = commands::pull_from_remote(
        &repo_path,
        req.remote.as_deref(),
        req.branch.as_deref(),
        req.strategy.as_deref(),
        req.auth_username.as_deref(),
        req.auth_token.as_deref(),
        req.store_auth,
    )
    .map_err(GitApiError::from_git_error)?;

    Ok(Json(serde_json::json!({
        "status": 0,
        "data": result
    })))
}

/// Fetch from remote
#[utoipa::path(
    post,
    path = "/api/git/repo/{repo_id}/fetch",
    params(
        ("repo_id" = String, Path, description = "Repository UUID or name"),
        ("path" = Option<String>, Query, description = "Repository file system path"),
    ),
    request_body = FetchRequest,
    responses(
        (status = 200, description = "Fetch completed", body = GitFetchResult)
    ),
    tag = "remotes"
)]
pub async fn fetch(
    Path(repo_id): Path<String>,
    Query(query): Query<RemotesQuery>,
    Json(req): Json<FetchRequest>,
) -> GitApiResult<Json<serde_json::Value>> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;

    let result = commands::fetch_from_remote(
        &repo_path,
        req.remote.as_deref(),
        req.prune,
        req.auth_username.as_deref(),
        req.auth_token.as_deref(),
        req.store_auth,
    )
    .map_err(GitApiError::from_git_error)?;

    Ok(Json(serde_json::json!({
        "status": 0,
        "data": result
    })))
}

/// Read an existing HTTPS credential from Git's configured credential helper.
pub async fn fill_credentials(
    Path(repo_id): Path<String>,
    Query(query): Query<RemotesQuery>,
    Json(req): Json<GitCredentialFillRequest>,
) -> GitApiResult<Json<GitCredentialFillResponse>> {
    let repo_path = resolve_repo_path(&repo_id, query.path.as_deref())?;

    let result = commands::fill_git_credentials(&repo_path, &req.remote_url)
        .map_err(GitApiError::from_git_error)?;

    Ok(Json(GitCredentialFillResponse {
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
