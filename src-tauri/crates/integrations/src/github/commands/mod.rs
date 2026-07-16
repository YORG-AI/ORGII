//! GitHub Tauri Commands
//!
//! Exposes GitHub operations to the frontend via `invoke()`. Credentials are
//! resolved at command entry from the centralized connection token store
//! (see `project_management::sync::git_credentials`); the frontend no longer
//! passes user IDs or hosted-service tokens.
//!
//! Split by domain:
//! - [`shared`]      — token resolution + authenticated REST client constructor
//! - [`repos`]       — repository listing, search, and branch commands
//! - [`pulls`]       — pull requests, reviews, inline review comments, checks
//! - [`issues`]      — issues, issue comments, labels, collaborators
//! - [`credentials`] — git credential lookup, repository clone, token check
//!
//! Every command is re-exported at this module's root so the Tauri
//! `generate_handler!` registration paths (`…::github::commands::github_*`)
//! stay unchanged.

mod credentials;
mod issues;
mod pulls;
mod repos;
mod shared;

pub use credentials::*;
pub use issues::*;
pub use pulls::*;
pub use repos::*;

#[cfg(test)]
#[path = "../tests/commands_tests.rs"]
mod tests;
