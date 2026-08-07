//! Background tick that drives `consolidate()` for every scope with
//! pending rows. Spawned once from `lib.rs::setup` via
//! `spawn_consolidation_tick`.

use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::Connection;
use tracing::{info, warn};

use super::entry::consolidate;
use super::triggers::{
    forced_trigger_ready, idle_trigger_ready, is_e2e_learnings_test_scope, lazy_trigger_ready,
};
use super::types::ConsolidationTrigger;

const CONSOLIDATION_IDLE_LOG_EVERY_TICKS: u64 = 10;

static CONSOLIDATION_TICK_COUNT: AtomicU64 = AtomicU64::new(0);

/// Spawn the consolidation tick. Called once from `lib.rs::setup`. Polls
/// every 60 seconds; when a trigger fires, it drains **every** scope with
/// pending rows. Safe to call multiple times — second-instance logs and
/// no-ops.
///
/// The tick itself never blocks startup: it runs on a dedicated
/// `std::thread` with an ad-hoc tokio runtime (the rest of the app uses
/// the same pattern — see `lib.rs` IDE server spawn).
pub fn spawn_consolidation_tick() {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        warn!("[consolidation] tick already running — skipping second spawn");
        return;
    }

    std::thread::spawn(|| {
        // Single 60s ticker; a current-thread runtime avoids a per-core worker set.
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(err) => {
                warn!("[consolidation] tick runtime init failed: {}", err);
                return;
            }
        };
        rt.block_on(async {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
            ticker.tick().await;

            loop {
                ticker.tick().await;
                if let Err(err) = run_tick().await {
                    warn!("[consolidation] tick failed: {}", err);
                }
            }
        });
    });
    info!("[consolidation] tick spawned (60s interval)");
}

/// One tick of the trigger loop. Picks the highest-priority trigger that
/// fires, then drains every scope with pending rows under that trigger.
async fn run_tick() -> Result<(), String> {
    let conn =
        crate::foundation::db_bridge::get_connection().map_err(|e| format!("tick DB: {}", e))?;

    let forced = forced_trigger_ready(&conn);
    let idle = idle_trigger_ready(&conn);

    let scopes: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT agent_scope FROM learnings
                 WHERE status = 'pending'",
            )
            .map_err(|e| format!("scope scan prepare: {}", e))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("scope scan query: {}", e))?;
        // Surface row-iteration errors instead of silently dropping
        // rows: a transient lock or schema mismatch that drops every
        // pending row would otherwise look identical to "no pending
        // scopes" and skip the consolidation pass entirely.
        rows.collect::<rusqlite::Result<Vec<String>>>()
            .map_err(|e| format!("scope scan row read: {}", e))?
            .into_iter()
            .filter(|scope| !is_e2e_learnings_test_scope(scope))
            .collect()
    };

    let tick_count = CONSOLIDATION_TICK_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
    if scopes.is_empty() {
        if tick_count % CONSOLIDATION_IDLE_LOG_EVERY_TICKS == 0 {
            info!(
                tick_count,
                "[consolidation] tick scanned pending scopes: none"
            );
        }
        return Ok(());
    }

    info!(
        tick_count,
        pending_scope_count = scopes.len(),
        forced,
        idle,
        "[consolidation] tick scanned pending scopes"
    );

    drive_scopes(&conn, scopes, forced, idle).await;
    Ok(())
}

fn select_trigger(forced: bool, idle: bool, lazy_ready: bool) -> Option<ConsolidationTrigger> {
    if forced {
        Some(ConsolidationTrigger::Forced)
    } else if idle && lazy_ready {
        Some(ConsolidationTrigger::Idle)
    } else if lazy_ready {
        Some(ConsolidationTrigger::Lazy)
    } else {
        None
    }
}

async fn drive_scopes(conn: &Connection, scopes: Vec<String>, forced: bool, idle: bool) {
    for scope in scopes {
        let Some(trigger) = select_trigger(forced, idle, lazy_trigger_ready(conn, &scope)) else {
            continue;
        };
        info!(
            "[consolidation] tick scope={} trigger={}",
            scope,
            trigger.as_str()
        );
        if let Err(err) = consolidate(&scope, trigger).await {
            warn!(
                "[consolidation] tick scope={} consolidate failed: {}",
                scope, err
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_trigger_respects_scope_cooldown() {
        assert!(select_trigger(false, true, false).is_none());
    }

    #[test]
    fn forced_trigger_bypasses_scope_cooldown() {
        assert!(matches!(
            select_trigger(true, true, false),
            Some(ConsolidationTrigger::Forced)
        ));
    }

    #[test]
    fn idle_trigger_runs_when_scope_is_lazy_ready() {
        assert!(matches!(
            select_trigger(false, true, true),
            Some(ConsolidationTrigger::Idle)
        ));
    }

    #[test]
    fn lazy_trigger_runs_without_global_idle() {
        assert!(matches!(
            select_trigger(false, false, true),
            Some(ConsolidationTrigger::Lazy)
        ));
    }
}
