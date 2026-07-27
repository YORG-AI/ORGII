//! Managed State
//!
//! `EventStoreState`: the Tauri-managed, multi-session `EventStore` registry.
//! Holds one `EventStore` per session id plus the active-session tracker and
//! the batched-notification bookkeeping consumed by [`super::schedule_notify`].

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use crate::agent_sessions::event_pipeline::session_manager::SessionStoreManager;
use crate::agent_sessions::event_pipeline::store::EventStore;

/// Multi-session EventStore state.
///
/// Holds one `EventStore` per session id. The "active" session is tracked by
/// `SessionStoreManager` and is the default target when a command is invoked
/// without an explicit `session_id` argument. Any session (active or not) can
/// be read, written, and broadcast independently — this is what enables
/// SubagentBlock chat-in-chat and cross-session replay.
pub struct EventStoreState {
    /// All live per-session stores. Populated lazily: the first write or read
    /// for a session materializes its `EventStore`.
    pub stores: Mutex<HashMap<String, EventStore>>,
    pub session_manager: Mutex<SessionStoreManager>,
    /// Tracks which sessions already have a batched notification pending.
    pub notify_pending: Mutex<HashSet<String>>,
}

impl Default for EventStoreState {
    fn default() -> Self {
        Self::new()
    }
}

impl EventStoreState {
    pub fn new() -> Self {
        Self {
            stores: Mutex::new(HashMap::new()),
            session_manager: Mutex::new(SessionStoreManager::new()),
            notify_pending: Mutex::new(HashSet::new()),
        }
    }

    /// Resolve the target session id for a command.
    ///
    /// - If `explicit` is `Some`, returns it unchanged.
    /// - Otherwise falls back to the active session from `SessionStoreManager`.
    /// - Returns an error string when neither is available (mis-use by caller).
    pub fn resolve_session_id(&self, explicit: Option<String>) -> Result<String, String> {
        if let Some(sid) = explicit {
            return Ok(sid);
        }
        let mgr = self
            .session_manager
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        mgr.active_id()
            .map(|s| s.to_string())
            .ok_or_else(|| "no active session and no explicit sessionId provided".to_string())
    }

    /// Run a closure against the target session's store (creating it if absent).
    ///
    /// Automatically registers the session in `SessionStoreManager` so it
    /// participates in LRU eviction and `active_id` resolution.
    pub fn with_store_mut<F, R>(&self, session_id: &str, f: F) -> R
    where
        F: FnOnce(&mut EventStore) -> R,
    {
        {
            let mut mgr = self
                .session_manager
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            mgr.register(session_id);
        }
        let mut stores = self.stores.lock().unwrap_or_else(|e| e.into_inner());
        let store = stores.entry(session_id.to_string()).or_default();
        f(store)
    }

    /// Run a closure against the target session's store if it exists.
    /// Returns `None` without materializing a store for unknown sessions.
    pub fn with_store_opt<F, R>(&self, session_id: &str, f: F) -> Option<R>
    where
        F: FnOnce(&EventStore) -> R,
    {
        let stores = self.stores.lock().unwrap_or_else(|e| e.into_inner());
        stores.get(session_id).map(f)
    }
}
