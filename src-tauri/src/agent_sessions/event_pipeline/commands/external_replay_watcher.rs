//! Process-local, source-deduplicated watcher leases for bounded external replay.
//!
//! A lease exists only while an external replay session is in the foreground.
//! The registry is keyed by the ORGII runtime database plus the canonical
//! physical source path, so two sessions stored in one SQLite database share a
//! single native watcher without leaking state across isolated ORGII homes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use orgtrack_core::sources::imported_history::replay::{ReplayInvalidated, INVALIDATED_EVENT_NAME};
use tauri::{AppHandle, Emitter};

const INVALIDATION_DEBOUNCE: Duration = Duration::from_millis(150);
const LEASE_TTL: Duration = Duration::from_secs(3 * 60);
const MAX_WATCHED_SOURCES: usize = 16;
const MAX_LEASES_PER_SOURCE: usize = 32;
const MAX_REGISTRY_ESTIMATED_BYTES: usize = 256 * 1024;
const BASE_ENTRY_ESTIMATED_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct WatchKey {
    runtime_identity: PathBuf,
    physical_source: PathBuf,
}

#[derive(Debug, Clone)]
struct WatchLease {
    source_id: String,
    /// Renderer foreground episode. Public session ids can repeat during an
    /// A→B→A switch, so the id alone cannot distinguish stale work.
    episode_id: u64,
    generation: Option<String>,
    touched_at: Instant,
}

#[derive(Debug, Clone)]
struct WatchFilter {
    physical_source: PathBuf,
    source_is_directory: bool,
}

impl WatchFilter {
    fn from_source_path(source_path: &Path) -> Result<(Self, PathBuf, RecursiveMode), String> {
        let physical_source = normalize_existing_path(source_path)?;
        let source_is_directory = physical_source.is_dir();
        if source_is_directory {
            return Ok((
                Self {
                    physical_source: physical_source.clone(),
                    source_is_directory: true,
                },
                physical_source,
                RecursiveMode::Recursive,
            ));
        }

        // Watch the parent so atomic replacement, rotation, and SQLite WAL
        // creation are visible even when the sidecar did not exist at open.
        // SHM is reader-lock coordination, not logical history; watching it
        // lets our own SQLite reads wake the replay loop indefinitely.
        let parent = physical_source
            .parent()
            .filter(|parent| parent.parent().is_some())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| physical_source.clone());
        Ok((
            Self {
                physical_source,
                source_is_directory: false,
            },
            parent,
            RecursiveMode::NonRecursive,
        ))
    }

    fn touches(&self, event: &Event) -> bool {
        if matches!(event.kind, EventKind::Access(_)) {
            return false;
        }
        event.paths.iter().any(|path| self.touches_path(path))
    }

    fn touches_path(&self, path: &Path) -> bool {
        let path = normalize_event_path(path);
        if self.source_is_directory {
            return path.starts_with(&self.physical_source);
        }
        if path == self.physical_source {
            return true;
        }
        let source = self.physical_source.to_string_lossy();
        path == format!("{source}-wal")
    }
}

struct SharedWatchState {
    filter: WatchFilter,
    leases: HashMap<String, WatchLease>,
    notification_pending: bool,
    healthy: bool,
    last_used: Instant,
}

struct WatchEntry {
    // Dropping the native watcher is the stop operation.
    _watcher: RecommendedWatcher,
    state: Arc<Mutex<SharedWatchState>>,
    estimated_bytes: usize,
}

#[derive(Default)]
struct WatchRegistry {
    entries: HashMap<WatchKey, WatchEntry>,
    estimated_bytes: usize,
}

fn registry() -> &'static Mutex<WatchRegistry> {
    static REGISTRY: OnceLock<Mutex<WatchRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(WatchRegistry::default()))
}

/// Acquire or refresh the foreground lease for one display session.
///
/// `false` is a supported outcome: the renderer keeps its visible-only 5s
/// delta fallback until a later open/poll successfully attaches a watcher.
pub(super) fn acquire(
    app: &AppHandle,
    source_id: &str,
    session_id: &str,
    episode_id: u64,
    generation: Option<&str>,
    source_path: &Path,
) -> bool {
    let (filter, watch_root, recursive_mode) = match WatchFilter::from_source_path(source_path) {
        Ok(target) => target,
        Err(error) => {
            log::warn!("[external-replay] cannot normalize watcher source: {error}");
            return false;
        }
    };
    let key = WatchKey {
        runtime_identity: runtime_identity(),
        physical_source: filter.physical_source.clone(),
    };
    let now = Instant::now();
    let mut registry = registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    prune_registry(&mut registry, now);

    let current_registry_bytes = registry.estimated_bytes;
    let updated_registry_bytes = if let Some(entry) = registry.entries.get_mut(&key) {
        let mut state = entry
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !accepts_episode(state.leases.get(session_id), episode_id) {
            return false;
        }
        if !state.healthy {
            None
        } else {
            if !state.leases.contains_key(session_id) && state.leases.len() >= MAX_LEASES_PER_SOURCE
            {
                return false;
            }
            let old_lease_bytes = state
                .leases
                .get(session_id)
                .map_or(0, |lease| estimate_lease_bytes(session_id, lease));
            let new_lease = WatchLease {
                source_id: source_id.to_string(),
                episode_id,
                generation: generation.map(str::to_string),
                touched_at: now,
            };
            let new_lease_bytes = estimate_lease_bytes(session_id, &new_lease);
            let updated_registry_bytes = current_registry_bytes
                .saturating_sub(old_lease_bytes)
                .saturating_add(new_lease_bytes);
            if updated_registry_bytes > MAX_REGISTRY_ESTIMATED_BYTES {
                return false;
            }
            state.leases.insert(session_id.to_string(), new_lease);
            state.last_used = now;
            entry.estimated_bytes = entry
                .estimated_bytes
                .saturating_sub(old_lease_bytes)
                .saturating_add(new_lease_bytes);
            Some(updated_registry_bytes)
        }
    } else {
        None
    };
    if let Some(updated_registry_bytes) = updated_registry_bytes {
        registry.estimated_bytes = updated_registry_bytes;
        return true;
    }

    // Retire an unhealthy entry before attempting a fresh native watcher.
    if let Some(entry) = registry.entries.remove(&key) {
        registry.estimated_bytes = registry
            .estimated_bytes
            .saturating_sub(entry.estimated_bytes);
        drop(entry);
    }
    let initial_lease = WatchLease {
        source_id: source_id.to_string(),
        episode_id,
        generation: generation.map(str::to_string),
        touched_at: now,
    };
    let estimated_bytes =
        estimate_entry_bytes(&key).saturating_add(estimate_lease_bytes(session_id, &initial_lease));
    if estimated_bytes > MAX_REGISTRY_ESTIMATED_BYTES
        || !evict_lru_until_capacity(&mut registry, estimated_bytes)
    {
        return false;
    }

    let shared = Arc::new(Mutex::new(SharedWatchState {
        filter,
        leases: HashMap::from([(session_id.to_string(), initial_lease)]),
        notification_pending: false,
        healthy: true,
        last_used: now,
    }));
    let callback_state = Arc::clone(&shared);
    let callback_app = app.clone();
    let mut watcher = match RecommendedWatcher::new(
        move |result| handle_native_event(result, &callback_state, &callback_app),
        Config::default(),
    ) {
        Ok(watcher) => watcher,
        Err(error) => {
            log::warn!("[external-replay] cannot create native watcher: {error}");
            return false;
        }
    };
    if let Err(error) = watcher.watch(&watch_root, recursive_mode) {
        log::warn!(
            "[external-replay] cannot watch {}: {error}",
            watch_root.display()
        );
        return false;
    }

    registry.estimated_bytes = registry.estimated_bytes.saturating_add(estimated_bytes);
    registry.entries.insert(
        key,
        WatchEntry {
            _watcher: watcher,
            state: shared,
            estimated_bytes,
        },
    );
    true
}

/// Return current health without creating a watcher. A safety poll uses this
/// to downgrade to the short fallback after an asynchronous watcher error.
pub(super) fn is_available(session_id: &str) -> bool {
    let now = Instant::now();
    let runtime_identity = runtime_identity();
    let registry = registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    all_live_watch_entries_healthy(registry.entries.iter().filter_map(|(key, entry)| {
        if key.runtime_identity != runtime_identity {
            return None;
        }
        let state = entry
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let holds_live_lease = state
            .leases
            .get(session_id)
            .is_some_and(|lease| lease_is_live(lease, now));
        Some((holds_live_lease, state.healthy))
    }))
}

/// A replay source can own several physical watchers (for example Qoder's
/// transcript, shared launch logs, edit snapshots and spill output). The
/// renderer may suppress its 5-second fallback only while every watcher that
/// still holds this session's live lease is healthy. Entries from another
/// session, another runtime, or an expired lease do not participate.
fn all_live_watch_entries_healthy(entries: impl IntoIterator<Item = (bool, bool)>) -> bool {
    let mut found_live_lease = false;
    for (holds_live_lease, healthy) in entries {
        if !holds_live_lease {
            continue;
        }
        found_live_lease = true;
        if !healthy {
            return false;
        }
    }
    found_live_lease
}

fn lease_is_live(lease: &WatchLease, now: Instant) -> bool {
    now.checked_duration_since(lease.touched_at)
        .unwrap_or_default()
        < LEASE_TTL
}

/// Stop foreground delivery for one session. The native watcher is dropped as
/// soon as the last session sharing that physical source releases its lease.
pub(super) fn release_session(session_id: &str) {
    release_session_matching_episode(session_id, None);
}

/// Stop only the watcher lease owned by one renderer episode. This is used by
/// delayed request cleanup: an A1 completion must never tear down a newer A2
/// lease that happens to share the same public session id.
pub(super) fn release_session_if_episode(session_id: &str, episode_id: u64) {
    release_session_matching_episode(session_id, Some(episode_id));
}

fn release_session_matching_episode(session_id: &str, episode_id: Option<u64>) {
    let runtime_identity = runtime_identity();
    let mut registry = registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut empty_keys = Vec::new();
    let mut removed_lease_bytes = 0_usize;
    for (key, entry) in &mut registry.entries {
        if key.runtime_identity != runtime_identity {
            continue;
        }
        let mut state = entry
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(lease) = take_matching_lease(&mut state.leases, session_id, episode_id) {
            let lease_bytes = estimate_lease_bytes(session_id, &lease);
            entry.estimated_bytes = entry.estimated_bytes.saturating_sub(lease_bytes);
            removed_lease_bytes = removed_lease_bytes.saturating_add(lease_bytes);
        }
        if state.leases.is_empty() {
            empty_keys.push(key.clone());
        }
    }
    registry.estimated_bytes = registry.estimated_bytes.saturating_sub(removed_lease_bytes);
    let removed = empty_keys
        .into_iter()
        .filter_map(|key| registry.entries.remove(&key))
        .collect::<Vec<_>>();
    for entry in &removed {
        registry.estimated_bytes = registry
            .estimated_bytes
            .saturating_sub(entry.estimated_bytes);
    }
    drop(registry);
    drop(removed);
}

fn accepts_episode(current: Option<&WatchLease>, incoming_episode_id: u64) -> bool {
    current.is_none_or(|current| current.episode_id <= incoming_episode_id)
}

fn take_matching_lease(
    leases: &mut HashMap<String, WatchLease>,
    session_id: &str,
    episode_id: Option<u64>,
) -> Option<WatchLease> {
    let matches = leases
        .get(session_id)
        .is_some_and(|lease| episode_id.is_none_or(|episode_id| lease.episode_id == episode_id));
    if !matches {
        return None;
    }
    leases.remove(session_id)
}

fn handle_native_event(
    result: notify::Result<Event>,
    shared: &Arc<Mutex<SharedWatchState>>,
    app: &AppHandle,
) {
    let now = Instant::now();
    let should_schedule = {
        let mut state = shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let relevant = match result {
            Ok(event) => state.filter.touches(&event),
            Err(error) => {
                state.healthy = false;
                log::warn!("[external-replay] watcher failed; using polling fallback: {error}");
                true
            }
        };
        let has_live_lease = state.leases.values().any(|lease| lease_is_live(lease, now));
        if !relevant || !has_live_lease || state.notification_pending {
            false
        } else {
            state.notification_pending = true;
            state.last_used = now;
            true
        }
    };
    if !should_schedule {
        return;
    }

    let state = Arc::clone(shared);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(INVALIDATION_DEBOUNCE).await;
        let invalidations = {
            let now = Instant::now();
            let mut state = state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.notification_pending = false;
            state
                .leases
                .iter()
                .filter(|(_, lease)| lease_is_live(lease, now))
                .map(|(session_id, lease)| ReplayInvalidated {
                    session_id: session_id.clone(),
                    source_id: lease.source_id.clone(),
                    generation: lease.generation.clone(),
                })
                .collect::<Vec<_>>()
        };
        for invalidation in invalidations {
            if let Err(error) = app.emit(INVALIDATED_EVENT_NAME, invalidation) {
                log::debug!("[external-replay] invalidation listener unavailable: {error}");
            }
        }
    });
}

fn prune_registry(registry: &mut WatchRegistry, now: Instant) {
    let mut expired = Vec::new();
    let mut removed_lease_bytes = 0_usize;
    for (key, entry) in &mut registry.entries {
        let mut state = entry
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let expired_sessions = state
            .leases
            .iter()
            .filter(|(_, lease)| !lease_is_live(lease, now))
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();
        for session_id in expired_sessions {
            if let Some(lease) = state.leases.remove(&session_id) {
                let lease_bytes = estimate_lease_bytes(&session_id, &lease);
                entry.estimated_bytes = entry.estimated_bytes.saturating_sub(lease_bytes);
                removed_lease_bytes = removed_lease_bytes.saturating_add(lease_bytes);
            }
        }
        if state.leases.is_empty() && now.duration_since(state.last_used) >= LEASE_TTL {
            expired.push(key.clone());
        }
    }
    registry.estimated_bytes = registry.estimated_bytes.saturating_sub(removed_lease_bytes);
    for key in expired {
        if let Some(entry) = registry.entries.remove(&key) {
            registry.estimated_bytes = registry
                .estimated_bytes
                .saturating_sub(entry.estimated_bytes);
        }
    }
}

/// Capacity pressure degrades the least-recently-used source back to its
/// renderer safety poll. In normal operation there is one foreground lease;
/// this path bounds pathological multi-window/multi-source cases.
fn evict_lru_until_capacity(registry: &mut WatchRegistry, incoming_bytes: usize) -> bool {
    while registry.entries.len() >= MAX_WATCHED_SOURCES
        || registry.estimated_bytes.saturating_add(incoming_bytes) > MAX_REGISTRY_ESTIMATED_BYTES
    {
        let lru_key = registry
            .entries
            .iter()
            .min_by_key(|(_, entry)| {
                entry
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .last_used
            })
            .map(|(key, _)| key.clone());
        let Some(lru_key) = lru_key else {
            return false;
        };
        if let Some(entry) = registry.entries.remove(&lru_key) {
            registry.estimated_bytes = registry
                .estimated_bytes
                .saturating_sub(entry.estimated_bytes);
        }
    }
    true
}

fn estimate_entry_bytes(key: &WatchKey) -> usize {
    BASE_ENTRY_ESTIMATED_BYTES
        .saturating_add(key.runtime_identity.as_os_str().len())
        .saturating_add(key.physical_source.as_os_str().len())
}

fn estimate_lease_bytes(session_id: &str, lease: &WatchLease) -> usize {
    std::mem::size_of::<WatchLease>()
        .saturating_add(session_id.len())
        .saturating_add(lease.source_id.len())
        .saturating_add(lease.generation.as_ref().map_or(0, String::len))
}

fn runtime_identity() -> PathBuf {
    normalize_event_path(&database::db::get_db_path())
}

fn normalize_existing_path(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize()
        .map_err(|error| format!("{}: {error}", path.display()))
}

fn normalize_event_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir().unwrap_or_default().join(path)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{DataChange, ModifyKind};

    fn modified(path: impl Into<PathBuf>) -> Event {
        Event {
            kind: EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            paths: vec![path.into()],
            attrs: Default::default(),
        }
    }

    fn lease(episode_id: u64) -> WatchLease {
        WatchLease {
            source_id: "codex_app".to_string(),
            episode_id,
            generation: Some("generation-1".to_string()),
            touched_at: Instant::now(),
        }
    }

    #[test]
    fn sqlite_filter_includes_wal_but_ignores_shm_lock_churn() {
        let filter = WatchFilter {
            physical_source: PathBuf::from("/tmp/history.db"),
            source_is_directory: false,
        };
        assert!(filter.touches(&modified("/tmp/history.db")));
        assert!(filter.touches(&modified("/tmp/history.db-wal")));
        assert!(!filter.touches(&modified("/tmp/history.db-shm")));
        assert!(!filter.touches(&modified("/tmp/another.db-wal")));
    }

    #[test]
    fn file_filter_ignores_read_access_and_unrelated_atomic_rewrites() {
        let filter = WatchFilter {
            physical_source: PathBuf::from("/tmp/transcript.jsonl"),
            source_is_directory: false,
        };
        let mut access = modified("/tmp/transcript.jsonl");
        access.kind = EventKind::Access(notify::event::AccessKind::Any);
        assert!(!filter.touches(&access));
        assert!(!filter.touches(&modified("/tmp/transcript.jsonl.tmp")));
    }

    #[test]
    fn directory_filter_covers_manifest_children_only() {
        let filter = WatchFilter {
            physical_source: PathBuf::from("/tmp/manifest-root"),
            source_is_directory: true,
        };
        assert!(filter.touches(&modified("/tmp/manifest-root/blobs/one")));
        assert!(!filter.touches(&modified("/tmp/manifest-root-copy/one")));
    }

    #[test]
    fn availability_requires_every_live_session_watch_to_be_healthy() {
        assert!(all_live_watch_entries_healthy([
            (true, true),
            (true, true),
            (false, false),
        ]));
        assert!(!all_live_watch_entries_healthy([
            (true, true),
            (true, false),
            (false, true),
        ]));
        assert!(!all_live_watch_entries_healthy([
            (false, true),
            (false, false),
        ]));
    }

    #[test]
    fn stale_episode_cannot_replace_or_release_a_reopened_session_lease() {
        let mut leases = HashMap::from([("codexapp-a".to_string(), lease(102))]);

        assert!(!accepts_episode(leases.get("codexapp-a"), 100));
        assert!(take_matching_lease(&mut leases, "codexapp-a", Some(100)).is_none());
        assert_eq!(
            leases.get("codexapp-a").map(|lease| lease.episode_id),
            Some(102)
        );

        assert!(take_matching_lease(&mut leases, "codexapp-a", Some(102)).is_some());
        assert!(!leases.contains_key("codexapp-a"));
    }

    #[test]
    fn physical_source_key_single_flights_sessions_but_partitions_runtimes() {
        let first = WatchKey {
            runtime_identity: PathBuf::from("/orgii-home-a/sessions.db"),
            physical_source: PathBuf::from("/cli/history.db"),
        };
        let same_process_and_source = WatchKey {
            runtime_identity: PathBuf::from("/orgii-home-a/sessions.db"),
            physical_source: PathBuf::from("/cli/history.db"),
        };
        let other_runtime = WatchKey {
            runtime_identity: PathBuf::from("/orgii-home-b/sessions.db"),
            physical_source: PathBuf::from("/cli/history.db"),
        };

        assert_eq!(first, same_process_and_source);
        assert_ne!(first, other_runtime);
        let mut entries = HashMap::new();
        entries.insert(first, "session-a");
        entries.insert(same_process_and_source, "session-b");
        entries.insert(other_runtime, "other-instance");
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn watcher_lease_expires_at_the_three_minute_boundary() {
        let now = Instant::now();
        let mut active = lease(1);
        active.touched_at = now - LEASE_TTL + Duration::from_nanos(1);
        assert!(lease_is_live(&active, now));

        active.touched_at = now - LEASE_TTL;
        assert!(!lease_is_live(&active, now));
    }

    #[test]
    fn watcher_registry_limits_are_byte_and_count_bounded() {
        assert!(MAX_WATCHED_SOURCES > 0);
        assert!(MAX_LEASES_PER_SOURCE > 0);
        assert!(MAX_REGISTRY_ESTIMATED_BYTES >= BASE_ENTRY_ESTIMATED_BYTES);
        let key = WatchKey {
            runtime_identity: PathBuf::from("/orgii-home/sessions.db"),
            physical_source: PathBuf::from("/cli/transcript.jsonl"),
        };
        let estimated = estimate_entry_bytes(&key)
            .saturating_add(estimate_lease_bytes("codexapp-session", &lease(1)));
        assert!(estimated < MAX_REGISTRY_ESTIMATED_BYTES);
    }
}
