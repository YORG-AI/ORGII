//! Unified HTTP API Module
//!
//! Hosts the in-process axum server that composes the Git, Search,
//! Agent, Project, and WebSocket routers under a single port. Routes
//! and OpenAPI types come from the `git_api` and `api_search` crates;
//! this module owns server bootstrap, agent routes, and the WebSocket
//! handler.

pub mod agent;
pub mod agent_approval_ingest;
pub mod agent_status_ingest;
pub mod mobile_bridge;
mod server;
pub mod websocket_handler;

// Re-export main server function
pub use server::start_server;
pub use websocket_handler::init_broadcaster;

// ── Global AppHandle for API adapters that execute desktop-owned state ──

static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

pub fn init_app_handle(handle: tauri::AppHandle) {
    APP_HANDLE.set(handle).ok();
}

pub fn get_app_handle() -> Option<&'static tauri::AppHandle> {
    APP_HANDLE.get()
}

#[cfg(test)]
mod tests;
