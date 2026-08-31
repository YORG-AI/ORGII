pub mod config;
mod handlers;
pub mod state;
pub mod store;

use axum::http::{HeaderName, Method};
use axum::routing::{get, post};
use axum::Router;
use tower_http::cors::{Any, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::trace::TraceLayer;

use config::RelayConfig;
use state::{RelayState, MAX_FRAME_BYTES};
use store::DeviceStore;

pub fn build_state(config: RelayConfig) -> Result<RelayState, String> {
    let store = DeviceStore::open(&config.database_path)?;
    Ok(RelayState::new(config, store))
}

pub fn build_router(state: RelayState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([
            HeaderName::from_static("authorization"),
            HeaderName::from_static("content-type"),
        ]);
    Router::new()
        .route("/healthz", get(handlers::health))
        .route("/v1/pairings", post(handlers::create_pairing))
        .route("/v1/pairings/complete", post(handlers::complete_pairing))
        .route("/v1/devices", get(handlers::list_devices))
        .route("/v1/devices/revoke", post(handlers::revoke_device))
        .route("/v1/desktops/primary", post(handlers::set_primary_desktop))
        .route("/v1/desktop/ws", get(handlers::desktop_socket))
        .route("/v1/mobile/ws", get(handlers::mobile_socket))
        .layer(RequestBodyLimitLayer::new(MAX_FRAME_BYTES))
        .layer(cors)
        // Device credentials are carried in WebSocket query parameters. Log
        // only the path so neither tracing spans nor their error records can
        // persist the raw token.
        .layer(TraceLayer::new_for_http().make_span_with(
            |request: &axum::http::Request<axum::body::Body>| {
                tracing::info_span!(
                    "http.request",
                    method = %request.method(),
                    path = %sanitized_request_path(request.uri())
                )
            },
        ))
        .with_state(state)
}

fn sanitized_request_path(uri: &axum::http::Uri) -> &str {
    uri.path()
}

pub async fn serve(config: RelayConfig) -> Result<(), String> {
    let listen_addr = config.listen_addr;
    let state = build_state(config)?;
    let listener = tokio::net::TcpListener::bind(listen_addr)
        .await
        .map_err(|err| format!("bind relay listener: {err}"))?;
    tracing::info!(%listen_addr, "mobile relay listening");
    axum::serve(listener, build_router(state))
        .await
        .map_err(|err| format!("serve mobile relay: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_path_excludes_websocket_credentials() {
        let uri: axum::http::Uri = "/v1/mobile/ws?token=raw-secret&pairingCode=PAIR"
            .parse()
            .expect("URI");
        assert_eq!(sanitized_request_path(&uri), "/v1/mobile/ws");
        assert!(!sanitized_request_path(&uri).contains("raw-secret"));
    }
}
