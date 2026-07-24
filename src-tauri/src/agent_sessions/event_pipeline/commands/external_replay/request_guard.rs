use super::*;

#[derive(Debug, Clone, Copy)]
pub(super) struct ReplayRequestState {
    request_token: u64,
    episode_id: u64,
    touched_at: Instant,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct PrewarmRequestState {
    request_token: u64,
    episode_id: u64,
    active: bool,
    touched_at: Instant,
}

pub(super) fn replay_request_states() -> &'static Mutex<HashMap<String, ReplayRequestState>> {
    static REQUEST_STATES: OnceLock<Mutex<HashMap<String, ReplayRequestState>>> = OnceLock::new();
    REQUEST_STATES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn prewarm_request_states() -> &'static Mutex<HashMap<String, PrewarmRequestState>> {
    static REQUEST_STATES: OnceLock<Mutex<HashMap<String, PrewarmRequestState>>> = OnceLock::new();
    REQUEST_STATES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn begin_prewarm_request(session_id: &str, episode_id: u64) -> Result<u64, String> {
    static NEXT_REQUEST_TOKEN: AtomicU64 = AtomicU64::new(0);
    let now = Instant::now();
    let mut request_states = prewarm_request_states()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    request_states
        .retain(|_, entry| now.duration_since(entry.touched_at) < PREWARM_REQUEST_STATE_TTL);
    if let Some(current) = request_states.get(session_id) {
        if current.episode_id > episode_id || (!current.active && current.episode_id >= episode_id)
        {
            return Err(format!(
                "stale external replay prewarm episode {episode_id}; current episode is {}",
                current.episode_id
            ));
        }
    }
    if !request_states.contains_key(session_id)
        && request_states.len() >= MAX_PREWARM_REQUEST_STATES
    {
        if let Some(oldest) = request_states
            .iter()
            .min_by_key(|(_, entry)| entry.touched_at)
            .map(|(session_id, _)| session_id.clone())
        {
            request_states.remove(&oldest);
        }
    }
    let request_token = NEXT_REQUEST_TOKEN
        .fetch_add(1, Ordering::Relaxed)
        .saturating_add(1);
    request_states.insert(
        session_id.to_string(),
        PrewarmRequestState {
            request_token,
            episode_id,
            active: true,
            touched_at: now,
        },
    );
    Ok(request_token)
}

pub(super) fn is_current_prewarm_request(
    session_id: &str,
    episode_id: u64,
    request_token: u64,
) -> bool {
    prewarm_request_states()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(session_id)
        .is_some_and(|current| {
            current.active
                && current.episode_id == episode_id
                && current.request_token == request_token
        })
}

/// Mark the latest prewarm episode as cancelled without dropping its episode
/// floor. Keeping a short-lived tombstone prevents a delayed IPC invocation
/// from recreating the just-closed A episode after an A -> B switch.
pub(in crate::agent_sessions::event_pipeline::commands) fn cancel_prewarm_requests(
    session_id: &str,
) {
    let mut request_states = prewarm_request_states()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(current) = request_states.get_mut(session_id) {
        current.active = false;
        current.touched_at = Instant::now();
    }
}

/// Validate the independent prewarm ticket and publish its bounded window as
/// one linearizable operation. The lock order is session manager -> stores ->
/// prewarm registry; `es_switch_session` cancels the old prewarm while holding
/// the manager lock, so either this commit wins before the switch or it cannot
/// write after the switch.
pub(super) fn apply_prewarm_window_if_current(
    state: &EventStoreState,
    session_id: &str,
    episode_id: u64,
    request_token: u64,
    events: &[SessionEvent],
) -> bool {
    let mut manager = state
        .session_manager
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut stores = state
        .stores
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let request_states = prewarm_request_states()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let is_current = request_states.get(session_id).is_some_and(|current| {
        current.active && current.episode_id == episode_id && current.request_token == request_token
    });
    if !is_current {
        return false;
    }
    manager.register(session_id);
    stores
        .entry(session_id.to_string())
        .or_default()
        .set_external_replay_window(events.to_vec());
    true
}

pub(super) fn begin_replay_request(
    session_id: &str,
    episode_id: u64,
    allow_activate: bool,
) -> Result<u64, String> {
    static NEXT_REQUEST_TOKEN: AtomicU64 = AtomicU64::new(0);
    let now = Instant::now();
    let mut request_states = replay_request_states()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    request_states
        .retain(|_, entry| now.duration_since(entry.touched_at) < REPLAY_REQUEST_STATE_TTL);
    if let Some(current) = request_states.get(session_id) {
        if current.episode_id != episode_id && (!allow_activate || episode_id < current.episode_id)
        {
            return Err(format!(
                "stale external replay foreground episode {episode_id}; current episode is {}",
                current.episode_id
            ));
        }
    } else if !allow_activate {
        return Err("external replay foreground episode is not open".to_string());
    }
    if !request_states.contains_key(session_id) && request_states.len() >= MAX_REPLAY_REQUEST_STATES
    {
        if let Some(oldest) = request_states
            .iter()
            .min_by_key(|(_, entry)| entry.touched_at)
            .map(|(session_id, _)| session_id.clone())
        {
            // Dropping the ticket only makes that completion stale. It can
            // never become valid for a future episode because tickets are
            // process-global and monotonic.
            request_states.remove(&oldest);
        }
    }
    let request_token = NEXT_REQUEST_TOKEN
        .fetch_add(1, Ordering::Relaxed)
        .saturating_add(1);
    request_states.insert(
        session_id.to_string(),
        ReplayRequestState {
            request_token,
            episode_id,
            touched_at: now,
        },
    );
    Ok(request_token)
}

pub(super) fn is_current_replay_request(
    session_id: &str,
    episode_id: u64,
    request_token: u64,
) -> bool {
    replay_request_states()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(session_id)
        .is_some_and(|current| {
            current.episode_id == episode_id && current.request_token == request_token
        })
}

pub(super) fn is_current_replay_episode(session_id: &str, episode_id: u64) -> bool {
    replay_request_states()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(session_id)
        .is_some_and(|current| current.episode_id == episode_id)
}

pub(super) fn release_replay_watch_if_stale_episode(session_id: &str, episode_id: u64) {
    if !is_current_replay_episode(session_id, episode_id) {
        external_replay_watcher::release_session_if_episode(session_id, episode_id);
    }
}

pub(super) fn release_session_runtime_if_episode(session_id: &str, episode_id: u64) {
    let released = {
        let mut request_states = replay_request_states()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if request_states
            .get(session_id)
            .is_some_and(|current| current.episode_id == episode_id)
        {
            request_states.remove(session_id);
            true
        } else {
            false
        }
    };
    if released {
        cancel_prewarm_requests(session_id);
        external_replay_watcher::release_session_if_episode(session_id, episode_id);
    }
}

/// Invalidate pending external replay delivery and release its foreground
/// watcher. Native SDE sessions never create either entry, so calling this
/// from the shared session lifecycle is a strict no-op for native behavior.
pub(in crate::agent_sessions::event_pipeline::commands) fn release_session_runtime(
    session_id: &str,
) {
    replay_request_states()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(session_id);
    cancel_prewarm_requests(session_id);
    external_replay_watcher::release_session(session_id);
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct ReplayApplyResult {
    pub(super) upserted: u64,
    pub(super) removed: u64,
    pub(super) changed: bool,
}

/// External-only authoritative apply path. Native SDE Agent never calls this
/// helper and retains its existing EventStore set/merge semantics.
pub(super) fn apply_external_replay_delta(
    store: &mut EventStore,
    delta: &ExternalReplayDelta,
) -> ReplayApplyResult {
    if delta.reset_required {
        store.set_external_replay_window(delta.events.clone());
        return ReplayApplyResult {
            upserted: delta.events.len() as u64,
            removed: 0,
            changed: true,
        };
    }
    let mut result = ReplayApplyResult::default();
    for event in delta.events.iter().cloned() {
        let unchanged = store
            .get_by_id(&event.id)
            .is_some_and(|existing| session_events_equal(existing, &event));
        if !unchanged {
            store.upsert(event);
            result.upserted += 1;
        }
    }
    result.removed = store.remove_by_ids(&delta.removed_event_ids) as u64;
    result.changed = result.upserted > 0 || result.removed > 0;
    result
}
