//! Single-writer artifact writer for one shell replay: durable frame
//! persistence, bounded in-memory preview/summary state, the EventStore
//! publish path, and the writer-task failure fallback.

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use chrono::Utc;
use core_types::session_event::{
    ShellReplayBookmark, ShellReplayRef, ShellReplayState, ShellReplayStatus,
};
use rusqlite::params;
use tauri::AppHandle;

use crate::bus::event_pipeline_bridge;

use super::active::{
    active_state, append_tail, insert_active, remove_active, update_active_after_append,
    ShellReplayAppend, ShellReplayStream, ShellReplayTarget,
};
use super::range::load_row;
use super::text::{
    decode_utf8_prefix, decode_utf8_tail, decode_utf8_tail_bounded, truncate_string_prefix,
    truncate_string_tail,
};
use super::{
    byte_line_count, safe_component, ReplayPageState, FILE_MAGIC, FRAME_HEADER_BYTES,
    SHELL_REPLAY_FORMAT_VERSION, SHELL_REPLAY_FRAME_MAX_BYTES, SHELL_REPLAY_PAGE_BYTES,
    SHELL_REPLAY_PREVIEW_BYTES, SHELL_REPLAY_SUMMARY_HEAD_BYTES, SHELL_REPLAY_SUMMARY_MAX_BYTES,
    SHELL_REPLAY_SUMMARY_TAIL_BYTES,
};

const STATE_FLUSH_INTERVAL: Duration = Duration::from_millis(50);
const EXACT_EVENT_RETRY_DELAYS_MS: &[u64] = &[0, 5, 10, 20, 40, 80, 160];

#[derive(Debug, Default)]
pub(super) struct BoundedTerminalText {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    total_bytes: u64,
}

impl BoundedTerminalText {
    pub(super) fn append(&mut self, stream: ShellReplayStream, bytes: &[u8]) {
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

    pub(super) fn render(&self) -> String {
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
    pub(super) total_bytes: u64,
    pub(super) last_sequence: u64,
    page: ReplayPageState,
    pub(super) preview: VecDeque<u8>,
    summary: BoundedTerminalText,
    last_state_flush: Instant,
    bytes_at_last_state_flush: u64,
    app_handle: Option<AppHandle>,
    attached_live: bool,
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

    pub(in super::super) fn target(&self) -> ShellReplayTarget {
        self.target.clone()
    }

    pub(in super::super) fn app_handle(&self) -> Option<AppHandle> {
        self.app_handle.clone()
    }

    #[cfg(test)]
    pub(in super::super) fn inject_read_only_artifact_for_test(&mut self) {
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
    pub(super) fn retained_capacity_bytes(&self) -> usize {
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

    pub(super) fn state(
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
pub(crate) fn mark_writer_task_failure(
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

pub(super) fn retry_exact_event_publish(
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

fn status_str(status: ShellReplayStatus) -> &'static str {
    match status {
        ShellReplayStatus::Running => "running",
        ShellReplayStatus::Complete => "complete",
        ShellReplayStatus::Incomplete => "incomplete",
    }
}

pub(super) fn persist_state(state: &ShellReplayState, updated_at: &str) -> rusqlite::Result<()> {
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
