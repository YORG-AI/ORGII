//! Per-file parse watermarks for incremental transcript ingestion.
//!
//! A huge imported CLI transcript that keeps growing (a live session) changes
//! its `(mtime, size)` signature on every boot, which used to force a full
//! re-parse of the whole file each time. The watermark persists, per
//! `(source, source_session_id)`, the byte offset of the last COMPLETE line
//! already folded into the parser's accumulator, a hash of exactly those
//! bytes, and the accumulator state itself (`state_json`). A later parse
//! resumes from the offset when the prefix is verifiably intact — file at
//! least as large, mtime not regressed, same parser version, prefix hash
//! match — and falls back to a full re-parse otherwise.
//!
//! Only newline-terminated lines advance the watermark: a live writer may
//! still be appending to the final unterminated line, so its effects must
//! not be frozen into the persisted state (the parser feeds it into a
//! throwaway clone of the accumulator instead).

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedParseWatermark {
    pub byte_offset: i64,
    pub source_size_bytes: i64,
    /// Nanosecond mtime; see [`super::metadata::ImportedHistoryCacheInput::source_mtime_ms`].
    pub source_mtime_ms: i64,
    pub prefix_hash: String,
    pub parser_version: i64,
    pub state_json: String,
}

pub fn read_parse_watermark_from_conn(
    conn: &Connection,
    source: &str,
    source_session_id: &str,
) -> Result<Option<ImportedParseWatermark>, String> {
    let result = conn
        .query_row(
            "SELECT byte_offset, source_size_bytes, source_mtime_ms, prefix_hash,
                    parser_version, state_json
             FROM imported_history_parse_watermarks
             WHERE source = ?1 AND source_session_id = ?2",
            params![source, source_session_id],
            |row| {
                Ok(ImportedParseWatermark {
                    byte_offset: row.get(0)?,
                    source_size_bytes: row.get(1)?,
                    source_mtime_ms: row.get(2)?,
                    prefix_hash: row.get(3)?,
                    parser_version: row.get(4)?,
                    state_json: row.get(5)?,
                })
            },
        )
        .optional();
    match result {
        Ok(watermark) => Ok(watermark),
        Err(
            rusqlite::Error::InvalidColumnType(..)
            | rusqlite::Error::FromSqlConversionFailure(..)
            | rusqlite::Error::IntegralValueOutOfRange(..),
        ) => Ok(None),
        Err(err) => Err(format!("Failed to read imported parse watermark: {err}")),
    }
}

pub fn write_parse_watermark_from_conn(
    conn: &Connection,
    source: &str,
    source_session_id: &str,
    watermark: &ImportedParseWatermark,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO imported_history_parse_watermarks (
            source, source_session_id, byte_offset, source_size_bytes,
            source_mtime_ms, prefix_hash, parser_version, state_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            source,
            source_session_id,
            watermark.byte_offset,
            watermark.source_size_bytes,
            watermark.source_mtime_ms,
            watermark.prefix_hash,
            watermark.parser_version,
            watermark.state_json,
        ],
    )
    .map_err(|err| format!("Failed to write imported parse watermark: {err}"))?;
    Ok(())
}

pub fn clear_parse_watermark_from_conn(
    conn: &Connection,
    source: &str,
    source_session_id: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM imported_history_parse_watermarks
         WHERE source = ?1 AND source_session_id = ?2",
        params![source, source_session_id],
    )
    .map_err(|err| format!("Failed to clear imported parse watermark: {err}"))?;
    Ok(())
}

/// Streaming FNV-1a 64 over the processed prefix. Integrity check against
/// accidental prefix rewrites, not an adversarial digest — chosen because it
/// can keep hashing across the resume boundary (validate the stored prefix,
/// then continue over newly consumed lines) without re-reading the file.
#[derive(Debug, Clone)]
pub struct PrefixHasher(u64);

impl Default for PrefixHasher {
    fn default() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }
}

impl PrefixHasher {
    pub fn update(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.0 ^= u64::from(byte);
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }

    pub fn digest(&self) -> String {
        format!("{:016x}", self.0)
    }
}

#[derive(Debug)]
pub struct TranscriptLine {
    pub text: String,
    /// `false` only for a final line with no trailing newline — a live
    /// writer may still be appending to it, so it must not advance the
    /// watermark or the persisted accumulator state.
    pub terminated: bool,
}

/// Line reader over one transcript that tracks the complete-line byte offset
/// and prefix hash, seeking past an intact watermark prefix on open.
pub struct WatermarkedTranscriptReader {
    reader: BufReader<File>,
    hasher: PrefixHasher,
    complete_offset: u64,
    resume_state_json: Option<String>,
    buf: Vec<u8>,
    error_label: &'static str,
}

impl WatermarkedTranscriptReader {
    pub fn open(
        path: &Path,
        error_label: &'static str,
        watermark: Option<&ImportedParseWatermark>,
        parser_version: i64,
        current_mtime_ns: i64,
        current_size_bytes: i64,
    ) -> Result<Self, String> {
        let mut file = File::open(path).map_err(|err| {
            format!(
                "Failed to open {error_label} history {}: {err}",
                path.display()
            )
        })?;
        let file_len = file
            .metadata()
            .map_err(|err| format!("Failed to read {error_label} history metadata: {err}"))?
            .len();

        let mut hasher = PrefixHasher::default();
        let mut complete_offset = 0u64;
        let mut resume_state_json = None;
        if let Some(watermark) = watermark {
            let eligible = watermark.parser_version == parser_version
                && watermark.byte_offset >= 0
                && current_size_bytes >= watermark.source_size_bytes
                && current_mtime_ns >= watermark.source_mtime_ms
                && watermark.byte_offset as u64 <= file_len;
            if eligible
                && Self::hash_prefix(&mut file, watermark.byte_offset as u64, &mut hasher)?
                && hasher.digest() == watermark.prefix_hash
            {
                complete_offset = watermark.byte_offset as u64;
                resume_state_json = Some(watermark.state_json.clone());
            }
            if resume_state_json.is_none() {
                hasher = PrefixHasher::default();
                file.seek(SeekFrom::Start(0)).map_err(|err| {
                    format!("Failed to rewind {error_label} history: {err}")
                })?;
            }
        }

        Ok(Self {
            reader: BufReader::new(file),
            hasher,
            complete_offset,
            resume_state_json,
            buf: Vec::new(),
            error_label,
        })
    }

    fn hash_prefix(
        file: &mut File,
        prefix_len: u64,
        hasher: &mut PrefixHasher,
    ) -> Result<bool, String> {
        let mut remaining = prefix_len;
        let mut chunk = vec![0u8; 256 * 1024];
        while remaining > 0 {
            let take = remaining.min(chunk.len() as u64) as usize;
            let read = file
                .read(&mut chunk[..take])
                .map_err(|err| format!("Failed to read history prefix: {err}"))?;
            if read == 0 {
                return Ok(false);
            }
            hasher.update(&chunk[..read]);
            remaining -= read as u64;
        }
        Ok(true)
    }

    pub fn resume_state_json(&self) -> Option<&str> {
        self.resume_state_json.as_deref()
    }

    pub fn next_line(&mut self) -> Result<Option<TranscriptLine>, String> {
        self.buf.clear();
        let read = self
            .reader
            .read_until(b'\n', &mut self.buf)
            .map_err(|err| {
                format!(
                    "Failed to read {} history line: {err}",
                    self.error_label
                )
            })?;
        if read == 0 {
            return Ok(None);
        }
        let terminated = self.buf.last() == Some(&b'\n');
        if terminated {
            self.hasher.update(&self.buf);
            self.complete_offset += read as u64;
        }
        let mut end = self.buf.len();
        if terminated {
            end -= 1;
            if end > 0 && self.buf[end - 1] == b'\r' {
                end -= 1;
            }
        }
        let text = std::str::from_utf8(&self.buf[..end])
            .map_err(|err| {
                format!(
                    "Failed to read {} history line: {err}",
                    self.error_label
                )
            })?
            .to_string();
        Ok(Some(TranscriptLine { text, terminated }))
    }

    pub fn into_watermark(
        self,
        parser_version: i64,
        current_mtime_ns: i64,
        current_size_bytes: i64,
        state_json: String,
    ) -> ImportedParseWatermark {
        ImportedParseWatermark {
            byte_offset: self.complete_offset as i64,
            source_size_bytes: current_size_bytes,
            source_mtime_ms: current_mtime_ns,
            prefix_hash: self.hasher.digest(),
            parser_version,
            state_json,
        }
    }
}

#[cfg(test)]
#[path = "watermark_tests.rs"]
mod tests;
