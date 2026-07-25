//! Exhaustive imported-history replay source registry.
//!
//! A source may share a storage driver with another source, but it must still
//! have an explicit registry entry.  In particular there is no "try the old
//! full loader" catch-all: adding a sixteenth source requires choosing a
//! driver and implementing its replay adapter deliberately.

use serde::{Deserialize, Serialize};

use crate::sources::imported_history::metadata::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportedHistorySourceId {
    ClaudeCode,
    CodexApp,
    CursorIde,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplayStorageFamily {
    JsonLines,
    SqliteWal,
    SqliteKeyValue,
    SqliteManifestBlob,
    SqliteTaskBlob,
    WholeJson,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportedReplayDescriptor {
    pub source: ImportedHistorySourceId,
    pub source_id: &'static str,
    pub session_prefix: &'static str,
    pub storage_family: ReplayStorageFamily,
    pub parser_version: u32,
    pub support: ReplayAdapterSupport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayAdapterSupport {
    Incremental,
    Pending,
}

impl ImportedHistorySourceId {
    pub const ALL: [Self; 15] = [
        Self::ClaudeCode,
        Self::CodexApp,
        Self::CursorIde,
        Self::CursorCli,
        Self::OpenCode,
        Self::Windsurf,
        Self::WorkBuddy,
        Self::Trae,
        Self::Cline,
        Self::Warp,
        Self::ZCode,
        Self::Qoder,
        Self::MimoCode,
        Self::Omp,
        Self::QoderCli,
    ];

    pub fn parse(value: &str) -> Result<Self, String> {
        Self::ALL
            .into_iter()
            .find(|source| source.as_str() == value)
            .ok_or_else(|| format!("Unknown imported replay source: {value}"))
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => SOURCE_CLAUDE_CODE,
            Self::CodexApp => SOURCE_CODEX_APP,
            Self::CursorIde => SOURCE_CURSOR_IDE,
            Self::CursorCli => SOURCE_CURSOR_CLI,
            Self::OpenCode => SOURCE_OPENCODE,
            Self::Windsurf => SOURCE_WINDSURF,
            Self::WorkBuddy => SOURCE_WORKBUDDY,
            Self::Trae => SOURCE_TRAE,
            Self::Cline => SOURCE_CLINE,
            Self::Warp => SOURCE_WARP,
            Self::ZCode => SOURCE_ZCODE,
            Self::Qoder => SOURCE_QODER,
            Self::MimoCode => SOURCE_MIMO_CODE,
            Self::Omp => SOURCE_OMP,
            Self::QoderCli => SOURCE_QODER_CLI,
        }
    }

    pub const fn descriptor(self) -> ImportedReplayDescriptor {
        use crate::sources;
        match self {
            Self::ClaudeCode => ImportedReplayDescriptor {
                source: self,
                source_id: SOURCE_CLAUDE_CODE,
                session_prefix: sources::claude_code::SESSION_PREFIX,
                storage_family: ReplayStorageFamily::JsonLines,
                // v2 materializes non-rangeable JSONL payloads once per
                // generation instead of decoding the source line per page.
                parser_version: 2,
                support: ReplayAdapterSupport::Incremental,
            },
            Self::CodexApp => ImportedReplayDescriptor {
                source: self,
                source_id: SOURCE_CODEX_APP,
                session_prefix: sources::codex::SESSION_PREFIX,
                storage_family: ReplayStorageFamily::JsonLines,
                // v3 additionally materializes decoded/cross-line payloads
                // once per generation, avoiding range-read reparse loops.
                parser_version: 3,
                support: ReplayAdapterSupport::Incremental,
            },
            Self::CursorIde => ImportedReplayDescriptor {
                source: self,
                source_id: SOURCE_CURSOR_IDE,
                session_prefix: sources::cursor_ide::CURSORIDE_SESSION_PREFIX,
                storage_family: ReplayStorageFamily::SqliteKeyValue,
                // v2 derives turn headers and event sequences from the same
                // canonical order after filtering stale/duplicate KV entries.
                parser_version: 2,
                support: ReplayAdapterSupport::Incremental,
            },
            Self::CursorCli => ImportedReplayDescriptor {
                source: self,
                source_id: SOURCE_CURSOR_CLI,
                session_prefix: sources::cursor_cli::SESSION_PREFIX,
                storage_family: ReplayStorageFamily::SqliteManifestBlob,
                // v2 persists decoded manifest-blob payload artifacts.
                parser_version: 2,
                support: ReplayAdapterSupport::Incremental,
            },
            Self::OpenCode => ImportedReplayDescriptor {
                source: self,
                source_id: SOURCE_OPENCODE,
                session_prefix: sources::opencode::history::OPENCODE_SESSION_PREFIX,
                storage_family: ReplayStorageFamily::SqliteWal,
                parser_version: 1,
                support: ReplayAdapterSupport::Incremental,
            },
            Self::Windsurf => ImportedReplayDescriptor {
                source: self,
                source_id: SOURCE_WINDSURF,
                session_prefix: sources::windsurf::history::WINDSURF_SESSION_PREFIX,
                storage_family: ReplayStorageFamily::SqliteKeyValue,
                // v2 shares Cursor IDE's canonical KV ordering contract.
                parser_version: 2,
                support: ReplayAdapterSupport::Incremental,
            },
            Self::WorkBuddy => ImportedReplayDescriptor {
                source: self,
                source_id: SOURCE_WORKBUDDY,
                session_prefix: sources::workbuddy::WORKBUDDY_SESSION_PREFIX,
                storage_family: ReplayStorageFamily::JsonLines,
                // v2 materializes non-rangeable JSONL payloads once.
                parser_version: 2,
                support: ReplayAdapterSupport::Incremental,
            },
            Self::Trae => ImportedReplayDescriptor {
                source: self,
                source_id: SOURCE_TRAE,
                session_prefix: sources::trae::history::TRAE_SESSION_PREFIX,
                storage_family: ReplayStorageFamily::JsonLines,
                // v2 materializes non-rangeable JSONL payloads once.
                parser_version: 2,
                support: ReplayAdapterSupport::Incremental,
            },
            Self::Cline => ImportedReplayDescriptor {
                source: self,
                source_id: SOURCE_CLINE,
                session_prefix: sources::cline::history::CLINE_SESSION_PREFIX,
                storage_family: ReplayStorageFamily::WholeJson,
                // v2 upgrades rebuildable artifact integrity keys to SHA-256.
                parser_version: 2,
                support: ReplayAdapterSupport::Incremental,
            },
            Self::Warp => ImportedReplayDescriptor {
                source: self,
                source_id: SOURCE_WARP,
                session_prefix: sources::warp::history::WARP_SESSION_PREFIX,
                storage_family: ReplayStorageFamily::SqliteTaskBlob,
                // v2 persists decoded task-BLOB payload artifacts.
                parser_version: 2,
                support: ReplayAdapterSupport::Incremental,
            },
            Self::ZCode => ImportedReplayDescriptor {
                source: self,
                source_id: SOURCE_ZCODE,
                session_prefix: sources::zcode::history::ZCODE_SESSION_PREFIX,
                storage_family: ReplayStorageFamily::SqliteWal,
                parser_version: 1,
                support: ReplayAdapterSupport::Incremental,
            },
            Self::Qoder => ImportedReplayDescriptor {
                source: self,
                source_id: SOURCE_QODER,
                session_prefix: sources::qoder::history::QODER_SESSION_PREFIX,
                storage_family: ReplayStorageFamily::JsonLines,
                // v3 also materializes transcript JSONL payloads once per
                // generation; sidecar artifacts retain their existing path.
                parser_version: 3,
                support: ReplayAdapterSupport::Incremental,
            },
            Self::MimoCode => ImportedReplayDescriptor {
                source: self,
                source_id: SOURCE_MIMO_CODE,
                session_prefix: sources::mimo_code::history::MIMO_CODE_SESSION_PREFIX,
                storage_family: ReplayStorageFamily::SqliteWal,
                parser_version: 1,
                support: ReplayAdapterSupport::Incremental,
            },
            Self::Omp => ImportedReplayDescriptor {
                source: self,
                source_id: SOURCE_OMP,
                session_prefix: sources::omp::history::OMP_SESSION_PREFIX,
                storage_family: ReplayStorageFamily::JsonLines,
                // v2 materializes non-rangeable JSONL payloads once.
                parser_version: 2,
                support: ReplayAdapterSupport::Incremental,
            },
            Self::QoderCli => ImportedReplayDescriptor {
                source: self,
                source_id: SOURCE_QODER_CLI,
                session_prefix: sources::qoder_cli::history::QODER_CLI_SESSION_PREFIX,
                storage_family: ReplayStorageFamily::JsonLines,
                // v2 materializes non-rangeable JSONL payloads once.
                parser_version: 2,
                support: ReplayAdapterSupport::Incremental,
            },
        }
    }

    /// Derive a source from its canonical imported session-id prefix.
    /// Prefixes are deliberately centralized here so a caller cannot route a
    /// Codex session through another provider's adapter.
    pub fn from_session_id(session_id: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|source| session_id.starts_with(source.descriptor().session_prefix))
    }

    pub fn validate_session_id(self, session_id: &str) -> Result<(), String> {
        let derived = Self::from_session_id(session_id)
            .ok_or_else(|| format!("Session id {session_id} has no imported-history prefix"))?;
        if derived != self {
            return Err(format!(
                "Replay source/session mismatch: source={} session={session_id} belongs to {}",
                self.as_str(),
                derived.as_str()
            ));
        }
        Ok(())
    }

    pub fn source_session_id(self, session_id: &str) -> Result<&str, String> {
        self.validate_session_id(session_id)?;
        Ok(&session_id[self.descriptor().session_prefix.len()..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_is_exhaustive_and_unique() {
        assert_eq!(
            ImportedHistorySourceId::ALL.len(),
            IMPORTED_HISTORY_SOURCES.len()
        );
        let mut ids = std::collections::BTreeSet::new();
        let mut prefixes = std::collections::BTreeSet::new();
        for source in ImportedHistorySourceId::ALL {
            let descriptor = source.descriptor();
            assert!(ids.insert(descriptor.source_id));
            assert!(prefixes.insert(descriptor.session_prefix));
            assert_eq!(ImportedHistorySourceId::parse(source.as_str()), Ok(source));
        }
        assert_eq!(
            ids,
            IMPORTED_HISTORY_SOURCES.into_iter().collect(),
            "every transcript-bearing imported source must declare an explicit replay adapter"
        );
    }

    #[test]
    fn source_and_session_prefix_must_agree() {
        let codex = ImportedHistorySourceId::CodexApp;
        assert!(codex.validate_session_id("codexapp-abc").is_ok());
        assert!(codex.validate_session_id("claudecodeapp-abc").is_err());
    }

    #[test]
    fn completed_jsonl_adapters_are_advertised_incremental() {
        let incremental = ImportedHistorySourceId::ALL
            .into_iter()
            .filter(|source| {
                source.descriptor().storage_family == ReplayStorageFamily::JsonLines
                    && source.descriptor().support == ReplayAdapterSupport::Incremental
            })
            .collect::<Vec<_>>();
        assert_eq!(
            incremental,
            vec![
                ImportedHistorySourceId::ClaudeCode,
                ImportedHistorySourceId::CodexApp,
                ImportedHistorySourceId::WorkBuddy,
                ImportedHistorySourceId::Trae,
                ImportedHistorySourceId::Qoder,
                ImportedHistorySourceId::Omp,
                ImportedHistorySourceId::QoderCli,
            ]
        );
    }

    #[test]
    fn all_fifteen_sources_have_explicit_incremental_adapters() {
        assert!(ImportedHistorySourceId::ALL
            .into_iter()
            .all(|source| source.descriptor().support == ReplayAdapterSupport::Incremental));
    }
}
