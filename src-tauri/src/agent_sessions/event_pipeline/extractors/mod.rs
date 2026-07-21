//! Rendering Data Extractors
//!
//! Pre-computes structured display data from `SessionEvent` fields so
//! the frontend rendering layer does zero JSON parsing at display time.
//!
//! ## Usage
//!
//! ```ignore
//! use crate::agent_sessions::event_pipeline::extractors::{extract_event_data, extract_batch};
//!
//! // Single event
//! if let Some(data) = extract_event_data(&event) {
//!     // data is ExtractedData enum (Thinking, File, Shell, etc.)
//! }
//!
//! // Batch (for initial load)
//! let pairs = extract_batch(&events); // Vec<(event_id, ExtractedData)>
//! ```

mod file_extractor;
pub(crate) mod git_artifacts;
mod helpers;
pub mod lang;
mod misc_extractor;
mod search_extractor;
mod shell_extractor;

#[allow(clippy::module_inception)]
pub mod extractors;
pub mod types;

pub use extractors::{
    extract_batch, extract_event_data, extract_event_data_with_bounded_shell_output,
};
pub use types::ExtractedData;

/// Register `extract_event_data` against the inversion-of-control slot
/// in `core_types::session_event`. Called once at startup so
/// `SessionEvent::recompute_extracted` produces typed rendering
/// envelopes without `core_types` depending on this module.
pub fn register_extractor_hook() {
    core_types::session_event::register_extractor(extract_event_data);
}
