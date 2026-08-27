use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

pub(super) const CODEX_TURN_OFFSET_CACHE_CAPACITY: usize = 8;
pub(super) const CODEX_TURN_OFFSET_LIMIT_PER_SESSION: usize = 4_096;
pub(super) const CODEX_INITIAL_TURN_LIMIT: usize = 4_096;
pub(super) const CODEX_TURN_CATALOG_PREVIEW_MAX_BYTES: usize = 512;
pub(super) const CODEX_REVERSE_SCAN_MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct CodexTranscriptSignature {
    pub(super) modified_ns: u128,
    pub(super) size_bytes: u64,
}

#[derive(Debug, Clone)]
pub(super) struct CodexTurnOffset {
    pub(super) turn_id: String,
    pub(super) byte_offset: u64,
    pub(super) sequence: usize,
}

#[derive(Debug, Clone)]
pub(super) struct CodexTurnCatalogEntry {
    pub(super) byte_offset: u64,
    pub(super) started_at: String,
    pub(super) user_preview: String,
    pub(super) last_agent_preview: Option<String>,
    pub(super) following_line_count: usize,
}

#[derive(Debug)]
pub(super) struct CodexTurnOffsetCacheEntry {
    path: PathBuf,
    signature: CodexTranscriptSignature,
    turns: HashMap<String, (u64, usize)>,
}

#[derive(Debug, Default)]
pub(super) struct CodexTurnOffsetCache {
    pub(super) entries: VecDeque<CodexTurnOffsetCacheEntry>,
}

impl CodexTurnOffsetCache {
    pub(super) fn get(
        &mut self,
        path: &Path,
        signature: CodexTranscriptSignature,
        turn_id: &str,
    ) -> Option<(u64, usize)> {
        let index = self.entries.iter().position(|entry| entry.path == path)?;
        let entry = self.entries.remove(index)?;
        if entry.signature != signature {
            return None;
        }
        let offset = entry.turns.get(turn_id).copied();
        self.entries.push_back(entry);
        offset
    }

    pub(super) fn insert(
        &mut self,
        path: PathBuf,
        signature: CodexTranscriptSignature,
        offsets: Vec<CodexTurnOffset>,
    ) {
        if let Some(index) = self.entries.iter().position(|entry| entry.path == path) {
            self.entries.remove(index);
        }
        let turns = offsets
            .into_iter()
            .rev()
            .take(CODEX_TURN_OFFSET_LIMIT_PER_SESSION)
            .map(|offset| (offset.turn_id, (offset.byte_offset, offset.sequence)))
            .collect();
        self.entries.push_back(CodexTurnOffsetCacheEntry {
            path,
            signature,
            turns,
        });
        while self.entries.len() > CODEX_TURN_OFFSET_CACHE_CAPACITY {
            self.entries.pop_front();
        }
    }
}

pub(super) fn codex_turn_offset_cache() -> &'static Mutex<CodexTurnOffsetCache> {
    static CACHE: OnceLock<Mutex<CodexTurnOffsetCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(CodexTurnOffsetCache::default()))
}

#[derive(Debug)]
struct CodexTurnCatalogCacheEntry {
    path: PathBuf,
    signature: CodexTranscriptSignature,
    entries: Vec<CodexTurnCatalogEntry>,
}

#[derive(Debug, Default)]
pub(super) struct CodexTurnCatalogCache {
    entries: VecDeque<CodexTurnCatalogCacheEntry>,
}

impl CodexTurnCatalogCache {
    pub(super) fn exact(
        &mut self,
        path: &Path,
        signature: CodexTranscriptSignature,
    ) -> Option<Vec<CodexTurnCatalogEntry>> {
        let index = self
            .entries
            .iter()
            .position(|entry| entry.path == path && entry.signature == signature)?;
        let entry = self.entries.remove(index)?;
        let catalog = entry.entries.clone();
        self.entries.push_back(entry);
        Some(catalog)
    }

    pub(super) fn latest_for_path(
        &self,
        path: &Path,
    ) -> Option<(CodexTranscriptSignature, Vec<CodexTurnCatalogEntry>)> {
        self.entries
            .iter()
            .rev()
            .find(|entry| entry.path == path)
            .map(|entry| (entry.signature, entry.entries.clone()))
    }

    pub(super) fn insert(
        &mut self,
        path: PathBuf,
        signature: CodexTranscriptSignature,
        entries: Vec<CodexTurnCatalogEntry>,
    ) {
        if let Some(index) = self.entries.iter().position(|entry| entry.path == path) {
            self.entries.remove(index);
        }
        self.entries.push_back(CodexTurnCatalogCacheEntry {
            path,
            signature,
            entries,
        });
        while self.entries.len() > CODEX_TURN_OFFSET_CACHE_CAPACITY {
            self.entries.pop_front();
        }
    }
}

pub(super) fn codex_turn_catalog_cache() -> &'static Mutex<CodexTurnCatalogCache> {
    static CACHE: OnceLock<Mutex<CodexTurnCatalogCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(CodexTurnCatalogCache::default()))
}

pub(super) fn codex_transcript_file_signature(
    path: &Path,
) -> Result<CodexTranscriptSignature, String> {
    let metadata = fs::metadata(path)
        .map_err(|err| format!("Failed to stat Codex history {}: {err}", path.display()))?;
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    Ok(CodexTranscriptSignature {
        modified_ns,
        size_bytes: metadata.len(),
    })
}

pub(super) fn bounded_codex_turn_preview(message: &str) -> String {
    if message.len() <= CODEX_TURN_CATALOG_PREVIEW_MAX_BYTES {
        return message.to_string();
    }
    let mut cut = CODEX_TURN_CATALOG_PREVIEW_MAX_BYTES;
    while !message.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &message[..cut])
}

pub(super) fn remember_codex_turn_offsets(
    path: &Path,
    signature_before: CodexTranscriptSignature,
    offsets: Vec<CodexTurnOffset>,
) -> Result<(), String> {
    let signature_after = codex_transcript_file_signature(path)?;
    if signature_before == signature_after {
        codex_turn_offset_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(path.to_path_buf(), signature_after, offsets);
    }
    Ok(())
}
