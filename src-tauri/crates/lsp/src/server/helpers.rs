//! Pure-logic helpers shared across the `server` submodules.
//!
//! Everything here is free of `LspServer` state so the unit tests in
//! `tests/server_tests.rs` can exercise them without spawning a child
//! process.

use std::str::FromStr;

use super::super::types::*;

/// Parse a stringly-typed URI into the `lsp_types::Uri` newtype.
///
/// Returns a `Result` rather than `unwrap`ing because the wire
/// surface (Tauri commands, agent-core query_lsp) hands us URIs that
/// originated from frontend / LLM input, so a malformed one is a
/// runtime error and not a programmer error.
pub(crate) fn parse_uri(input: &str) -> Result<Uri, String> {
    Uri::from_str(input).map_err(|err| format!("Invalid URI {:?}: {}", input, err))
}

/// Strip the `Content-Length: N\r\n\r\n` framing prefix from an
/// outbound message before pushing the body into the log buffer.
/// Returns the original input unchanged if the separator isn't found
/// (e.g. an unframed debug write) so the log still captures
/// something useful.
pub(crate) fn strip_framing_prefix(framed: &str) -> &str {
    framed
        .find("\r\n\r\n")
        .map(|idx| &framed[idx + 4..])
        .unwrap_or(framed)
}

/// Resolve the effective `TextDocumentSyncKind` for a capability set.
///
/// Phase 11 capability gating: if a server hasn't completed
/// `initialize` yet (so `caps` is `None`), we conservatively default
/// to `Full` — the server might be picky about ordering and we'd
/// rather send a redundant full document than skip a required change.
/// Once we've seen the real capabilities we honour whatever kind they
/// advertised, including `None` (the gate that lets `did_change`
/// short-circuit).
pub(crate) fn resolve_sync_kind(caps: Option<&ServerCapabilities>) -> TextDocumentSyncKind {
    match caps {
        Some(caps) => caps.text_document_sync_kind(),
        None => TextDocumentSyncKind::FULL,
    }
}
