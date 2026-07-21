//! Document synchronisation (`textDocument/didOpen` / `didChange` /
//! `didClose`) plus the read side of the diagnostics cache those
//! notifications keep warm.

use std::collections::HashMap;

use super::super::types::*;
use super::helpers::{parse_uri, resolve_sync_kind};
use super::lifecycle::LspServer;

impl LspServer {
    /// Notify server that a document was opened.
    pub async fn did_open(
        &self,
        uri: &str,
        language_id: &str,
        version: i32,
        text: &str,
    ) -> Result<(), String> {
        let params = DidOpenTextDocumentParams {
            text_document: TextDocumentItem {
                uri: parse_uri(uri)?,
                language_id: language_id.to_string(),
                version,
                text: text.to_string(),
            },
        };
        self.send_typed_notification("textDocument/didOpen", &params)
            .await
    }

    /// Notify server that a document changed by re-shipping the full
    /// document text.
    ///
    /// Capability-gated on the cached
    /// `ServerCapabilities.text_document_sync` resolved kind:
    ///
    /// * `Full` — send the single full-text change event.
    /// * `Incremental` — also send the full-text event. Per the LSP
    ///   spec, a server that advertises `Incremental` still accepts a
    ///   single change event with no `range`, treating it as a full
    ///   replacement (this is exactly how rust-analyzer / pyright
    ///   behave today). We don't ship per-keystroke ranges here
    ///   because no caller has a diff against the previous version —
    ///   agent-core's post-edit refresh and `LspTool::ensure_open`
    ///   both read the file from disk, and the frontend WebSocket
    ///   producer ships the full buffer too. A future incremental
    ///   wire path can be added when a change-set producer
    ///   materializes (CodeMirror integration); that would grow a new
    ///   arm here, not a parallel method, to keep the capability gate
    ///   authoritative.
    /// * `None` — server doesn't accept `didChange`; skip silently
    ///   with a debug log so editor refreshes don't spam errors at
    ///   servers that only sync on `didOpen`/`didClose` (rare, but
    ///   the spec allows it).
    pub async fn did_change(&self, uri: &str, version: i32, text: &str) -> Result<(), String> {
        let kind = self.resolved_sync_kind().await;
        if kind == TextDocumentSyncKind::NONE {
            log::debug!(
                "[LSP] {} skipping didChange (server advertised sync kind None) for {}",
                self.language,
                uri
            );
            return Ok(());
        }

        let params = DidChangeTextDocumentParams {
            text_document: VersionedTextDocumentIdentifier {
                uri: parse_uri(uri)?,
                version,
            },
            content_changes: vec![TextDocumentContentChangeEvent {
                range: None,
                range_length: None,
                text: text.to_string(),
            }],
        };
        self.send_typed_notification("textDocument/didChange", &params)
            .await
    }

    /// Read the cached `text_document_sync` capability. Pre-init
    /// callers (no capabilities stored yet) get `Full` so the
    /// document still syncs — this matches the `require_capability`
    /// "degrade open" contract used by hover / definition / refs.
    ///
    /// We collapse `Full` and `Incremental` into "send the change
    /// notification" because today every caller has the full file
    /// content (no per-keystroke diff is available — agent-core's
    /// post-edit hook reads from disk, `LspTool::ensure_open` reads
    /// from disk, the frontend WebSocket producer ships full text).
    /// When a frontend producer that emits incremental ranges lands,
    /// this helper grows a third return value and `did_change` gains
    /// a new arm — see the LSP optimisation plan, Phase 11.
    async fn resolved_sync_kind(&self) -> TextDocumentSyncKind {
        resolve_sync_kind(self.capabilities.read().await.as_ref())
    }

    /// Notify server that a document was closed.
    ///
    /// Also evicts the file's cached diagnostics — once the editor has
    /// dropped the buffer there's no consumer for them, and keeping
    /// stale entries around just bloats the bounded cache.
    pub async fn did_close(&self, uri: &str) -> Result<(), String> {
        let params = DidCloseTextDocumentParams {
            text_document: TextDocumentIdentifier {
                uri: parse_uri(uri)?,
            },
        };
        let result = self
            .send_typed_notification("textDocument/didClose", &params)
            .await;

        self.diagnostics_cache.write().await.evict(uri);

        result
    }

    /// Get a read-only snapshot of all cached diagnostics.
    /// Returns a map of file URI → typed `PublishDiagnosticsParams`.
    pub async fn get_cached_diagnostics(&self) -> HashMap<String, PublishDiagnosticsParams> {
        self.diagnostics_cache.read().await.snapshot()
    }

    /// Get cached diagnostics for a single file URI.
    /// Returns the typed `Diagnostic` list, or empty if none cached.
    pub async fn get_file_diagnostics(&self, uri: &str) -> Vec<lsp_types::Diagnostic> {
        let cache = self.diagnostics_cache.read().await;
        cache
            .get(uri)
            .map(|params| params.diagnostics.clone())
            .unwrap_or_default()
    }
}
