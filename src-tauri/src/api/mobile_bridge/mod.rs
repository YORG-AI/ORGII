//! ORGII Mobile Bridge — Phase 0 LAN WebSocket JSON-RPC server.

pub mod adapters;
pub mod auth;
pub mod commands;
pub mod fanout;
pub mod relay;
pub mod rpc;
pub mod ws_handler;

use axum::routing::get;
use axum::Router;

pub use fanout::{on_bus_message, on_snapshot_envelope};

/// Mobile bridge routes mounted on the unified IDE server.
pub fn router() -> Router {
    Router::new()
        .route("/mobile/health", get(ws_handler::health_shallow))
        .route("/mobile/health/deep", get(ws_handler::health_deep))
        .route("/mobile/ws", get(ws_handler::mobile_ws_handler))
}
