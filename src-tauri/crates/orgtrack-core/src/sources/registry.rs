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

use super::imported_history::{
    cache as imported_history_cache, metadata, ImportedHistorySessionPage,
    ImportedHistorySessionRow,
};
use super::{
    claude_code, cline, codex, copilot, cursor_cli, cursor_ide, kimi, mimo_code, omp, opencode, pi,
    qoder, qoder_cli, qwen_code, trae, warp, windsurf, workbuddy, zcode,
};

/// Signature every provider's paginated session loader shares. The `&mut
/// Connection` is the source cache store the scan writes through; `limit` /
/// `offset` page the returned rows. Page zero performs discovery/sync;
/// continuation pages read the resulting cache snapshot directly.
type ScanFn = fn(&mut Connection, usize, usize) -> Result<ImportedHistorySessionPage, String>;

/// One registered provider: its stable `source` id (matches the
/// `metadata::SOURCE_*` constants and the `source` column written to every
/// cache table), a human label for CLI/UI listing, and its scan loader.
pub struct RegisteredSource {
    pub id: &'static str,
    pub label: &'static str,
    scan: ScanFn,
    /// Cache-snapshot reader for continuation pages, for providers whose
    /// page-zero loader filters beyond the generic cache predicate. Page-zero
    /// offsets are positions in that filtered stream, so such providers must
    /// re-apply the same filter on "Load more" or the page seam duplicates
    /// and leaks rows. `None` means the generic cache page is already
    /// consistent with page zero.
    continuation: Option<ScanFn>,
}

impl RegisteredSource {
    /// Discover this provider on page zero, then read continuation pages from
    /// the stable cache snapshot without repeating the scan.
    pub fn scan(
        &self,
        conn: &mut Connection,
        limit: usize,
        offset: usize,
    ) -> Result<ImportedHistorySessionPage, String> {
        if offset == 0 {
            (self.scan)(conn, limit, offset)
        } else if let Some(continuation) = self.continuation {
            continuation(conn, limit, offset)
        } else {
            imported_history_cache::query_imported_session_page_from_conn(
                conn, self.id, limit, offset,
            )
        }
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
        continuation: None,
    },
    RegisteredSource {
        id: metadata::SOURCE_CODEX_APP,
        label: "Codex",
        scan: codex::app::list_codex_app_sessions_paginated,
        continuation: None,
    },
    RegisteredSource {
        id: metadata::SOURCE_CURSOR_CLI,
        label: "Cursor CLI",
        scan: cursor_cli::history::list_cursor_cli_history_sessions_paginated,
        continuation: None,
    },
    RegisteredSource {
        id: metadata::SOURCE_CURSOR_IDE,
        label: "Cursor IDE",
        scan: scan_cursor_ide,
        // Cursor's page zero filters to listable sessions (named, ≥1 user
        // bubble); continuation pages must re-apply that filter over the
        // cache snapshot to keep offsets aligned with page zero.
        continuation: Some(scan_cursor_ide_cached),
    },
    RegisteredSource {
        id: metadata::SOURCE_OPENCODE,
        label: "OpenCode",
        scan: opencode::history::list_opencode_history_sessions_paginated,
        continuation: None,
    },
    RegisteredSource {
        id: metadata::SOURCE_CLINE,
        label: "Cline",
        scan: cline::history::list_cline_history_sessions_paginated,
        continuation: None,
    },
    RegisteredSource {
        id: metadata::SOURCE_COPILOT,
        label: "Copilot CLI",
        scan: copilot::history::list_copilot_history_sessions_paginated,
        continuation: None,
    },
    RegisteredSource {
        id: metadata::SOURCE_WINDSURF,
        label: "Windsurf",
        scan: windsurf::history::list_windsurf_history_sessions_paginated,
        continuation: None,
    },
    RegisteredSource {
        id: metadata::SOURCE_WARP,
        label: "Warp",
        scan: warp::history::list_warp_history_sessions_paginated,
        continuation: None,
    },
    RegisteredSource {
        id: metadata::SOURCE_TRAE,
        label: "Trae",
        scan: trae::history::list_trae_history_sessions_paginated,
        continuation: None,
    },
    RegisteredSource {
        id: metadata::SOURCE_ZCODE,
        label: "ZCode",
        scan: zcode::history::list_zcode_history_sessions_paginated,
        continuation: None,
    },
    RegisteredSource {
        id: metadata::SOURCE_QODER,
        label: "Qoder",
        scan: qoder::history::list_qoder_history_sessions_paginated,
        continuation: None,
    },
    RegisteredSource {
        id: metadata::SOURCE_QODER_CLI,
        label: "Qoder CLI",
        scan: qoder_cli::history::list_qoder_cli_history_sessions_paginated,
        continuation: None,
    },
    RegisteredSource {
        id: metadata::SOURCE_QWEN_CODE,
        label: "Qwen Code",
        scan: qwen_code::history::list_qwen_code_history_sessions_paginated,
        continuation: None,
    },
    RegisteredSource {
        id: metadata::SOURCE_KIMI,
        label: "Kimi",
        scan: kimi::history::list_kimi_history_sessions_paginated,
        continuation: None,
    },
    RegisteredSource {
        id: metadata::SOURCE_MIMO_CODE,
        label: "Mimo Code",
        scan: mimo_code::history::list_mimo_code_history_sessions_paginated,
        continuation: None,
    },
    RegisteredSource {
        id: metadata::SOURCE_OMP,
        label: "OMP",
        scan: omp::history::list_omp_history_sessions_paginated,
        continuation: None,
    },
    RegisteredSource {
        id: metadata::SOURCE_PI,
        label: "Pi",
        scan: pi::history::list_pi_history_sessions_paginated,
        continuation: None,
    },
    RegisteredSource {
        id: metadata::SOURCE_WORKBUDDY,
        label: "WorkBuddy",
        scan: workbuddy::list_workbuddy_history_sessions_paginated,
        continuation: None,
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
    normalize_cursor_ide_page(cursor_ide::history::list_cursor_ide_sessions_paginated(
        conn, limit, offset,
    )?)
}

/// Continuation twin of [`scan_cursor_ide`]: same normalization over the
/// filtered cache-snapshot reader (no discovery re-run).
fn scan_cursor_ide_cached(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<ImportedHistorySessionPage, String> {
    normalize_cursor_ide_page(
        cursor_ide::history::list_cursor_ide_sessions_paginated_cached(conn, limit, offset)?,
    )
}

fn normalize_cursor_ide_page(
    page: cursor_ide::history::CursorIdeSessionPage,
) -> Result<ImportedHistorySessionPage, String> {
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
                client_origin: None,
                client_origin_raw: None,
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

    fn should_not_scan(
        _conn: &mut Connection,
        _limit: usize,
        _offset: usize,
    ) -> Result<ImportedHistorySessionPage, String> {
        panic!("continuation page repeated provider scan")
    }

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
        assert!(find(metadata::SOURCE_PI).is_some());
        assert!(!is_registered("definitely_not_a_source"));
        assert!(scan_source(
            &mut Connection::open_in_memory().unwrap(),
            "definitely_not_a_source",
            1,
            0
        )
        .is_err());
    }

    #[test]
    fn continuation_page_reads_cache_without_provider_scan() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::store::sqlite::SqliteRecordStore::init_source_cache_tables(&conn)
            .expect("init source cache");
        let source = RegisteredSource {
            id: metadata::SOURCE_CLAUDE_CODE,
            label: "test",
            scan: should_not_scan,
            continuation: None,
        };

        let page = source.scan(&mut conn, 20, 20).expect("cached page");

        assert!(page.sessions.is_empty());
        assert!(!page.has_more);
    }

    #[test]
    fn continuation_override_handles_follow_up_pages_instead_of_generic_cache() {
        fn filtered_continuation(
            _conn: &mut Connection,
            _limit: usize,
            offset: usize,
        ) -> Result<ImportedHistorySessionPage, String> {
            assert!(offset > 0, "continuation override called for page zero");
            Err("continuation override reached".to_string())
        }

        let mut conn = Connection::open_in_memory().unwrap();
        crate::store::sqlite::SqliteRecordStore::init_source_cache_tables(&conn)
            .expect("init source cache");
        let source = RegisteredSource {
            id: metadata::SOURCE_CURSOR_IDE,
            label: "test",
            scan: should_not_scan,
            continuation: Some(filtered_continuation),
        };

        let err = source.scan(&mut conn, 20, 20).expect_err("override used");
        assert!(err.contains("continuation override reached"));

        // The registered Cursor IDE entry must carry a filtered continuation:
        // its page zero filters to listable sessions, so the generic cache
        // page would misalign the seam.
        let cursor = find(metadata::SOURCE_CURSOR_IDE).expect("cursor registered");
        assert!(cursor.continuation.is_some());
    }
}
