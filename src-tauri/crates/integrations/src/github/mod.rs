//! GitHub Local API Module
//!
//! Moves GitHub API calls from the legacy server (port 8001) to local Rust,
//! reducing server pressure. Includes token storage, API client with 401
//! auto-retry, and profile data fetching with concurrent requests.

pub mod client;
pub mod commands;
pub mod detect;
pub mod profile;
pub mod star;
