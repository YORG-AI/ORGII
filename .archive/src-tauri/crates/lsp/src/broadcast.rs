//! WebSocket broadcast inversion-of-control point.
//!
//! The LSP server reads JSON-RPC messages off each language server's
//! stdout and forwards `textDocument/publishDiagnostics` notifications to
//! the IDE WebSocket so the frontend can render diagnostics in-place. The
//! WebSocket lives in the `app` crate (`api::websocket_handler`), so to
//! avoid a back-edge we register a function pointer at startup.
//!
//! Pattern mirrors `database::register_sessions_init`: a `OnceLock<fn>`
//! cell, set once by `app::run`, called by this crate without compile-time
//! coupling to the IDE server.

use std::sync::OnceLock;

/// Type signature of the IDE WebSocket broadcast function. The `app` crate
/// adapts `api::websocket_handler::broadcast` (which has the same shape)
/// into this slot at startup.
pub type BroadcastFn = fn(String);

fn cell() -> &'static OnceLock<BroadcastFn> {
    static CELL: OnceLock<BroadcastFn> = OnceLock::new();
    &CELL
}

/// Register the broadcast function pointer. Idempotent: subsequent calls
/// are silently ignored, which keeps tests safe across `app::run` re-entry.
pub fn register_broadcast(broadcast_fn: BroadcastFn) {
    let _ = cell().set(broadcast_fn);
}

/// Send `message` to every connected WebSocket client.
///
/// If no broadcaster has been registered (e.g. unit tests that exercise the
/// LSP server without spinning up the IDE HTTP layer), the message is
/// dropped with a `log::warn!` — matching the original `app::api::
/// websocket_handler::broadcast` behaviour when its channel is missing.
pub fn send(message: String) {
    if let Some(broadcast_fn) = cell().get() {
        broadcast_fn(message);
    } else {
        log::warn!("[LSP] broadcast called before register_broadcast; message dropped");
    }
}
