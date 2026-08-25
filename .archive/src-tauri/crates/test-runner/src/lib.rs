//! Test runner — discovery, execution, and result streaming for multiple frameworks
//!
//! Communicates with the frontend via Tauri commands (invoke) and events (emit).
//!
//! Commands: `detect_test_framework`, `discover_tests`, `run_tests`,
//!           `stop_tests`, `get_test_patterns`
//! Events:   `test-event` — streaming test results
//!
//! Supported frameworks:
//! - JavaScript/TypeScript: Jest, Vitest, Mocha
//! - Python: Pytest
//! - Rust: `cargo test`

pub mod commands;
pub mod detection;
pub mod discovery;
pub mod runner;
pub mod types;

pub use commands::*;
pub use types::*;

#[cfg(test)]
mod tests;
