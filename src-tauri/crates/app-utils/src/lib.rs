//! Small utility helpers shared across workspace crates.
//!
//! JSON file I/O (`json::*`) used by CLI agent config modules, Serde
//! defaults, and opt-in test fixtures. No workspace-crate dependencies.
//!
//! Add new general-purpose helpers here when two or more workspace crates
//! would otherwise duplicate them. If a helper is specific to one domain
//! (key vault, settings, etc.), keep it inside that crate instead.

pub mod json;

#[cfg(feature = "testing")]
pub mod testing;

/// Serde `default = ...` helper that returns `true`.
///
/// Use as `#[serde(default = "app_utils::default_true")]` on `bool` fields
/// whose absence from the wire payload should be treated as "enabled".
/// Centralised here so workspace crates don't duplicate the helper (every
/// duplicate is a latent extraction-blocker — see the 0504 cleanup pass).
pub fn default_true() -> bool {
    true
}
