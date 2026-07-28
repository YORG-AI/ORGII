use core_types::activity::ActivityChunk;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportedHistoryLoader {
    ClaudeCode,
    Codex,
    Cursor,
    CursorCli,
    OpenCode,
    Windsurf,
    WorkBuddy,
    Trae,
    Cline,
    Warp,
    ZCode,
    Qoder,
    MimoCode,
    Omp,
    QoderCli,
}

fn imported_history_loader(session_id: &str) -> Option<ImportedHistoryLoader> {
    if session_id.starts_with(super::super::claude_code::SESSION_PREFIX) {
        Some(ImportedHistoryLoader::ClaudeCode)
    } else if session_id.starts_with(super::super::codex::SESSION_PREFIX) {
        Some(ImportedHistoryLoader::Codex)
    } else if session_id.starts_with(super::super::cursor_ide::CURSORIDE_SESSION_PREFIX) {
        Some(ImportedHistoryLoader::Cursor)
    } else if session_id.starts_with(super::super::cursor_cli::SESSION_PREFIX) {
        Some(ImportedHistoryLoader::CursorCli)
    } else if session_id.starts_with(super::super::opencode::history::OPENCODE_SESSION_PREFIX) {
        Some(ImportedHistoryLoader::OpenCode)
    } else if session_id.starts_with(super::super::windsurf::history::WINDSURF_SESSION_PREFIX) {
        Some(ImportedHistoryLoader::Windsurf)
    } else if session_id.starts_with(super::super::workbuddy::WORKBUDDY_SESSION_PREFIX) {
        Some(ImportedHistoryLoader::WorkBuddy)
    } else if session_id.starts_with(super::super::trae::history::TRAE_SESSION_PREFIX) {
        Some(ImportedHistoryLoader::Trae)
    } else if session_id.starts_with(super::super::cline::history::CLINE_SESSION_PREFIX) {
        Some(ImportedHistoryLoader::Cline)
    } else if session_id.starts_with(super::super::warp::history::WARP_SESSION_PREFIX) {
        Some(ImportedHistoryLoader::Warp)
    } else if session_id.starts_with(super::super::zcode::history::ZCODE_SESSION_PREFIX) {
        Some(ImportedHistoryLoader::ZCode)
    } else if session_id.starts_with(super::super::qoder::history::QODER_SESSION_PREFIX) {
        Some(ImportedHistoryLoader::Qoder)
    } else if session_id.starts_with(super::super::mimo_code::history::MIMO_CODE_SESSION_PREFIX) {
        Some(ImportedHistoryLoader::MimoCode)
    } else if session_id.starts_with(super::super::omp::history::OMP_SESSION_PREFIX) {
        Some(ImportedHistoryLoader::Omp)
    } else if session_id.starts_with(super::super::qoder_cli::history::QODER_CLI_SESSION_PREFIX) {
        Some(ImportedHistoryLoader::QoderCli)
    } else {
        None
    }
}

/// Load one imported provider session through its existing canonical history
/// reader. `None` means the id is not owned by an imported-history provider;
/// `Some(empty)` is a known provider session whose source currently has no
/// readable chunks.
///
/// This is the single provider router for cross-provider projections such as
/// per-round Orgtrack metadata. It deliberately delegates parsing to the
/// established source modules instead of introducing another transcript
/// reader.
pub fn load_activity_chunks_for_session(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<Vec<ActivityChunk>>, String> {
    let chunks = match imported_history_loader(session_id) {
        Some(ImportedHistoryLoader::ClaudeCode) => {
            super::super::claude_code::history::load_claude_code_history_for_session(conn, session_id)?
        }
        Some(ImportedHistoryLoader::Codex) => {
            super::super::codex::app::load_codex_app_for_session(conn, session_id)?
        }
        Some(ImportedHistoryLoader::Cursor) => {
            super::super::cursor_ide::history::load_history_for_session(session_id)?
        }
        Some(ImportedHistoryLoader::CursorCli) => {
            super::super::cursor_cli::history::load_cursor_cli_history_for_session(conn, session_id)?
        }
        Some(ImportedHistoryLoader::OpenCode) => {
            super::super::opencode::history::load_opencode_history_for_session(session_id)?
        }
        Some(ImportedHistoryLoader::Windsurf) => {
            super::super::windsurf::history::load_windsurf_history_for_session(session_id)?
        }
        Some(ImportedHistoryLoader::WorkBuddy) => {
            super::super::workbuddy::load_workbuddy_history_for_session(conn, session_id)?
        }
        Some(ImportedHistoryLoader::Trae) => {
            super::super::trae::history::load_trae_history_for_session(conn, session_id)?
        }
        Some(ImportedHistoryLoader::Cline) => {
            super::super::cline::history::load_cline_history_for_session(conn, session_id)?
        }
        Some(ImportedHistoryLoader::Warp) => {
            super::super::warp::history::load_warp_history_for_session(session_id)?
        }
        Some(ImportedHistoryLoader::ZCode) => {
            super::super::zcode::history::load_zcode_history_for_session(session_id)?
        }
        Some(ImportedHistoryLoader::Qoder) => {
            super::super::qoder::history::load_qoder_history_for_session(conn, session_id)?
        }
        Some(ImportedHistoryLoader::MimoCode) => {
            super::super::mimo_code::history::load_mimo_code_history_for_session(conn, session_id)?
        }
        Some(ImportedHistoryLoader::Omp) => {
            super::super::omp::history::load_omp_history_for_session(conn, session_id)?
        }
        Some(ImportedHistoryLoader::QoderCli) => {
            super::super::qoder_cli::history::load_qoder_cli_history_for_session(conn, session_id)?
        }
        None => return Ok(None),
    };
    Ok(Some(chunks))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_every_imported_provider_to_its_existing_history_loader() {
        let cases = [
            ("claudecodeapp-id", ImportedHistoryLoader::ClaudeCode),
            ("codexapp-id", ImportedHistoryLoader::Codex),
            ("cursoride-id", ImportedHistoryLoader::Cursor),
            ("cursorcliapp-id", ImportedHistoryLoader::CursorCli),
            ("opencodeapp-id", ImportedHistoryLoader::OpenCode),
            ("windsurfapp-id", ImportedHistoryLoader::Windsurf),
            ("workbuddyapp-id", ImportedHistoryLoader::WorkBuddy),
            ("traeapp-id", ImportedHistoryLoader::Trae),
            ("clineapp-id", ImportedHistoryLoader::Cline),
            ("warpapp-id", ImportedHistoryLoader::Warp),
            ("zcodeapp-id", ImportedHistoryLoader::ZCode),
            ("qoderapp-id", ImportedHistoryLoader::Qoder),
            ("mimocodeapp-id", ImportedHistoryLoader::MimoCode),
            ("ompapp-id", ImportedHistoryLoader::Omp),
            ("qodercliapp-id", ImportedHistoryLoader::QoderCli),
        ];

        for (session_id, expected) in cases {
            assert_eq!(imported_history_loader(session_id), Some(expected));
        }
        assert_eq!(imported_history_loader("org2-native-id"), None);
    }
}
