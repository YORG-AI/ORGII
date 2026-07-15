//! Per-session state for Plan mode — the plan-file slot cache and the
//! pre-Plan mode snapshot.
//!
//! These two structures are cheap, in-memory, and session-scoped. Nothing in
//! here touches the DB: the plan file itself is the disk artifact, and
//! `pre_plan_mode` only needs to survive for the lifetime of a Plan session
//! (it's consulted once by `agent_plan_approval_response` — the Build-button
//! click handler — to restore the previous mode on approval).
//!
//! Lock discipline: both maps use `std::sync::Mutex`. Hold the guard for
//! the minimal code needed and never across `.await` points.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::session::AgentExecMode;

/// What we cached the first (or last) time `create_plan` ran in this session.
///
/// Re-calling `create_plan` with the same `title` keeps the same slug+hash+path
/// so iterating the plan just overwrites the same file. Calling with a
/// different title (or with `new_plan: true`) rotates the slot.
#[derive(Debug, Clone)]
pub struct PlanSlot {
    pub title: String,
    pub slug: String,
    pub hash: String,
    pub resolved_path: PathBuf,
}

/// Cache of the current plan slot per session.
///
/// Cloneable so it can be shared across tool contexts; `create_plan` is
/// currently the only consumer (after exit_plan_mode was retired) but the
/// cache is session-scoped and the clear-on-approval path still depends on it.
#[derive(Debug, Clone, Default)]
pub struct PlanSlotCache {
    inner: Arc<Mutex<HashMap<String, PlanSlot>>>,
}

impl PlanSlotCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns the current slot for the session, if any.
    pub fn get(&self, session_id: &str) -> Option<PlanSlot> {
        self.inner
            .lock()
            .ok()
            .and_then(|guard| guard.get(session_id).cloned())
    }

    /// Inserts or replaces the slot for the session.
    pub fn set(&self, session_id: &str, slot: PlanSlot) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.insert(session_id.to_string(), slot);
        }
    }

    /// Clears the slot (called by `agent_plan_approval_response` after the
    /// user clicks Build).
    pub fn clear(&self, session_id: &str) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.remove(session_id);
        }
    }
}

/// Pre-Plan mode snapshot: remembers the mode a session was in *before* it
/// entered Plan mode, so the Build-button click handler
/// (`agent_plan_approval_response`) can restore it on approval.
///
/// Entering Plan repeatedly (e.g., approve → re-enter) overwrites the snapshot
/// with the mode that was active at the *new* entry: the pre-Plan mode is
/// always "whatever you were in the last time you said 'take me to Plan'".
#[derive(Debug, Clone, Default)]
pub struct PrePlanModeCache {
    inner: Arc<Mutex<HashMap<String, AgentExecMode>>>,
}

impl PrePlanModeCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, session_id: &str) -> Option<AgentExecMode> {
        self.inner
            .lock()
            .ok()
            .and_then(|guard| guard.get(session_id).copied())
    }

    pub fn set(&self, session_id: &str, mode: AgentExecMode) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.insert(session_id.to_string(), mode);
        }
    }

    pub fn take(&self, session_id: &str) -> Option<AgentExecMode> {
        self.inner
            .lock()
            .ok()
            .and_then(|mut guard| guard.remove(session_id))
    }
}

/// Coordinator-requested `AgentExecMode` override.
///
/// Set by the inbox-drain side-effect path when the recipient observes
/// a historical `AgentMessage::ExecModeSetRequest` already persisted by an
/// older build. New Agent Org work carries mode on `TaskAssigned`.
/// Consumed (`take`) by the next call into `resolve_agent_mode` so the
/// next turn launches in the requested mode without the LLM having to
/// echo the override back. Once consumed, the cache resets — a
/// follow-up coordinator override has to be sent explicitly (one-shot,
/// not sticky).
#[derive(Debug, Clone, Default)]
pub struct RequestedExecModeCache {
    inner: Arc<Mutex<HashMap<String, AgentExecMode>>>,
}

impl RequestedExecModeCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&self, session_id: &str, mode: AgentExecMode) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.insert(session_id.to_string(), mode);
        }
    }

    pub fn take(&self, session_id: &str) -> Option<AgentExecMode> {
        self.inner
            .lock()
            .ok()
            .and_then(|mut guard| guard.remove(session_id))
    }

    pub fn peek(&self, session_id: &str) -> Option<AgentExecMode> {
        self.inner
            .lock()
            .ok()
            .and_then(|guard| guard.get(session_id).copied())
    }
}

/// Most recently RESOLVED (approved or rejected) plan for a session.
///
/// Feeds the Plan-mode re-entry note: when a session returns to Plan mode
/// after a resolution, the prompt suffix points the model at the prior
/// plan file so iterative planning extends it instead of duplicating or
/// contradicting it (CC `plan_mode_reentry` parity).
#[derive(Debug, Clone)]
pub struct LastResolvedPlan {
    pub plan_path: String,
    pub plan_title: String,
    pub approved: bool,
}

/// Process-global store, keyed by session id.
///
/// Global (not a session-object field like the caches above) because the
/// reader is a prompt section that only carries a session id. Written by
/// `interaction::plan_approval::resolve_pending` (the single resolution
/// chokepoint), cleared by `mark_ready` when a new pending plan supersedes
/// the note. In-memory only — the hint is best-effort and need not survive
/// a restart.
fn last_resolved_plans() -> &'static Mutex<HashMap<String, LastResolvedPlan>> {
    static STORE: std::sync::OnceLock<Mutex<HashMap<String, LastResolvedPlan>>> =
        std::sync::OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn record_last_resolved_plan(session_id: &str, plan: LastResolvedPlan) {
    if let Ok(mut guard) = last_resolved_plans().lock() {
        guard.insert(session_id.to_string(), plan);
    }
}

pub fn last_resolved_plan(session_id: &str) -> Option<LastResolvedPlan> {
    last_resolved_plans()
        .lock()
        .ok()
        .and_then(|guard| guard.get(session_id).cloned())
}

pub fn clear_last_resolved_plan(session_id: &str) {
    if let Ok(mut guard) = last_resolved_plans().lock() {
        guard.remove(session_id);
    }
}

/// Tracks the most recent non-Plan `AgentExecMode` observed per session.
///
/// This is written every turn the user is in a non-Plan mode and read
/// exactly once, when the session transitions *into* Plan mode, so that
/// `agent_plan_approval_response` (Build click) knows where to go back
/// to. Think of it as a small "most recently used mode" sidecar — it is
/// *not* a general-purpose history.
#[derive(Debug, Clone, Default)]
pub struct LastNonPlanModeCache {
    inner: Arc<Mutex<HashMap<String, AgentExecMode>>>,
}

impl LastNonPlanModeCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, session_id: &str) -> Option<AgentExecMode> {
        self.inner
            .lock()
            .ok()
            .and_then(|guard| guard.get(session_id).copied())
    }

    pub fn set(&self, session_id: &str, mode: AgentExecMode) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.insert(session_id.to_string(), mode);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn sample_slot() -> PlanSlot {
        PlanSlot {
            title: "Refactor Auth".into(),
            slug: "refactor-auth".into(),
            hash: "deadbeef".into(),
            resolved_path: PathBuf::from("/tmp/x/.orgii/plans/refactor-auth_deadbeef.plan.md"),
        }
    }

    #[test]
    fn plan_slot_cache_roundtrip() {
        let cache = PlanSlotCache::new();
        assert!(cache.get("s1").is_none());
        cache.set("s1", sample_slot());
        let got = cache.get("s1").unwrap();
        assert_eq!(got.slug, "refactor-auth");
        cache.clear("s1");
        assert!(cache.get("s1").is_none());
    }

    #[test]
    fn plan_slot_cache_is_session_scoped() {
        let cache = PlanSlotCache::new();
        cache.set("s1", sample_slot());
        assert!(cache.get("s2").is_none(), "must not leak across sessions");
    }

    #[test]
    fn pre_plan_mode_take_removes_entry() {
        let cache = PrePlanModeCache::new();
        cache.set("s1", AgentExecMode::Build);
        let took = cache.take("s1");
        assert_eq!(took, Some(AgentExecMode::Build));
        assert!(cache.get("s1").is_none());
    }

    #[test]
    fn pre_plan_mode_overwrite_on_reenter() {
        let cache = PrePlanModeCache::new();
        cache.set("s1", AgentExecMode::Build);
        cache.set("s1", AgentExecMode::Ask);
        assert_eq!(cache.get("s1"), Some(AgentExecMode::Ask));
    }

    #[test]
    fn requested_exec_mode_take_consumes_once() {
        let cache = RequestedExecModeCache::new();
        cache.set("s1", AgentExecMode::Plan);
        assert_eq!(cache.take("s1"), Some(AgentExecMode::Plan));
        assert!(
            cache.take("s1").is_none(),
            "second take must return None — overrides are one-shot"
        );
    }

    #[test]
    fn requested_exec_mode_overwrite_replaces_pending() {
        let cache = RequestedExecModeCache::new();
        cache.set("s1", AgentExecMode::Plan);
        cache.set("s1", AgentExecMode::Build);
        assert_eq!(cache.take("s1"), Some(AgentExecMode::Build));
    }

    #[test]
    fn requested_exec_mode_session_scoped() {
        let cache = RequestedExecModeCache::new();
        cache.set("s1", AgentExecMode::Plan);
        assert!(cache.peek("s2").is_none());
    }
}
