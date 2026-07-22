//! Unified source registry and scan dispatch.
//!
//! Every imported-history source owns a compact catalog refresher and a
//! storage-specific bounded replay adapter. Registry scans deliberately call
//! only the catalog refresher, then page ORGII's compact cache; they never call
//! the legacy transcript loaders that materialize complete histories.
//!
//! The read side already has its router:
//! [`super::imported_history::load_activity_chunks_for_session`] takes a
//! `session_id` and returns the session's [`core_types::activity::ActivityChunk`]
//! stream regardless of which provider owns it. This module is the write/scan
//! twin — enumerate the providers, scan one (or all) of them into a
//! connection, and let the analytics layer ([`crate::usage_dashboard`],
//! [`crate::session_usage`]) read the result. Hosts that want a bare,
//! app-independent store (tests, the `orgtrack` CLI) get the whole loading
//! pipeline from these two entry points plus [`crate::store::sqlite`] table
//! init.
//!
//! Adding a provider is one line here plus its loader — the same "localized
//! plug-in" property the parsers already have.

use rusqlite::Connection;

use super::imported_history::{
    cache, catalog, metadata, replay::ImportedHistorySourceId, ImportedHistorySessionPage,
};

/// One registered provider: its stable `source` id (matches the
/// `metadata::SOURCE_*` constants and the `source` column written to every
/// cache table), a human label for CLI/UI listing, and its scan loader.
pub struct RegisteredSource {
    pub id: &'static str,
    pub label: &'static str,
    source: ImportedHistorySourceId,
}

impl RegisteredSource {
    /// Discover this provider's sessions on disk, upsert them into `conn`'s
    /// source cache tables, and read back `[offset, offset + limit)`.
    pub fn scan(
        &self,
        conn: &mut Connection,
        limit: usize,
        offset: usize,
    ) -> Result<ImportedHistorySessionPage, String> {
        catalog::refresh_source(conn, self.source)?;
        cache::query_imported_session_page_from_conn(conn, self.id, limit, offset)
    }
}

/// The registered providers, in a stable display order (native-CLI agents
/// first, IDE assistants after). Any provider with a
/// `list_*_history_sessions_paginated` loader belongs here; providers that are
/// only *detected* (see the extra `metadata::SOURCE_*` ids without a loader)
/// do not, because there is nothing to scan yet.
static REGISTERED: &[RegisteredSource] = &[
    RegisteredSource {
        id: metadata::SOURCE_CLAUDE_CODE,
        label: "Claude Code",
        source: ImportedHistorySourceId::ClaudeCode,
    },
    RegisteredSource {
        id: metadata::SOURCE_CODEX_APP,
        label: "Codex",
        source: ImportedHistorySourceId::CodexApp,
    },
    RegisteredSource {
        id: metadata::SOURCE_CURSOR_CLI,
        label: "Cursor CLI",
        source: ImportedHistorySourceId::CursorCli,
    },
    RegisteredSource {
        id: metadata::SOURCE_CURSOR_IDE,
        label: "Cursor IDE",
        source: ImportedHistorySourceId::CursorIde,
    },
    RegisteredSource {
        id: metadata::SOURCE_OPENCODE,
        label: "OpenCode",
        source: ImportedHistorySourceId::OpenCode,
    },
    RegisteredSource {
        id: metadata::SOURCE_CLINE,
        label: "Cline",
        source: ImportedHistorySourceId::Cline,
    },
    RegisteredSource {
        id: metadata::SOURCE_WINDSURF,
        label: "Windsurf",
        source: ImportedHistorySourceId::Windsurf,
    },
    RegisteredSource {
        id: metadata::SOURCE_WARP,
        label: "Warp",
        source: ImportedHistorySourceId::Warp,
    },
    RegisteredSource {
        id: metadata::SOURCE_TRAE,
        label: "Trae",
        source: ImportedHistorySourceId::Trae,
    },
    RegisteredSource {
        id: metadata::SOURCE_ZCODE,
        label: "ZCode",
        source: ImportedHistorySourceId::ZCode,
    },
    RegisteredSource {
        id: metadata::SOURCE_QODER,
        label: "Qoder",
        source: ImportedHistorySourceId::Qoder,
    },
    RegisteredSource {
        id: metadata::SOURCE_QODER_CLI,
        label: "Qoder CLI",
        source: ImportedHistorySourceId::QoderCli,
    },
    RegisteredSource {
        id: metadata::SOURCE_MIMO_CODE,
        label: "Mimo Code",
        source: ImportedHistorySourceId::MimoCode,
    },
    RegisteredSource {
        id: metadata::SOURCE_OMP,
        label: "OMP",
        source: ImportedHistorySourceId::Omp,
    },
    RegisteredSource {
        id: metadata::SOURCE_WORKBUDDY,
        label: "WorkBuddy",
        source: ImportedHistorySourceId::WorkBuddy,
    },
];

/// Every provider the registry can scan, in display order.
pub fn registered_sources() -> &'static [RegisteredSource] {
    REGISTERED
}

/// Look up a provider by its stable `source` id.
pub fn find(source_id: &str) -> Option<&'static RegisteredSource> {
    REGISTERED.iter().find(|source| source.id == source_id)
}

/// Whether `source_id` names a scannable registered provider.
pub fn is_registered(source_id: &str) -> bool {
    find(source_id).is_some()
}

/// Scan a single provider by id into `conn` and return one page of sessions.
/// Errors with a listable hint when the id is unknown.
pub fn scan_source(
    conn: &mut Connection,
    source_id: &str,
    limit: usize,
    offset: usize,
) -> Result<ImportedHistorySessionPage, String> {
    match find(source_id) {
        Some(source) => source.scan(conn, limit, offset),
        None => Err(format!(
            "unknown source '{source_id}' — known sources: {}",
            REGISTERED
                .iter()
                .map(|source| source.id)
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_ids_are_unique_and_nonempty() {
        let mut seen = std::collections::HashSet::new();
        for source in registered_sources() {
            assert!(!source.id.is_empty(), "empty source id");
            assert!(!source.label.is_empty(), "empty label for {}", source.id);
            assert!(seen.insert(source.id), "duplicate source id {}", source.id);
        }
    }

    #[test]
    fn find_matches_registered_and_rejects_unknown() {
        assert!(is_registered(metadata::SOURCE_CLAUDE_CODE));
        assert!(find(metadata::SOURCE_WARP).is_some());
        assert!(!is_registered("definitely_not_a_source"));
        assert!(scan_source(
            &mut Connection::open_in_memory().unwrap(),
            "definitely_not_a_source",
            1,
            0
        )
        .is_err());
    }
}
