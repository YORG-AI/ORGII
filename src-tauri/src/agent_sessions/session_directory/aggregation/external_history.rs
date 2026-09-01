//! External history source registry.
//!
//! One page loader per imported CLI/IDE provider, the ordered loader table the
//! sidebar and directory pages walk, and the manual re-sync entry point.

use orgtrack_core::sources::claude_code::history as claude_code_history;
use orgtrack_core::sources::cline::history as cline_history;
use orgtrack_core::sources::codex::app as codex_app_history;
use orgtrack_core::sources::copilot::history as copilot_history;
use orgtrack_core::sources::cursor_cli::history as cursor_cli_history;
use orgtrack_core::sources::cursor_ide::history as cursor_ide_history;
use orgtrack_core::sources::cursor_ide::history::CursorIdeSessionPage;
use orgtrack_core::sources::imported_history::metadata::{
    SOURCE_CLAUDE_CODE, SOURCE_CLINE, SOURCE_CODEX_APP, SOURCE_COPILOT, SOURCE_CURSOR_CLI,
    SOURCE_CURSOR_IDE, SOURCE_KIMI, SOURCE_MIMO_CODE, SOURCE_OMP, SOURCE_OPENCODE, SOURCE_PI,
    SOURCE_QODER, SOURCE_QODER_CLI, SOURCE_QWEN_CODE, SOURCE_TRAE, SOURCE_WARP, SOURCE_WINDSURF,
    SOURCE_WORKBUDDY, SOURCE_ZCODE,
};
use orgtrack_core::sources::imported_history::ImportedHistorySessionPage;
use orgtrack_core::sources::kimi::history as kimi_history;
use orgtrack_core::sources::mimo_code::history as mimo_code_history;
use orgtrack_core::sources::omp::history as omp_history;
use orgtrack_core::sources::opencode::history as opencode_history;
use orgtrack_core::sources::pi::history as pi_history;
use orgtrack_core::sources::qoder::history as qoder_history;
use orgtrack_core::sources::qoder_cli::history as qoder_cli_history;
use orgtrack_core::sources::qwen_code::history as qwen_code_history;
use orgtrack_core::sources::trae::history as trae_history;
use orgtrack_core::sources::warp::history as warp_history;
use orgtrack_core::sources::windsurf::history as windsurf_history;
use orgtrack_core::sources::workbuddy as workbuddy_history;
use orgtrack_core::sources::zcode::history as zcode_history;

pub(super) const IMPORTED_HISTORY_PAGE_SIZE: usize = 500;

pub(super) enum ExternalHistoryPage {
    Imported(ImportedHistorySessionPage),
    CursorIde(CursorIdeSessionPage),
}

pub(super) type ExternalHistoryPageLoader =
    fn(&mut rusqlite::Connection, usize, usize) -> Result<ExternalHistoryPage, String>;

pub(super) struct ExternalHistorySourceLoader {
    pub(super) source: &'static str,
    pub(super) load_page: ExternalHistoryPageLoader,
    /// Filtered cache-snapshot reader for continuation pages. Sources whose
    /// page-zero loader filters beyond the generic cache predicate (Cursor
    /// IDE's listable-session check) must re-apply that filter on "Load
    /// more", or offsets computed against page zero's filtered stream
    /// misalign — duplicating rows already shown and surfacing rows page
    /// zero hides. `None` = the generic cache page matches page zero.
    pub(super) load_continuation_page: Option<ExternalHistoryPageLoader>,
}

fn load_claude_code_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    claude_code_history::list_claude_code_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_codex_app_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    codex_app_history::list_codex_app_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_cursor_ide_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    cursor_ide_history::list_cursor_ide_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::CursorIde)
}

fn load_cursor_ide_external_history_continuation_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    cursor_ide_history::list_cursor_ide_sessions_paginated_cached(conn, limit, offset)
        .map(ExternalHistoryPage::CursorIde)
}

fn load_cursor_cli_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    cursor_cli_history::list_cursor_cli_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_opencode_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    opencode_history::list_opencode_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_windsurf_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    windsurf_history::list_windsurf_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_workbuddy_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    workbuddy_history::list_workbuddy_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_trae_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    trae_history::list_trae_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_cline_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    cline_history::list_cline_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_warp_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    warp_history::list_warp_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_zcode_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    zcode_history::list_zcode_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_qoder_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    qoder_history::list_qoder_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_mimo_code_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    mimo_code_history::list_mimo_code_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_omp_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    omp_history::list_omp_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_pi_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    pi_history::list_pi_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_qoder_cli_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    qoder_cli_history::list_qoder_cli_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_qwen_code_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    qwen_code_history::list_qwen_code_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_kimi_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    kimi_history::list_kimi_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

fn load_copilot_external_history_page(
    conn: &mut rusqlite::Connection,
    limit: usize,
    offset: usize,
) -> Result<ExternalHistoryPage, String> {
    copilot_history::list_copilot_history_sessions_paginated(conn, limit, offset)
        .map(ExternalHistoryPage::Imported)
}

pub(super) const EXTERNAL_HISTORY_SOURCE_LOADERS: &[ExternalHistorySourceLoader] = &[
    ExternalHistorySourceLoader {
        source: SOURCE_CLAUDE_CODE,
        load_page: load_claude_code_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_CODEX_APP,
        load_page: load_codex_app_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_CURSOR_IDE,
        load_page: load_cursor_ide_external_history_page,
        load_continuation_page: Some(load_cursor_ide_external_history_continuation_page),
    },
    ExternalHistorySourceLoader {
        source: SOURCE_CURSOR_CLI,
        load_page: load_cursor_cli_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_OPENCODE,
        load_page: load_opencode_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_WINDSURF,
        load_page: load_windsurf_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_WORKBUDDY,
        load_page: load_workbuddy_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_TRAE,
        load_page: load_trae_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_CLINE,
        load_page: load_cline_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_WARP,
        load_page: load_warp_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_ZCODE,
        load_page: load_zcode_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_QODER,
        load_page: load_qoder_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_MIMO_CODE,
        load_page: load_mimo_code_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_OMP,
        load_page: load_omp_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_PI,
        load_page: load_pi_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_QODER_CLI,
        load_page: load_qoder_cli_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_QWEN_CODE,
        load_page: load_qwen_code_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_COPILOT,
        load_page: load_copilot_external_history_page,
        load_continuation_page: None,
    },
    ExternalHistorySourceLoader {
        source: SOURCE_KIMI,
        load_page: load_kimi_external_history_page,
        load_continuation_page: None,
    },
];

/// Discover a source's current records and incrementally re-sync its metadata
/// cache, discarding the returned page. This runs the exact sync the
/// sidebar/list path performs (re-parsing every record whose signature changed,
/// e.g. after a parser-version bump), so a manual update can refresh counts and
/// names immediately instead of waiting for a lazy list load.
pub fn resync_external_history_source(
    conn: &mut rusqlite::Connection,
    source: &str,
) -> Result<bool, String> {
    let loader = EXTERNAL_HISTORY_SOURCE_LOADERS
        .iter()
        .find(|loader| loader.source == source)
        .ok_or_else(|| format!("Unknown external history source: {source}"))?;
    let changes_before = conn.total_changes();
    (loader.load_page)(conn, IMPORTED_HISTORY_PAGE_SIZE, 0)?;
    Ok(conn.total_changes() > changes_before)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pi_external_history_loader_is_registered_once() {
        assert_eq!(
            EXTERNAL_HISTORY_SOURCE_LOADERS
                .iter()
                .filter(|loader| loader.source == SOURCE_PI)
                .count(),
            1
        );
    }

    #[test]
    fn desktop_external_history_loaders_include_qwen_code_once() {
        assert_eq!(
            EXTERNAL_HISTORY_SOURCE_LOADERS
                .iter()
                .filter(|loader| loader.source == SOURCE_QWEN_CODE)
                .count(),
            1
        );
    }

    #[test]
    fn desktop_external_history_loaders_include_kimi_once() {
        assert_eq!(
            EXTERNAL_HISTORY_SOURCE_LOADERS
                .iter()
                .filter(|loader| loader.source == SOURCE_KIMI)
                .count(),
            1
        );
    }

    #[test]
    fn desktop_external_history_loaders_include_copilot_once() {
        assert_eq!(
            EXTERNAL_HISTORY_SOURCE_LOADERS
                .iter()
                .filter(|loader| loader.source == SOURCE_COPILOT)
                .count(),
            1
        );
    }
}
