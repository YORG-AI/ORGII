//! In-memory live agent-status registry fed by lifecycle hooks.
//!
//! `POST /hooks/agent-status` (see `api::agent_status_ingest`) delivers one
//! normalized [`AgentStatusEventV1`] per hook invocation; this module owns
//! the cross-event state: the last-status map keyed by canonical session id,
//! fanout to the frontend, staleness rules, terminal-status persistence, and
//! the debounced `last-status.json` cache that survives restarts.
//!
//! Privacy: entries carry short tool/prompt previews and live only here and
//! in the owner-only cache file — never in `sessions.db` (only the bare
//! status string of terminal states is written to `orgtrack_core_sessions`).

use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};

use database::db::get_connection;
use orgtrack_core::status_adapter::{AgentLiveState, AgentStatusEventV1};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

pub const AGENT_LIVE_STATUS_CHANGED_EVENT: &str = "agent-live-status:changed";

/// A `working` entry older than this is treated as expired: a healthy turn
/// keeps emitting tool hooks, a killed CLI stops.
const WORKING_STALE_SECS: i64 = 180;
/// `waiting` outlives `working` (a permission prompt can sit unanswered) but
/// is garbage-collected eventually.
const WAITING_STALE_SECS: i64 = 30 * 60;
/// Hydration horizon for `last-status.json` and the map GC horizon; also how
/// long sticky `done`/`failed` entries stay useful for "unread" affordances.
const ENTRY_TTL_SECS: i64 = 30 * 60;
/// Same (session, state, tool) within this window updates the map but skips
/// the frontend fanout — guards PreToolUse/PostToolUse spam.
const FANOUT_COALESCE_MS: i64 = 250;
/// Debounce for persisting the map to `last-status.json`.
const PERSIST_DEBOUNCE_MS: u64 = 2_000;

const CACHE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveStatusEntry {
    pub event: AgentStatusEventV1,
    pub received_at_ms: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct LiveStatusCacheFile {
    version: u32,
    entries: Vec<LiveStatusEntry>,
}

/// Wire shape shared by the Tauri event payload and `agent_live_status_list`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveStatusWire {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orgii_session_id: Option<String>,
    pub source: String,
    /// Existing session-status vocabulary (`running`, `waiting_for_user`, ...).
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_input_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interactive_prompt: Option<String>,
    pub is_interrupt: bool,
    pub updated_at_ms: i64,
}

fn registry() -> &'static RwLock<HashMap<String, LiveStatusEntry>> {
    static LIVE: OnceLock<RwLock<HashMap<String, LiveStatusEntry>>> = OnceLock::new();
    LIVE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn last_fanout() -> &'static Mutex<HashMap<String, (String, i64)>> {
    static LAST: OnceLock<Mutex<HashMap<String, (String, i64)>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(HashMap::new()))
}

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
static PERSIST_SCHEDULED: AtomicBool = AtomicBool::new(false);

pub fn init_app_handle(handle: tauri::AppHandle) {
    APP_HANDLE.set(handle).ok();
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn wire_from_entry(entry: &LiveStatusEntry) -> LiveStatusWire {
    LiveStatusWire {
        session_id: entry.event.session_id.clone(),
        orgii_session_id: entry.event.orgii_session_id.clone(),
        source: entry.event.source.clone(),
        status: entry.event.state.as_session_status_str(),
        tool_name: entry.event.tool_name.clone(),
        tool_input_preview: entry.event.tool_input_preview.clone(),
        interactive_prompt: entry.event.interactive_prompt.clone(),
        is_interrupt: entry.event.is_interrupt,
        updated_at_ms: entry.received_at_ms,
    }
}

fn is_entry_fresh(entry: &LiveStatusEntry, now_ms: i64) -> bool {
    let age_secs = (now_ms - entry.received_at_ms) / 1_000;
    match entry.event.state {
        AgentLiveState::Working => age_secs < WORKING_STALE_SECS,
        AgentLiveState::Waiting => age_secs < WAITING_STALE_SECS,
        AgentLiveState::Done | AgentLiveState::Failed => age_secs < ENTRY_TTL_SECS,
    }
}

/// Ingest one normalized status event (called from the loopback HTTP route).
pub fn ingest(event: AgentStatusEventV1) {
    let received_at_ms = now_ms();
    let entry = LiveStatusEntry {
        event,
        received_at_ms,
    };

    {
        let mut map = registry().write().unwrap_or_else(|poisoned| {
            // A panicked writer can't leave the map structurally broken
            // (plain HashMap inserts); keep serving rather than wedging
            // every future hook post.
            poisoned.into_inner()
        });
        map.insert(entry.event.session_id.clone(), entry.clone());
        if let Some(orgii_id) = entry.event.orgii_session_id.clone() {
            map.insert(orgii_id, entry.clone());
        }
        // Opportunistic GC keeps the map bounded without a dedicated timer.
        map.retain(|_, existing| {
            received_at_ms - existing.received_at_ms < ENTRY_TTL_SECS * 1_000
        });
    }

    if entry.event.state.is_terminal() {
        persist_terminal_status(&entry);
    }
    // TUI-hosted managed sessions have no runner process: their identity
    // binding and status rows are driven from these events. Must run before
    // the fanout coalesce below (which can early-return) — the bridge has
    // its own cheap change-memo.
    crate::agent_sessions::cli::tui_bridge::on_live_status_event(&entry.event);
    schedule_cache_persist();

    // Coalesce identical rapid-fire updates (map above is always current).
    let fanout_key = format!(
        "{}|{}",
        entry.event.state.as_session_status_str(),
        entry.event.tool_name.as_deref().unwrap_or_default()
    );
    {
        let mut last = last_fanout().lock().unwrap_or_else(|p| p.into_inner());
        if let Some((previous_key, at_ms)) = last.get(&entry.event.session_id) {
            if *previous_key == fanout_key && received_at_ms - at_ms < FANOUT_COALESCE_MS {
                return;
            }
        }
        last.insert(
            entry.event.session_id.clone(),
            (fanout_key, received_at_ms),
        );
        last.retain(|_, (_, at_ms)| received_at_ms - *at_ms < ENTRY_TTL_SECS * 1_000);
    }

    let wire = wire_from_entry(&entry);
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit(AGENT_LIVE_STATUS_CHANGED_EVENT, &wire);
    }
    if let Ok(message) = serde_json::to_string(&serde_json::json!({
        "type": "agent.live_status",
        "payload": wire,
    })) {
        crate::api::websocket_handler::broadcast(message);
    }
}

/// Terminal states are durable facts worth surviving the in-memory map:
/// stamp them onto the canonical session row (no-op if the session has not
/// been imported yet — the scanner births the row with fresh status later).
fn persist_terminal_status(entry: &LiveStatusEntry) {
    let session_id = entry.event.session_id.clone();
    let status = entry.event.state.as_session_status_str().to_string();
    let completed_at = entry.event.occurred_at.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(conn) = get_connection() else {
            return;
        };
        let _ = conn.execute(
            "UPDATE orgtrack_core_sessions SET status = ?1, completed_at = ?2 WHERE session_id = ?3",
            rusqlite::params![status, completed_at, session_id],
        );
    });
}

/// Current live status for a session if it is still fresh under the
/// per-state staleness rules. Returns the status string plus the entry.
pub fn effective_live_status(session_id: &str) -> Option<(&'static str, LiveStatusEntry)> {
    let map = registry().read().unwrap_or_else(|p| p.into_inner());
    let entry = map.get(session_id)?;
    if !is_entry_fresh(entry, now_ms()) {
        return None;
    }
    Some((entry.event.state.as_session_status_str(), entry.clone()))
}

/// Drop a session's live status (managed-session terminal transitions: the
/// runner's exit-code truth wins over any lingering hook state).
pub fn clear(session_ids: &[&str]) {
    let mut map = registry().write().unwrap_or_else(|p| p.into_inner());
    let mut removed = false;
    for session_id in session_ids {
        if session_id.is_empty() {
            continue;
        }
        removed |= map.remove(*session_id).is_some();
    }
    drop(map);
    if removed {
        schedule_cache_persist();
    }
}

/// A transcript updated within this window reads as `running` even without
/// hook signals — the fallback for CLIs with no hook mechanism.
const MTIME_ACTIVE_WINDOW_SECS: i64 = 60;

/// Decorate an imported sidebar/list row: a fresh hook-derived status wins;
/// otherwise recent transcript activity (updated_at within 60s) reads as
/// running. `None` keeps the historical default ("completed").
pub fn live_status_for_imported_row(
    session_id: &str,
    updated_at_iso: &str,
) -> Option<(&'static str, bool)> {
    if let Some((status, entry)) = effective_live_status(session_id) {
        // Done matches the imported default; skip the override so terminal
        // rows keep their plain historical rendering.
        if entry.event.state != AgentLiveState::Done {
            let is_active = matches!(
                entry.event.state,
                AgentLiveState::Working | AgentLiveState::Waiting
            );
            return Some((status, is_active));
        }
        return None;
    }
    let updated_at_ms = chrono::DateTime::parse_from_rfc3339(updated_at_iso)
        .ok()?
        .timestamp_millis();
    if now_ms() - updated_at_ms < MTIME_ACTIVE_WINDOW_SECS * 1_000 {
        return Some(("running", true));
    }
    None
}

/// Snapshot of all fresh entries, for initial frontend hydration.
pub fn list_fresh() -> Vec<LiveStatusWire> {
    let now = now_ms();
    let map = registry().read().unwrap_or_else(|p| p.into_inner());
    let mut seen_session_ids = std::collections::HashSet::new();
    map.values()
        .filter(|entry| is_entry_fresh(entry, now))
        .filter(|entry| seen_session_ids.insert(entry.event.session_id.clone()))
        .map(wire_from_entry)
        .collect()
}

/// Load `last-status.json` into the map at startup, dropping expired entries.
pub fn hydrate_from_disk() {
    let path = app_paths::agent_status_cache_path();
    let Ok(bytes) = fs::read(&path) else {
        return;
    };
    let Ok(cache) = serde_json::from_slice::<LiveStatusCacheFile>(&bytes) else {
        tracing::warn!("[AgentLiveStatus] Ignoring unreadable {}", path.display());
        return;
    };
    if cache.version != CACHE_SCHEMA_VERSION {
        return;
    }
    let now = now_ms();
    let mut map = registry().write().unwrap_or_else(|p| p.into_inner());
    for entry in cache.entries {
        if now - entry.received_at_ms >= ENTRY_TTL_SECS * 1_000 {
            continue;
        }
        map.insert(entry.event.session_id.clone(), entry.clone());
        if let Some(orgii_id) = entry.event.orgii_session_id.clone() {
            map.insert(orgii_id, entry);
        }
    }
}

fn schedule_cache_persist() {
    if PERSIST_SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(PERSIST_DEBOUNCE_MS)).await;
        PERSIST_SCHEDULED.store(false, Ordering::SeqCst);
        persist_cache_now();
    });
}

fn persist_cache_now() {
    let entries = {
        let map = registry().read().unwrap_or_else(|p| p.into_inner());
        // The map holds each entry once per key (canonical + orgii alias);
        // dedupe on the canonical id so the file stays minimal.
        let mut seen = std::collections::HashSet::new();
        map.values()
            .filter(|entry| seen.insert(entry.event.session_id.clone()))
            .cloned()
            .collect::<Vec<_>>()
    };
    let cache = LiveStatusCacheFile {
        version: CACHE_SCHEMA_VERSION,
        entries,
    };
    let Ok(bytes) = serde_json::to_vec(&cache) else {
        return;
    };
    let path = app_paths::agent_status_cache_path();
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let temp_path = parent.join(format!(".last-status.{}.tmp", std::process::id()));
    if fs::write(&temp_path, bytes).is_err() {
        return;
    }
    app_paths::set_sensitive_file_permissions(&temp_path).ok();
    if fs::rename(&temp_path, &path).is_err() {
        let _ = fs::remove_file(&temp_path);
    }
}

/// Tauri command: fresh live statuses for initial frontend hydration.
#[tauri::command]
pub fn agent_live_status_list() -> Vec<LiveStatusWire> {
    list_fresh()
}

#[cfg(test)]
mod tests {
    use super::*;
    use orgtrack_core::status_adapter::AGENT_STATUS_SCHEMA_VERSION;

    fn event(session_id: &str, state: AgentLiveState) -> AgentStatusEventV1 {
        AgentStatusEventV1 {
            schema_version: AGENT_STATUS_SCHEMA_VERSION,
            source: "claude_code".to_string(),
            source_session_id: session_id.to_string(),
            session_id: format!("claudecodeapp-{session_id}"),
            state,
            event_name: "Test".to_string(),
            tool_name: None,
            tool_input_preview: None,
            interactive_prompt: None,
            is_interrupt: false,
            cwd: None,
            orgii_session_id: None,
            occurred_at: "2026-07-17T10:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn staleness_rules_per_state() {
        let now = now_ms();
        let fresh_working = LiveStatusEntry {
            event: event("a", AgentLiveState::Working),
            received_at_ms: now - 10_000,
        };
        let stale_working = LiveStatusEntry {
            event: event("a", AgentLiveState::Working),
            received_at_ms: now - (WORKING_STALE_SECS + 5) * 1_000,
        };
        let old_waiting = LiveStatusEntry {
            event: event("a", AgentLiveState::Waiting),
            received_at_ms: now - (WORKING_STALE_SECS + 5) * 1_000,
        };
        let ancient_waiting = LiveStatusEntry {
            event: event("a", AgentLiveState::Waiting),
            received_at_ms: now - (WAITING_STALE_SECS + 5) * 1_000,
        };
        let done = LiveStatusEntry {
            event: event("a", AgentLiveState::Done),
            received_at_ms: now - (WORKING_STALE_SECS + 5) * 1_000,
        };
        assert!(is_entry_fresh(&fresh_working, now));
        assert!(!is_entry_fresh(&stale_working, now));
        assert!(is_entry_fresh(&old_waiting, now));
        assert!(!is_entry_fresh(&ancient_waiting, now));
        assert!(is_entry_fresh(&done, now));
    }

    #[test]
    fn state_maps_to_existing_status_vocabulary() {
        assert_eq!(AgentLiveState::Working.as_session_status_str(), "running");
        assert_eq!(
            AgentLiveState::Waiting.as_session_status_str(),
            "waiting_for_user"
        );
        assert_eq!(AgentLiveState::Done.as_session_status_str(), "completed");
        assert_eq!(AgentLiveState::Failed.as_session_status_str(), "failed");
    }
}
