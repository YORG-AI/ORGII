//! Durable, bounded-memory shell transcript storage.
//!
//! `run_shell` writes every stdout/stderr byte once to an append-only artifact.
//! Live UI state contains only a 32 KiB tail plus an immutable byte/sequence
//! watermark; range reads are capped so neither Tauri IPC nor React has to
//! materialize the complete transcript.

use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, RwLock};
use std::time::{Duration, Instant};

use chrono::Utc;
use core_types::session_event::{
    ShellReplayBookmark, ShellReplayRef, ShellReplayState, ShellReplayStatus,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::bus::event_pipeline_bridge;

pub const SHELL_REPLAY_FORMAT_VERSION: u32 = 1;
pub const SHELL_REPLAY_PREVIEW_BYTES: usize = 32 * 1024;
pub const SHELL_REPLAY_RANGE_MAX_BYTES: usize = 256 * 1024;
pub const SHELL_REPLAY_PAGE_BYTES: u64 = 64 * 1024;
pub const SHELL_REPLAY_FRAME_MAX_BYTES: usize = 16 * 1024;
pub const SHELL_REPLAY_SUMMARY_HEAD_BYTES: usize = 15 * 1024;
pub const SHELL_REPLAY_SUMMARY_TAIL_BYTES: usize = 15 * 1024;
pub const SHELL_REPLAY_SUMMARY_MAX_BYTES: usize = 30 * 1024;

const FILE_MAGIC: &[u8] = b"ORGII-SHELL-REPLAY\x01";
const FRAME_HEADER_BYTES: usize = 8 + 8 + 1 + 4;
const ANSI_SEQUENCE_CARRY_MAX_BYTES: usize = 64;
const SHELL_REPLAY_RANGE_MAX_FRAMES: usize = 4_096;
const SHELL_REPLAY_RANGE_MAX_SCANNED_FRAMES: usize = 65_537;
const STATE_FLUSH_INTERVAL: Duration = Duration::from_millis(50);
const EXACT_EVENT_RETRY_DELAYS_MS: &[u64] = &[0, 5, 10, 20, 40, 80, 160];

/// Largest prefix that can be decoded independently as UTF-8. A short
/// incomplete suffix is retained by the pipe/PTY pump for its next read;
/// genuinely invalid bytes stay in the artifact and are rendered lossily.
pub(super) fn complete_utf8_prefix_len(bytes: &[u8]) -> usize {
    match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(err) if err.error_len().is_none() => err.valid_up_to(),
        Err(_) => bytes.len(),
    }
}

/// Largest prefix that is independently renderable by a terminal. Besides a
/// split UTF-8 codepoint, retain a short trailing ANSI CSI sequence (for
/// example `ESC[31` without its final `m`) for the next frame. This keeps a
/// range that starts at a frame boundary from exposing a naked `[31m` fragment.
/// The carry is deliberately capped so malformed, unterminated control data
/// cannot grow writer memory without bound.
pub(super) fn complete_terminal_prefix_len(bytes: &[u8]) -> usize {
    let utf8_end = complete_utf8_prefix_len(bytes);
    let prefix = &bytes[..utf8_end];
    let scan_start = prefix.len().saturating_sub(ANSI_SEQUENCE_CARRY_MAX_BYTES);
    let Some(relative_escape) = prefix[scan_start..].iter().rposition(|byte| *byte == 0x1b) else {
        return utf8_end;
    };
    let escape = scan_start + relative_escape;
    let suffix = &prefix[escape..];
    if suffix.len() == 1 {
        return escape;
    }
    if suffix[1] == b'[' && !suffix[2..].iter().any(|byte| matches!(*byte, 0x40..=0x7e)) {
        return escape;
    }
    utf8_end
}

fn decode_utf8_prefix(bytes: &[u8]) -> (String, usize) {
    for trim in 0..=3.min(bytes.len()) {
        let end = bytes.len() - trim;
        if let Ok(text) = std::str::from_utf8(&bytes[..end]) {
            return (text.to_string(), end);
        }
    }
    (String::from_utf8_lossy(bytes).into_owned(), bytes.len())
}

fn decode_utf8_tail(bytes: &[u8]) -> (String, usize) {
    for skip in 0..=3.min(bytes.len()) {
        if let Ok(text) = std::str::from_utf8(&bytes[skip..]) {
            return (text.to_string(), bytes.len() - skip);
        }
    }
    (String::from_utf8_lossy(bytes).into_owned(), bytes.len())
}

fn truncate_string_prefix(mut value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    value
}

fn truncate_string_tail(value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut start = value.len() - max_bytes;
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    value[start..].to_string()
}

fn decode_utf8_tail_bounded(bytes: &[u8], max_bytes: usize) -> String {
    truncate_string_tail(decode_utf8_tail(bytes).0, max_bytes)
}

#[derive(Debug)]
struct ActiveReplayState {
    replay_ref: ShellReplayRef,
    bookmark: ShellReplayBookmark,
    terminal_preview: VecDeque<u8>,
}

impl ActiveReplayState {
    fn snapshot(&self) -> ShellReplayState {
        let preview: Vec<u8> = self.terminal_preview.iter().copied().collect();
        ShellReplayState {
            replay_ref: self.replay_ref.clone(),
            bookmark: self.bookmark,
            terminal_preview: decode_utf8_tail_bounded(&preview, SHELL_REPLAY_PREVIEW_BYTES),
            status: ShellReplayStatus::Running,
            error: None,
            completed_at: None,
        }
    }
}

static ACTIVE_REPLAYS: LazyLock<RwLock<HashMap<String, HashMap<String, ActiveReplayState>>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

#[derive(Debug, Clone)]
pub struct ShellReplayTarget {
    pub session_id: String,
    pub call_id: String,
}

impl ShellReplayTarget {
    pub fn new(session_id: impl Into<String>, call_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            call_id: call_id.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellReplayStream {
    Stdout,
    Stderr,
}

impl ShellReplayStream {
    fn as_byte(self) -> u8 {
        match self {
            Self::Stdout => 1,
            Self::Stderr => 2,
        }
    }

    fn from_byte(value: u8) -> Result<Self, String> {
        match value {
            1 => Ok(Self::Stdout),
            2 => Ok(Self::Stderr),
            _ => Err(format!("unknown shell replay stream tag {value}")),
        }
    }

    pub fn as_wire_str(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
    }
}

#[derive(Debug)]
pub struct ShellReplayAppend {
    pub sequence: u64,
    pub persisted_bytes: u64,
}

#[derive(Debug, Default)]
struct BoundedTerminalText {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    total_bytes: u64,
}

impl BoundedTerminalText {
    fn append(&mut self, stream: ShellReplayStream, bytes: &[u8]) {
        let stderr_prefix = if stream == ShellReplayStream::Stderr {
            b"[stderr] ".as_slice()
        } else {
            &[]
        };
        self.append_bytes(stderr_prefix);
        self.append_bytes(bytes);
    }

    fn append_bytes(&mut self, bytes: &[u8]) {
        self.total_bytes = self.total_bytes.saturating_add(bytes.len() as u64);
        let head_remaining = SHELL_REPLAY_SUMMARY_HEAD_BYTES.saturating_sub(self.head.len());
        self.head
            .extend_from_slice(&bytes[..bytes.len().min(head_remaining)]);
        for byte in bytes {
            if self.tail.len() >= SHELL_REPLAY_SUMMARY_TAIL_BYTES {
                self.tail.pop_front();
            }
            self.tail.push_back(*byte);
        }
    }

    fn render(&self) -> String {
        let tail: Vec<u8> = self.tail.iter().copied().collect();
        let retained = self.head.len().saturating_add(self.tail.len());
        if self.total_bytes as usize <= retained || self.tail.is_empty() {
            // Until truncation starts, `head` and `tail` overlap. Stitch only
            // the non-overlapping tail suffix so medium-sized output is
            // returned exactly instead of being cut at the head budget.
            let overlap = retained.saturating_sub(self.total_bytes as usize);
            let mut exact = self.head.clone();
            exact.extend_from_slice(&tail[overlap.min(tail.len())..]);
            return truncate_string_tail(
                String::from_utf8_lossy(&exact).into_owned(),
                SHELL_REPLAY_SUMMARY_MAX_BYTES,
            );
        }
        let (head_text, head_bytes) = decode_utf8_prefix(&self.head);
        let (tail_text, tail_bytes) = decode_utf8_tail(&tail);
        let omitted = self
            .total_bytes
            .saturating_sub(head_bytes as u64)
            .saturating_sub(tail_bytes as u64);
        let marker = format!(
            "\n\n[... {omitted} bytes omitted; complete output is available in Session Replay ...]\n\n"
        );
        let text_budget = SHELL_REPLAY_SUMMARY_MAX_BYTES.saturating_sub(marker.len());
        let head_budget = text_budget / 2;
        let tail_budget = text_budget.saturating_sub(head_budget);
        format!(
            "{}{}{}",
            truncate_string_prefix(head_text, head_budget),
            marker,
            truncate_string_tail(tail_text, tail_budget)
        )
    }
}

/// Single-writer owner for one shell artifact.
pub struct ShellReplayWriter {
    target: ShellReplayTarget,
    path: PathBuf,
    file: BufWriter<File>,
    file_offset: u64,
    total_bytes: u64,
    last_sequence: u64,
    page: ReplayPageState,
    preview: VecDeque<u8>,
    summary: BoundedTerminalText,
    last_state_flush: Instant,
    bytes_at_last_state_flush: u64,
    app_handle: Option<AppHandle>,
    attached_live: bool,
}

#[derive(Debug, Clone)]
struct ReplayPageState {
    page_index: u64,
    file_offset: u64,
    output_byte_start: u64,
    first_sequence: u64,
    last_sequence: u64,
    line_count: u64,
    dirty: bool,
}

impl ReplayPageState {
    fn initial() -> Self {
        Self {
            page_index: 0,
            file_offset: FILE_MAGIC.len() as u64,
            output_byte_start: 0,
            first_sequence: 1,
            last_sequence: 0,
            line_count: 0,
            dirty: false,
        }
    }
}

impl ShellReplayWriter {
    /// Preflight the durable artifact and manifest before the subprocess is
    /// spawned. A failure here must fail the tool call rather than run an
    /// unrecorded command.
    pub fn create(
        replay_root: &Path,
        target: ShellReplayTarget,
        command: &str,
        cwd: &Path,
        app_handle: Option<AppHandle>,
    ) -> Result<Self, String> {
        Self::create_internal(replay_root, target, command, cwd, app_handle, true)
    }

    /// Create a durable replay for historical import without advertising it
    /// as a currently-running shell or mutating live EventStore state.
    pub fn create_detached(
        replay_root: &Path,
        target: ShellReplayTarget,
        command: &str,
        cwd: &Path,
    ) -> Result<Self, String> {
        Self::create_internal(replay_root, target, command, cwd, None, false)
    }

    fn create_internal(
        replay_root: &Path,
        target: ShellReplayTarget,
        command: &str,
        cwd: &Path,
        app_handle: Option<AppHandle>,
        attached_live: bool,
    ) -> Result<Self, String> {
        // Production initializes the canonical schema once through the app's
        // database dispatcher. `agent_core` unit tests do not boot that app
        // layer, so they explicitly initialize the same leaf-owned schema.
        #[cfg(test)]
        {
            let conn = database::db::get_connection()
                .map_err(|err| format!("open shell replay test database: {err}"))?;
            database::init_shell_replay_tables(&conn)
                .map_err(|err| format!("initialize shell replay test schema: {err}"))?;
        }

        let session_component = safe_component(&target.session_id);
        let call_component = safe_component(&target.call_id);
        let relative_path = PathBuf::from(session_component).join(format!("{call_component}.slog"));
        let path = replay_root.join(&relative_path);
        let parent = path
            .parent()
            .ok_or_else(|| "shell replay path has no parent".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|err| format!("create shell replay directory {}: {err}", parent.display()))?;

        let file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .read(true)
            .open(&path)
            .map_err(|err| format!("create shell replay {}: {err}", path.display()))?;
        let mut file = BufWriter::new(file);
        file.write_all(FILE_MAGIC)
            .and_then(|_| file.flush())
            .and_then(|_| file.get_ref().sync_all())
            .map_err(|err| format!("initialize shell replay {}: {err}", path.display()))?;

        let now = Utc::now().to_rfc3339();
        let relative_path_str = relative_path.to_string_lossy().to_string();
        let insert_result = database::db::with_sessions_writer(|| -> rusqlite::Result<()> {
            let conn = database::db::get_connection()?;
            let tx = database::db::begin_immediate(&conn)?;
            tx.execute(
                "INSERT INTO shell_replays (
                    session_id, call_id, relative_path, status, total_bytes,
                    last_sequence, terminal_preview, error, completed_at,
                    format_version, command, cwd, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, 'running', 0, 0, '', NULL, NULL, ?4, ?5, ?6, ?7, ?7)
                 ON CONFLICT(session_id, call_id) DO UPDATE SET
                    relative_path = excluded.relative_path,
                    status = 'running', total_bytes = 0, last_sequence = 0,
                    terminal_preview = '', error = NULL, completed_at = NULL,
                    format_version = excluded.format_version,
                    command = excluded.command, cwd = excluded.cwd,
                    created_at = excluded.created_at, updated_at = excluded.updated_at",
                params![
                    target.session_id,
                    target.call_id,
                    relative_path_str,
                    SHELL_REPLAY_FORMAT_VERSION,
                    command,
                    cwd.to_string_lossy(),
                    now,
                ],
            )?;
            tx.execute(
                "DELETE FROM shell_replay_pages WHERE session_id = ?1 AND call_id = ?2",
                params![target.session_id, target.call_id],
            )?;
            tx.execute(
                "INSERT INTO shell_replay_pages (
                    session_id, call_id, page_index, file_offset,
                    output_byte_start, first_sequence
                 ) VALUES (?1, ?2, 0, ?3, 0, 1)",
                params![target.session_id, target.call_id, FILE_MAGIC.len() as u64],
            )?;
            tx.commit()
        });
        if let Err(err) = insert_result {
            let _ = fs::remove_file(&path);
            return Err(format!("create shell replay manifest: {err}"));
        }

        let writer = Self {
            target,
            path,
            file,
            file_offset: FILE_MAGIC.len() as u64,
            total_bytes: 0,
            last_sequence: 0,
            page: ReplayPageState::initial(),
            preview: VecDeque::with_capacity(SHELL_REPLAY_PREVIEW_BYTES),
            summary: BoundedTerminalText::default(),
            last_state_flush: Instant::now(),
            bytes_at_last_state_flush: 0,
            app_handle,
            attached_live,
        };
        if attached_live {
            insert_active(&writer.target);
            if let Err(err) =
                writer.publish_state(writer.state(ShellReplayStatus::Running, None, None), true)
            {
                remove_active(&writer.target);
                let _ = fs::remove_file(&writer.path);
                let _ = delete_exact_manifest(&writer.target);
                return Err(format!("seed shell replay EventStore state: {err}"));
            }
        }
        Ok(writer)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub(super) fn target(&self) -> ShellReplayTarget {
        self.target.clone()
    }

    pub(super) fn app_handle(&self) -> Option<AppHandle> {
        self.app_handle.clone()
    }

    #[cfg(test)]
    pub(super) fn inject_read_only_artifact_for_test(&mut self) {
        let read_only = OpenOptions::new().read(true).open(&self.path).unwrap();
        self.file = BufWriter::new(read_only);
    }

    pub fn append(
        &mut self,
        stream: ShellReplayStream,
        bytes: &[u8],
    ) -> Result<ShellReplayAppend, String> {
        if bytes.is_empty() {
            return Ok(ShellReplayAppend {
                sequence: self.last_sequence,
                persisted_bytes: self.total_bytes,
            });
        }
        if bytes.len() > SHELL_REPLAY_FRAME_MAX_BYTES {
            return Err(format!(
                "shell replay chunk exceeds the {} byte frame limit: {} bytes",
                SHELL_REPLAY_FRAME_MAX_BYTES,
                bytes.len()
            ));
        }

        self.last_sequence = self.last_sequence.saturating_add(1);
        let sequence = self.last_sequence;
        let frame_file_offset = self.file_offset;
        let frame_byte_start = self.total_bytes;
        let timestamp_millis = Utc::now().timestamp_millis();
        let length = u32::try_from(bytes.len())
            .map_err(|_| format!("shell replay chunk is too large: {} bytes", bytes.len()))?;

        self.file
            .write_all(&sequence.to_le_bytes())
            .and_then(|_| self.file.write_all(&timestamp_millis.to_le_bytes()))
            .and_then(|_| self.file.write_all(&[stream.as_byte()]))
            .and_then(|_| self.file.write_all(&length.to_le_bytes()))
            .and_then(|_| self.file.write_all(bytes))
            .map_err(|err| format!("append shell replay {}: {err}", self.path.display()))?;
        self.file_offset = self
            .file_offset
            .saturating_add(FRAME_HEADER_BYTES as u64)
            .saturating_add(bytes.len() as u64);
        self.total_bytes = self.total_bytes.saturating_add(bytes.len() as u64);

        let page_index = frame_byte_start / SHELL_REPLAY_PAGE_BYTES;
        if page_index != self.page.page_index {
            self.persist_page_index()?;
            self.page = ReplayPageState {
                page_index,
                file_offset: frame_file_offset,
                output_byte_start: frame_byte_start,
                first_sequence: sequence,
                last_sequence: sequence,
                line_count: 0,
                dirty: true,
            };
        }
        self.page.last_sequence = sequence;
        self.page.line_count = self.page.line_count.saturating_add(byte_line_count(bytes));
        self.page.dirty = true;

        append_tail(&mut self.preview, stream, bytes, SHELL_REPLAY_PREVIEW_BYTES);
        self.summary.append(stream, bytes);
        update_active_after_append(
            &self.target,
            stream,
            bytes,
            self.last_sequence,
            self.total_bytes,
        );
        self.maybe_flush_state(false)?;

        Ok(ShellReplayAppend {
            sequence,
            persisted_bytes: self.total_bytes,
        })
    }

    pub fn flush_running_state(&mut self) -> Result<(), String> {
        self.maybe_flush_state(true)
    }

    pub fn flush_due_state(&mut self) -> Result<(), String> {
        self.maybe_flush_state(false)
    }

    pub fn summary(&self) -> String {
        self.summary.render()
    }

    #[cfg(test)]
    fn retained_capacity_bytes(&self) -> usize {
        self.file.capacity()
            + self.preview.capacity()
            + self.summary.head.capacity()
            + self.summary.tail.capacity()
    }

    pub fn finalize(
        self,
        status: ShellReplayStatus,
        error: Option<String>,
    ) -> Result<String, String> {
        self.finalize_at(status, error, Utc::now().to_rfc3339())
    }

    pub fn finalize_at(
        mut self,
        status: ShellReplayStatus,
        error: Option<String>,
        completed_at: String,
    ) -> Result<String, String> {
        let mut terminal_status = status;
        let mut terminal_error = error;
        if let Err(err) = self
            .file
            .flush()
            .and_then(|_| self.file.get_ref().sync_all())
        {
            terminal_status = ShellReplayStatus::Incomplete;
            terminal_error = Some(format!(
                "finalize shell replay {}: {err}",
                self.path.display()
            ));
        }
        if let Err(err) = self.persist_page_index() {
            terminal_status = ShellReplayStatus::Incomplete;
            terminal_error = Some(err);
        }

        let state = self.state(
            terminal_status,
            terminal_error.clone(),
            Some(completed_at.clone()),
        );
        if let Err(err) = persist_state(&state, &completed_at) {
            let message = format!("persist final shell replay manifest: {err}");
            let _ = self.publish_state(
                self.state(
                    ShellReplayStatus::Incomplete,
                    Some(message.clone()),
                    Some(completed_at),
                ),
                false,
            );
            if self.attached_live {
                remove_active(&self.target);
            }
            return Err(message);
        }
        if let Err(err) = self.publish_state(state, false) {
            let message = format!("persist final shell replay EventStore state: {err}");
            let incomplete = self.state(
                ShellReplayStatus::Incomplete,
                Some(message.clone()),
                Some(completed_at.clone()),
            );
            let _ = persist_state(&incomplete, &completed_at);
            // The adapter may have updated the in-memory row before its
            // synchronous SQLite save failed. Correct that tentative complete
            // state explicitly; EventStore treats incomplete as strongest.
            let _ = self.publish_state(incomplete, false);
            if self.attached_live {
                remove_active(&self.target);
            }
            return Err(message);
        }
        if self.attached_live {
            remove_active(&self.target);
        }
        if terminal_status == ShellReplayStatus::Incomplete {
            return Err(terminal_error.unwrap_or_else(|| "shell replay is incomplete".to_string()));
        }
        Ok(self.summary.render())
    }

    pub fn mark_incomplete(&mut self, error: String) {
        let completed_at = Utc::now().to_rfc3339();
        let mut error = error;
        if let Err(sync_error) = self
            .file
            .flush()
            .and_then(|_| self.file.get_ref().sync_all())
        {
            error.push_str(&format!("; sync incomplete replay failed: {sync_error}"));
        }
        if let Err(index_error) = self.persist_page_index() {
            error.push_str(&format!("; {index_error}"));
        }
        let state = self.state(
            ShellReplayStatus::Incomplete,
            Some(error),
            Some(completed_at.clone()),
        );
        let _ = persist_state(&state, &completed_at);
        let _ = self.publish_state(state, false);
        if self.attached_live {
            remove_active(&self.target);
        }
    }

    fn maybe_flush_state(&mut self, force: bool) -> Result<(), String> {
        let bytes_since_flush = self
            .total_bytes
            .saturating_sub(self.bytes_at_last_state_flush);
        if !force && bytes_since_flush == 0 {
            return Ok(());
        }
        if !force
            && bytes_since_flush < SHELL_REPLAY_PAGE_BYTES
            && self.last_state_flush.elapsed() < STATE_FLUSH_INTERVAL
        {
            return Ok(());
        }
        self.file
            .flush()
            .map_err(|err| format!("flush shell replay {}: {err}", self.path.display()))?;
        self.persist_page_index()?;
        let now = Utc::now().to_rfc3339();
        let state = self.state(ShellReplayStatus::Running, None, None);
        persist_state(&state, &now).map_err(|err| format!("persist shell replay state: {err}"))?;
        self.publish_state(state, false)?;
        self.last_state_flush = Instant::now();
        self.bytes_at_last_state_flush = self.total_bytes;
        Ok(())
    }

    fn persist_page_index(&mut self) -> Result<(), String> {
        if !self.page.dirty {
            return Ok(());
        }
        upsert_page(&self.target, &self.page)
            .map_err(|err| format!("index shell replay page: {err}"))?;
        self.page.dirty = false;
        Ok(())
    }

    fn state(
        &self,
        status: ShellReplayStatus,
        error: Option<String>,
        completed_at: Option<String>,
    ) -> ShellReplayState {
        let preview: Vec<u8> = self.preview.iter().copied().collect();
        ShellReplayState {
            replay_ref: ShellReplayRef {
                session_id: self.target.session_id.clone(),
                call_id: self.target.call_id.clone(),
                format_version: SHELL_REPLAY_FORMAT_VERSION,
            },
            bookmark: ShellReplayBookmark {
                visible_through_sequence: self.last_sequence,
                visible_bytes: self.total_bytes,
            },
            terminal_preview: decode_utf8_tail_bounded(&preview, SHELL_REPLAY_PREVIEW_BYTES),
            status,
            error,
            completed_at,
        }
    }

    fn publish_state(&self, state: ShellReplayState, seed_bookmark: bool) -> Result<(), String> {
        if let Some(handle) = self.app_handle.as_ref() {
            retry_exact_event_publish(&self.target, || {
                event_pipeline_bridge::update_shell_replay_by_call_id(
                    handle,
                    &self.target.session_id,
                    &self.target.call_id,
                    state.clone(),
                    seed_bookmark,
                )
            })?;
        }
        Ok(())
    }
}

/// Failure fallback for a writer task that panicked or was cancelled after it
/// took ownership of `ShellReplayWriter`. The exact manifest and EventStore
/// row are marked incomplete; no caller may convert this path into success.
pub(super) fn mark_writer_task_failure(
    target: &ShellReplayTarget,
    artifact_path: Option<&Path>,
    app_handle: Option<&AppHandle>,
    error: String,
) -> Result<(), String> {
    if let Some(path) = artifact_path {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .map_err(|err| format!("open failed writer replay {}: {err}", path.display()))?;
        file.sync_all()
            .map_err(|err| format!("sync failed writer replay {}: {err}", path.display()))?;
    }

    let row = load_row(&target.session_id, &target.call_id)?
        .ok_or_else(|| "failed writer replay manifest is missing".to_string())?;
    let completed_at = Utc::now().to_rfc3339();
    let mut state = active_state(&target.session_id, &target.call_id).unwrap_or(ShellReplayState {
        replay_ref: ShellReplayRef {
            session_id: target.session_id.clone(),
            call_id: target.call_id.clone(),
            format_version: row.meta.format_version,
        },
        bookmark: ShellReplayBookmark {
            visible_through_sequence: row.meta.last_sequence,
            visible_bytes: row.meta.total_bytes,
        },
        terminal_preview: row.meta.terminal_preview,
        status: ShellReplayStatus::Running,
        error: None,
        completed_at: None,
    });
    state.status = ShellReplayStatus::Incomplete;
    state.error = Some(error);
    state.completed_at = Some(completed_at.clone());

    let result = (|| {
        persist_state(&state, &completed_at)
            .map_err(|err| format!("persist failed writer manifest: {err}"))?;
        if let Some(handle) = app_handle {
            retry_exact_event_publish(target, || {
                event_pipeline_bridge::update_shell_replay_by_call_id(
                    handle,
                    &target.session_id,
                    &target.call_id,
                    state.clone(),
                    false,
                )
            })?;
        }
        Ok(())
    })();
    remove_active(target);
    result
}

fn retry_exact_event_publish(
    target: &ShellReplayTarget,
    mut publish: impl FnMut() -> Result<Option<String>, String>,
) -> Result<(), String> {
    for (attempt, delay_ms) in EXACT_EVENT_RETRY_DELAYS_MS.iter().copied().enumerate() {
        if delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(delay_ms));
        }
        match publish()? {
            Some(_) => return Ok(()),
            None if attempt + 1 < EXACT_EVENT_RETRY_DELAYS_MS.len() => continue,
            None => break,
        }
    }
    Err(format!(
        "exact shell tool event was not found for session {} call {} after {} bounded attempts",
        target.session_id,
        target.call_id,
        EXACT_EVENT_RETRY_DELAYS_MS.len()
    ))
}

/// Clone the currently active, bounded shell states for immutable first-insert
/// stamping on a new Session Replay timeline event.
pub fn active_states_for_session(session_id: &str) -> HashMap<String, ShellReplayState> {
    ACTIVE_REPLAYS
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(session_id)
        .map(|states| {
            states
                .iter()
                .map(|(call_id, state)| (call_id.clone(), state.snapshot()))
                .collect()
        })
        .unwrap_or_default()
}

pub fn active_state(session_id: &str, call_id: &str) -> Option<ShellReplayState> {
    ACTIVE_REPLAYS
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(session_id)
        .and_then(|states| states.get(call_id))
        .map(ActiveReplayState::snapshot)
}

fn insert_active(target: &ShellReplayTarget) {
    let mut active = ACTIVE_REPLAYS
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    active.entry(target.session_id.clone()).or_default().insert(
        target.call_id.clone(),
        ActiveReplayState {
            replay_ref: ShellReplayRef {
                session_id: target.session_id.clone(),
                call_id: target.call_id.clone(),
                format_version: SHELL_REPLAY_FORMAT_VERSION,
            },
            bookmark: ShellReplayBookmark {
                visible_through_sequence: 0,
                visible_bytes: 0,
            },
            terminal_preview: VecDeque::with_capacity(SHELL_REPLAY_PREVIEW_BYTES),
        },
    );
}

fn update_active_after_append(
    target: &ShellReplayTarget,
    stream: ShellReplayStream,
    bytes: &[u8],
    sequence: u64,
    persisted_bytes: u64,
) {
    let mut active = ACTIVE_REPLAYS
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(state) = active
        .get_mut(&target.session_id)
        .and_then(|states| states.get_mut(&target.call_id))
    {
        append_tail(
            &mut state.terminal_preview,
            stream,
            bytes,
            SHELL_REPLAY_PREVIEW_BYTES,
        );
        state.bookmark.visible_through_sequence = sequence;
        state.bookmark.visible_bytes = persisted_bytes;
    }
}

fn remove_active(target: &ShellReplayTarget) {
    let mut active = ACTIVE_REPLAYS
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let remove_session = if let Some(states) = active.get_mut(&target.session_id) {
        states.remove(&target.call_id);
        states.is_empty()
    } else {
        false
    };
    if remove_session {
        active.remove(&target.session_id);
    }
}

#[cfg(test)]
fn active_registry_retained_bytes() -> usize {
    ACTIVE_REPLAYS
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .values()
        .flat_map(|states| states.values())
        .map(|state| std::mem::size_of::<ActiveReplayState>() + state.terminal_preview.capacity())
        .sum()
}

fn append_tail(tail: &mut VecDeque<u8>, stream: ShellReplayStream, bytes: &[u8], capacity: usize) {
    if stream == ShellReplayStream::Stderr {
        for byte in b"[stderr] " {
            if tail.len() >= capacity {
                tail.pop_front();
            }
            tail.push_back(*byte);
        }
    }
    for byte in bytes {
        if tail.len() >= capacity {
            tail.pop_front();
        }
        tail.push_back(*byte);
    }
}

fn safe_component(value: &str) -> String {
    let mut readable: String = value
        .chars()
        .take(64)
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if readable.is_empty() || readable == "." || readable == ".." {
        readable = "replay".to_string();
    }
    let digest = blake3::hash(value.as_bytes()).to_hex();
    format!("{readable}-{}", &digest[..12])
}

pub fn resolve_replay_root() -> PathBuf {
    app_paths::shell_replays_dir()
}

fn upsert_page(target: &ShellReplayTarget, page: &ReplayPageState) -> rusqlite::Result<()> {
    database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection()?;
        conn.execute(
            "INSERT INTO shell_replay_pages (
                session_id, call_id, page_index, file_offset,
                output_byte_start, first_sequence, last_sequence, line_count
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(session_id, call_id, page_index) DO UPDATE SET
                last_sequence = excluded.last_sequence,
                line_count = excluded.line_count",
            params![
                target.session_id,
                target.call_id,
                page.page_index,
                page.file_offset,
                page.output_byte_start,
                page.first_sequence,
                page.last_sequence,
                page.line_count,
            ],
        )?;
        Ok(())
    })
}

fn byte_line_count(bytes: &[u8]) -> u64 {
    bytes.iter().filter(|byte| **byte == b'\n').count() as u64
}

fn status_str(status: ShellReplayStatus) -> &'static str {
    match status {
        ShellReplayStatus::Running => "running",
        ShellReplayStatus::Complete => "complete",
        ShellReplayStatus::Incomplete => "incomplete",
    }
}

fn persist_state(state: &ShellReplayState, updated_at: &str) -> rusqlite::Result<()> {
    database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection()?;
        let updated = conn.execute(
            "UPDATE shell_replays SET
                status = ?3, total_bytes = ?4, last_sequence = ?5,
                terminal_preview = ?6, error = ?7, completed_at = ?8,
                updated_at = ?9
             WHERE session_id = ?1 AND call_id = ?2
               AND (
                    status = 'running'
                    OR (status = 'complete' AND ?3 IN ('complete', 'incomplete'))
                    OR (status = 'incomplete' AND ?3 = 'incomplete')
               )",
            params![
                state.replay_ref.session_id,
                state.replay_ref.call_id,
                status_str(state.status),
                state.bookmark.visible_bytes,
                state.bookmark.visible_through_sequence,
                state.terminal_preview,
                state.error,
                state.completed_at,
                updated_at,
            ],
        )?;
        if updated != 1 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    })
}

fn delete_exact_manifest(target: &ShellReplayTarget) -> rusqlite::Result<()> {
    database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection()?;
        let tx = database::db::begin_immediate(&conn)?;
        tx.execute(
            "DELETE FROM shell_replay_pages WHERE session_id = ?1 AND call_id = ?2",
            params![target.session_id, target.call_id],
        )?;
        tx.execute(
            "DELETE FROM shell_replays WHERE session_id = ?1 AND call_id = ?2",
            params![target.session_id, target.call_id],
        )?;
        tx.commit()
    })
}

#[derive(Debug, Clone)]
struct ShellReplayMeta {
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
struct ReplayRow {
    meta: ShellReplayMeta,
    relative_path: PathBuf,
}

fn parse_status(value: &str) -> Result<ShellReplayStatus, String> {
    match value {
        "running" => Ok(ShellReplayStatus::Running),
        "complete" => Ok(ShellReplayStatus::Complete),
        "incomplete" => Ok(ShellReplayStatus::Incomplete),
        other => Err(format!("unknown shell replay status {other:?}")),
    }
}

fn load_row(session_id: &str, call_id: &str) -> Result<Option<ReplayRow>, String> {
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

pub(super) fn load_complete_replay_state_if_matches(
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

/// Repair artifacts whose manifest was still `running` when the application
/// last exited. Valid complete frames are retained, a torn final frame is
/// truncated, page indexes are rebuilt, and the replay is made explicitly
/// `incomplete` so it can never be presented as complete/successful.
pub fn recover_incomplete_replays() -> Result<usize, String> {
    recover_incomplete_replays_at(&resolve_replay_root())
}

fn recover_incomplete_replays_at(replay_root: &Path) -> Result<usize, String> {
    let rows: Vec<(String, String, PathBuf)> = {
        let conn = database::db::get_connection().map_err(|err| err.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT session_id, call_id, relative_path
                 FROM shell_replays WHERE status = 'running'",
            )
            .map_err(|err| err.to_string())?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    PathBuf::from(row.get::<_, String>(2)?),
                ))
            })
            .map_err(|err| err.to_string())?;
        mapped.filter_map(Result::ok).collect()
    };

    let mut recovered = 0usize;
    for (session_id, call_id, relative_path) in rows {
        let target = ShellReplayTarget::new(session_id, call_id);
        recover_one_replay(replay_root, &target, &relative_path)?;
        remove_active(&target);
        recovered = recovered.saturating_add(1);
    }
    Ok(recovered)
}

fn recover_one_replay(
    replay_root: &Path,
    target: &ShellReplayTarget,
    relative_path: &Path,
) -> Result<(), String> {
    if !is_safe_relative_path(relative_path) {
        return mark_recovered_manifest(
            target,
            0,
            0,
            "",
            &[],
            "invalid replay path found during startup recovery",
        );
    }

    let path = replay_root.join(relative_path);
    let file = match OpenOptions::new().read(true).write(true).open(&path) {
        Ok(file) => file,
        Err(err) => {
            return mark_recovered_manifest(
                target,
                0,
                0,
                "",
                &[],
                &format!("replay artifact unavailable after restart: {err}"),
            )
        }
    };
    let mut reader = BufReader::new(
        file.try_clone()
            .map_err(|err| format!("clone replay for recovery: {err}"))?,
    );
    let mut magic = vec![0u8; FILE_MAGIC.len()];
    if reader.read_exact(&mut magic).is_err() || magic != FILE_MAGIC {
        file.set_len(0)
            .map_err(|err| format!("truncate corrupt replay {}: {err}", path.display()))?;
        file.sync_all()
            .map_err(|err| format!("sync corrupt replay {}: {err}", path.display()))?;
        return mark_recovered_manifest(
            target,
            0,
            0,
            "",
            &[],
            "replay header was corrupt after restart",
        );
    }

    let mut file_offset = FILE_MAGIC.len() as u64;
    let mut total_bytes = 0u64;
    let mut last_sequence = 0u64;
    let mut preview = VecDeque::with_capacity(SHELL_REPLAY_PREVIEW_BYTES);
    let mut pages: Vec<ReplayPageState> = Vec::new();
    let mut recovery_note = "application exited before replay finalized".to_string();

    loop {
        let frame_offset = file_offset;
        let mut header = [0u8; FRAME_HEADER_BYTES];
        match reader.read_exact(&mut header) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => {
                if reader
                    .get_ref()
                    .metadata()
                    .map(|meta| meta.len() > frame_offset)
                    .unwrap_or(false)
                {
                    recovery_note = "truncated incomplete replay frame after restart".to_string();
                }
                break;
            }
            Err(err) => {
                recovery_note = format!("failed to scan replay after restart: {err}");
                break;
            }
        }
        let sequence = u64::from_le_bytes(header[0..8].try_into().expect("sequence bytes"));
        let stream = match ShellReplayStream::from_byte(header[16]) {
            Ok(stream) => stream,
            Err(err) => {
                recovery_note = err;
                break;
            }
        };
        let length = u32::from_le_bytes(header[17..21].try_into().expect("length bytes")) as usize;
        if length == 0 || length > SHELL_REPLAY_FRAME_MAX_BYTES {
            recovery_note = format!("invalid replay frame length {length} found after restart");
            break;
        }
        if sequence != last_sequence.saturating_add(1) {
            recovery_note = "invalid replay frame sequence found after restart".to_string();
            break;
        }
        let mut payload = vec![0u8; length];
        if reader.read_exact(&mut payload).is_err() {
            recovery_note = "truncated incomplete replay payload after restart".to_string();
            break;
        }

        let frame_byte_start = total_bytes;
        let page_index = frame_byte_start / SHELL_REPLAY_PAGE_BYTES;
        if pages
            .last()
            .is_none_or(|page| page.page_index != page_index)
        {
            pages.push(ReplayPageState {
                page_index,
                file_offset: frame_offset,
                output_byte_start: frame_byte_start,
                first_sequence: sequence,
                last_sequence: sequence,
                line_count: 0,
                dirty: false,
            });
        }
        let page = pages.last_mut().expect("page was inserted");
        page.last_sequence = sequence;
        page.line_count = page.line_count.saturating_add(byte_line_count(&payload));
        append_tail(&mut preview, stream, &payload, SHELL_REPLAY_PREVIEW_BYTES);
        total_bytes = total_bytes.saturating_add(length as u64);
        last_sequence = sequence;
        file_offset = frame_offset
            .saturating_add(FRAME_HEADER_BYTES as u64)
            .saturating_add(length as u64);
    }

    file.set_len(file_offset)
        .and_then(|_| file.sync_all())
        .map_err(|err| format!("truncate recovered replay {}: {err}", path.display()))?;
    let preview_text = decode_utf8_tail_bounded(
        &preview.iter().copied().collect::<Vec<_>>(),
        SHELL_REPLAY_PREVIEW_BYTES,
    );
    mark_recovered_manifest(
        target,
        total_bytes,
        last_sequence,
        &preview_text,
        &pages,
        &recovery_note,
    )
}

fn mark_recovered_manifest(
    target: &ShellReplayTarget,
    total_bytes: u64,
    last_sequence: u64,
    preview: &str,
    pages: &[ReplayPageState],
    error: &str,
) -> Result<(), String> {
    let completed_at = Utc::now().to_rfc3339();
    database::db::with_sessions_writer(|| -> rusqlite::Result<()> {
        let conn = database::db::get_connection()?;
        let tx = database::db::begin_immediate(&conn)?;
        tx.execute(
            "DELETE FROM shell_replay_pages WHERE session_id = ?1 AND call_id = ?2",
            params![target.session_id, target.call_id],
        )?;
        for page in pages {
            tx.execute(
                "INSERT INTO shell_replay_pages (
                    session_id, call_id, page_index, file_offset,
                    output_byte_start, first_sequence, last_sequence, line_count
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    target.session_id,
                    target.call_id,
                    page.page_index,
                    page.file_offset,
                    page.output_byte_start,
                    page.first_sequence,
                    page.last_sequence,
                    page.line_count,
                ],
            )?;
        }
        tx.execute(
            "UPDATE shell_replays SET status = 'incomplete', total_bytes = ?3,
                last_sequence = ?4, terminal_preview = ?5, error = ?6,
                completed_at = ?7, updated_at = ?7
             WHERE session_id = ?1 AND call_id = ?2",
            params![
                target.session_id,
                target.call_id,
                total_bytes,
                last_sequence,
                preview,
                error,
                completed_at,
            ],
        )?;
        tx.commit()
    })
    .map_err(|err| format!("persist recovered shell replay: {err}"))
}

fn is_safe_relative_path(path: &Path) -> bool {
    !path.is_absolute()
        && path.components().all(|component| {
            matches!(
                component,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
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

fn read_range(
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

/// Remove the manifest and artifact files for an explicitly deleted session.
/// The caller supplies the trusted replay root resolved from AppHandle.
pub fn ensure_session_replays_deletable(session_id: &str) -> Result<(), String> {
    let active_calls: Vec<String> = ACTIVE_REPLAYS
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(session_id)
        .map(|states| states.keys().cloned().collect())
        .unwrap_or_default();
    if active_calls.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "cannot delete session {session_id} while shell replay calls are active: {}",
            active_calls.join(", ")
        ))
    }
}

/// Persist the exact artifact paths before the owning Session row is removed.
/// If the process crashes after the Session commit but before file deletion,
/// startup can still retry from this queue without depending on that row.
pub fn queue_session_replay_cleanup(session_id: &str) -> Result<(), String> {
    ensure_session_replays_deletable(session_id)?;
    let now = Utc::now().to_rfc3339();
    database::db::with_sessions_writer(|| -> rusqlite::Result<()> {
        let conn = database::db::get_connection()?;
        let paths = {
            let mut stmt =
                conn.prepare("SELECT relative_path FROM shell_replays WHERE session_id = ?1")?;
            let paths = stmt
                .query_map([session_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            paths
        };
        let tx = database::db::begin_immediate(&conn)?;
        for relative_path in paths {
            let relative = Path::new(&relative_path);
            if !is_safe_relative_path(relative) {
                return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                    std::io::Error::other(format!(
                        "refusing to queue unsafe shell replay path {relative_path}"
                    )),
                )));
            }
            tx.execute(
                "INSERT INTO shell_replay_cleanup_jobs (
                    session_id, relative_path, attempts, last_error, created_at, updated_at
                 ) VALUES (?1, ?2, 0, NULL, ?3, ?3)
                 ON CONFLICT(session_id, relative_path) DO NOTHING",
                params![session_id, relative_path, now],
            )?;
        }
        tx.commit()
    })
    .map_err(|err| err.to_string())
}

fn record_cleanup_failure(session_id: &str, relative_path: &str, error: &str) {
    let now = Utc::now().to_rfc3339();
    let _ = database::db::with_sessions_writer(|| -> rusqlite::Result<()> {
        let conn = database::db::get_connection()?;
        conn.execute(
            "UPDATE shell_replay_cleanup_jobs
             SET attempts = attempts + 1, last_error = ?3, updated_at = ?4
             WHERE session_id = ?1 AND relative_path = ?2",
            params![session_id, relative_path, error, now],
        )?;
        Ok(())
    });
}

fn process_queued_session_replay_cleanup(session_id: &str) -> Result<(), String> {
    ensure_session_replays_deletable(session_id)?;
    let replay_root = resolve_replay_root();
    let conn = database::db::get_connection().map_err(|err| err.to_string())?;
    let paths: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT relative_path FROM shell_replay_cleanup_jobs
                 WHERE session_id = ?1 ORDER BY relative_path",
            )
            .map_err(|err| err.to_string())?;
        let paths = stmt
            .query_map([session_id], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|err| err.to_string())?;
        paths
    };

    for relative_path in &paths {
        let relative = Path::new(relative_path);
        if !is_safe_relative_path(relative) {
            let error = format!("refusing to delete unsafe shell replay path {relative_path}");
            record_cleanup_failure(session_id, relative_path, &error);
            return Err(format!(
                "refusing to delete unsafe shell replay path {relative_path}"
            ));
        }
        let path = replay_root.join(relative);
        if let Err(err) = fs::remove_file(&path) {
            if err.kind() != std::io::ErrorKind::NotFound {
                let error = format!("delete shell replay {}: {err}", path.display());
                record_cleanup_failure(session_id, relative_path, &error);
                return Err(error);
            }
        }
    }

    // Keep the manifest until every artifact deletion has succeeded. A file
    // failure therefore leaves an exact row that can be retried or diagnosed,
    // instead of creating an unaddressable orphan.
    database::db::with_sessions_writer(|| -> rusqlite::Result<()> {
        let conn = database::db::get_connection()?;
        let tx = database::db::begin_immediate(&conn)?;
        tx.execute(
            "DELETE FROM shell_replay_pages WHERE session_id = ?1",
            [session_id],
        )?;
        tx.execute(
            "DELETE FROM shell_replays WHERE session_id = ?1",
            [session_id],
        )?;
        tx.execute(
            "DELETE FROM shell_replay_cleanup_jobs WHERE session_id = ?1",
            [session_id],
        )?;
        tx.commit()
    })
    .map_err(|err| err.to_string())?;
    // All manifests for a session share the exact safe-component directory.
    // Remove it only after deriving the non-traversable component ourselves;
    // never trust a path from SQLite for recursive deletion.
    let session_dir = replay_root.join(safe_component(session_id));
    if let Err(err) = fs::remove_dir(&session_dir) {
        if !matches!(
            err.kind(),
            std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
        ) {
            tracing::warn!(path = %session_dir.display(), error = %err, "failed to remove empty shell replay session directory");
        }
    }
    Ok(())
}

pub fn remove_session_replays(session_id: &str) -> Result<(), String> {
    queue_session_replay_cleanup(session_id)?;
    process_queued_session_replay_cleanup(session_id)
}

fn table_has_session(conn: &rusqlite::Connection, table: &str, session_id: &str) -> bool {
    let table_exists = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [table],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(false);
    if !table_exists {
        return false;
    }
    let sql = format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE session_id = ?1)");
    conn.query_row(&sql, [session_id], |row| row.get::<_, bool>(0))
        .unwrap_or(true)
}

/// Retry cleanup jobs left by a crash. A job is processed only after both
/// possible owning Session rows are gone, so a failed Session transaction can
/// never cause startup to remove logs for a still-visible Session.
pub fn retry_pending_replay_cleanups() -> Result<(usize, usize), String> {
    let conn = database::db::get_connection().map_err(|err| err.to_string())?;
    let session_ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT DISTINCT session_id FROM shell_replay_cleanup_jobs")
            .map_err(|err| err.to_string())?;
        let session_ids = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|err| err.to_string())?;
        session_ids
    };
    let mut completed = 0usize;
    let mut failed = 0usize;
    for session_id in session_ids {
        if table_has_session(&conn, "agent_sessions", &session_id)
            || table_has_session(&conn, "code_sessions", &session_id)
        {
            continue;
        }
        match process_queued_session_replay_cleanup(&session_id) {
            Ok(()) => completed = completed.saturating_add(1),
            Err(error) => {
                failed = failed.saturating_add(1);
                tracing::warn!(session_id, error = %error, "shell replay cleanup retry failed");
            }
        }
    }
    Ok((completed, failed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_test_home<T>(test: impl FnOnce(&Path) -> T) -> T {
        let sandbox = test_helpers::test_env::sandbox();
        let conn = database::db::get_connection().unwrap();
        database::init_shell_replay_tables(&conn).unwrap();
        test(sandbox.path())
    }

    fn append_payload(writer: &mut ShellReplayWriter, total: usize, chunk_size: usize) {
        let chunk = vec![b'r'; chunk_size];
        let mut remaining = total;
        while remaining > 0 {
            let count = remaining.min(chunk.len());
            writer
                .append(ShellReplayStream::Stdout, &chunk[..count])
                .unwrap();
            remaining -= count;
        }
    }

    #[cfg(unix)]
    fn peak_rss_bytes() -> usize {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
        let rc = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
        assert_eq!(rc, 0, "getrusage failed");
        let rss = unsafe { usage.assume_init() }.ru_maxrss as usize;
        #[cfg(target_os = "macos")]
        {
            rss
        }
        #[cfg(not(target_os = "macos"))]
        {
            rss.saturating_mul(1024)
        }
    }

    #[test]
    #[serial_test::serial]
    fn writer_preserves_complete_bytes_and_bounds_preview_and_summary() {
        with_test_home(|home| {
            let root = home.join("replays");
            let target = ShellReplayTarget::new("session-a", "call-a");
            let mut writer =
                ShellReplayWriter::create(&root, target.clone(), "emit", home, None).unwrap();
            let chunk = vec![b'x'; 1024];
            for _ in 0..1024 {
                writer.append(ShellReplayStream::Stdout, &chunk).unwrap();
            }
            writer.flush_running_state().unwrap();
            assert!(writer.preview.len() <= SHELL_REPLAY_PREVIEW_BYTES);
            assert!(writer.summary().len() <= 32 * 1024);
            let summary = writer.finalize(ShellReplayStatus::Complete, None).unwrap();
            assert!(summary.contains("bytes omitted"));

            let range = read_range(
                &root,
                "session-a",
                "call-a",
                u64::MAX,
                u64::MAX,
                0,
                SHELL_REPLAY_RANGE_MAX_BYTES as u64,
            )
            .unwrap();
            assert_eq!(range.next_offset_bytes, SHELL_REPLAY_RANGE_MAX_BYTES as u64);
            assert!(!range.eof);
            assert_eq!(
                range
                    .frames
                    .iter()
                    .map(|frame| frame.text.len())
                    .sum::<usize>(),
                SHELL_REPLAY_RANGE_MAX_BYTES
            );
        });
    }

    #[test]
    #[serial_test::serial]
    fn range_clamps_future_sequence_and_bytes() {
        with_test_home(|home| {
            let root = home.join("replays");
            let target = ShellReplayTarget::new("session-b", "call-b");
            let mut writer = ShellReplayWriter::create(&root, target, "emit", home, None).unwrap();
            writer
                .append(ShellReplayStream::Stdout, b"EARLY\n")
                .unwrap();
            let early_bytes = writer.total_bytes;
            writer
                .append(ShellReplayStream::Stdout, b"FUTURE\n")
                .unwrap();
            writer.finalize(ShellReplayStatus::Complete, None).unwrap();

            let range = read_range(&root, "session-b", "call-b", 1, early_bytes, 0, 1024).unwrap();
            let text: String = range.frames.into_iter().map(|frame| frame.text).collect();
            assert_eq!(text, "EARLY\n");
            assert!(!text.contains("FUTURE"));
        });
    }

    #[test]
    fn summary_is_exact_before_truncation_and_utf8_prefix_carries_split_codepoint() {
        let mut summary = BoundedTerminalText::default();
        let exact = "中🙂".repeat(3_000);
        summary.append(ShellReplayStream::Stdout, exact.as_bytes());
        assert_eq!(summary.render(), exact);
        assert!(!summary.render().contains("bytes omitted"));

        let emoji = "🙂".as_bytes();
        let mut first_read = vec![b'x'; 16 * 1024 - 2];
        first_read.extend_from_slice(&emoji[..2]);
        assert_eq!(first_read.len(), 16 * 1024);
        assert_eq!(complete_utf8_prefix_len(&first_read), 16 * 1024 - 2);
        let mut carry = first_read.split_off(16 * 1024 - 2);
        carry.extend_from_slice(&emoji[2..]);
        assert_eq!(complete_utf8_prefix_len(&carry), emoji.len());
        assert_eq!(std::str::from_utf8(&carry).unwrap(), "🙂");
    }

    #[test]
    fn exact_event_publish_retries_writer_before_event_insertion_race() {
        let target = ShellReplayTarget::new("session-race", "call-race");
        let mut attempts = 0;
        retry_exact_event_publish(&target, || {
            attempts += 1;
            Ok((attempts >= 3).then(|| "tool-call-call-race".to_string()))
        })
        .unwrap();
        assert_eq!(attempts, 3);
    }

    #[test]
    fn unknown_manifest_status_is_not_treated_as_running() {
        assert_eq!(parse_status("running").unwrap(), ShellReplayStatus::Running);
        assert!(parse_status("future-corrupt-value").is_err());
    }

    #[test]
    #[serial_test::serial]
    fn ansi_csi_split_is_carried_into_the_next_frame() {
        with_test_home(|home| {
            let root = home.join("replays");
            let mut writer = ShellReplayWriter::create(
                &root,
                ShellReplayTarget::new("session-ansi", "call-ansi"),
                "emit ansi",
                home,
                None,
            )
            .unwrap();

            let mut first_read = vec![b'x'; SHELL_REPLAY_FRAME_MAX_BYTES - 2];
            first_read.extend_from_slice(b"\x1b[");
            let first_prefix = complete_terminal_prefix_len(&first_read);
            assert_eq!(first_prefix, SHELL_REPLAY_FRAME_MAX_BYTES - 2);
            writer
                .append(ShellReplayStream::Stdout, &first_read[..first_prefix])
                .unwrap();

            let mut next_frame = first_read[first_prefix..].to_vec();
            next_frame.extend_from_slice(b"31mRED");
            assert_eq!(complete_terminal_prefix_len(&next_frame), next_frame.len());
            writer
                .append(ShellReplayStream::Stdout, &next_frame)
                .unwrap();
            let bookmark = writer
                .state(ShellReplayStatus::Complete, None, None)
                .bookmark;
            writer.finalize(ShellReplayStatus::Complete, None).unwrap();

            let range = read_range(
                &root,
                "session-ansi",
                "call-ansi",
                bookmark.visible_through_sequence,
                bookmark.visible_bytes,
                first_prefix as u64,
                64,
            )
            .unwrap();
            assert_eq!(range.frames.len(), 1);
            assert_eq!(range.frames[0].text, "\x1b[31mRED");
            assert!(!range.frames[0].text.starts_with("[31m"));
        });
    }

    #[test]
    #[serial_test::serial]
    fn range_aligns_to_complete_sequence_and_never_splits_emoji() {
        with_test_home(|home| {
            let root = home.join("replays");
            let target = ShellReplayTarget::new("session-utf8", "call-utf8");
            let mut writer =
                ShellReplayWriter::create(&root, target, "emit utf8", home, None).unwrap();
            let text = format!("{}🙂END", "x".repeat(1_000));
            let append = writer
                .append(ShellReplayStream::Stdout, text.as_bytes())
                .unwrap();
            writer.finalize(ShellReplayStatus::Complete, None).unwrap();

            // Both the requested offset and limit land inside this frame. The
            // response aligns back and returns the one complete sequence.
            let range = read_range(
                &root,
                "session-utf8",
                "call-utf8",
                append.sequence,
                append.persisted_bytes,
                1_002,
                1,
            )
            .unwrap();
            assert_eq!(range.frames.len(), 1);
            assert_eq!(range.frames[0].sequence, append.sequence);
            assert_eq!(range.frames[0].byte_start, 0);
            assert_eq!(range.frames[0].text, text);
            assert!(!range.frames[0].text.contains('\u{fffd}'));
        });
    }

    #[test]
    #[serial_test::serial]
    fn bounded_preview_and_summary_trim_only_utf8_edges() {
        with_test_home(|home| {
            let root = home.join("replays");
            let mut writer = ShellReplayWriter::create(
                &root,
                ShellReplayTarget::new("session-preview-utf8", "call-preview-utf8"),
                "emit utf8",
                home,
                None,
            )
            .unwrap();
            for _ in 0..10_000 {
                writer
                    .append(ShellReplayStream::Stdout, "汉🙂".as_bytes())
                    .unwrap();
            }
            let active = active_state("session-preview-utf8", "call-preview-utf8").unwrap();
            assert!(active.terminal_preview.len() <= SHELL_REPLAY_PREVIEW_BYTES);
            assert!(!active.terminal_preview.contains('\u{fffd}'));
            assert!(!writer.summary().contains('\u{fffd}'));
            writer.finalize(ShellReplayStatus::Complete, None).unwrap();
            let row = load_row("session-preview-utf8", "call-preview-utf8")
                .unwrap()
                .unwrap();
            assert!(row.meta.terminal_preview.len() <= SHELL_REPLAY_PREVIEW_BYTES);
            assert!(!row.meta.terminal_preview.contains('\u{fffd}'));
        });
    }

    #[test]
    #[serial_test::serial]
    fn invalid_utf8_cannot_expand_serialized_preview_summary_or_range_budget() {
        with_test_home(|home| {
            let root = home.join("replays");
            let mut writer = ShellReplayWriter::create(
                &root,
                ShellReplayTarget::new("session-invalid-utf8", "call-invalid-utf8"),
                "emit bytes",
                home,
                None,
            )
            .unwrap();
            for _ in 0..8 {
                writer
                    .append(
                        ShellReplayStream::Stdout,
                        &vec![0xff; SHELL_REPLAY_FRAME_MAX_BYTES],
                    )
                    .unwrap();
            }
            let active = active_state("session-invalid-utf8", "call-invalid-utf8").unwrap();
            assert!(active.terminal_preview.len() <= SHELL_REPLAY_PREVIEW_BYTES);
            assert!(writer.summary().len() <= SHELL_REPLAY_SUMMARY_MAX_BYTES);
            writer.finalize(ShellReplayStatus::Complete, None).unwrap();
            let row = load_row("session-invalid-utf8", "call-invalid-utf8")
                .unwrap()
                .unwrap();
            assert!(row.meta.terminal_preview.len() <= SHELL_REPLAY_PREVIEW_BYTES);
            let range = read_range(
                &root,
                "session-invalid-utf8",
                "call-invalid-utf8",
                row.meta.last_sequence,
                row.meta.total_bytes,
                0,
                SHELL_REPLAY_RANGE_MAX_BYTES as u64,
            )
            .unwrap();
            assert!(
                range
                    .frames
                    .iter()
                    .map(|frame| frame.text.len())
                    .sum::<usize>()
                    <= SHELL_REPLAY_RANGE_MAX_BYTES
            );
            assert!(!range.eof);
            assert!(range.next_offset_bytes > 0);
            assert!(range.next_offset_bytes < row.meta.total_bytes);
        });
    }

    #[test]
    #[serial_test::serial]
    fn tail_range_alignment_still_reaches_bookmark_and_tail_sentinel() {
        with_test_home(|home| {
            let root = home.join("replays");
            let mut writer = ShellReplayWriter::create(
                &root,
                ShellReplayTarget::new("session-tail", "call-tail"),
                "emit tail",
                home,
                None,
            )
            .unwrap();
            for _ in 0..20 {
                writer
                    .append(ShellReplayStream::Stdout, &vec![b'x'; 16 * 1024])
                    .unwrap();
            }
            writer
                .append(ShellReplayStream::Stdout, b"TAIL_SENTINEL")
                .unwrap();
            let visible_bytes = writer.total_bytes;
            let visible_sequence = writer.last_sequence;
            writer.finalize(ShellReplayStatus::Complete, None).unwrap();

            let offset = visible_bytes
                .saturating_sub(SHELL_REPLAY_RANGE_MAX_BYTES as u64)
                .saturating_add(1);
            let range = read_range(
                &root,
                "session-tail",
                "call-tail",
                visible_sequence,
                visible_bytes,
                offset,
                SHELL_REPLAY_RANGE_MAX_BYTES as u64,
            )
            .unwrap();
            assert!(range.eof);
            assert_eq!(range.next_offset_bytes, visible_bytes);
            assert!(range
                .frames
                .last()
                .is_some_and(|frame| frame.text == "TAIL_SENTINEL"));
            assert!(
                range
                    .frames
                    .iter()
                    .map(|frame| frame.byte_end - frame.byte_start)
                    .sum::<u64>()
                    <= SHELL_REPLAY_RANGE_MAX_BYTES as u64
            );
        });
    }

    #[test]
    #[serial_test::serial]
    fn active_registry_is_exact_per_append_and_clears_only_on_finalize() {
        with_test_home(|home| {
            let root = home.join("replays");
            let target = ShellReplayTarget::new("session-active", "call-active");
            let mut writer =
                ShellReplayWriter::create(&root, target.clone(), "emit", home, None).unwrap();
            let initial = active_states_for_session("session-active");
            assert_eq!(initial["call-active"].bookmark.visible_bytes, 0);

            writer.append(ShellReplayStream::Stdout, b"first").unwrap();
            let after_first = active_state("session-active", "call-active").unwrap();
            assert_eq!(after_first.bookmark.visible_through_sequence, 1);
            assert_eq!(after_first.bookmark.visible_bytes, 5);
            assert_eq!(after_first.terminal_preview, "first");

            // Dropping consumer snapshots cannot own or erase writer state.
            drop(initial);
            drop(after_first);
            writer.append(ShellReplayStream::Stderr, b"second").unwrap();
            let latest = active_state("session-active", "call-active").unwrap();
            assert_eq!(latest.bookmark.visible_through_sequence, 2);
            assert_eq!(latest.bookmark.visible_bytes, 11);
            assert!(latest.terminal_preview.ends_with("[stderr] second"));

            writer.finalize(ShellReplayStatus::Complete, None).unwrap();
            assert!(active_state("session-active", "call-active").is_none());
        });
    }

    #[test]
    #[serial_test::serial]
    fn startup_recovery_truncates_torn_frame_rebuilds_pages_and_marks_incomplete() {
        with_test_home(|home| {
            let root = home.join("replays");
            let target = ShellReplayTarget::new("session-recover", "call-recover");
            let path = {
                let mut writer =
                    ShellReplayWriter::create(&root, target.clone(), "emit", home, None).unwrap();
                writer
                    .append(ShellReplayStream::Stdout, b"line-one\n")
                    .unwrap();
                writer.flush_running_state().unwrap();
                writer.path().to_path_buf()
            };
            let valid_len = fs::metadata(&path).unwrap().len();
            OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap()
                .write_all(&[7u8; 9])
                .unwrap();

            assert_eq!(recover_incomplete_replays_at(&root).unwrap(), 1);
            assert_eq!(fs::metadata(&path).unwrap().len(), valid_len);
            let row = load_row("session-recover", "call-recover")
                .unwrap()
                .unwrap();
            assert_eq!(row.meta.status, ShellReplayStatus::Incomplete);
            assert_eq!(row.meta.total_bytes, 9);
            assert_eq!(row.meta.last_sequence, 1);
            assert!(row.meta.error.unwrap().contains("truncated"));
            assert!(active_state("session-recover", "call-recover").is_none());

            let conn = database::db::get_connection().unwrap();
            let page: (u64, u64) = conn
                .query_row(
                    "SELECT last_sequence, line_count FROM shell_replay_pages
                     WHERE session_id = ?1 AND call_id = ?2 AND page_index = 0",
                    params!["session-recover", "call-recover"],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(page, (1, 1));
        });
    }

    #[test]
    #[serial_test::serial]
    fn oversized_frame_is_rejected_and_corrupt_length_is_never_allocated() {
        with_test_home(|home| {
            let root = home.join("replays");
            let target = ShellReplayTarget::new("session-corrupt-length", "call-corrupt-length");
            let path = {
                let mut writer =
                    ShellReplayWriter::create(&root, target, "emit", home, None).unwrap();
                let oversized = vec![b'x'; SHELL_REPLAY_FRAME_MAX_BYTES + 1];
                assert!(writer
                    .append(ShellReplayStream::Stdout, &oversized)
                    .unwrap_err()
                    .contains("frame limit"));
                assert_eq!(writer.last_sequence, 0);
                assert_eq!(writer.total_bytes, 0);

                writer.append(ShellReplayStream::Stdout, b"valid").unwrap();
                writer.flush_running_state().unwrap();
                writer.path().to_path_buf()
            };
            let valid_len = fs::metadata(&path).unwrap().len();
            let mut corrupt = OpenOptions::new().append(true).open(&path).unwrap();
            corrupt.write_all(&2u64.to_le_bytes()).unwrap();
            corrupt.write_all(&0i64.to_le_bytes()).unwrap();
            corrupt
                .write_all(&[ShellReplayStream::Stdout.as_byte()])
                .unwrap();
            corrupt.write_all(&u32::MAX.to_le_bytes()).unwrap();
            corrupt.flush().unwrap();

            assert_eq!(recover_incomplete_replays_at(&root).unwrap(), 1);
            assert_eq!(fs::metadata(&path).unwrap().len(), valid_len);
            let row = load_row("session-corrupt-length", "call-corrupt-length")
                .unwrap()
                .unwrap();
            assert_eq!(row.meta.status, ShellReplayStatus::Incomplete);
            assert_eq!(row.meta.total_bytes, 5);
            assert!(row.meta.error.unwrap().contains("frame length"));
        });
    }

    #[test]
    #[serial_test::serial]
    fn range_rejects_corrupt_length_before_payload_allocation() {
        with_test_home(|home| {
            let root = home.join("replays");
            let mut writer = ShellReplayWriter::create(
                &root,
                ShellReplayTarget::new("session-range-corrupt", "call-range-corrupt"),
                "emit",
                home,
                None,
            )
            .unwrap();
            writer.append(ShellReplayStream::Stdout, b"valid").unwrap();
            let path = writer.path().to_path_buf();
            writer.finalize(ShellReplayStatus::Complete, None).unwrap();

            let mut file = OpenOptions::new().write(true).open(&path).unwrap();
            file.seek(SeekFrom::Start((FILE_MAGIC.len() + 17) as u64))
                .unwrap();
            file.write_all(&u32::MAX.to_le_bytes()).unwrap();
            file.sync_all().unwrap();

            let error = read_range(
                &root,
                "session-range-corrupt",
                "call-range-corrupt",
                u64::MAX,
                u64::MAX,
                0,
                64,
            )
            .unwrap_err();
            assert!(error.contains("invalid shell replay frame length"));
        });
    }

    #[test]
    #[serial_test::serial]
    fn range_rejects_zero_length_and_non_consecutive_sequences() {
        with_test_home(|home| {
            let root = home.join("replays");
            let mut writer = ShellReplayWriter::create(
                &root,
                ShellReplayTarget::new("session-range-structure", "call-range-structure"),
                "emit",
                home,
                None,
            )
            .unwrap();
            writer.append(ShellReplayStream::Stdout, b"a").unwrap();
            writer.append(ShellReplayStream::Stdout, b"b").unwrap();
            let path = writer.path().to_path_buf();
            writer.finalize(ShellReplayStatus::Complete, None).unwrap();

            let mut file = OpenOptions::new().write(true).open(&path).unwrap();
            file.seek(SeekFrom::Start((FILE_MAGIC.len() + 17) as u64))
                .unwrap();
            file.write_all(&0u32.to_le_bytes()).unwrap();
            file.sync_all().unwrap();
            let zero_error = read_range(
                &root,
                "session-range-structure",
                "call-range-structure",
                u64::MAX,
                u64::MAX,
                0,
                64,
            )
            .unwrap_err();
            assert!(zero_error.contains("frame length 0"));

            file.seek(SeekFrom::Start((FILE_MAGIC.len() + 17) as u64))
                .unwrap();
            file.write_all(&1u32.to_le_bytes()).unwrap();
            let second_sequence_offset = FILE_MAGIC.len() + FRAME_HEADER_BYTES + 1;
            file.seek(SeekFrom::Start(second_sequence_offset as u64))
                .unwrap();
            file.write_all(&1u64.to_le_bytes()).unwrap();
            file.sync_all().unwrap();
            let sequence_error = read_range(
                &root,
                "session-range-structure",
                "call-range-structure",
                u64::MAX,
                u64::MAX,
                0,
                64,
            )
            .unwrap_err();
            assert!(sequence_error.contains("strictly consecutive"));
        });
    }

    #[test]
    #[serial_test::serial]
    fn repeated_ten_megabyte_runs_have_constant_retained_allocator_budget() {
        with_test_home(|home| {
            const TEN_MIB: usize = 10 * 1024 * 1024;
            const MAX_ALLOWED_RETAINED_DELTA: usize = 64 * 1024 * 1024;
            const {
                assert!(super::super::subprocess::ESTIMATED_RETAINED_OUTPUT_BYTES <= 512 * 1024);
            }

            let active_before = active_registry_retained_bytes();
            let mut observed_writer_capacity = HashMap::new();
            for (run, chunk_size) in [100usize, 1_024, 100, 1_024].into_iter().enumerate() {
                let root = home.join("replays");
                let call_id = format!("call-memory-{run}");
                let target = ShellReplayTarget::new("session-memory", &call_id);
                let mut writer =
                    ShellReplayWriter::create(&root, target, "emit 10MiB", home, None).unwrap();
                let chunk = vec![b'm'; chunk_size];
                let mut remaining = TEN_MIB;
                while remaining > 0 {
                    let count = remaining.min(chunk.len());
                    writer
                        .append(ShellReplayStream::Stdout, &chunk[..count])
                        .unwrap();
                    remaining -= count;
                }
                assert_eq!(writer.total_bytes, TEN_MIB as u64);
                assert!(writer.preview.len() <= SHELL_REPLAY_PREVIEW_BYTES);
                let retained = writer.retained_capacity_bytes();
                match observed_writer_capacity.insert(chunk_size, retained) {
                    Some(previous) => assert_eq!(
                        retained, previous,
                        "retained capacity grew across repeated {chunk_size}-byte runs"
                    ),
                    None => assert!(retained <= 160 * 1024),
                }
                writer.finalize(ShellReplayStatus::Complete, None).unwrap();
                assert!(active_state("session-memory", &call_id).is_none());
                let row = load_row("session-memory", &call_id).unwrap().unwrap();
                assert_eq!(row.meta.total_bytes, TEN_MIB as u64);
                assert_eq!(row.meta.terminal_preview.len(), SHELL_REPLAY_PREVIEW_BYTES);
            }
            let active_after = active_registry_retained_bytes();
            let isolated_allocator_delta = active_after.saturating_sub(active_before);
            assert!(
                isolated_allocator_delta <= MAX_ALLOWED_RETAINED_DELTA,
                "retained allocator delta was {isolated_allocator_delta} bytes"
            );
            assert_eq!(isolated_allocator_delta, 0);
        });
    }

    #[cfg(unix)]
    #[test]
    #[serial_test::serial]
    #[ignore = "serial OS RSS stress; run explicitly for #425 memory acceptance"]
    fn shell_replay_rss_plateau_after_ten_megabyte_warmup() {
        with_test_home(|home| {
            const TEN_MIB: usize = 10 * 1024 * 1024;
            let root = home.join("replays");

            let mut warmup = ShellReplayWriter::create(
                &root,
                ShellReplayTarget::new("session-rss", "call-rss-warmup"),
                "warm up allocator",
                home,
                None,
            )
            .unwrap();
            append_payload(&mut warmup, TEN_MIB, 1_024);
            warmup.finalize(ShellReplayStatus::Complete, None).unwrap();
            let warm_peak = peak_rss_bytes();

            for (run, chunk_size) in [100usize, 1_024, 100, 1_024].into_iter().enumerate() {
                let mut writer = ShellReplayWriter::create(
                    &root,
                    ShellReplayTarget::new("session-rss", format!("call-rss-{run}")),
                    "stress allocator",
                    home,
                    None,
                )
                .unwrap();
                append_payload(&mut writer, TEN_MIB, chunk_size);
                writer.finalize(ShellReplayStatus::Complete, None).unwrap();
            }
            let final_peak = peak_rss_bytes();
            let delta = final_peak.saturating_sub(warm_peak);
            eprintln!(
                "shell replay RSS: warm_peak={warm_peak} final_peak={final_peak} delta={delta}"
            );
            assert!(
                delta <= 64 * 1024 * 1024,
                "RSS grew by {delta} bytes after warmup"
            );
        });
    }

    #[test]
    #[serial_test::serial]
    fn concurrent_replays_keep_independent_bounded_state() {
        with_test_home(|home| {
            let root = home.join("replays");
            let mut writers = Vec::new();
            for index in 0..4 {
                let call_id = format!("call-concurrent-{index}");
                let mut writer = ShellReplayWriter::create(
                    &root,
                    ShellReplayTarget::new("session-concurrent", &call_id),
                    "emit",
                    home,
                    None,
                )
                .unwrap();
                writer
                    .append(ShellReplayStream::Stdout, &vec![b'c'; 1_024])
                    .unwrap();
                writers.push(writer);
            }
            let active = active_states_for_session("session-concurrent");
            assert_eq!(active.len(), 4);
            assert!(active.values().all(|state| {
                state.bookmark.visible_through_sequence == 1
                    && state.bookmark.visible_bytes == 1_024
                    && state.terminal_preview.len() == 1_024
            }));
            assert!(
                writers
                    .iter()
                    .map(ShellReplayWriter::retained_capacity_bytes)
                    .sum::<usize>()
                    + active_registry_retained_bytes()
                    <= 4 * 160 * 1024
            );
            for writer in writers {
                writer.finalize(ShellReplayStatus::Complete, None).unwrap();
            }
            assert!(active_states_for_session("session-concurrent").is_empty());
        });
    }

    #[test]
    #[serial_test::serial]
    fn explicit_delete_removes_only_safe_session_directory_and_manifest() {
        with_test_home(|home| {
            let root = resolve_replay_root();
            let session_id = "../session-delete";
            let target = ShellReplayTarget::new(session_id, "call-delete");
            let mut writer = ShellReplayWriter::create(&root, target, "emit", home, None).unwrap();
            writer
                .append(ShellReplayStream::Stdout, b"delete me")
                .unwrap();
            let artifact = writer.path().to_path_buf();
            let session_dir = artifact.parent().unwrap().to_path_buf();
            writer.finalize(ShellReplayStatus::Complete, None).unwrap();
            assert!(artifact.exists());

            remove_session_replays(session_id).unwrap();
            assert!(!artifact.exists());
            assert!(!session_dir.exists());
            assert!(load_row(session_id, "call-delete").unwrap().is_none());
            assert!(root.exists());
        });
    }

    #[test]
    #[serial_test::serial]
    fn explicit_delete_refuses_active_writer_without_erasing_manifest() {
        with_test_home(|home| {
            let root = resolve_replay_root();
            let session_id = "session-delete-active";
            let mut writer = ShellReplayWriter::create(
                &root,
                ShellReplayTarget::new(session_id, "call-delete-active"),
                "emit",
                home,
                None,
            )
            .unwrap();
            writer.append(ShellReplayStream::Stdout, b"live").unwrap();
            let artifact = writer.path().to_path_buf();

            let error = remove_session_replays(session_id).unwrap_err();
            assert!(error.contains("calls are active"));
            assert!(artifact.exists());
            assert!(load_row(session_id, "call-delete-active")
                .unwrap()
                .is_some());

            writer.finalize(ShellReplayStatus::Complete, None).unwrap();
            remove_session_replays(session_id).unwrap();
        });
    }

    #[test]
    #[serial_test::serial]
    fn file_delete_failure_preserves_manifest_for_retry() {
        with_test_home(|home| {
            let root = resolve_replay_root();
            let session_id = "session-delete-failure";
            let mut writer = ShellReplayWriter::create(
                &root,
                ShellReplayTarget::new(session_id, "call-delete-failure"),
                "emit",
                home,
                None,
            )
            .unwrap();
            writer.append(ShellReplayStream::Stdout, b"data").unwrap();
            let artifact = writer.path().to_path_buf();
            writer.finalize(ShellReplayStatus::Complete, None).unwrap();

            fs::remove_file(&artifact).unwrap();
            fs::create_dir(&artifact).unwrap();
            let error = remove_session_replays(session_id).unwrap_err();
            assert!(error.contains("delete shell replay"));
            assert!(load_row(session_id, "call-delete-failure")
                .unwrap()
                .is_some());
            let conn = database::db::get_connection().unwrap();
            let queued: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM shell_replay_cleanup_jobs WHERE session_id = ?1",
                    [session_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(queued, 1);

            fs::remove_dir(&artifact).unwrap();
            assert_eq!(retry_pending_replay_cleanups().unwrap(), (1, 0));
            assert!(load_row(session_id, "call-delete-failure")
                .unwrap()
                .is_none());
        });
    }

    #[test]
    #[serial_test::serial]
    fn startup_cleanup_waits_until_the_owning_session_row_is_gone() {
        with_test_home(|home| {
            let root = resolve_replay_root();
            let session_id = "session-delete-crash-window";
            let mut writer = ShellReplayWriter::create(
                &root,
                ShellReplayTarget::new(session_id, "call-delete-crash-window"),
                "emit",
                home,
                None,
            )
            .unwrap();
            writer
                .append(ShellReplayStream::Stdout, b"keep until delete")
                .unwrap();
            let artifact = writer.path().to_path_buf();
            writer.finalize(ShellReplayStatus::Complete, None).unwrap();

            let conn = database::db::get_connection().unwrap();
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS agent_sessions (
                    session_id TEXT PRIMARY KEY
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO agent_sessions (session_id) VALUES (?1)",
                [session_id],
            )
            .unwrap();
            queue_session_replay_cleanup(session_id).unwrap();

            assert_eq!(retry_pending_replay_cleanups().unwrap(), (0, 0));
            assert!(artifact.exists());

            conn.execute(
                "DELETE FROM agent_sessions WHERE session_id = ?1",
                [session_id],
            )
            .unwrap();
            assert_eq!(retry_pending_replay_cleanups().unwrap(), (1, 0));
            assert!(!artifact.exists());
            assert!(load_row(session_id, "call-delete-crash-window")
                .unwrap()
                .is_none());
        });
    }
}
