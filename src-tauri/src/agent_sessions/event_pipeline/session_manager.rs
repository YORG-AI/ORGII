//! SessionStoreManager — session metadata + LRU eviction policy
//!
//! Each session now owns its own `EventStore` instance (held by
//! `EventStoreState::stores`). This manager is the pure policy layer:
//!
//! - tracks which session is currently *active* (default target when commands
//!   omit `session_id`),
//! - keeps a pin set for long-running agent ownership; rebuildable bounded
//!   external stores may still be dropped under aggregate byte pressure,
//! - maintains an LRU order of "idle" sessions and enforces max cache size.
//!
//! All event data lives in the per-session stores. This struct does not touch
//! `SessionEvent` values — it only decides which session ids are eligible for
//! eviction from the outer `HashMap<String, EventStore>`.

use std::collections::{HashMap, HashSet, VecDeque};

/// Maximum number of idle (unpinned) sessions kept in the LRU ring.
const MAX_CACHED_IDLE: usize = 15;
/// Total cap across idle + pinned.
const MAX_TOTAL_CACHED: usize = 25;
/// Byte budget for stores whose owners publish an estimate (bounded external
/// replay does; native SDE stores intentionally keep their existing policy).
const MAX_TRACKED_CACHED_BYTES: usize = 96 * 1024 * 1024;

/// Metadata about a cached session. Events live in
/// `EventStoreState::stores[session_id]`; this struct only tracks "when was
/// this last touched" so the LRU policy has a tiebreaker.
#[derive(Debug, Clone)]
struct SessionMeta {
    touched_at_ms: u64,
    estimated_bytes: usize,
}

/// Session registry + LRU policy engine.
pub struct SessionStoreManager {
    /// All known sessions (active + idle + pinned). Mirrors the key set of the
    /// outer stores `HashMap` — kept in sync by the `EventStoreState` helpers.
    known: HashMap<String, SessionMeta>,
    /// Running-session ownership. Count-based LRU never evicts these entries.
    /// Aggregate byte pressure may drop a rebuildable external store while
    /// preserving this pin so the next write/reopen restores it as pinned.
    pinned: HashSet<String>,
    /// FIFO of unpinned sessions in touched order (front = oldest).
    lru_order: VecDeque<String>,
    /// The currently active session (default target when `session_id` is
    /// omitted by Tauri commands).
    active_id: Option<String>,
}

impl Default for SessionStoreManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionStoreManager {
    pub fn new() -> Self {
        Self {
            known: HashMap::with_capacity(MAX_TOTAL_CACHED),
            pinned: HashSet::new(),
            lru_order: VecDeque::with_capacity(MAX_CACHED_IDLE),
            active_id: None,
        }
    }

    pub fn active_id(&self) -> Option<&str> {
        self.active_id.as_deref()
    }

    /// Set the active session. If the session isn't known yet, it's registered
    /// and touched. Returns the ids that should be evicted from the outer
    /// stores map as a result of LRU pressure.
    pub fn set_active(&mut self, session_id: &str) -> Vec<String> {
        if let Some(ref old) = self.active_id {
            if old == session_id {
                return Vec::new();
            }
            // Demote the previous active session into the LRU ring.
            self.touch_lru(old.clone());
        }
        self.active_id = Some(session_id.to_string());
        self.register(session_id);
        self.enforce_limits()
    }

    /// Register a session (on first write / subscription). Idempotent.
    pub fn register(&mut self, session_id: &str) {
        self.known
            .entry(session_id.to_string())
            .and_modify(|m| m.touched_at_ms = now_ms())
            .or_insert_with(|| SessionMeta {
                touched_at_ms: now_ms(),
                estimated_bytes: 0,
            });
        if !self.pinned.contains(session_id)
            && self.active_id.as_deref() != Some(session_id)
            && !self.lru_order.iter().any(|id| id == session_id)
        {
            self.lru_order.push_back(session_id.to_string());
        }
    }

    /// Publish the current bounded-store footprint and enforce the aggregate
    /// byte LRU. Native SDE callers never invoke this, so their cache behavior
    /// remains unchanged.
    pub fn update_estimated_bytes(
        &mut self,
        session_id: &str,
        estimated_bytes: usize,
    ) -> Vec<String> {
        self.register(session_id);
        if let Some(meta) = self.known.get_mut(session_id) {
            meta.estimated_bytes = estimated_bytes;
        }
        self.enforce_limits()
    }

    /// Add a conservative upper bound for a generic bounded-replay mutation.
    /// Same-ID upserts deliberately over-count; an exact compaction pass resets
    /// the estimate when it reaches the per-store threshold.
    pub fn add_estimated_bytes(
        &mut self,
        session_id: &str,
        added_bytes: usize,
    ) -> (usize, Vec<String>) {
        self.register(session_id);
        let estimated_bytes = if let Some(meta) = self.known.get_mut(session_id) {
            meta.estimated_bytes = meta.estimated_bytes.saturating_add(added_bytes);
            meta.estimated_bytes
        } else {
            0
        };
        let evicted = self.enforce_limits();
        (estimated_bytes, evicted)
    }

    /// Pin a session (agent started running). Pinned sessions skip LRU eviction.
    pub fn pin(&mut self, session_id: &str) {
        self.register(session_id);
        self.pinned.insert(session_id.to_string());
        self.remove_lru(session_id);
    }

    /// Unpin a session (agent finished). Session becomes eligible for eviction.
    pub fn unpin(&mut self, session_id: &str) -> Vec<String> {
        self.pinned.remove(session_id);
        if self.known.contains_key(session_id) && self.active_id.as_deref() != Some(session_id) {
            self.touch_lru(session_id.to_string());
        }
        self.enforce_limits()
    }

    pub fn is_pinned(&self, session_id: &str) -> bool {
        self.pinned.contains(session_id)
    }

    pub fn has_known(&self, session_id: &str) -> bool {
        self.known.contains_key(session_id)
    }

    /// Mark a session as recently touched (LRU promotion).
    pub fn touch(&mut self, session_id: &str) {
        self.register(session_id);
    }

    /// Explicitly forget a session. Caller is responsible for removing the
    /// backing store entry.
    pub fn evict(&mut self, session_id: &str) {
        self.known.remove(session_id);
        self.pinned.remove(session_id);
        self.remove_lru(session_id);
        if self.active_id.as_deref() == Some(session_id) {
            self.active_id = None;
        }
    }

    pub fn clear(&mut self) {
        self.known.clear();
        self.pinned.clear();
        self.lru_order.clear();
        self.active_id = None;
    }

    pub fn known_count(&self) -> usize {
        self.known.len()
    }

    pub fn pinned_count(&self) -> usize {
        self.pinned.len()
    }

    pub fn idle_count(&self) -> usize {
        self.lru_order.len()
    }

    // =========================================================================
    // LRU management
    // =========================================================================

    fn touch_lru(&mut self, session_id: String) {
        if self.pinned.contains(&session_id) {
            return;
        }
        self.remove_lru(&session_id);
        self.lru_order.push_back(session_id.clone());
        if let Some(meta) = self.known.get_mut(&session_id) {
            meta.touched_at_ms = now_ms();
        }
    }

    fn remove_lru(&mut self, session_id: &str) {
        self.lru_order.retain(|id| id != session_id);
    }

    /// Returns session ids that should be dropped from the backing stores.
    fn enforce_limits(&mut self) -> Vec<String> {
        let mut evicted = Vec::new();
        while self.lru_order.len() > MAX_CACHED_IDLE {
            if let Some(oldest) = self.lru_order.pop_front() {
                if self.active_id.as_deref() != Some(&oldest) && !self.pinned.contains(&oldest) {
                    self.known.remove(&oldest);
                    evicted.push(oldest);
                }
            } else {
                break;
            }
        }
        while self.known.len() > MAX_TOTAL_CACHED {
            if let Some(oldest) = self.lru_order.pop_front() {
                if self.active_id.as_deref() != Some(&oldest) && !self.pinned.contains(&oldest) {
                    self.known.remove(&oldest);
                    evicted.push(oldest);
                }
            } else {
                break;
            }
        }
        while self.tracked_bytes() > MAX_TRACKED_CACHED_BYTES {
            // Only owners that explicitly published a positive estimate are
            // rebuildable bounded-replay stores. Native SDE stores retain the
            // legacy estimate of zero and must never become collateral damage
            // of the external byte budget. A non-active running external store
            // may be removed, but its pin remains as owner state so rebuilding
            // it does not accidentally make it count-evictable.
            let oldest_rebuildable = self
                .known
                .iter()
                .filter(|(session_id, meta)| {
                    meta.estimated_bytes > 0
                        && self.active_id.as_deref() != Some(session_id.as_str())
                })
                .min_by(|(left_id, left), (right_id, right)| {
                    left.touched_at_ms
                        .cmp(&right.touched_at_ms)
                        .then_with(|| left_id.cmp(right_id))
                })
                .map(|(session_id, _)| session_id.clone());
            let Some(oldest) = oldest_rebuildable else {
                break;
            };
            self.known.remove(&oldest);
            self.remove_lru(&oldest);
            evicted.push(oldest);
        }
        evicted
    }

    fn tracked_bytes(&self) -> usize {
        self.known.values().fold(0_usize, |total, meta| {
            total.saturating_add(meta.estimated_bytes)
        })
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
#[path = "tests/session_manager_tests.rs"]
mod tests;
