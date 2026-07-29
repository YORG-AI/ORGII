//! Orgtrack Core
//!
//! Publishable core for collecting developer activity, writing canonical
//! records, projecting replay/stat views, and syncing repo-shareable `.orgtrack`
//! metadata. Host applications provide paths, permissions, UI commands, and
//! runtime-specific adapters.

pub mod canonical;
pub mod development_artifact;
pub mod edit_extraction;
#[cfg(test)]
mod edit_extraction_tests;
pub mod hook_adapter;
pub mod policy;
pub mod pricing;
pub mod privacy;
pub mod profile;
pub mod projectors;
pub mod repo_sync;
pub mod resource_interaction;
#[cfg(feature = "sqlite")]
pub mod session_usage;
pub mod sources;
pub mod status_adapter;
pub mod store;
pub mod sync_export;
#[cfg(feature = "sqlite")]
pub mod usage_dashboard;

pub use canonical::*;
pub use privacy::*;
pub use repo_sync::types::*;
