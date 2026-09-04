//! HTTP route handlers for fuzzy file-name search
//!
//! Filters results against `.gitignore` rules so ignored files are excluded.
use axum::{extract::Query, http::StatusCode, Json};
use serde::Deserialize;

use crate::error::ApiError;
use crate::types::*;
use search::file::SearchOptions;
use search::file::{clear_file_index_cache, index_project_files, search_files_fuzzy};

// ============================================
// Route Handlers
// ============================================

/// Search files with fuzzy matching
///
/// Searches for files in a directory using fuzzy matching (similar to VS Code's file search).
/// Respects .gitignore and excludes common build directories.
#[utoipa::path(
    get,
    path = "/api/search/files",
    params(
        ("query" = String, Query, description = "Search query"),
        ("root_path" = String, Query, description = "Root directory to search in"),
        ("max_results" = Option<usize>, Query, description = "Maximum results (default: 50)"),
    ),
    responses(
        (status = 200, description = "Search completed successfully", body = FileSearchResponse),
        (status = 400, description = "Invalid request or search failed", body = ApiError)
    ),
    tag = "file-search"
)]
pub async fn search_files(
    Query(params): Query<FileSearchParams>,
) -> Result<Json<FileSearchResponse>, (StatusCode, Json<ApiError>)> {
    let options = SearchOptions {
        root_path: params.root_path,
        query: params.query,
        max_results: params.max_results,
        file_extensions: params.file_extensions,
        exclude_dirs: params.exclude_dirs,
    };

    match search_files_fuzzy(options).await {
        Ok(results) => {
            let response = FileSearchResponse {
                files: results
                    .files
                    .into_iter()
                    .map(|f| FileSearchResult {
                        path: f.path,
                        file_type: f.file_type,
                        score: f.score,
                        filename: f.filename,
                    })
                    .collect(),
                folders: results
                    .folders
                    .into_iter()
                    .map(|f| FileSearchResult {
                        path: f.path,
                        file_type: f.file_type,
                        score: f.score,
                        filename: f.filename,
                    })
                    .collect(),
                total_indexed: results.total_indexed,
                search_time_ms: results.search_time_ms,
            };
            Ok(Json(response))
        }
        Err(e) => Err((StatusCode::BAD_REQUEST, Json(ApiError::new(e)))),
    }
}

/// Force re-index a directory
///
/// Clears the cache and rebuilds the file index for a directory.
/// Use this when files have changed and you want fresh results.
#[utoipa::path(
    post,
    path = "/api/search/files/index",
    request_body = FileIndexRequest,
    responses(
        (status = 200, description = "Indexing completed", body = FileIndexResponse),
        (status = 400, description = "Indexing failed", body = ApiError)
    ),
    tag = "file-search"
)]
pub async fn index_files(
    Json(req): Json<FileIndexRequest>,
) -> Result<Json<FileIndexResponse>, (StatusCode, Json<ApiError>)> {
    match index_project_files(req.root_path.clone(), req.exclude_dirs).await {
        Ok(count) => Ok(Json(FileIndexResponse {
            count,
            message: format!("Indexed {} files in {}", count, req.root_path),
        })),
        Err(e) => Err((StatusCode::BAD_REQUEST, Json(ApiError::new(e)))),
    }
}

/// Clear file search cache
///
/// Clears all cached file indexes. Next search will rebuild the index.
#[utoipa::path(
    delete,
    path = "/api/search/files/cache",
    responses(
        (status = 200, description = "Cache cleared successfully"),
    ),
    tag = "file-search"
)]
pub async fn clear_cache() -> StatusCode {
    clear_file_index_cache();
    StatusCode::OK
}

// ============================================
// Query Parameter Types
// ============================================

#[derive(Debug, Deserialize)]
pub struct FileSearchParams {
    pub query: String,
    pub root_path: String,
    pub max_results: Option<usize>,
    #[serde(default)]
    pub file_extensions: Option<Vec<String>>,
    #[serde(default)]
    pub exclude_dirs: Option<Vec<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn search_files_maps_successful_results_and_applies_filters() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::create_dir_all(dir.path().join("src")).expect("create src");
        std::fs::write(dir.path().join("src/lib.rs"), "pub fn library() {}")
            .expect("write Rust file");
        std::fs::write(dir.path().join("src/library.md"), "docs").expect("write docs file");
        std::fs::write(dir.path().join("README.md"), "readme").expect("write readme");

        let Json(response) = search_files(Query(FileSearchParams {
            query: "lib".to_string(),
            root_path: dir.path().to_string_lossy().into_owned(),
            max_results: Some(10),
            file_extensions: Some(vec![".rs".to_string()]),
            exclude_dirs: None,
        }))
        .await
        .expect("successful search");

        assert_eq!(response.files.len(), 1);
        assert_eq!(response.files[0].filename, "lib.rs");
        assert_eq!(response.files[0].file_type, "file");
        assert!(response.files[0].path.ends_with("src/lib.rs"));
        assert!(response.folders.is_empty());
        assert_eq!(response.total_indexed, 4);
    }

    #[tokio::test]
    async fn index_files_excludes_requested_directories_and_reports_count() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::create_dir_all(dir.path().join("src")).expect("create src");
        std::fs::create_dir_all(dir.path().join("generated")).expect("create generated");
        std::fs::write(dir.path().join("src/lib.rs"), "pub fn covered() {}").expect("write source");
        std::fs::write(dir.path().join("generated/output.rs"), "generated")
            .expect("write excluded source");

        let root_path = dir.path().to_string_lossy().into_owned();
        let Json(response) = index_files(Json(FileIndexRequest {
            root_path: root_path.clone(),
            exclude_dirs: Some(vec!["generated".to_string()]),
        }))
        .await
        .expect("successful index");

        assert_eq!(response.count, 2);
        assert_eq!(response.message, format!("Indexed 2 files in {root_path}"));
    }

    #[tokio::test]
    async fn missing_roots_return_bad_request_errors() {
        let dir = tempfile::tempdir().expect("temp dir");
        let missing = dir.path().join("missing").to_string_lossy().into_owned();

        let (search_status, Json(search_error)) = search_files(Query(FileSearchParams {
            query: "anything".to_string(),
            root_path: missing.clone(),
            max_results: None,
            file_extensions: None,
            exclude_dirs: None,
        }))
        .await
        .expect_err("missing search root");
        assert_eq!(search_status, StatusCode::BAD_REQUEST);
        assert!(search_error.error.contains("Path does not exist"));

        let (index_status, Json(index_error)) = index_files(Json(FileIndexRequest {
            root_path: missing,
            exclude_dirs: None,
        }))
        .await
        .expect_err("missing index root");
        assert_eq!(index_status, StatusCode::BAD_REQUEST);
        assert!(index_error.error.contains("Path does not exist"));
    }

    #[tokio::test]
    async fn clear_cache_returns_ok() {
        assert_eq!(clear_cache().await, StatusCode::OK);
    }
}
