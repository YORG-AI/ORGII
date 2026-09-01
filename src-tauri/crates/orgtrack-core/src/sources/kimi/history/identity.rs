//! Kimi session identity, bounded-safety limits, and on-disk layout mapping.

use crate::sources::imported_history::ImportedHistoryRecentPath;

pub const KIMI_SESSION_PREFIX: &str = "kimihistoryapp-";
pub type KimiRecentPath = ImportedHistoryRecentPath;

pub(super) const KIMI_METADATA_PARSER_VERSION: i64 = 5;
pub(super) const DEFAULT_MODEL: &str = "kimi-for-coding";
pub(super) const MAX_CONFIG_BYTES: u64 = 64 * 1024;
pub(super) const MAX_WIRE_FILE_BYTES: i64 = 64 * 1024 * 1024;
pub(super) const MAX_CHANGED_SESSIONS_PER_SYNC: usize = 256;
pub(super) const MAX_PARSE_SOURCE_BYTES_PER_SYNC: i64 = 64 * 1024 * 1024;
pub(super) const MAX_STATE_JSON_BYTES: usize = 4 * 1024 * 1024;
pub(super) const MAX_USAGE_ROUNDS: usize = 20_000;
pub(super) const MAX_ID_BYTES: usize = 1_024;
pub(super) const MAX_MODEL_BYTES: usize = 1_024;
pub(super) const MAX_REPLAY_CHUNKS: usize = 20_000;
pub(super) const MAX_REPLAY_TEXT_BYTES: usize = 8 * 1024 * 1024;
pub(super) const MAX_REPLAY_MESSAGE_CHARS: usize = 50_000;
pub(super) const MAX_CODE_OPEN_STEPS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum KimiLayout {
    Legacy,
    Code,
}

impl KimiLayout {
    pub(super) fn state_label(self) -> &'static str {
        match self {
            Self::Legacy => "legacy",
            Self::Code => "code",
        }
    }
}

pub(super) fn layout_from_source_id(source_session_id: &str) -> Result<KimiLayout, String> {
    if source_session_id.starts_with("cli/") {
        Ok(KimiLayout::Legacy)
    } else if source_session_id.starts_with("code/") {
        Ok(KimiLayout::Code)
    } else {
        Err(format!(
            "Unknown Kimi source namespace: {source_session_id}"
        ))
    }
}

pub(super) fn session_placement(
    source_session_id: &str,
    has_replayable_content: bool,
) -> Result<(bool, Option<String>), String> {
    match layout_from_source_id(source_session_id)? {
        KimiLayout::Legacy => Ok((true, None)),
        KimiLayout::Code => {
            let parts = source_session_id.split('/').collect::<Vec<_>>();
            if parts.len() != 4 {
                return Err(format!(
                    "Invalid Kimi Code source identity: {source_session_id}"
                ));
            }
            let parent_session_id = (parts[3] != "main")
                .then(|| format!("{KIMI_SESSION_PREFIX}code/{}/{}/main", parts[1], parts[2]));
            // Main agents with replayable context appear in the sidebar.
            // Subagents retain the same bit for stats/fork ownership, but their
            // parent id keeps them out of the top-level list. Metadata-only
            // rows remain cached for usage/signatures without empty sessions.
            Ok((has_replayable_content, parent_session_id))
        }
    }
}
