//! Centralized data directory resolution for the ORGII app.
//!
//! Every module that needs a filesystem path under `~/.orgii/` should call
//! helpers from this crate instead of computing paths inline. This guarantees
//! a single fallback strategy, makes disk-usage tracking trivial, and lets
//! tests redirect everything via the `ORGII_HOME` env var.
//!
//! This crate is the leaf-most behavior crate in the workspace: it is allowed
//! to do filesystem and process work (e.g. `set_sensitive_file_permissions`)
//! but takes no domain dependencies. Every other crate may depend on it.
//!
//! The crate's public surface is intentionally flat: submodules exist only to
//! keep this file readable, and every public item is re-exported here so
//! callers keep using `app_paths::<helper>()`.

mod cli_homes;
mod data_root;
mod home;
mod permissions;
mod shell_path;
mod system_git;
mod temp;

pub use cli_homes::*;
pub use data_root::*;
pub use home::*;
pub use permissions::*;
pub use shell_path::*;
pub use system_git::*;
pub use temp::*;
