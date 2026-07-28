//! Durable manifest row access and the paged byte-range reader behind the
//! `shell_replay_read_range` Tauri command.

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use core_types::session_event::{
    ShellReplayBookmark, ShellReplayRef, ShellReplayState, ShellReplayStatus,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::active::{active_state, ShellReplayStream};
use super::{
    is_safe_relative_path, resolve_replay_root, FILE_MAGIC, FRAME_HEADER_BYTES,
    SHELL_REPLAY_FORMAT_VERSION, SHELL_REPLAY_FRAME_MAX_BYTES, SHELL_REPLAY_RANGE_MAX_BYTES,
};

const SHELL_REPLAY_RANGE_MAX_FRAMES: usize = 4_096;
const SHELL_REPLAY_RANGE_MAX_SCANNED_FRAMES: usize = 65_537;

#[derive(Debug, Clone)]
pub(super) struct ShellReplayMeta {
    pub session_id: String,
    pub call_id: String,
    pub format_version: u32,
    pub status: ShellReplayStatus,
    pub total_bytes: u64,
    pub last_sequence: u64,
    pub terminal_preview: String,
    pub error: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellReplayFrame {
    pub sequence: u64,
    pub stream: String,
    pub byte_start: u64,
    pub byte_end: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellReplayRange {
    pub frames: Vec<ShellReplayFrame>,
    pub next_offset_bytes: u64,
    pub eof: bool,
}

#[derive(Debug)]
pub(super) struct ReplayRow {
    pub(super) meta: ShellReplayMeta,
    relative_path: PathBuf,
}

pub(super) fn parse_status(value: &str) -> Result<ShellReplayStatus, String> {
    match value {
        "running" => Ok(ShellReplayStatus::Running),
        "complete" => Ok(ShellReplayStatus::Complete),
        "incomplete" => Ok(ShellReplayStatus::Incomplete),
        other => Err(format!("unknown shell replay status {other:?}")),
    }
}

pub(super) fn load_row(session_id: &str, call_id: &str) -> Result<Option<ReplayRow>, String> {
    let conn = database::db::get_connection().map_err(|err| err.to_string())?;
    conn.query_row(
        "SELECT relative_path, status, total_bytes, last_sequence,
                terminal_preview, error, completed_at, format_version
         FROM shell_replays WHERE session_id = ?1 AND call_id = ?2",
        params![session_id, call_id],
        |row| {
            let status: String = row.get(1)?;
            let parsed_status = parse_status(&status);
            let mut error: Option<String> = row.get(5)?;
            if let Err(status_error) = &parsed_status {
                error = Some(match error {
                    Some(existing) => format!("{existing}; {status_error}"),
                    None => status_error.clone(),
                });
            }
            Ok(ReplayRow {
                relative_path: PathBuf::from(row.get::<_, String>(0)?),
                meta: ShellReplayMeta {
                    session_id: session_id.to_string(),
                    call_id: call_id.to_string(),
                    status: parsed_status.unwrap_or(ShellReplayStatus::Incomplete),
                    total_bytes: row.get(2)?,
                    last_sequence: row.get(3)?,
                    terminal_preview: row.get(4)?,
                    error,
                    completed_at: row.get(6)?,
                    format_version: row.get(7)?,
                },
            })
        },
    )
    .optional()
    .map_err(|err| err.to_string())
}

pub fn load_replay_state(
    session_id: &str,
    call_id: &str,
) -> Result<Option<ShellReplayState>, String> {
    Ok(load_row(session_id, call_id)?.map(|row| ShellReplayState {
        replay_ref: ShellReplayRef {
            session_id: row.meta.session_id,
            call_id: row.meta.call_id,
            format_version: row.meta.format_version,
        },
        bookmark: ShellReplayBookmark {
            visible_through_sequence: row.meta.last_sequence,
            visible_bytes: row.meta.total_bytes,
        },
        terminal_preview: row.meta.terminal_preview,
        status: row.meta.status,
        error: row.meta.error,
        completed_at: row.meta.completed_at,
    }))
}

pub(crate) fn load_complete_replay_state_if_matches(
    replay_root: &Path,
    session_id: &str,
    call_id: &str,
    expected_bytes: u64,
) -> Result<Option<ShellReplayState>, String> {
    let Some(row) = load_row(session_id, call_id)? else {
        return Ok(None);
    };
    if row.meta.status != ShellReplayStatus::Complete
        || row.meta.total_bytes != expected_bytes
        || row.meta.format_version != SHELL_REPLAY_FORMAT_VERSION
        || !is_safe_relative_path(&row.relative_path)
        || !replay_root.join(&row.relative_path).is_file()
    {
        return Ok(None);
    }
    Ok(Some(ShellReplayState {
        replay_ref: ShellReplayRef {
            session_id: row.meta.session_id,
            call_id: row.meta.call_id,
            format_version: row.meta.format_version,
        },
        bookmark: ShellReplayBookmark {
            visible_through_sequence: row.meta.last_sequence,
            visible_bytes: row.meta.total_bytes,
        },
        terminal_preview: row.meta.terminal_preview,
        status: row.meta.status,
        error: row.meta.error,
        completed_at: row.meta.completed_at,
    }))
}

/// Bounded current tail used by `await_output` for new binary replay jobs.
/// It comes from the durable manifest rather than interpreting `.slog` frame
/// headers as text. Legacy `.txt` jobs keep their separate bounded reader.
pub fn read_replay_tail(session_id: &str, call_id: &str) -> Result<String, String> {
    if let Some(state) = active_state(session_id, call_id) {
        return Ok(state.terminal_preview);
    }
    Ok(load_row(session_id, call_id)?
        .map(|row| row.meta.terminal_preview)
        .unwrap_or_default())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
pub async fn shell_replay_read_range(
    session_id: String,
    call_id: String,
    visible_through_sequence: u64,
    visible_bytes: u64,
    offset_bytes: u64,
    limit_bytes: u64,
) -> Result<ShellReplayRange, String> {
    let replay_root = resolve_replay_root();
    tokio::task::spawn_blocking(move || {
        read_range(
            &replay_root,
            &session_id,
            &call_id,
            visible_through_sequence,
            visible_bytes,
            offset_bytes,
            limit_bytes,
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

pub(super) fn read_range(
    replay_root: &Path,
    session_id: &str,
    call_id: &str,
    visible_through_sequence: u64,
    visible_bytes: u64,
    offset_bytes: u64,
    limit_bytes: u64,
) -> Result<ShellReplayRange, String> {
    let row = load_row(session_id, call_id)?
        .ok_or_else(|| format!("shell replay not found for {session_id}/{call_id}"))?;
    if row.meta.format_version != SHELL_REPLAY_FORMAT_VERSION {
        return Err(format!(
            "unsupported shell replay format version {}",
            row.meta.format_version
        ));
    }

    let visible_sequence = visible_through_sequence.min(row.meta.last_sequence);
    let visible_end = visible_bytes.min(row.meta.total_bytes);
    let start = offset_bytes.min(visible_end);
    let limit = limit_bytes.min(SHELL_REPLAY_RANGE_MAX_BYTES as u64).max(1);
    let tail_request = start.saturating_add(limit) >= visible_end;
    if start >= visible_end || visible_sequence == 0 {
        return Ok(ShellReplayRange {
            frames: Vec::new(),
            next_offset_bytes: start,
            eof: true,
        });
    }

    if row.relative_path.is_absolute()
        || row
            .relative_path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("invalid shell replay path in manifest".to_string());
    }
    let path = replay_root.join(&row.relative_path);
    let conn = database::db::get_connection().map_err(|err| err.to_string())?;
    let (file_offset, mut output_offset): (u64, u64) = conn
        .query_row(
            "SELECT file_offset, output_byte_start FROM shell_replay_pages
             WHERE session_id = ?1 AND call_id = ?2 AND output_byte_start <= ?3
             ORDER BY output_byte_start DESC LIMIT 1",
            params![session_id, call_id, start],
            |page| Ok((page.get(0)?, page.get(1)?)),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .unwrap_or((FILE_MAGIC.len() as u64, 0));

    let file = File::open(&path).map_err(|err| format!("open {}: {err}", path.display()))?;
    let mut reader = BufReader::new(file);
    reader
        .seek(SeekFrom::Start(file_offset))
        .map_err(|err| format!("seek {}: {err}", path.display()))?;

    let mut frames = Vec::new();
    let mut next_offset = start;
    let mut response_bytes = 0u64;
    let mut rendered_response_bytes = 0usize;
    let mut previous_sequence: Option<u64> = None;
    let mut scanned_frames = 0usize;
    loop {
        if frames.len() >= SHELL_REPLAY_RANGE_MAX_FRAMES {
            break;
        }
        scanned_frames = scanned_frames.saturating_add(1);
        if scanned_frames > SHELL_REPLAY_RANGE_MAX_SCANNED_FRAMES {
            return Err("shell replay range scan exceeded the forward-progress guard".to_string());
        }
        let mut header = [0u8; FRAME_HEADER_BYTES];
        match reader.read_exact(&mut header) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(err) => return Err(format!("read shell replay frame: {err}")),
        }
        let sequence = u64::from_le_bytes(header[0..8].try_into().expect("8-byte sequence"));
        let _timestamp_millis =
            i64::from_le_bytes(header[8..16].try_into().expect("8-byte timestamp"));
        let stream = ShellReplayStream::from_byte(header[16])?;
        let length =
            u32::from_le_bytes(header[17..21].try_into().expect("4-byte frame length")) as usize;
        if length == 0 || length > SHELL_REPLAY_FRAME_MAX_BYTES {
            return Err(format!(
                "invalid shell replay frame length {length}; expected 1..={SHELL_REPLAY_FRAME_MAX_BYTES}"
            ));
        }
        if previous_sequence.is_some_and(|previous| sequence != previous.saturating_add(1)) {
            return Err(format!(
                "invalid shell replay sequence {sequence}; frames must be strictly consecutive"
            ));
        }
        previous_sequence = Some(sequence);
        let mut payload = vec![0u8; length];
        reader
            .read_exact(&mut payload)
            .map_err(|err| format!("read shell replay payload: {err}"))?;

        let frame_start = output_offset;
        let frame_end = output_offset.saturating_add(length as u64);
        output_offset = frame_end;
        if frame_end <= start {
            continue;
        }
        if sequence > visible_sequence || frame_start >= visible_end {
            break;
        }
        // Range boundaries are always complete stored frames. The frontend
        // keys/merges frames by sequence, so returning two slices with the
        // same sequence would overwrite data. It also risks splitting UTF-8.
        if frame_end > visible_end {
            break;
        }
        // A tail request must reach the bookmark. If its starting offset is
        // inside a frame, including that whole frame could consume alignment
        // bytes and stop before the actual tail. Skip only that containing
        // frame when later frames exist; all returned frames remain complete.
        if tail_request
            && frame_start < start
            && frame_end < visible_end
            && visible_end.saturating_sub(frame_start) > limit
        {
            continue;
        }
        let frame_visible_bytes = frame_end.saturating_sub(frame_start);
        if !frames.is_empty() && response_bytes.saturating_add(frame_visible_bytes) > limit {
            break;
        }
        if frame_visible_bytes > SHELL_REPLAY_RANGE_MAX_BYTES as u64 {
            return Err("shell replay frame exceeds range response budget".to_string());
        }
        let byte_start = frame_start;
        let byte_end = frame_start.saturating_add(frame_visible_bytes);
        let text = String::from_utf8_lossy(&payload[..frame_visible_bytes as usize]).into_owned();
        // Invalid UTF-8 is lossily rendered as a three-byte replacement
        // character. Cap the serialized text as well as raw output bytes so
        // a nominal 256 KiB read can never inflate into a much larger IPC
        // response. A stored frame is at most 16 KiB, so the first frame
        // always fits and preserves forward progress.
        if !frames.is_empty()
            && rendered_response_bytes.saturating_add(text.len()) > SHELL_REPLAY_RANGE_MAX_BYTES
        {
            break;
        }
        rendered_response_bytes = rendered_response_bytes.saturating_add(text.len());
        frames.push(ShellReplayFrame {
            sequence,
            stream: stream.as_wire_str().to_string(),
            byte_start,
            byte_end,
            text,
        });
        response_bytes = response_bytes.saturating_add(frame_visible_bytes);
        next_offset = byte_end;
        if next_offset >= visible_end || response_bytes >= limit {
            break;
        }
    }

    Ok(ShellReplayRange {
        frames,
        next_offset_bytes: next_offset,
        eof: next_offset >= visible_end,
    })
}
