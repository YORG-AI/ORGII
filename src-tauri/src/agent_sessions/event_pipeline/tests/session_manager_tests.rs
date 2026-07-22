use crate::agent_sessions::event_pipeline::session_manager::SessionStoreManager;

#[test]
fn test_set_active_initial() {
    let mut mgr = SessionStoreManager::new();
    let evicted = mgr.set_active("session-1");
    assert!(evicted.is_empty());
    assert_eq!(mgr.active_id(), Some("session-1"));
    assert!(mgr.has_known("session-1"));
}

#[test]
fn test_set_active_switch_demotes_previous() {
    let mut mgr = SessionStoreManager::new();

    mgr.set_active("s1");
    mgr.set_active("s2");
    assert_eq!(mgr.active_id(), Some("s2"));
    // s1 is now known but idle.
    assert!(mgr.has_known("s1"));
    assert!(!mgr.is_pinned("s1"));
    assert_eq!(mgr.idle_count(), 1);
}

#[test]
fn test_set_active_idempotent_same_id() {
    let mut mgr = SessionStoreManager::new();
    mgr.set_active("s1");
    let evicted = mgr.set_active("s1");
    assert!(evicted.is_empty());
    assert_eq!(mgr.idle_count(), 0);
}

#[test]
fn test_pin_prevents_eviction() {
    let mut mgr = SessionStoreManager::new();

    mgr.register("running-session");
    mgr.pin("running-session");

    // Register 30 sessions to exceed MAX_TOTAL_CACHED (25).
    for i in 0..30 {
        let sid = format!("idle-{}", i);
        mgr.register(&sid);
    }

    // Force eviction pressure by setting a new active.
    mgr.set_active("fresh");

    assert!(mgr.is_pinned("running-session"));
    assert!(mgr.has_known("running-session"));
}

#[test]
fn test_unpin() {
    let mut mgr = SessionStoreManager::new();

    mgr.register("s1");
    mgr.pin("s1");
    assert!(mgr.is_pinned("s1"));

    mgr.unpin("s1");
    assert!(!mgr.is_pinned("s1"));
    assert!(mgr.has_known("s1"));
}

#[test]
fn test_register_is_idempotent() {
    let mut mgr = SessionStoreManager::new();
    mgr.register("s1");
    mgr.register("s1");
    mgr.register("s1");
    assert_eq!(mgr.known_count(), 1);
}

#[test]
fn native_registration_keeps_the_existing_non_evicting_write_contract() {
    let mut mgr = SessionStoreManager::new();

    // Generic EventStore writes (including native SDE traffic) only register
    // the store.  External replay opts into enforcement later by publishing
    // its bounded byte estimate; adding that policy must not silently change
    // when native stores are evicted.
    for index in 0..30 {
        mgr.register(&format!("native-{index}"));
    }

    assert_eq!(mgr.known_count(), 30);
}

#[test]
fn test_evict_clears_all_state() {
    let mut mgr = SessionStoreManager::new();
    mgr.register("s1");
    mgr.pin("s1");
    mgr.set_active("s1");

    mgr.evict("s1");
    assert!(!mgr.has_known("s1"));
    assert!(!mgr.is_pinned("s1"));
    assert_eq!(mgr.active_id(), None);
}

#[test]
fn test_clear() {
    let mut mgr = SessionStoreManager::new();
    mgr.register("s1");
    mgr.pin("s1");
    mgr.set_active("s1");

    mgr.clear();
    assert!(mgr.active_id().is_none());
    assert_eq!(mgr.known_count(), 0);
    assert_eq!(mgr.pinned_count(), 0);
}

#[test]
fn test_touch_registers_if_missing() {
    let mut mgr = SessionStoreManager::new();
    mgr.touch("s1");
    assert!(mgr.has_known("s1"));
}

#[test]
fn test_enforce_limits_evicts_oldest_unpinned() {
    let mut mgr = SessionStoreManager::new();

    // Pin one session so it's always safe.
    mgr.register("pinned");
    mgr.pin("pinned");

    // Register 20 idle sessions.
    for i in 0..20 {
        mgr.register(&format!("idle-{}", i));
    }

    // Set a new active — this pushes one more idle into the ring and
    // enforces limits. After this, `idle_count` should be capped at
    // MAX_CACHED_IDLE (= 15), with the oldest idle sessions evicted.
    let evicted = mgr.set_active("new-active");
    assert!(
        !evicted.is_empty(),
        "expected some idle sessions to be evicted"
    );

    assert!(mgr.is_pinned("pinned"));
    assert!(mgr.has_known("pinned"));
    assert!(mgr.has_known("new-active"));
    assert!(mgr.idle_count() <= 15);
}

#[test]
fn tracked_external_bytes_evict_oldest_idle_store() {
    let mut mgr = SessionStoreManager::new();
    let per_session = 25 * 1024 * 1024;
    let mut evicted = Vec::new();
    for id in ["external-1", "external-2", "external-3", "external-4"] {
        evicted.extend(mgr.update_estimated_bytes(id, per_session));
    }
    assert_eq!(evicted, vec!["external-1".to_string()]);
    assert!(!mgr.has_known("external-1"));
    assert!(mgr.has_known("external-4"));
}

#[test]
fn tracked_external_bytes_can_drop_pinned_rebuildable_store_but_keep_owner_pin() {
    let mut mgr = SessionStoreManager::new();
    let per_session = 16 * 1024 * 1024;

    // Native SDE ownership is deliberately untracked by the external byte
    // budget and must remain resident even if it is older than every replay.
    mgr.register("sdeagent-native-running");
    mgr.pin("sdeagent-native-running");

    mgr.set_active("cliagent-active");
    mgr.pin("cliagent-active");
    assert!(mgr
        .update_estimated_bytes("cliagent-active", per_session)
        .is_empty());

    let mut evicted = Vec::new();
    for index in 1..=6 {
        let session_id = format!("cliagent-pinned-{index}");
        mgr.pin(&session_id);
        evicted.extend(mgr.update_estimated_bytes(&session_id, per_session));
    }

    assert_eq!(evicted, vec!["cliagent-pinned-1".to_string()]);
    assert!(!mgr.has_known("cliagent-pinned-1"));
    assert!(
        mgr.is_pinned("cliagent-pinned-1"),
        "running ownership survives cache eviction so a rebuild stays pinned"
    );
    assert!(mgr.has_known("sdeagent-native-running"));
    assert!(mgr.is_pinned("sdeagent-native-running"));
    assert!(mgr.has_known("cliagent-active"));

    // A later event/reopen can materialize the evicted store without losing
    // its running-owner pin semantics.
    mgr.register("cliagent-pinned-1");
    assert!(mgr.has_known("cliagent-pinned-1"));
    assert!(mgr.is_pinned("cliagent-pinned-1"));
}
