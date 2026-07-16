//! System Services
//!
//! OS-integration Tauri commands and helpers: macOS dock + tray + app menu,
//! native notifications, VPN interface detection, ipinfo geolocation lookup,
//! and host-toolchain
//! dependency probing (git, node, python, …).
//!
//! Pure leaf — no back-edges into `app`. The `#[tauri::command]` functions
//! are re-registered from `commands/handler_list.inc` via bare
//! `system_services::…` paths. Distinct from the lower-level
//! `app_platform` crate (which only ships the macOS Objective-C
//! `@try/@catch` FFI trampoline used by `agent_core` and friends).

pub mod app_menu;
pub mod dependencies;
pub mod dock_menu;
pub mod network;
pub mod notifications;
pub mod power;
pub mod system_recents;
pub mod tray;
pub mod workspace_ports;

#[cfg(test)]
mod tests;
