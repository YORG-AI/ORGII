//! Unified IDE HTTP/WebSocket server
//!
//! Combines the Git API, Search API, and WebSocket event broadcast into a
//! single Axum server bound on port 13847 (high port chosen to avoid OS
//! service conflicts).
//!
//! CORS is fully open (`Any`) since the server only accepts connections from
//! the local WebView.
use axum::Router;
use std::net::SocketAddr;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
use tower_http::timeout::TimeoutLayer;
use utoipa::OpenApi;

use super::websocket_handler;

// ============================================
// OpenAPI Documentation
// ============================================

#[derive(OpenApi)]
#[openapi(
    paths(
        // Git API - Status
        git_api::routes::status::get_status,
        git_api::routes::status::get_ahead_behind,
        git_api::routes::status::get_default_branch,
        git_api::routes::status::get_local_commits,
        // Git API - Branches
        git_api::routes::branches::get_branches,
        git_api::routes::branches::get_current_branch_name,
        git_api::routes::branches::create_branch,
        git_api::routes::branches::delete_branch,
        git_api::routes::branches::rename_branch,
        git_api::routes::branches::checkout,
        // Git API - Commits
        git_api::routes::commits::get_commits,
        git_api::routes::commits::commit,
        git_api::routes::commits::amend_commit,
        // Git API - Remotes
        git_api::routes::remotes::get_remotes,
        git_api::routes::remotes::add_remote,
        git_api::routes::remotes::update_remote,
        git_api::routes::remotes::delete_remote,
        git_api::routes::remotes::push,
        git_api::routes::remotes::pull,
        git_api::routes::remotes::fetch,
        // Git API - Staging
        git_api::routes::staging::stage_files,
        git_api::routes::staging::unstage_files,
        git_api::routes::staging::discard_changes,
        // Git API - Stash
        git_api::routes::stash::stash_list,
        git_api::routes::stash::stash_push,
        git_api::routes::stash::stash_apply,
        git_api::routes::stash::stash_drop,
        // Git API - Diff
        git_api::routes::diff::get_file_content,
        git_api::routes::diff::get_file_diff,
        git_api::routes::diff::get_batch_file_diffs,
        git_api::routes::diff::get_staged_diff,
        git_api::routes::diff::get_diff_summary,
        git_api::routes::diff::get_commit_diff,
        git_api::routes::diff::get_blame,
        // Git API - Merge/Rebase/Cherry-pick/Revert/Reset
        git_api::routes::merge::merge,
        git_api::routes::merge::merge_abort,
        git_api::routes::merge::merge_continue,
        git_api::routes::merge::rebase,
        git_api::routes::merge::rebase_abort,
        git_api::routes::merge::rebase_continue,
        git_api::routes::merge::cherry_pick,
        git_api::routes::merge::cherry_pick_abort,
        git_api::routes::merge::cherry_pick_continue,
        git_api::routes::merge::revert,
        git_api::routes::merge::revert_abort,
        git_api::routes::merge::reset,
        // Search API paths
        api_search::file_routes::search_files,
        api_search::file_routes::index_files,
        api_search::file_routes::clear_cache,
        api_search::code_routes::search_symbols,
        api_search::code_routes::get_file_symbols,
        // Git API paths
        git_api::routes::file::get_git_file_status,
        git_api::routes::file::get_file_mtime,
        git_api::routes::worktrees::get_worktrees,
    ),
    components(
        schemas(
            // Git API types
            git_api::types::GitStatus,
            git_api::types::GitStatusResponse,
            git_api::types::AheadBehind,
            git_api::types::AheadBehindResponse,
            git_api::types::WorkingDirectory,
            git_api::types::WorkingDirectoryFile,
            git_api::types::GitBranchInfo,
            git_api::types::GitBranchesData,
            git_api::types::BranchesResponse,
            git_api::types::CurrentBranchResponse,
            git_api::types::GitCurrentBranchName,
            git_api::types::CurrentBranchNameResponse,
            git_api::types::CreateBranchRequest,
            git_api::types::CheckoutRequest,
            git_api::types::GitCommitInfo,
            git_api::types::GitCommitAuthor,
            git_api::types::GitCommitsData,
            git_api::types::CommitsResponse,
            git_api::types::CommitRequest,
            git_api::types::CommitInfoResponse,
            git_api::types::AmendCommitRequest,
            git_api::types::GitRemoteInfo,
            git_api::types::GitRemotesData,
            git_api::types::RemotesResponse,
            git_api::types::RemoteInfoResponse,
            git_api::types::AddRemoteRequest,
            git_api::types::UpdateRemoteRequest,
            git_api::types::GitFetchResult,
            git_api::types::FetchRequest,
            git_api::types::GitPushResult,
            git_api::types::PushRequest,
            git_api::types::GitPullResult,
            git_api::types::PullRequest,
            git_api::types::StageFilesRequest,
            git_api::types::DiscardChangesRequest,
            git_api::types::StashEntry,
            git_api::types::GitStashListData,
            git_api::types::StashListResponse,
            git_api::types::GitStashResult,
            git_api::types::StashResultResponse,
            git_api::types::StashPushRequest,
            git_api::types::StashApplyRequest,
            git_api::types::GitFileContentResult,
            git_api::types::FileContentResponse,
            git_api::types::DiffLine,
            git_api::types::GitDiffHunk,
            git_api::types::GitDiffStats,
            git_api::types::FileDiffResult,
            git_api::types::FileDiffResponse,
            git_api::types::BatchFileDiffResult,
            git_api::types::BatchFileDiffResponse,
            git_api::types::BatchFileDiffRequest,
            git_api::types::CommitDiffResult,
            git_api::types::CommitDiffResponse,
            git_api::types::GitBlameLineInfo,
            git_api::types::GitBlameResult,
            git_api::types::BlameResponse,
            git_api::types::MergeRequest,
            git_api::types::GitMergeResult,
            git_api::types::MergeResultResponse,
            git_api::types::RebaseRequest,
            git_api::types::GitRebaseResult,
            git_api::types::RebaseResultResponse,
            git_api::types::CherryPickRequest,
            git_api::types::GitCherryPickResult,
            git_api::types::CherryPickResultResponse,
            git_api::types::RevertRequest,
            git_api::types::GitRevertResult,
            git_api::types::RevertResultResponse,
            git_api::types::ResetRequest,
            git_api::types::GitResetResult,
            git_api::types::ResetResultResponse,
            git_api::types::WorktreeEntry,
            git_api::types::WorktreeListResponse,
            git_api::types::ApiError,
            // Search API types
            api_search::error::ApiError,
            api_search::types::ApiInfo,
            api_search::types::EndpointsList,
            api_search::types::FileSearchQuery,
            api_search::types::FileSearchResult,
            api_search::types::FileSearchResponse,
            api_search::types::FileIndexRequest,
            api_search::types::FileIndexResponse,
            api_search::types::SymbolSearchQuery,
            api_search::types::ApiSymbolInfo,
            api_search::types::SymbolSearchResponse,
            api_search::types::FileSymbolsQuery,
            api_search::types::FileSymbol,
            api_search::types::FileSymbolsResponse,
            // Git file types
            git_api::file_types::GitFileStatus,
            git_api::file_types::GitFileStatusResponse,
            git_api::file_types::FileMtimeResponse,
        )
    ),
    tags(
        (name = "git-status", description = "Git status operations"),
        (name = "git-branches", description = "Branch operations"),
        (name = "git-commits", description = "Commit operations"),
        (name = "git-remotes", description = "Remote operations"),
        (name = "git-staging", description = "Staging operations"),
        (name = "git-stash", description = "Stash operations"),
        (name = "git-files", description = "File content operations"),
        (name = "git-diff", description = "Diff operations"),
        (name = "git-blame", description = "Git blame operations"),
        (name = "git-merge", description = "Merge operations"),
        (name = "git-rebase", description = "Rebase operations"),
        (name = "git-cherry-pick", description = "Cherry-pick operations"),
        (name = "git-revert", description = "Revert operations"),
        (name = "git-reset", description = "Reset operations"),
        (name = "file-search", description = "Fuzzy file search with .gitignore support"),
        (name = "code-search", description = "Code symbol search"),
        (name = "file-status", description = "File status and metadata operations"),
    ),
    info(
        title = "Orgii IDE Backend API",
        version = "1.0.0",
        description = r#"
# Orgii IDE Backend API

Unified REST and WebSocket API for IDE backend operations.

## REST Endpoints

### Git Operations
- `/git/*` - Git operations (status, branches, commits, push, pull, etc.)

### Search Operations
- `/search/files` - File search with fuzzy matching
- `/search/code/*` - Code symbol search

## WebSocket
- `/ws` - Real-time events (file changes, git status updates, LSP diagnostics)

## Documentation
The OpenAPI spec is served at `/api-docs/openapi.json`.
        "#,
    )
)]
struct ApiDoc;

// ============================================
// Server
// ============================================

// High port to avoid conflicts with common apps
const DEFAULT_IDE_SERVER_PORT: u16 = 13847;

pub(crate) fn ide_server_port() -> u16 {
    std::env::var("ORGII_IDE_SERVER_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_IDE_SERVER_PORT)
}

/// Start the unified IDE server
pub async fn start_server(
    ws_tx: broadcast::Sender<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let addr = SocketAddr::from(([127, 0, 0, 1], ide_server_port()));

    // Create CORS layer (allow frontend on any localhost port)
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Create WebSocket router with state
    let ws_router = Router::new()
        .route("/ws", axum::routing::get(websocket_handler::ws_handler))
        .with_state(ws_tx.clone());

    // Create main app with nested routes
    let app = Router::new()
        // OpenAPI spec (machine-readable; no Swagger UI)
        .route(
            "/api-docs/openapi.json",
            axum::routing::get(|| async { axum::Json(ApiDoc::openapi()) }),
        )
        // Git API routes (without /api prefix, nested under /git)
        .nest("/git", git_api::routes::create_routes())
        // Search API routes (without /api prefix, nested under /search)
        .nest("/search", api_search::routes::create_routes())
        // Agent API routes (with 200s response timeout to prevent stale connections
        // from holding the global AgentLoop mutex indefinitely)
        .nest(
            "/agent",
            super::agent::create_routes().layer(TimeoutLayer::with_status_code(
                axum::http::StatusCode::REQUEST_TIMEOUT,
                std::time::Duration::from_secs(200),
            )),
        )
        // Hermes plugin lifecycle callbacks for integrated and external TUI sessions.
        .merge(super::hermes_hook::router())
        // Automation webhook route — fires registered webhook triggers
        .route(
            "/automation/webhook/{*route}",
            axum::routing::post(automation_webhook_handler),
        )
        // Sync framework inbound webhook route. Verifies
        // the per-(project, adapter) HMAC secret then drops the
        // delivery into the merge_external outbox so the standard
        // worker apply path consumes it. See
        // `project_management::sync::webhook_listener` for the full
        // request lifecycle.
        .merge(project_management::sync::webhook_listener::router())
        // Merge WebSocket router
        .merge(ws_router)
        // Apply CORS
        .layer(cors);

    println!("🚀 Unified IDE server starting on http://{}", addr);
    println!("📚 Git API: http://{}/git/*", addr);
    println!("🔍 Search API: http://{}/search/*", addr);
    println!("📄 File API: http://{}/api/file/*", addr);
    println!("🤖 Agent API: http://{}/agent/*", addr);
    println!("🔌 WebSocket: ws://{}/ws", addr);

    // Bind first so the global Hermes descriptor never advertises a port that
    // this process failed to acquire.
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tokio::spawn(async {
        if let Err(error) = super::hermes_hook::initialize_global_hook().await {
            tracing::warn!(%error, "[Hermes Hook] Global hook initialization failed");
        }
    });
    axum::serve(listener, app).await?;

    Ok(())
}

/// Handler for automation webhook triggers.
/// POST /automation/webhook/{route} fires the matching webhook trigger.
async fn automation_webhook_handler(
    axum::extract::Path(route): axum::extract::Path<String>,
) -> axum::response::Response {
    let full_route = format!("/automation/webhook/{}", route);
    if agent_core::automation::triggers::webhook_registry::fire(&full_route) {
        axum::response::IntoResponse::into_response((
            axum::http::StatusCode::OK,
            axum::Json(serde_json::json!({ "fired": true, "route": full_route })),
        ))
    } else {
        axum::response::IntoResponse::into_response((
            axum::http::StatusCode::NOT_FOUND,
            axum::Json(
                serde_json::json!({ "fired": false, "error": "No webhook registered for this route" }),
            ),
        ))
    }
}
