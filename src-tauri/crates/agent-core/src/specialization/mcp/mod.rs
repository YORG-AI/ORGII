//! MCP (Model Context Protocol) client integration.
//!
//! Provides MCP server connection management at the `agent_core` level,
//! usable by all agent types. Built on top of the official [`rmcp`] crate.
//!
//! # Modules
//!
//! - [`config`]: Server configuration (global + workspace-scoped)
//! - [`client`]: MCP protocol client (thin wrapper around rmcp `RunningService`)
//! - [`handler`]: rmcp `ClientHandler` impl bridging to our event channel
//! - [`notification`]: `ServerNotification` wire type used by the manager
//! - [`manager`]: Lifecycle management for multiple servers
//! - [`bridge`]: Bridges MCP tools into the agent's `ToolRegistry`
//! - [`commands`]: Tauri commands for the frontend settings UI

// External callers (lib.rs, init/, state/commands/, api/agent/test/) reach
// `commands`, `bridge`, and `config` through their flat
// submodule paths. Everything else is consumed only by sibling submodules
// inside this crate, so we keep it `pub(crate)` to avoid leaking surface.
pub mod bridge;
pub mod commands;
pub mod config;

pub(crate) mod auth_tool;
pub(crate) mod client;
pub(crate) mod env_expansion;
pub(crate) mod errors;
pub(crate) mod handler;
pub(crate) mod instructions;
pub(crate) mod manager;
pub(crate) mod needs_auth_cache;
pub(crate) mod notification;
pub(crate) mod oauth;
pub(crate) mod oauth_store;
pub(crate) mod prompts;
pub(crate) mod resource_tools;
pub(crate) mod resources;
pub(crate) mod result;

pub use bridge::register_mcp_tools;
pub use manager::McpManager;
