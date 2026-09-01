//! Tauri application assembly for the `org2` binary.
//!
//! `lib.rs` stays a thin crate root; everything that configures, builds, and
//! runs the desktop application lives here:
//!
//! - [`bootstrap`]: process-level bootstrap that must precede the Tauri builder
//! - [`plugins`]: builder construction, plugin order, and custom URI schemes
//! - [`setup_hook`]: the `.setup()` hook, split into ordered init stages
//! - [`lifecycle`]: window, page-load, and run-event handlers
//! - [`builder`]: wires the pieces above together and runs the application

pub(crate) mod bootstrap;
pub(crate) mod builder;
pub(crate) mod lifecycle;
pub(crate) mod plugins;
pub(crate) mod setup_hook;

pub(crate) use builder::run;
