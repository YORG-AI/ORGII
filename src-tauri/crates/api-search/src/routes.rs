//! Central route registration for the search HTTP API.
use axum::{
    routing::{delete, get, post},
    Json, Router,
};

use crate::code_routes;
use crate::file_routes;

async fn api_info() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "name": "Orgii Search API",
        "version": "1.0.0",
        "status": "running",
        "endpoints": {
            "openapi_spec": "/api-docs/openapi.json",
            "file_search": "/api/search/files?query=...&root_path=...",
            "file_index": "/api/search/files/index",
            "symbol_search": "/api/search/code/symbols?repo_path=...",
        }
    }))
}

pub fn create_routes() -> Router {
    Router::new()
        .route("/", get(api_info))
        .route("/api/search/files", get(file_routes::search_files))
        .route("/api/search/files/index", post(file_routes::index_files))
        .route("/api/search/files/cache", delete(file_routes::clear_cache))
        .route("/api/search/code/symbols", get(code_routes::search_symbols))
        .route(
            "/api/search/code/file-symbols",
            get(code_routes::get_file_symbols),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[tokio::test]
    async fn root_route_reports_the_public_api_contract() {
        let response = create_routes()
            .oneshot(
                Request::builder()
                    .uri("/")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("router response");

        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = response
            .into_body()
            .collect()
            .await
            .expect("response body")
            .to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).expect("JSON response");
        assert_eq!(json["name"], "Orgii Search API");
        assert_eq!(json["version"], "1.0.0");
        assert_eq!(json["status"], "running");
        assert_eq!(
            json["endpoints"]["file_search"],
            "/api/search/files?query=...&root_path=..."
        );
        assert_eq!(
            json["endpoints"]["symbol_search"],
            "/api/search/code/symbols?repo_path=..."
        );
    }

    #[tokio::test]
    async fn router_rejects_unknown_paths_wrong_methods_and_missing_query_fields() {
        let router = create_routes();

        let unknown = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/missing")
                    .body(Body::empty())
                    .expect("unknown request"),
            )
            .await
            .expect("unknown response");
        assert_eq!(unknown.status(), axum::http::StatusCode::NOT_FOUND);

        let wrong_method = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/")
                    .body(Body::empty())
                    .expect("wrong-method request"),
            )
            .await
            .expect("wrong-method response");
        assert_eq!(
            wrong_method.status(),
            axum::http::StatusCode::METHOD_NOT_ALLOWED
        );

        let missing_query = router
            .oneshot(
                Request::builder()
                    .uri("/api/search/files?query=needle")
                    .body(Body::empty())
                    .expect("missing-query request"),
            )
            .await
            .expect("missing-query response");
        assert_eq!(missing_query.status(), axum::http::StatusCode::BAD_REQUEST);
    }
}
