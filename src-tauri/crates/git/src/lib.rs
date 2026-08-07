//! Git Core Module
//!
//! Core git functionality (utilities, bundles, watching, repo management)

pub mod branches;
pub mod bundle;
pub mod hooks;
pub mod pr_base;
pub mod repos;
pub mod types;
pub mod util;
pub mod watch;
pub mod worktree;

pub use bundle::*;
pub use util::*;
pub use watch::{EventEmitter, RepoStateStore, RepoWatchManager, RepoWatcher, REPO_WATCH_MANAGER};

#[cfg(test)]
mod tests;
