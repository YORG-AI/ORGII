//! Bounded diagnostics cache backing `textDocument/publishDiagnostics`.
//!
//! Written by the stdout listener (`super::listener`) and read by the
//! document-sync accessors (`super::documents`).

use std::collections::{HashMap, VecDeque};

use super::super::types::*;

/// Maximum number of file URIs cached per LSP server. When the cache is
/// full and a new URI arrives, the oldest entry is evicted (FIFO order
/// approximating LRU on insertion). 500 is well above realistic editor
/// fan-out (a single workspace rarely has hundreds of distinct files
/// open at once) and bounds memory at roughly a few MB per server.
const MAX_DIAGNOSTIC_FILES: usize = 500;

/// Bounded diagnostics cache for `textDocument/publishDiagnostics`.
///
/// LSP servers continuously publish diagnostics as they re-analyse the
/// workspace, so an unbounded `HashMap` would grow without limit in
/// long-lived sessions. This wrapper keeps insertion order in a
/// `VecDeque` and evicts the oldest entry when the cap is hit.
///
/// Empty diagnostic arrays are NOT stored — when the server reports
/// "this file is now clean" we eagerly evict the entry instead, which
/// keeps the cache focused on files that actually have problems.
#[derive(Default)]
pub(crate) struct DiagnosticsCache {
    map: HashMap<String, PublishDiagnosticsParams>,
    order: VecDeque<String>,
}

impl DiagnosticsCache {
    /// Insert/replace diagnostics for a URI, evicting the oldest entry
    /// when over the cap. Empty diagnostics arrays cause eviction
    /// rather than insertion — once a file is "now clean" there's
    /// nothing useful to surface and keeping the URI around just
    /// pressures the bounded cap.
    pub fn upsert(&mut self, uri: String, params: PublishDiagnosticsParams) {
        if params.diagnostics.is_empty() {
            self.evict(&uri);
            return;
        }

        use std::collections::hash_map::Entry;
        if let Entry::Occupied(mut occupied) = self.map.entry(uri.clone()) {
            occupied.insert(params);
            return;
        }

        if self.map.len() >= MAX_DIAGNOSTIC_FILES {
            if let Some(oldest) = self.order.pop_front() {
                self.map.remove(&oldest);
            }
        }

        self.order.push_back(uri.clone());
        self.map.insert(uri, params);
    }

    /// Drop a single URI (called on `textDocument/didClose` and on
    /// "now clean" notifications).
    pub fn evict(&mut self, uri: &str) {
        if self.map.remove(uri).is_some() {
            if let Some(pos) = self.order.iter().position(|u| u == uri) {
                self.order.remove(pos);
            }
        }
    }

    pub fn snapshot(&self) -> HashMap<String, PublishDiagnosticsParams> {
        self.map.clone()
    }

    pub fn get(&self, uri: &str) -> Option<&PublishDiagnosticsParams> {
        self.map.get(uri)
    }
}
