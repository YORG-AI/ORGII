//! Performance Optimization Module
//!
//! Provides Rust-accelerated implementations for performance-critical operations:
//! - Image luminance calculation (for adaptive UI theming)
//! - Binary file detection (SIMD-accelerated)
//! - Large JSON parsing (simd-json)
//! - Hash computation (SHA-256)
//! - Diff computation and fuzzy patch application
//! - Process metrics collection (memory, CPU usage)

pub mod app_memory;
pub mod binary_detection;
pub mod diff_patch;
pub mod hash;
pub mod image_luminance;
pub mod json_fast;
pub mod local_model_hardware;
pub mod process_metrics;

// Re-export all commands
pub use app_memory::*;
pub use binary_detection::*;
pub use diff_patch::*;
pub use hash::*;
pub use image_luminance::*;
pub use json_fast::*;
pub use local_model_hardware::*;
pub use process_metrics::*;

#[cfg(test)]
mod tests;
