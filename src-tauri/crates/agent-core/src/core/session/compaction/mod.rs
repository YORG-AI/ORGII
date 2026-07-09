//! Context compaction orchestration.
//!
//! - [`fork`]: Automatic context-fork when the window is nearly full
//! - [`manual`]: User-triggered `/compact` command handler

pub mod fork;
pub mod manual;
pub(crate) mod persist;
