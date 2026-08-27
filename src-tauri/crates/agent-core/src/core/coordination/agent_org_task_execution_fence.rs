//! Per-TaskExecution side-effect fence.
//!
//! Every tool call made by a persisted TaskExecution Turn holds a shared
//! permit for its exact `(run, task)` identity. Cancellation/reassignment
//! takes the exclusive permit before committing the Task fence. Tokio's
//! writer-preferring lock closes the "one more tool call" race: once a
//! handoff is queued, later effects cannot pass it and must revalidate the
//! now-cancelled Task after the writer releases.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use rusqlite::{params, OptionalExtension};
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TaskExecutionEffectIdentity {
    pub(crate) org_run_id: String,
    pub(crate) task_id: String,
    pub(crate) session_id: String,
    pub(crate) turn_intent_id: String,
    pub(crate) owner_member_id: String,
    pub(crate) activation_generation: i64,
}

struct FenceSlot {
    lock: Arc<RwLock<()>>,
    active_effects: AtomicUsize,
}

impl FenceSlot {
    fn new() -> Self {
        Self {
            lock: Arc::new(RwLock::new(())),
            active_effects: AtomicUsize::new(0),
        }
    }
}

static TASK_FENCES: OnceLock<Mutex<HashMap<String, Weak<FenceSlot>>>> = OnceLock::new();

fn fence_key(org_run_id: &str, task_id: &str) -> String {
    format!("{org_run_id}\u{1f}{task_id}")
}

fn slot(org_run_id: &str, task_id: &str) -> Arc<FenceSlot> {
    let registry = TASK_FENCES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut registry = registry
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let key = fence_key(org_run_id, task_id);
    if let Some(current) = registry.get(&key).and_then(Weak::upgrade) {
        return current;
    }
    let current = Arc::new(FenceSlot::new());
    registry.insert(key, Arc::downgrade(&current));
    current
}

/// Shared permit held for the complete duration of one TaskExecution tool
/// call, including its lowest adapter side effect.
pub(crate) struct TaskExecutionEffectPermit {
    slot: Arc<FenceSlot>,
    _guard: OwnedRwLockReadGuard<()>,
}

/// Cloneable, one-shot release passed to an adapter whose side effect has a
/// distinct admission boundary (currently process spawn). The registry owns
/// the permit until the adapter crosses that boundary; dropping or releasing
/// any clone releases it exactly once.
#[derive(Clone)]
pub(crate) struct TaskExecutionEffectFenceRelease {
    permit: Arc<Mutex<Option<TaskExecutionEffectPermit>>>,
}

impl TaskExecutionEffectFenceRelease {
    pub(crate) fn new(permit: TaskExecutionEffectPermit) -> Self {
        Self {
            permit: Arc::new(Mutex::new(Some(permit))),
        }
    }

    pub(crate) fn release(&self) {
        let mut permit = self
            .permit
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        permit.take();
    }
}

impl std::fmt::Debug for TaskExecutionEffectFenceRelease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TaskExecutionEffectFenceRelease")
            .field(
                "released",
                &self.permit.lock().map_or(true, |permit| permit.is_none()),
            )
            .finish()
    }
}

impl PartialEq for TaskExecutionEffectFenceRelease {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.permit, &other.permit)
    }
}

impl Eq for TaskExecutionEffectFenceRelease {}

#[derive(Clone)]
pub(crate) struct TaskExecutionHandoffAuthority {
    org_run_id: String,
    task_id: String,
}

impl TaskExecutionHandoffAuthority {
    pub(crate) fn matches(&self, org_run_id: &str, task_id: &str) -> bool {
        self.org_run_id == org_run_id && self.task_id == task_id
    }
}

pub(crate) struct TaskExecutionHandoffFence {
    authority: TaskExecutionHandoffAuthority,
    _guard: OwnedRwLockWriteGuard<()>,
}

impl TaskExecutionHandoffFence {
    pub(crate) fn authority(&self) -> TaskExecutionHandoffAuthority {
        self.authority.clone()
    }
}

impl Drop for TaskExecutionEffectPermit {
    fn drop(&mut self) {
        self.slot.active_effects.fetch_sub(1, Ordering::SeqCst);
    }
}

pub(crate) async fn acquire_effect(
    identity: &TaskExecutionEffectIdentity,
) -> TaskExecutionEffectPermit {
    let slot = slot(&identity.org_run_id, &identity.task_id);
    let guard = Arc::clone(&slot.lock).read_owned().await;
    slot.active_effects.fetch_add(1, Ordering::SeqCst);
    TaskExecutionEffectPermit {
        slot,
        _guard: guard,
    }
}

/// Exclusive handoff permit. The caller keeps this guard across the IMMEDIATE
/// transaction that cancels the old Task and creates its blocked replacement.
pub(crate) async fn acquire_handoff(org_run_id: &str, task_id: &str) -> TaskExecutionHandoffFence {
    let guard = Arc::clone(&slot(org_run_id, task_id).lock)
        .write_owned()
        .await;
    TaskExecutionHandoffFence {
        authority: TaskExecutionHandoffAuthority {
            org_run_id: org_run_id.to_string(),
            task_id: task_id.to_string(),
        },
        _guard: guard,
    }
}

pub(crate) fn active_effect_count(org_run_id: &str, task_id: &str) -> usize {
    slot(org_run_id, task_id)
        .active_effects
        .load(Ordering::SeqCst)
}

/// Persist a conservative marker immediately before an external adapter is
/// entered. A crash or transport error leaves the marker set, so a later
/// handoff cannot claim the remote outcome is known. The returned value is the
/// previous sticky state and may be restored only after a successful response.
pub(crate) fn begin_external_effect(
    identity: &TaskExecutionEffectIdentity,
) -> Result<bool, String> {
    database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
        let previous = external_effect_state_for_exact_execution(&tx, identity)?
            .ok_or_else(|| "task_execution_external_effect_authority_stale".to_string())?;
        let changed = tx
            .execute(
                "UPDATE agent_org_runtime_tasks SET external_effect_unknown=1
                 WHERE org_run_id=?1 AND id=?2 AND status='in_progress'
                   AND owner=?3 AND activation_generation=?4",
                params![
                    &identity.org_run_id,
                    &identity.task_id,
                    &identity.owner_member_id,
                    identity.activation_generation,
                ],
            )
            .map_err(|error| error.to_string())?;
        if changed != 1 {
            return Err("task_execution_external_effect_authority_stale".to_string());
        }
        tx.commit().map_err(|error| error.to_string())?;
        Ok(previous)
    })
}

/// A successful external response proves only this call. Restore the sticky
/// state that existed before it; a prior unknown effect must never be erased by
/// an unrelated later success.
pub(crate) fn restore_external_effect_after_success(
    identity: &TaskExecutionEffectIdentity,
    previous_unknown: bool,
) -> Result<(), String> {
    database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
        external_effect_state_for_exact_execution(&tx, identity)?
            .ok_or_else(|| "task_execution_external_effect_authority_stale".to_string())?;
        let changed = tx
            .execute(
                "UPDATE agent_org_runtime_tasks SET external_effect_unknown=?5
                 WHERE org_run_id=?1 AND id=?2 AND status='in_progress'
                   AND owner=?3 AND activation_generation=?4",
                params![
                    &identity.org_run_id,
                    &identity.task_id,
                    &identity.owner_member_id,
                    identity.activation_generation,
                    i64::from(previous_unknown),
                ],
            )
            .map_err(|error| error.to_string())?;
        if changed != 1 {
            return Err("task_execution_external_effect_authority_stale".to_string());
        }
        tx.commit().map_err(|error| error.to_string())?;
        Ok(())
    })
}

fn external_effect_state_for_exact_execution(
    conn: &rusqlite::Connection,
    identity: &TaskExecutionEffectIdentity,
) -> Result<Option<bool>, String> {
    conn.query_row(
        "SELECT task.external_effect_unknown
         FROM agent_org_runtime_tasks task
         JOIN agent_org_runtime_runs run ON run.id=task.org_run_id
         WHERE task.org_run_id=?1 AND task.id=?2 AND task.status='in_progress'
           AND task.owner=?3 AND task.activation_generation=?4
           AND run.status='running' AND run.activation_generation=?4
           AND EXISTS (
               SELECT 1 FROM agent_org_runtime_turn_contexts context
               JOIN session_turn_intents intent
                 ON intent.session_id=context.session_id
                AND intent.turn_intent_id=context.turn_intent_id
               WHERE context.session_id=?5 AND context.turn_intent_id=?6
                 AND context.org_run_id=?1 AND context.task_id=?2
                 AND context.owner_member_id=?3
                 AND context.activation_generation=?4
                 AND context.turn_kind='task_execution'
                 AND intent.org_run_id=?1 AND intent.status='running'
           )",
        params![
            &identity.org_run_id,
            &identity.task_id,
            &identity.owner_member_id,
            identity.activation_generation,
            &identity.session_id,
            &identity.turn_intent_id,
        ],
        |row| Ok(row.get::<_, i64>(0)? != 0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(crate) fn external_effect_unknown_with_connection(
    conn: &rusqlite::Connection,
    org_run_id: &str,
    task_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT external_effect_unknown FROM agent_org_runtime_tasks
         WHERE org_run_id=?1 AND id=?2",
        params![org_run_id, task_id],
        |row| Ok(row.get::<_, i64>(0)? != 0),
    )
    .optional()
    .map_err(|error| error.to_string())?
    .ok_or_else(|| format!("task_not_found:{task_id}"))
}

pub(crate) fn clear_external_effect_unknown_in_tx(
    conn: &rusqlite::Connection,
    org_run_id: &str,
    task_id: &str,
) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE agent_org_runtime_tasks SET external_effect_unknown=0
             WHERE org_run_id=?1 AND id=?2",
            params![org_run_id, task_id],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 {
        return Err(format!("task_not_found:{task_id}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> TaskExecutionEffectIdentity {
        TaskExecutionEffectIdentity {
            org_run_id: "run".to_string(),
            task_id: "task".to_string(),
            session_id: "session".to_string(),
            turn_intent_id: "turn".to_string(),
            owner_member_id: "member".to_string(),
            activation_generation: 1,
        }
    }

    #[tokio::test]
    async fn handoff_waits_for_the_exact_active_effect() {
        let identity = identity();
        let effect = acquire_effect(&identity).await;
        assert_eq!(active_effect_count("run", "task"), 1);

        let writer = tokio::spawn(async { acquire_handoff("run", "task").await });
        tokio::task::yield_now().await;
        assert!(!writer.is_finished());
        drop(effect);

        let guard = writer.await.expect("writer task");
        assert_eq!(active_effect_count("run", "task"), 0);
        drop(guard);
    }

    #[tokio::test]
    async fn effect_queued_after_handoff_cannot_overtake_the_writer() {
        let identity = identity();
        let first_effect = acquire_effect(&identity).await;
        let (queued_tx, queued_rx) = tokio::sync::oneshot::channel();
        let writer = tokio::spawn(async move {
            queued_tx.send(()).unwrap();
            acquire_handoff("run", "task").await
        });
        queued_rx.await.unwrap();
        tokio::task::yield_now().await;

        let late_identity = identity.clone();
        let late_effect = tokio::spawn(async move { acquire_effect(&late_identity).await });
        tokio::task::yield_now().await;
        assert!(!writer.is_finished());
        assert!(!late_effect.is_finished());

        drop(first_effect);
        let handoff = writer.await.expect("handoff writer");
        tokio::task::yield_now().await;
        assert!(
            !late_effect.is_finished(),
            "a read permit queued after the writer must remain fenced"
        );
        drop(handoff);
        drop(late_effect.await.expect("late effect permit"));
    }
}
