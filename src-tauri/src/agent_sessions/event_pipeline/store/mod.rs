//! EventStore — high-performance per-session event storage
//!
//! Stores events in a `Vec<SessionEvent>` with O(1) lookup via `HashMap<String, usize>`.
//! Each instance manages one session; the command layer in `commands/mod.rs` holds
//! a `HashMap<sessionId, EventStore>` for multi-session support and handles
//! batch-throttled `es:changed` notifications to the frontend.
//!
//! # Submodules
//!
//! - `helpers`   — Pure free functions (transcript dedup, placeholder detection, etc.)
//! - `hydration` — Bulk load / merge operations (`set`, `append`, `merge_events`, etc.)
//! - `event_ops` — Single-event CRUD, streaming finalization, shell stamping, clear
//! - `tool_ops`  — Tool-call specific operations (spawning tool find + arg propagation)
//! - `repair`    — Post-load repair (`repair_subagent_links`, `cancel_orphan_interactive_events`)
//! - `turn_ops`  — Turn window management (`unload_turn_body`)

use std::collections::{HashMap, HashSet};

use crate::agent_sessions::event_pipeline::types::{
    SessionEvent, ShellReplayState, ShellReplayStatus,
};

mod event_ops;
mod helpers;
mod hydration;
mod repair;
mod tool_ops;
mod turn_ops;

/// Snapshot/EventStore terminal previews are deliberately bounded. The full
/// transcript lives in the append-only shell replay artifact.
pub(super) const MAX_SHELL_REPLAY_PREVIEW_BYTES: usize = 32 * 1024;

fn utf8_tail(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut start = value.len() - max_bytes;
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}

fn truncate_utf8_tail(value: &mut String, max_bytes: usize) {
    if value.len() > max_bytes {
        *value = utf8_tail(value, max_bytes).to_string();
    }
}

pub(super) fn bound_shell_replay_state(mut state: ShellReplayState) -> ShellReplayState {
    truncate_utf8_tail(&mut state.terminal_preview, MAX_SHELL_REPLAY_PREVIEW_BYTES);
    state
}

/// Merge a mutable live replay state without allowing a stale callback to
/// move the visible watermark or terminal status backwards.
pub(super) fn monotonic_shell_replay_state(
    existing: Option<&ShellReplayState>,
    incoming: ShellReplayState,
) -> ShellReplayState {
    let incoming = bound_shell_replay_state(incoming);
    let Some(existing) = existing else {
        return incoming;
    };
    if existing.replay_ref != incoming.replay_ref {
        return existing.clone();
    }

    // A durability failure can legitimately lower the visible watermark: for
    // example, crash recovery may discard a torn frame that an in-memory
    // running preview had already advertised. Incomplete is therefore
    // stronger than monotonic progress and must win before the watermark
    // comparison. Once incomplete, later running/complete callbacks remain
    // unable to revive the replay.
    if existing.status != ShellReplayStatus::Incomplete
        && incoming.status == ShellReplayStatus::Incomplete
    {
        return incoming;
    }
    if existing.status == ShellReplayStatus::Incomplete
        && incoming.status != ShellReplayStatus::Incomplete
    {
        return existing.clone();
    }

    let old_mark = existing.bookmark;
    let new_mark = incoming.bookmark;
    if new_mark.visible_through_sequence < old_mark.visible_through_sequence
        || new_mark.visible_bytes < old_mark.visible_bytes
    {
        return existing.clone();
    }

    // Incomplete is the strongest terminal state: once durability is known to
    // have failed it must never be replaced by running or complete. Complete
    // may still be corrected to incomplete when the final persistence barrier
    // fails after the in-memory state was tentatively updated.
    if existing.status == ShellReplayStatus::Complete
        && incoming.status == ShellReplayStatus::Running
    {
        return existing.clone();
    }

    incoming
}

/// Remove legacy whole-output copies from a new shell timeline event. This is
/// defense in depth: the executor's event factory already emits metadata-only
/// shell results, but EventStore must never become a second transcript store.
fn is_shell_event(event: &SessionEvent) -> bool {
    event.ui_canonical == core_types::tool_names::RUN_SHELL
        || matches!(
            event.function_name.as_str(),
            "run_shell"
                | "bash"
                | "shell"
                | "execute_command"
                | "run_terminal_command"
                | "terminal"
                | "terminal_command"
        )
        || event.shell_replay.is_some()
}

pub(super) fn sanitize_live_shell_event(event: &mut SessionEvent) {
    // A display alias such as `run_shell` is not proof that a durable replay
    // exists. External CLI providers share the alias but enter through a
    // different execution path. Only a concrete replay state authorizes
    // removal of their inline payload.
    if !is_shell_event(event) || event.shell_replay.is_none() {
        return;
    }

    if let serde_json::Value::Object(args) = &mut event.args {
        args.remove("streamOutput");
    }
    event.result = serde_json::json!({});
    if let Some(core_types::extracted::ExtractedData::Shell(shell)) = event.extracted.as_mut() {
        shell.output = None;
        shell.stream_output = None;
    }
}

/// Keep an external/unrecognized live shell bounded without ever turning it
/// into an empty card. Terminal events receive an explicit incomplete preview
/// state; running events keep only a bounded `streamOutput` until their final
/// provider payload is imported into a durable replay.
fn bound_unbacked_live_shell_event(event: &mut SessionEvent) {
    if !is_shell_event(event) || event.shell_replay.is_some() {
        return;
    }
    let preview = legacy_shell_text(event)
        .map(|text| utf8_tail(text, MAX_SHELL_REPLAY_PREVIEW_BYTES).to_string())
        .unwrap_or_default();
    if preview.is_empty() {
        return;
    }

    if event.display_status
        == crate::agent_sessions::event_pipeline::types::EventDisplayStatus::Running
    {
        event.result = serde_json::json!({});
        if let serde_json::Value::Object(args) = &mut event.args {
            args.insert(
                "streamOutput".to_string(),
                serde_json::Value::String(preview.clone()),
            );
        }
        if let Some(core_types::extracted::ExtractedData::Shell(shell)) = event.extracted.as_mut() {
            shell.output = None;
            shell.stream_output = Some(preview);
        }
        return;
    }

    let call_id = event.call_id.clone().unwrap_or_else(|| event.id.clone());
    event.shell_replay = Some(ShellReplayState {
        replay_ref: crate::agent_sessions::event_pipeline::types::ShellReplayRef {
            session_id: event.session_id.clone(),
            call_id,
            format_version: 1,
        },
        bookmark: Default::default(),
        terminal_preview: preview,
        status: ShellReplayStatus::Incomplete,
        error: Some("完整回放未建立，仅显示有界预览".to_string()),
        completed_at: Some(event.created_at.clone()),
    });
}

/// Borrow a legacy shell payload in place so hydration can copy only the
/// bounded preview. Returning an owned `String` here would briefly duplicate
/// an arbitrarily large historical transcript before it is truncated.
fn legacy_shell_text(event: &SessionEvent) -> Option<&str> {
    if let Some(core_types::extracted::ExtractedData::Shell(shell)) = event.extracted.as_ref() {
        if let Some(text) = shell.stream_output.as_ref().or(shell.output.as_ref()) {
            return Some(text.as_str());
        }
    }
    for path in [
        &["content"][..],
        &["observation"][..],
        &["output"][..],
        &["stdout"][..],
        &["stderr"][..],
        &["interleavedOutput"][..],
        &["output", "success", "interleavedOutput"][..],
        &["output", "success", "stdout"][..],
        &["output", "success", "stderr"][..],
        &["failure", "stderr"][..],
    ] {
        let mut value = &event.result;
        for key in path {
            let Some(next) = value.get(*key) else {
                value = &serde_json::Value::Null;
                break;
            };
            value = next;
        }
        if let Some(text) = value.as_str() {
            return Some(text);
        }
    }
    if let Some(text) = event
        .args
        .get("streamOutput")
        .and_then(|value| value.as_str())
    {
        return Some(text);
    }
    None
}

fn legacy_shell_exit_code(event: &SessionEvent) -> Option<i64> {
    if let Some(core_types::extracted::ExtractedData::Shell(shell)) = event.extracted.as_ref() {
        if shell.exit_code.is_some() {
            return shell.exit_code;
        }
    }
    for path in [
        &["exitCode"][..],
        &["exit_code"][..],
        &["output", "success", "exitCode"][..],
        &["failure", "exitCode"][..],
    ] {
        let mut value = &event.result;
        for key in path {
            let Some(next) = value.get(*key) else {
                value = &serde_json::Value::Null;
                break;
            };
            value = next;
        }
        if let Some(code) = value.as_i64() {
            return Some(code);
        }
    }
    None
}

/// Bound legacy cached shell payloads during hydration. Old sessions have no
/// durable replay bookmark, so we retain only a tail preview and explicitly
/// mark the synthetic ref incomplete; no readable byte watermark is forged.
pub(super) fn hydrate_shell_event_bounded(event: &mut SessionEvent) {
    if let Some(bookmarks) = event.shell_replay_bookmarks.as_mut() {
        for state in bookmarks.values_mut() {
            *state = bound_shell_replay_state(state.clone());
        }
    }
    if !is_shell_event(event) {
        return;
    }

    let legacy_preview = legacy_shell_text(event)
        .map(|text| utf8_tail(text, MAX_SHELL_REPLAY_PREVIEW_BYTES).to_string())
        .unwrap_or_default();
    let exit_code = legacy_shell_exit_code(event);

    if event.shell_replay.is_none() && !legacy_preview.is_empty() {
        let call_id = event.call_id.clone().unwrap_or_else(|| event.id.clone());
        event.shell_replay = Some(ShellReplayState {
            replay_ref: crate::agent_sessions::event_pipeline::types::ShellReplayRef {
                session_id: event.session_id.clone(),
                call_id,
                format_version: 1,
            },
            bookmark: Default::default(),
            terminal_preview: legacy_preview,
            status: ShellReplayStatus::Incomplete,
            error: Some("历史预览，完整输出不可恢复".to_string()),
            // Unknown legacy completion time must not be used as a historical
            // cursor fallback: doing so could reveal future output.
            completed_at: None,
        });
    } else if let Some(state) = event.shell_replay.take() {
        event.shell_replay = Some(bound_shell_replay_state(state));
    }

    if let (Some(code), serde_json::Value::Object(args)) = (exit_code, &mut event.args) {
        args.entry("shellExitCode".to_string())
            .or_insert_with(|| code.into());
    }
    sanitize_live_shell_event(event);
}

/// Capture active replay watermarks exactly once for a newly inserted live
/// timeline event. Upstream-provided entries win; the active registry only
/// fills missing calls. `Some(empty)` is intentional and distinguishes a new
/// event captured while no shell was active from a legacy row with no cursor.
pub(super) fn capture_shell_replay_bookmarks(
    event: &mut SessionEvent,
    active: &HashMap<String, ShellReplayState>,
) {
    let bookmarks = event
        .shell_replay_bookmarks
        .get_or_insert_with(HashMap::new);
    for (call_id, state) in active {
        if state.replay_ref.session_id != event.session_id || state.replay_ref.call_id != *call_id {
            continue;
        }
        bookmarks
            .entry(call_id.clone())
            .or_insert_with(|| bound_shell_replay_state(state.clone()));
    }
    for state in bookmarks.values_mut() {
        *state = bound_shell_replay_state(state.clone());
    }

    if event.action_type == "tool_call" {
        if let Some(call_id) = event.call_id.as_deref() {
            if let Some(active_state) = active.get(call_id) {
                event.shell_replay = Some(monotonic_shell_replay_state(
                    event.shell_replay.as_ref(),
                    active_state.clone(),
                ));
            }
        }
    }
    if let Some(state) = event.shell_replay.take() {
        event.shell_replay = Some(bound_shell_replay_state(state));
    }
    bound_unbacked_live_shell_event(event);
    sanitize_live_shell_event(event);
}

/// Same-ID updates may refresh mutable shell state, but the playback cursor
/// belongs to the timeline event's first insertion and is never replaced.
pub(super) fn preserve_first_insert_replay(existing: &SessionEvent, incoming: &mut SessionEvent) {
    incoming.shell_replay_bookmarks = existing.shell_replay_bookmarks.clone();
    incoming.shell_replay = match incoming.shell_replay.take() {
        Some(next) => Some(monotonic_shell_replay_state(
            existing.shell_replay.as_ref(),
            next,
        )),
        None => existing.shell_replay.clone(),
    };
}

pub(super) fn active_shell_replays_for_session(
    session_id: &str,
) -> HashMap<String, ShellReplayState> {
    agent_core::tools::impls::coding::exec::shell_replay::active_states_for_session(session_id)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HydrationMode {
    Full,
    RoundWindow,
    LivePartial,
}

/// Core event store for a single session.
pub struct EventStore {
    pub(super) events: Vec<SessionEvent>,
    pub(super) id_index: HashMap<String, usize>,
    pub(super) call_id_index: HashMap<String, usize>,
    pub(super) version: u64,
    pub(super) streaming: bool,
    pub(super) repo_id: Option<String>,
    pub(super) repo_path: Option<String>,
    pub(super) hydration_mode: HydrationMode,
    pub(super) changed_ids: HashSet<String>,
    pub(super) removed_ids: HashSet<String>,
    pub(super) last_full_snapshot_version: u64,
}

impl Default for EventStore {
    fn default() -> Self {
        Self::new()
    }
}

impl EventStore {
    pub fn new() -> Self {
        Self {
            events: Vec::with_capacity(256),
            id_index: HashMap::with_capacity(256),
            call_id_index: HashMap::with_capacity(64),
            version: 0,
            streaming: false,
            repo_id: None,
            repo_path: None,
            hydration_mode: HydrationMode::Full,
            changed_ids: HashSet::new(),
            removed_ids: HashSet::new(),
            last_full_snapshot_version: 0,
        }
    }

    // -------------------------------------------------------------------------
    // Repo context
    // -------------------------------------------------------------------------

    pub fn set_repo_context(&mut self, repo_id: Option<String>, repo_path: Option<String>) {
        self.repo_id = repo_id;
        self.repo_path = repo_path;
    }

    pub fn repo_id(&self) -> Option<&str> {
        self.repo_id.as_deref()
    }

    pub fn repo_path(&self) -> Option<&str> {
        self.repo_path.as_deref()
    }

    // -------------------------------------------------------------------------
    // Version / snapshot tracking
    // -------------------------------------------------------------------------

    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn should_emit_full_snapshot(&self) -> bool {
        self.last_full_snapshot_version == 0 || self.last_full_snapshot_version > self.version
    }

    pub fn mark_full_snapshot_emitted(&mut self) {
        self.last_full_snapshot_version = self.version;
        self.changed_ids.clear();
        self.removed_ids.clear();
    }

    pub fn take_delta_tracking(&mut self) -> (u64, Vec<String>, Vec<String>) {
        let base_version = self.last_full_snapshot_version;
        self.last_full_snapshot_version = self.version;
        let changed_ids = self.changed_ids.drain().collect();
        let removed_ids = self.removed_ids.drain().collect();
        (base_version, changed_ids, removed_ids)
    }

    // -------------------------------------------------------------------------
    // Streaming / hydration mode
    // -------------------------------------------------------------------------

    pub fn is_streaming(&self) -> bool {
        self.streaming
    }

    pub fn set_streaming(&mut self, streaming: bool) {
        self.streaming = streaming;
        if streaming && self.hydration_mode == HydrationMode::RoundWindow {
            self.hydration_mode = HydrationMode::LivePartial;
        }
    }

    pub fn hydration_mode(&self) -> HydrationMode {
        self.hydration_mode
    }

    pub fn mark_round_window(&mut self) {
        self.hydration_mode = HydrationMode::RoundWindow;
    }

    pub fn mark_full_hydration(&mut self) {
        self.hydration_mode = HydrationMode::Full;
    }

    pub(super) fn mark_live_partial_if_windowed(&mut self) {
        if self.hydration_mode == HydrationMode::RoundWindow {
            self.hydration_mode = HydrationMode::LivePartial;
        }
    }

    // -------------------------------------------------------------------------
    // Event accessors
    // -------------------------------------------------------------------------

    pub fn event_count(&self) -> usize {
        self.events.len()
    }

    pub fn events(&self) -> &[SessionEvent] {
        &self.events
    }

    pub fn last_event(&self) -> Option<&SessionEvent> {
        self.events.last()
    }

    // -------------------------------------------------------------------------
    // Delta / change tracking (private)
    // -------------------------------------------------------------------------

    pub(super) fn mark_changed(&mut self, id: impl Into<String>) {
        self.changed_ids.insert(id.into());
    }

    pub(super) fn mark_removed(&mut self, id: impl Into<String>) {
        let id = id.into();
        self.changed_ids.remove(&id);
        self.removed_ids.insert(id);
    }

    // -------------------------------------------------------------------------
    // Index management (private)
    // -------------------------------------------------------------------------

    pub(super) fn insert_index_entries(&mut self, event: &SessionEvent, idx: usize) {
        self.id_index.insert(event.id.clone(), idx);
        if let Some(ref call_id) = event.call_id {
            if event.action_type == "tool_call" {
                self.call_id_index.insert(call_id.clone(), idx);
            }
        }
    }

    pub(super) fn rebuild_indexes(&mut self) {
        self.id_index.clear();
        self.call_id_index.clear();
        for (idx, event) in self.events.iter().enumerate() {
            self.id_index.insert(event.id.clone(), idx);
            if let Some(ref call_id) = event.call_id {
                if event.action_type == "tool_call" {
                    self.call_id_index.insert(call_id.clone(), idx);
                }
            }
        }
    }

    pub(super) fn cap_events(&mut self) {
        use helpers::MAX_EVENTS;
        if self.events.len() > MAX_EVENTS {
            let drain_count = self.events.len() - MAX_EVENTS;
            let removed_ids: Vec<String> = self.events[..drain_count]
                .iter()
                .map(|event| event.id.clone())
                .collect();
            self.events.drain(..drain_count);
            for event_id in removed_ids {
                self.mark_removed(event_id);
            }
            self.rebuild_indexes();
        }
    }

    /// External-replay-only byte cap. Repeated bounded older-turn reads must
    /// not accumulate up to the generic 8,000-event limit (8,000 shell
    /// previews alone can exceed 250 MiB). Native SDE paths never call this.
    ///
    /// The retained set is a contiguous newest suffix. When the byte cut
    /// lands inside an older turn, advance to the next user row so the store
    /// drops that partial turn instead of rendering a detached body.
    pub fn cap_external_replay_bytes(&mut self, max_bytes: usize) -> Result<usize, String> {
        let mut retained_bytes = 2_usize; // `[]`
        let mut keep_from = self.events.len();
        for (index, event) in self.events.iter().enumerate().rev() {
            let event_bytes = serde_json::to_vec(event)
                .map_err(|error| format!("serialize external replay store event: {error}"))?
                .len();
            let separator = usize::from(keep_from < self.events.len());
            if retained_bytes
                .saturating_add(separator)
                .saturating_add(event_bytes)
                > max_bytes
            {
                break;
            }
            retained_bytes = retained_bytes
                .saturating_add(separator)
                .saturating_add(event_bytes);
            keep_from = index;
        }

        if keep_from > 0 && keep_from < self.events.len() {
            if let Some(next_turn) = self.events[keep_from..].iter().position(|event| {
                event.source == crate::agent_sessions::event_pipeline::types::EventSource::User
            }) {
                keep_from = keep_from.saturating_add(next_turn);
            }
        }

        if keep_from > 0 {
            let removed_ids = self.events[..keep_from]
                .iter()
                .map(|event| event.id.clone())
                .collect::<Vec<_>>();
            self.events.drain(..keep_from);
            for event_id in removed_ids {
                self.mark_removed(event_id);
            }
            self.rebuild_indexes();
        }

        serde_json::to_vec(&self.events)
            .map(|bytes| bytes.len())
            .map_err(|error| format!("serialize capped external replay store: {error}"))
    }

    /// Cap an older-page merge without immediately discarding the page that
    /// the foreground reader just requested.
    ///
    /// The requested page is retained first. Up to half of the budget then
    /// keeps its immediately newer resident neighbour so a prepend has a
    /// stable scroll anchor. The remaining budget retains the ordinary newest
    /// suffix. This policy is external-replay-only; native SDE stores never
    /// call it.
    pub fn cap_external_replay_bytes_preserving(
        &mut self,
        max_bytes: usize,
        preserved_event_ids: &HashSet<String>,
    ) -> Result<usize, String> {
        if preserved_event_ids.is_empty() {
            return self.cap_external_replay_bytes(max_bytes);
        }

        let event_bytes = self
            .events
            .iter()
            .map(|event| {
                serde_json::to_vec(event)
                    .map(|bytes| bytes.len())
                    .map_err(|error| format!("serialize external replay store event: {error}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut keep = vec![false; self.events.len()];
        let mut retained_bytes = 2_usize; // `[]`
        let mut retained_count = 0_usize;
        let mut last_preserved_index = None;

        for (index, (event, event_bytes)) in self.events.iter().zip(&event_bytes).enumerate() {
            if !preserved_event_ids.contains(&event.id) {
                continue;
            }
            let separator = usize::from(retained_count > 0);
            let next_bytes = retained_bytes
                .saturating_add(separator)
                .saturating_add(*event_bytes);
            if next_bytes > max_bytes {
                return Err(format!(
                    "requested external replay window exceeds the {max_bytes} byte resident budget"
                ));
            }
            keep[index] = true;
            retained_bytes = next_bytes;
            retained_count += 1;
            last_preserved_index = Some(index);
        }

        let Some(last_preserved_index) = last_preserved_index else {
            return self.cap_external_replay_bytes(max_bytes);
        };

        // Keep the immediately newer resident range as the prepend anchor, but
        // reserve at least half of the store for the newest live suffix.
        let neighbourhood_budget = max_bytes / 2;
        for (index, event_bytes) in event_bytes
            .iter()
            .enumerate()
            .skip(last_preserved_index.saturating_add(1))
        {
            if keep[index] {
                continue;
            }
            let separator = usize::from(retained_count > 0);
            let next_bytes = retained_bytes
                .saturating_add(separator)
                .saturating_add(*event_bytes);
            if next_bytes > neighbourhood_budget {
                break;
            }
            keep[index] = true;
            retained_bytes = next_bytes;
            retained_count += 1;
        }

        // Fill the remainder with the same newest-first priority used by the
        // ordinary external replay cap.
        for (index, event_bytes) in event_bytes.iter().enumerate().rev() {
            if keep[index] {
                continue;
            }
            let separator = usize::from(retained_count > 0);
            let next_bytes = retained_bytes
                .saturating_add(separator)
                .saturating_add(*event_bytes);
            if next_bytes > max_bytes {
                break;
            }
            keep[index] = true;
            retained_bytes = next_bytes;
            retained_count += 1;
        }

        let mut index = 0_usize;
        let mut removed_ids = Vec::new();
        self.events.retain(|event| {
            let retained = keep[index];
            index += 1;
            if !retained {
                removed_ids.push(event.id.clone());
            }
            retained
        });
        for event_id in removed_ids {
            self.mark_removed(event_id);
        }
        self.rebuild_indexes();

        serde_json::to_vec(&self.events)
            .map(|bytes| bytes.len())
            .map_err(|error| format!("serialize capped external replay store: {error}"))
    }

    pub(super) fn stamp_repo(&self, event: &mut SessionEvent) {
        if event.repo_id.is_none() {
            event.repo_id = self.repo_id.clone();
        }
        if event.repo_path.is_none() {
            event.repo_path = self.repo_path.clone();
        }
    }
}

#[cfg(test)]
#[path = "../tests/store_tests.rs"]
mod tests;
