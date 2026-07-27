//! Durable, bounded-memory shell transcript storage.
//!
//! `run_shell` writes every stdout/stderr byte once to an append-only artifact.
//! Live UI state contains only a 32 KiB tail plus an immutable byte/sequence
//! watermark; range reads are capped so neither Tauri IPC nor React has to
//! materialize the complete transcript.

use std::path::{Path, PathBuf};

mod active;
mod cleanup;
mod range;
mod recovery;
mod text;
mod writer;
#[cfg(test)]
mod tests;

pub use active::{
    active_state, active_states_for_session, ShellReplayAppend, ShellReplayStream,
    ShellReplayTarget,
};
pub use cleanup::{
    ensure_session_replays_deletable, queue_session_replay_cleanup, remove_session_replays,
    retry_pending_replay_cleanups,
};
pub use range::{
    load_replay_state, read_replay_tail, shell_replay_read_range, ShellReplayFrame,
    ShellReplayRange,
};
pub use recovery::recover_incomplete_replays;
pub use writer::ShellReplayWriter;

pub(super) use range::load_complete_replay_state_if_matches;
pub use range::__cmd__shell_replay_read_range;
pub(super) use text::complete_terminal_prefix_len;
#[cfg(test)]
pub(super) use text::complete_utf8_prefix_len;
pub(super) use writer::mark_writer_task_failure;

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

fn byte_line_count(bytes: &[u8]) -> u64 {
    bytes.iter().filter(|byte| **byte == b'\n').count() as u64
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
