//! Individual LSP Server Process
//!
//! Manages a single language server process, handling:
//! - Process spawning and lifecycle
//! - stdin/stdout communication
//! - Request/response correlation
//! - Notification sending
//!
//! Organized into submodules by responsibility:
//! - `lifecycle`: the `LspServer` type, spawn, `initialize`, shutdown, `Drop`
//! - `transport`: framed stdin writes, request IDs, pending-response map
//! - `listener`: stderr drain + framed stdout listener and its dispatch
//! - `documents`: `didOpen` / `didChange` / `didClose` and diagnostics reads
//! - `features`: capability-gated definition / references / hover / symbols
//! - `diagnostics`: the bounded `publishDiagnostics` cache
//! - `helpers`: pure-logic helpers (URI parsing, framing, sync-kind resolution)

mod diagnostics;
mod documents;
mod features;
mod helpers;
mod lifecycle;
mod listener;
mod transport;

// Re-exported so this module's surface stays exactly what it was before
// the split — `lsp::server::LspServer` plus the `pub(crate)` helpers the
// crate's test modules reach for via `crate::server::…`.
pub use lifecycle::LspServer;

// In a non-test build every consumer of these already lives inside
// `server/` and imports the defining submodule directly, so rustc sees
// the crate-visible re-exports as unused. They are kept unconditionally
// (rather than `#[cfg(test)]`-gated) so the `crate::server::…` paths are
// stable across both builds.
#[allow(unused_imports)]
pub(crate) use self::{
    diagnostics::DiagnosticsCache,
    helpers::{parse_uri, resolve_sync_kind, strip_framing_prefix},
    transport::drain_pending_on_close,
};

// Pure-logic helper tests live in `tests/server_tests.rs` so they
// stay close to the rest of the crate's per-module test layout.
// The `#[path]` is relative to this file, so it walks up out of
// `server/` after the module became a directory.
#[cfg(test)]
#[path = "../tests/server_tests.rs"]
mod tests;

// `drain_pending_on_close` is exercised by the integration harness
// in `tests/server_integration_tests.rs`, which wires a stub child
// process via `tokio::io::duplex` to drive the EOF path without a
// real LSP binary on disk.
#[cfg(test)]
#[path = "../tests/server_integration_tests.rs"]
mod integration_tests;
