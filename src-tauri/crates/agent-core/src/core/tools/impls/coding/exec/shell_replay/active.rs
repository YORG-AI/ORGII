//! Bounded, in-memory registry of currently active shell replays, plus the
//! session/call target and stream-tag types shared across the shell replay
//! pipeline.

use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, RwLock};

use core_types::session_event::{
    ShellReplayBookmark, ShellReplayRef, ShellReplayState, ShellReplayStatus,
};

use super::text::decode_utf8_tail_bounded;
use super::{SHELL_REPLAY_FORMAT_VERSION, SHELL_REPLAY_PREVIEW_BYTES};

#[derive(Debug)]
pub(super) struct ActiveReplayState {
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

pub(super) static ACTIVE_REPLAYS: LazyLock<RwLock<HashMap<String, HashMap<String, ActiveReplayState>>>> =
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
    pub(super) fn as_byte(self) -> u8 {
        match self {
            Self::Stdout => 1,
            Self::Stderr => 2,
        }
    }

    pub(super) fn from_byte(value: u8) -> Result<Self, String> {
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

pub(super) fn insert_active(target: &ShellReplayTarget) {
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

pub(super) fn update_active_after_append(
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

pub(super) fn remove_active(target: &ShellReplayTarget) {
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
pub(super) fn active_registry_retained_bytes() -> usize {
    ACTIVE_REPLAYS
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .values()
        .flat_map(|states| states.values())
        .map(|state| std::mem::size_of::<ActiveReplayState>() + state.terminal_preview.capacity())
        .sum()
}

pub(super) fn append_tail(
    tail: &mut VecDeque<u8>,
    stream: ShellReplayStream,
    bytes: &[u8],
    capacity: usize,
) {
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
