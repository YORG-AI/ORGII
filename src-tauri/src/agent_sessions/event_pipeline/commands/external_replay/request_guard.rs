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

trait TouchedRequestState {
    fn touched_at(&self) -> Instant;
}

impl TouchedRequestState for ReplayRequestState {
    fn touched_at(&self) -> Instant {
        self.touched_at
    }
}

impl TouchedRequestState for PrewarmRequestState {
    fn touched_at(&self) -> Instant {
        self.touched_at
    }
}

#[derive(Debug, Default)]
struct ReplayRequestRegistry {
    foreground: HashMap<String, ReplayRequestState>,
    prewarm: HashMap<String, PrewarmRequestState>,
}

fn replay_request_registry() -> &'static Mutex<ReplayRequestRegistry> {
    static REQUEST_REGISTRY: OnceLock<Mutex<ReplayRequestRegistry>> = OnceLock::new();
    REQUEST_REGISTRY.get_or_init(|| Mutex::new(ReplayRequestRegistry::default()))
}

fn prune_expired_request_states<State: TouchedRequestState>(
    entries: &mut HashMap<String, State>,
    now: Instant,
) {
    entries.retain(|_, entry| now.duration_since(entry.touched_at()) < REPLAY_REQUEST_STATE_TTL);
}

fn reserve_request_slot<State: TouchedRequestState>(
    entries: &mut HashMap<String, State>,
    session_id: &str,
) {
    if entries.contains_key(session_id) || entries.len() < MAX_REPLAY_REQUEST_STATES {
        return;
    }
    if let Some(oldest) = entries
        .iter()
        .min_by_key(|(_, entry)| entry.touched_at())
        .map(|(session_id, _)| session_id.clone())
    {
        entries.remove(&oldest);
    }
}

fn next_request_token() -> u64 {
    static NEXT_REQUEST_TOKEN: AtomicU64 = AtomicU64::new(0);
    NEXT_REQUEST_TOKEN
        .fetch_add(1, Ordering::Relaxed)
        .saturating_add(1)
}

pub(super) fn begin_validated_prewarm_request(
    source_id: &str,
    session_id: &str,
    episode_id: u64,
) -> Result<u64, String> {
    validate_primary_replay_target_identity(source_id, session_id)?;
    begin_prewarm_request(session_id, episode_id)
}

pub(super) fn begin_prewarm_request(session_id: &str, episode_id: u64) -> Result<u64, String> {
    let now = Instant::now();
    let mut registry = replay_request_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    prune_expired_request_states(&mut registry.prewarm, now);
    if let Some(current) = registry.prewarm.get(session_id) {
        if current.episode_id > episode_id || (!current.active && current.episode_id >= episode_id)
        {
            return Err(format!(
                "stale external replay prewarm episode {episode_id}; current episode is {}",
                current.episode_id
            ));
        }
    }
    reserve_request_slot(&mut registry.prewarm, session_id);
    let request_token = next_request_token();
    registry.prewarm.insert(
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
    replay_request_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .prewarm
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
    let mut registry = replay_request_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(current) = registry.prewarm.get_mut(session_id) {
        current.active = false;
        current.touched_at = Instant::now();
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) enum ReplayWindowPublish {
    Replace,
    Merge,
}

#[derive(Debug, Clone, Copy)]
enum ReplayRequestTicket {
    Foreground { episode_id: u64, request_token: u64 },
    Prewarm { episode_id: u64, request_token: u64 },
}

impl ReplayRequestTicket {
    fn is_current(self, registry: &ReplayRequestRegistry, session_id: &str) -> bool {
        match self {
            Self::Foreground {
                episode_id,
                request_token,
            } => registry.foreground.get(session_id).is_some_and(|current| {
                current.episode_id == episode_id && current.request_token == request_token
            }),
            Self::Prewarm {
                episode_id,
                request_token,
            } => registry.prewarm.get(session_id).is_some_and(|current| {
                current.active
                    && current.episode_id == episode_id
                    && current.request_token == request_token
            }),
        }
    }
}

/// Validate a replay ticket and mutate its bounded EventStore as one
/// linearizable operation. The shared lock order is session manager -> stores
/// -> request registry. Session switching cancels replay tickets while holding
/// the manager lock, so either publication wins before the switch or it cannot
/// write after the switch.
fn apply_replay_store_if_current<Result>(
    state: &EventStoreState,
    session_id: &str,
    ticket: ReplayRequestTicket,
    apply: impl FnOnce(&mut EventStore) -> Result,
) -> Option<Result> {
    let mut manager = state
        .session_manager
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut stores = state
        .stores
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let registry = replay_request_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !ticket.is_current(&registry, session_id) {
        return None;
    }
    manager.register(session_id);
    Some(apply(stores.entry(session_id.to_string()).or_default()))
}

fn apply_replay_window_if_current(
    state: &EventStoreState,
    session_id: &str,
    ticket: ReplayRequestTicket,
    events: &[SessionEvent],
    publish: ReplayWindowPublish,
) -> bool {
    apply_replay_store_if_current(state, session_id, ticket, |store| match publish {
        ReplayWindowPublish::Replace => store.set_external_replay_window(events.to_vec()),
        ReplayWindowPublish::Merge => store.merge_round_window_events(events.to_vec()),
    })
    .is_some()
}

pub(super) fn apply_prewarm_window_if_current(
    state: &EventStoreState,
    session_id: &str,
    episode_id: u64,
    request_token: u64,
    events: &[SessionEvent],
) -> bool {
    apply_replay_window_if_current(
        state,
        session_id,
        ReplayRequestTicket::Prewarm {
            episode_id,
            request_token,
        },
        events,
        ReplayWindowPublish::Replace,
    )
}

pub(super) fn apply_foreground_window_if_current(
    state: &EventStoreState,
    session_id: &str,
    episode_id: u64,
    request_token: u64,
    events: &[SessionEvent],
    publish: ReplayWindowPublish,
) -> bool {
    apply_replay_window_if_current(
        state,
        session_id,
        ReplayRequestTicket::Foreground {
            episode_id,
            request_token,
        },
        events,
        publish,
    )
}

pub(super) fn apply_foreground_delta_if_current(
    state: &EventStoreState,
    session_id: &str,
    episode_id: u64,
    request_token: u64,
    delta: &ExternalReplayDelta,
) -> Option<ReplayApplyResult> {
    apply_replay_store_if_current(
        state,
        session_id,
        ReplayRequestTicket::Foreground {
            episode_id,
            request_token,
        },
        |store| apply_external_replay_delta(store, delta),
    )
}

pub(super) fn begin_replay_request(
    session_id: &str,
    episode_id: u64,
    allow_activate: bool,
) -> Result<u64, String> {
    let now = Instant::now();
    let mut registry = replay_request_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    prune_expired_request_states(&mut registry.foreground, now);
    if let Some(current) = registry.foreground.get(session_id) {
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
    reserve_request_slot(&mut registry.foreground, session_id);
    let request_token = next_request_token();
    registry.foreground.insert(
        session_id.to_string(),
        ReplayRequestState {
            request_token,
            episode_id,
            touched_at: now,
        },
    );
    Ok(request_token)
}

pub(super) fn begin_validated_foreground_request(
    source_id: &str,
    session_id: &str,
    episode_id: u64,
    allow_activate: bool,
) -> Result<u64, String> {
    validate_primary_replay_target_identity(source_id, session_id)?;
    begin_replay_request(session_id, episode_id, allow_activate)
}

pub(super) fn is_current_replay_request(
    session_id: &str,
    episode_id: u64,
    request_token: u64,
) -> bool {
    replay_request_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .foreground
        .get(session_id)
        .is_some_and(|current| {
            current.episode_id == episode_id && current.request_token == request_token
        })
}

pub(super) fn is_current_replay_episode(session_id: &str, episode_id: u64) -> bool {
    replay_request_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .foreground
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
        let mut registry = replay_request_registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if registry
            .foreground
            .get(session_id)
            .is_some_and(|current| current.episode_id == episode_id)
        {
            registry.foreground.remove(session_id);
            if let Some(prewarm) = registry.prewarm.get_mut(session_id) {
                prewarm.active = false;
                prewarm.touched_at = Instant::now();
            }
            true
        } else {
            false
        }
    };
    if released {
        external_replay_watcher::release_session_if_episode(session_id, episode_id);
    }
}

/// Invalidate pending external replay delivery and release its foreground
/// watcher. Native SDE sessions never create either entry, so calling this
/// from the shared session lifecycle is a strict no-op for native behavior.
pub(in crate::agent_sessions::event_pipeline::commands) fn release_session_runtime(
    session_id: &str,
) {
    let mut registry = replay_request_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    registry.foreground.remove(session_id);
    if let Some(prewarm) = registry.prewarm.get_mut(session_id) {
        prewarm.active = false;
        prewarm.touched_at = Instant::now();
    }
    drop(registry);
    external_replay_watcher::release_session(session_id);
}

#[cfg(test)]
pub(super) fn has_foreground_request(session_id: &str) -> bool {
    replay_request_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .foreground
        .contains_key(session_id)
}

#[cfg(test)]
pub(super) fn has_prewarm_request(session_id: &str) -> bool {
    replay_request_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .prewarm
        .contains_key(session_id)
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

#[cfg(test)]
mod registry_policy_tests {
    use super::*;

    #[test]
    fn shared_request_slot_policy_prunes_expired_entries_and_evicts_the_lru() {
        let now = Instant::now();
        let mut entries = HashMap::new();
        entries.insert(
            "expired".to_string(),
            ReplayRequestState {
                request_token: 1,
                episode_id: 1,
                touched_at: now - REPLAY_REQUEST_STATE_TTL,
            },
        );
        prune_expired_request_states(&mut entries, now);
        assert!(entries.is_empty());

        for index in 0..MAX_REPLAY_REQUEST_STATES {
            entries.insert(
                format!("session-{index}"),
                ReplayRequestState {
                    request_token: index as u64,
                    episode_id: 1,
                    touched_at: now - Duration::from_millis(index as u64),
                },
            );
        }
        reserve_request_slot(&mut entries, "incoming");
        assert_eq!(entries.len(), MAX_REPLAY_REQUEST_STATES - 1);
        assert!(!entries.contains_key(&format!("session-{}", MAX_REPLAY_REQUEST_STATES - 1)));
    }
}
