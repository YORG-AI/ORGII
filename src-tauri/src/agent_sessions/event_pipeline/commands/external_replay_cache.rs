//! Throttled maintenance for ORGII-owned imported replay indexes.
//!
//! Cache eviction is deliberately outside the provider adapters. The provider
//! transcript remains the source of truth, while this process-local gate keeps
//! maintenance isolated per ORGII database and off the five-second delta path.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use orgtrack_core::sources::imported_history::replay::{self, ReplayCachePolicy};
use rusqlite::Connection;

const REPLAY_CACHE_PRUNE_INTERVAL: Duration = Duration::from_secs(60);
const REPLAY_CACHE_PRUNE_IDENTITIES: usize = 16;

#[derive(Default)]
struct ReplayCachePruneGate {
    last_started: HashMap<PathBuf, Instant>,
}

impl ReplayCachePruneGate {
    fn claim(&mut self, identity: PathBuf, now: Instant) -> bool {
        if self
            .last_started
            .get(&identity)
            .is_some_and(|last| now.saturating_duration_since(*last) < REPLAY_CACHE_PRUNE_INTERVAL)
        {
            return false;
        }

        // A desktop process normally sees one identity. Bound the registry as
        // well so test/dev home switching cannot create a process-lifetime map.
        if !self.last_started.contains_key(&identity)
            && self.last_started.len() >= REPLAY_CACHE_PRUNE_IDENTITIES
        {
            if let Some(oldest) = self
                .last_started
                .iter()
                .min_by_key(|(_, started)| **started)
                .map(|(path, _)| path.clone())
            {
                self.last_started.remove(&oldest);
            }
        }
        self.last_started.insert(identity, now);
        true
    }
}

fn prune_gate() -> &'static Mutex<ReplayCachePruneGate> {
    static GATE: OnceLock<Mutex<ReplayCachePruneGate>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(ReplayCachePruneGate::default()))
}

/// Run at most one cache prune per minute for this ORGII database identity.
///
/// Maintenance runs on its own blocking worker and is best-effort: failure
/// must not turn an otherwise valid replay operation into a user-visible
/// error, and the claimed interval prevents a corrupt cache row from causing
/// a hot retry loop.
fn prune_replay_cache(conn: &mut Connection) {
    match replay::prune_cache(conn, ReplayCachePolicy::default()) {
        Ok(report) if report.evicted_entries > 0 => log::info!(
            "[ExternalReplay] pruned {} cache entries ({} bytes; {} bytes remain)",
            report.evicted_entries,
            report.evicted_bytes,
            report.after_bytes
        ),
        Ok(_) => {}
        Err(error) => log::warn!("[ExternalReplay] replay cache prune failed: {error}"),
    }
}

/// Queue maintenance after a successful replay operation. The command does
/// not wait for cache accounting/eviction, and concurrent callers collapse at
/// the identity-aware gate before doing any SQLite scan.
pub(super) fn schedule_replay_cache_prune() {
    // Claim before spawning or opening SQLite. Unchanged five-second polls
    // therefore do no worker dispatch and no database work between the
    // identity-scoped maintenance intervals.
    let identity = database::db::get_db_path();
    let claimed = prune_gate()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .claim(identity, Instant::now());
    if !claimed {
        return;
    }

    let _prune_task = tokio::task::spawn_blocking(|| {
        let mut conn = match database::db::get_connection() {
            Ok(conn) => conn,
            Err(error) => {
                log::warn!("[ExternalReplay] open replay cache for prune failed: {error}");
                return;
            }
        };
        prune_replay_cache(&mut conn);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_gate_is_throttled_and_isolated_by_runtime_identity() {
        let now = Instant::now();
        let mut gate = ReplayCachePruneGate::default();
        let first = PathBuf::from("/orgii-home-a/sessions.db");
        let second = PathBuf::from("/orgii-home-b/sessions.db");

        assert!(gate.claim(first.clone(), now));
        assert!(!gate.claim(first.clone(), now + Duration::from_secs(59)));
        assert!(gate.claim(second, now + Duration::from_secs(59)));
        assert!(gate.claim(first, now + REPLAY_CACHE_PRUNE_INTERVAL));
    }

    #[test]
    fn prune_gate_registry_is_bounded() {
        let now = Instant::now();
        let mut gate = ReplayCachePruneGate::default();
        for index in 0..(REPLAY_CACHE_PRUNE_IDENTITIES + 5) {
            assert!(gate.claim(
                PathBuf::from(format!("/orgii-home-{index}/sessions.db")),
                now + Duration::from_secs(index as u64),
            ));
        }
        assert_eq!(gate.last_started.len(), REPLAY_CACHE_PRUNE_IDENTITIES);
        assert!(!gate
            .last_started
            .contains_key(&PathBuf::from("/orgii-home-0/sessions.db")));
    }
}
