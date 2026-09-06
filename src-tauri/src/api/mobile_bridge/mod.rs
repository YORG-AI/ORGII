//! ORGII Mobile Bridge — Phase 0 LAN WebSocket JSON-RPC server.

pub mod adapters;
pub mod auth;
pub mod commands;
pub mod fanout;
pub mod org2_cloud_auth;
pub mod relay;
pub mod rpc;
pub mod ws_handler;

use axum::routing::get;
use axum::Router;
use tower_http::cors::{Any, CorsLayer};

pub use fanout::{on_bus_message, on_snapshot_envelope};

pub const HEALTH_PATH: &str = "/mobile/health";
pub const HEALTH_DEEP_PATH: &str = "/mobile/health/deep";
pub const WS_PATH: &str = "/mobile/ws";

/// Every path the bridge listener serves.
///
/// The bridge owns a listener of its own precisely so that this list is the
/// complete attack surface of LAN exposure. Nothing from the unified IDE
/// server (`/git`, `/search`, `/agent`, `/ws`, the automation webhooks) is
/// mounted here.
pub const BRIDGE_ROUTES: [&str; 3] = [HEALTH_PATH, HEALTH_DEEP_PATH, WS_PATH];

/// Mobile bridge routes. Served on the bridge's own listener only.
pub fn router() -> Router {
    Router::new()
        .route(HEALTH_PATH, get(ws_handler::health_shallow))
        .route(HEALTH_DEEP_PATH, get(ws_handler::health_deep))
        .route(WS_PATH, get(ws_handler::mobile_ws_handler))
}

/// Start the mobile bridge listener, if Mobile Remote asks for one.
///
/// This is the *only* listener that `mobileRemote.allowLanExposure` may widen.
/// It serves [`BRIDGE_ROUTES`] and nothing else, on `mobileRemote.lanPort` —
/// the same port the desktop Settings section encodes into the pairing QR
/// code. The unified IDE server stays on loopback regardless.
///
/// The bind is resolved once at startup, like the IDE server's. Toggling
/// either Mobile Remote setting off is still honoured immediately, because
/// every bridge route re-reads settings per request
/// (`auth::check_bridge_available`); only turning a setting *on* needs a
/// restart.
pub fn spawn_bridge_listener(ide_server_port: u16) {
    let settings = auth::load_settings();
    let lan_port = auth::mobile_lan_port();
    let addr = match auth::mobile_bridge_bind_addr(&settings, lan_port, ide_server_port) {
        Ok(addr) => addr,
        Err(skip) => {
            tracing::info!(
                lan_port,
                ide_server_port,
                "[MobileBridge] {}",
                skip.message()
            );
            return;
        }
    };

    let exposed_to_lan = settings.allow_lan_exposure;
    auth::set_bridge_bound_lan(exposed_to_lan);

    tokio::spawn(async move {
        // Token-authenticated routes served to a browser PWA; the origin is
        // not a trust boundary here, the LAN token is.
        let cors = CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any);
        let app = router().layer(cors);

        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => listener,
            Err(err) => {
                tracing::error!(error = %err, %addr, "[MobileBridge] failed to bind");
                return;
            }
        };
        tracing::info!(
            %addr,
            exposed_to_lan,
            "[MobileBridge] bridge listening on {}",
            WS_PATH
        );
        if let Err(err) = axum::serve(listener, app).await {
            tracing::error!(error = %err, %addr, "[MobileBridge] bridge listener stopped");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_listener_serves_mobile_routes_only() {
        // Regression guard for the LAN exposure defect: the listener that
        // `allowLanExposure` widens must never carry an IDE route.
        for path in BRIDGE_ROUTES {
            assert!(
                path.starts_with("/mobile/"),
                "non-mobile route on the bridge listener: {path}"
            );
        }
    }
}
