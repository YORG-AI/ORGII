//! Unified source registry and scan dispatch.
//!
//! Every imported-history source ships a `list_*_history_sessions_paginated`
//! loader that fuses three steps behind one call: discover the provider's
//! sessions on disk, incrementally upsert them into the source cache tables of
//! the passed connection, and read back one page of normalized
//! [`ImportedHistorySessionPage`] rows. Those loaders live next to each
//! provider's parser, which is the right home for them — but the *set* of
//! providers, and the routing from a stable `source` id to the right loader,
//! was until now open-coded in every host (the desktop app's
//! `history_commands`, and any CLI). This module is the single place that owns
//! that mapping.
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

use super::imported_history::{metadata, ImportedHistorySessionPage, ImportedHistorySessionRow};
use super::{
    claude_code, cline, codex, cursor_cli, cursor_ide, mimo_code, omp, opencode, qoder, qoder_cli,
    trae, warp, windsurf, workbuddy, zcode,
};

/// Signature every provider's paginated session loader shares. The `&mut
/// Connection` is the source cache store the scan writes through; `limit` /
/// `offset` page the returned rows (the full provider set is always synced to
/// the cache regardless of the page window).
type ScanFn = fn(&mut Connection, usize, usize) -> Result<ImportedHistorySessionPage, String>;

/// One registered provider: its stable `source` id (matches the
/// `metadata::SOURCE_*` constants and the `source` column written to every
/// cache table), a human label for CLI/UI listing, and its scan loader.
pub struct RegisteredSource {
    pub id: &'static str,
    pub label: &'static str,
    scan: ScanFn,
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
        (self.scan)(conn, limit, offset)
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
        scan: claude_code::history::list_claude_code_history_sessions_paginated,
    },
    RegisteredSource {
        id: metadata::SOURCE_CODEX_APP,
        label: "Codex",
        scan: codex::app::list_codex_app_sessions_paginated,
    },
    RegisteredSource {
        id: metadata::SOURCE_CURSOR_CLI,
        label: "Cursor CLI",
        scan: cursor_cli::history::list_cursor_cli_history_sessions_paginated,
    },
    RegisteredSource {
        id: metadata::SOURCE_CURSOR_IDE,
        label: "Cursor IDE",
        scan: scan_cursor_ide,
    },
    RegisteredSource {
        id: metadata::SOURCE_OPENCODE,
        label: "OpenCode",
        scan: opencode::history::list_opencode_history_sessions_paginated,
    },
    RegisteredSource {
        id: metadata::SOURCE_CLINE,
        label: "Cline",
        scan: cline::history::list_cline_history_sessions_paginated,
    },
    RegisteredSource {
        id: metadata::SOURCE_WINDSURF,
        label: "Windsurf",
        scan: windsurf::history::list_windsurf_history_sessions_paginated,
    },
    RegisteredSource {
        id: metadata::SOURCE_WARP,
        label: "Warp",
        scan: warp::history::list_warp_history_sessions_paginated,
    },
    RegisteredSource {
        id: metadata::SOURCE_TRAE,
        label: "Trae",
        scan: trae::history::list_trae_history_sessions_paginated,
    },
    RegisteredSource {
        id: metadata::SOURCE_ZCODE,
        label: "ZCode",
        scan: zcode::history::list_zcode_history_sessions_paginated,
    },
    RegisteredSource {
        id: metadata::SOURCE_QODER,
        label: "Qoder",
        scan: qoder::history::list_qoder_history_sessions_paginated,
    },
    RegisteredSource {
        id: metadata::SOURCE_QODER_CLI,
        label: "Qoder CLI",
        scan: qoder_cli::history::list_qoder_cli_history_sessions_paginated,
    },
    RegisteredSource {
        id: metadata::SOURCE_MIMO_CODE,
        label: "Mimo Code",
        scan: mimo_code::history::list_mimo_code_history_sessions_paginated,
    },
    RegisteredSource {
        id: metadata::SOURCE_OMP,
        label: "OMP",
        scan: omp::history::list_omp_history_sessions_paginated,
    },
    RegisteredSource {
        id: metadata::SOURCE_WORKBUDDY,
        label: "WorkBuddy",
        scan: workbuddy::list_workbuddy_history_sessions_paginated,
    },
];

/// Cursor IDE's loader predates the shared row type and returns its own
/// `CursorIdeSessionRow` (identical apart from carrying no parent-session
/// linkage). Normalize it here so the registry exposes one uniform page type.
fn scan_cursor_ide(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<ImportedHistorySessionPage, String> {
    let page = cursor_ide::history::list_cursor_ide_sessions_paginated(conn, limit, offset)?;
    Ok(ImportedHistorySessionPage {
        has_more: page.has_more,
        sessions: page
            .sessions
            .into_iter()
            .map(|row| ImportedHistorySessionRow {
                session_id: row.session_id,
                name: row.name,
                status: row.status,
                created_at: row.created_at,
                updated_at: row.updated_at,
                category: row.category,
                read_only: row.read_only,
                model: row.model,
                total_tokens: row.total_tokens,
                background: row.background,
                is_active: row.is_active,
                repo_path: row.repo_path,
                repo_root_path: row.repo_root_path,
                repo_remote_urls: row.repo_remote_urls,
                storage_path: row.storage_path,
                repo_name: row.repo_name,
                branch: row.branch,
                files_changed: row.files_changed,
                lines_added: row.lines_added,
                lines_removed: row.lines_removed,
                touched_files: row.touched_files,
                parent_session_id: None,
            })
            .collect(),
    })
}

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
