//! Storage-neutral replay driver primitives.
//!
//! This module contains only mechanics whose semantics are identical across
//! storage families: bounded newline reads, UTF-8 range accounting, content
//! digests, compatibility ID hashes, and compact turn folding.

use std::io::{self, BufRead};

use rusqlite::{params, Transaction};
use sha2::{Digest, Sha256};

use crate::sources::imported_history::replay::ReplayPayloadRange;
use crate::sources::imported_history::{self, replay::ImportedHistorySourceId};

pub(super) const MAX_JSONL_RECORD_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum BoundedLine {
    Eof,
    Complete(Vec<u8>),
    Incomplete,
    TooLarge,
}

/// Reads one newline-terminated record without ever growing the backing
/// allocation beyond `max_bytes`.
pub(super) fn read_bounded_line(
    reader: &mut impl BufRead,
    max_bytes: usize,
) -> io::Result<BoundedLine> {
    let mut bytes = Vec::with_capacity(max_bytes.min(64 * 1024));
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(if bytes.is_empty() {
                BoundedLine::Eof
            } else {
                BoundedLine::Incomplete
            });
        }
        let take = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        let Some(next_len) = bytes.len().checked_add(take) else {
            return Ok(BoundedLine::TooLarge);
        };
        if next_len > max_bytes {
            return Ok(BoundedLine::TooLarge);
        }
        bytes
            .try_reserve_exact(take)
            .map_err(|error| io::Error::other(format!("reserve replay line: {error}")))?;
        bytes.extend_from_slice(&available[..take]);
        let complete = available[take - 1] == b'\n';
        reader.consume(take);
        if complete {
            return Ok(BoundedLine::Complete(bytes));
        }
    }
}

pub(super) fn trim_jsonl_line(mut bytes: &[u8]) -> &[u8] {
    while bytes
        .last()
        .is_some_and(|byte| matches!(byte, b'\n' | b'\r'))
    {
        bytes = &bytes[..bytes.len() - 1];
    }
    bytes
}

pub(super) fn utf8_boundary_at_or_before(text: &str, mut offset: usize) -> usize {
    offset = offset.min(text.len());
    while offset > 0 && !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

pub(super) fn utf8_boundary_at_or_after(text: &str, mut offset: usize) -> usize {
    offset = offset.min(text.len());
    while offset < text.len() && !text.is_char_boundary(offset) {
        offset += 1;
    }
    offset
}

/// Accumulates a byte range over one or more decoded UTF-8 payload parts.
///
/// `part_start` is the byte offset of each part in the decoded logical
/// payload. Reporting the adjusted first boundary (rather than the requested
/// mid-scalar offset) keeps the next page aligned.
pub(super) struct Utf8RangeBuilder {
    requested_start: u64,
    requested_end: u64,
    max_bytes: usize,
    actual_start: Option<u64>,
    next_offset: Option<u64>,
    text: String,
}

impl Utf8RangeBuilder {
    pub(super) fn new(offset: u64, total_bytes: u64, max_bytes: usize) -> Self {
        let requested_start = offset.min(total_bytes);
        let requested_end = requested_start
            .saturating_add(max_bytes as u64)
            .min(total_bytes);
        Self {
            requested_start,
            requested_end,
            max_bytes,
            actual_start: None,
            next_offset: None,
            text: String::with_capacity(max_bytes.min(256 * 1024).saturating_add(4)),
        }
    }

    pub(super) fn push_part(&mut self, part_start: u64, part: &str) {
        let part_end = part_start.saturating_add(part.len() as u64);
        if part_end <= self.requested_start || part_start >= self.requested_end {
            return;
        }
        let overlap_start = self.requested_start.max(part_start);
        let overlap_end = self.requested_end.min(part_end);
        let start =
            utf8_boundary_at_or_after(part, overlap_start.saturating_sub(part_start) as usize);
        let mut end =
            utf8_boundary_at_or_before(part, overlap_end.saturating_sub(part_start) as usize);
        if end <= start {
            end = start;
        }
        if end == start && start < part.len() && self.max_bytes > 0 && self.text.is_empty() {
            end = part[start..]
                .char_indices()
                .nth(1)
                .map_or(part.len(), |(next, _)| start + next);
        }
        let actual_start = part_start.saturating_add(start as u64);
        self.actual_start.get_or_insert(actual_start);
        if start < end {
            self.text.push_str(&part[start..end]);
            self.next_offset = Some(part_start.saturating_add(end as u64));
        } else {
            self.next_offset.get_or_insert(actual_start);
        }
    }

    pub(super) fn finish(
        self,
        event_id: &str,
        field_path: &str,
        total_bytes: u64,
    ) -> ReplayPayloadRange {
        let offset = self.actual_start.unwrap_or(self.requested_start);
        let next_offset = self.next_offset.unwrap_or(offset);
        ReplayPayloadRange {
            event_id: event_id.to_string(),
            field_path: field_path.to_string(),
            offset,
            next_offset,
            eof: next_offset >= total_bytes,
            total_bytes,
            text: self.text,
        }
    }
}

pub(super) fn range_from_text(
    event_id: &str,
    field_path: &str,
    text: &str,
    offset: u64,
    max_bytes: usize,
) -> Result<ReplayPayloadRange, String> {
    let mut range = Utf8RangeBuilder::new(offset, text.len() as u64, max_bytes);
    range.push_part(0, text);
    Ok(range.finish(event_id, field_path, text.len() as u64))
}

#[derive(Clone, Default)]
pub(in crate::sources::imported_history::replay) struct ContentDigest(Sha256);

impl ContentDigest {
    fn update(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }

    pub(in crate::sources::imported_history::replay) fn update_part(&mut self, bytes: &[u8]) {
        self.update(&(bytes.len() as u64).to_le_bytes());
        self.update(bytes);
    }

    pub(in crate::sources::imported_history::replay) fn finish_hex(&self) -> String {
        self.0
            .clone()
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

pub(super) fn content_digest(parts: &[&[u8]]) -> String {
    let mut digest = ContentDigest::default();
    for part in parts {
        digest.update_part(part);
    }
    digest.finish_hex()
}

/// Compatibility hash for IDs that are already persisted or exposed on the
/// replay wire. New correctness/change-detection hashes must use SHA-256.
pub(super) fn legacy_stable_id_hash_concat(parts: &[&[u8]]) -> String {
    legacy_fnv1a(parts, false)
}

/// Compatibility variant used by structured and whole-JSON event IDs.
pub(super) fn legacy_stable_id_hash_delimited(parts: &[&[u8]]) -> String {
    legacy_fnv1a(parts, true)
}

fn legacy_fnv1a(parts: &[&[u8]], delimited: bool) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for part in parts {
        for byte in *part {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        if delimited {
            hash ^= 0xff;
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!("{hash:016x}")
}

#[derive(Debug)]
struct PendingTurn {
    turn_id: String,
    start_sequence: i64,
    end_sequence: i64,
    started_at: String,
    ended_at: String,
    event_count: u64,
}

pub(super) fn rebuild_turns(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
) -> Result<(), String> {
    tx.execute(
        "DELETE FROM imported_replay_turns
         WHERE source=?1 AND source_session_id=?2 AND generation=?3",
        params![source.as_str(), source_session_id, generation],
    )
    .map_err(|error| format!("clear {} replay turn headers: {error}", source.as_str()))?;
    let mut statement = tx
        .prepare(
            "SELECT sequence,event_id,function_name,created_at
             FROM imported_replay_events
             WHERE source=?1 AND source_session_id=?2 AND generation=?3
             ORDER BY sequence",
        )
        .map_err(|error| format!("prepare {} replay turn fold: {error}", source.as_str()))?;
    let mut rows = statement
        .query(params![source.as_str(), source_session_id, generation])
        .map_err(|error| format!("query {} replay turn fold: {error}", source.as_str()))?;
    let mut turn_index = -1_i64;
    let mut current = None;
    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
        let sequence = row.get::<_, i64>(0).map_err(|error| error.to_string())?;
        let event_id = row.get::<_, String>(1).map_err(|error| error.to_string())?;
        let function = row.get::<_, String>(2).map_err(|error| error.to_string())?;
        let created_at = row.get::<_, String>(3).map_err(|error| error.to_string())?;
        if function == imported_history::FUNCTION_USER_MESSAGE || current.is_none() {
            if let Some(turn) = current.take() {
                insert_turn_header(tx, source, source_session_id, generation, turn_index, turn)?;
            }
            turn_index = turn_index
                .checked_add(1)
                .ok_or_else(|| "Replay turn index overflow".to_string())?;
            current = Some(PendingTurn {
                turn_id: event_id,
                start_sequence: sequence,
                end_sequence: sequence,
                started_at: created_at.clone(),
                ended_at: created_at,
                event_count: 1,
            });
        } else if let Some(turn) = current.as_mut() {
            turn.end_sequence = sequence;
            turn.ended_at = created_at;
            turn.event_count = turn
                .event_count
                .checked_add(1)
                .ok_or_else(|| "Replay turn event count overflow".to_string())?;
        }
        tx.execute(
            "UPDATE imported_replay_events SET turn_index=?1
             WHERE source=?2 AND source_session_id=?3 AND generation=?4 AND sequence=?5",
            params![
                turn_index,
                source.as_str(),
                source_session_id,
                generation,
                sequence
            ],
        )
        .map_err(|error| format!("assign {} replay turn: {error}", source.as_str()))?;
    }
    drop(rows);
    drop(statement);
    if let Some(turn) = current {
        insert_turn_header(tx, source, source_session_id, generation, turn_index, turn)?;
    }
    Ok(())
}

fn insert_turn_header(
    tx: &Transaction<'_>,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    generation: &str,
    turn_index: i64,
    turn: PendingTurn,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO imported_replay_turns(
             source,source_session_id,generation,turn_index,turn_id,
             start_sequence,end_sequence,started_at,ended_at,event_count
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![
            source.as_str(),
            source_session_id,
            generation,
            turn_index,
            turn.turn_id,
            turn.start_sequence,
            turn.end_sequence,
            turn.started_at,
            turn.ended_at,
            turn.event_count as i64
        ],
    )
    .map(|_| ())
    .map_err(|error| format!("insert {} replay turn: {error}", source.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn bounded_line_refuses_oversize_before_growing_past_the_cap() {
        let mut input = Cursor::new(b"123456789\n".as_slice());
        assert_eq!(
            read_bounded_line(&mut input, 8).expect("bounded line"),
            BoundedLine::TooLarge
        );
    }

    #[test]
    fn utf8_range_reports_the_actual_boundary_and_makes_progress() {
        let range = range_from_text("event", "result.output", "a你b", 2, 1).expect("UTF-8 range");
        assert_eq!(range.offset, 4);
        assert_eq!(range.next_offset, 5);
        assert_eq!(range.text, "b");
    }

    #[test]
    fn content_digest_is_sha256_and_length_delimits_parts() {
        let first = content_digest(&[b"ab", b"c"]);
        let second = content_digest(&[b"a", b"bc"]);
        assert_eq!(first.len(), 64);
        assert_ne!(first, second);
    }
}
