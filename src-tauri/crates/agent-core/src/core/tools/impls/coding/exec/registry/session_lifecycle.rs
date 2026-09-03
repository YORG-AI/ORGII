//! Session-scoped lifecycle operations for the background-job registry.
//!
//! Archive and Team Delete need a stronger invariant than the public job
//! status: a killed subagent may still own a Tokio task, and a killed shell
//! may still own a process group or an output-replay pipeline. This module
//! keeps exact Session indexes and exposes bounded, read-only evidence for
//! those execution owners without adding a scanner or retained worker.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::task::AbortHandle;
use tokio_util::sync::CancellationToken;

use super::{
    broadcast_subagent_job_changed, process_tree_exists, remove, remove_indexed_handle,
    terminate_shell_process_tree, BackgroundJob, JobKind, JobStatus, ShellCompletionState,
    OWNER_INDEX, REGISTRY, TOMBSTONES,
};

const FINALITY_OBSERVATION_INTERVAL: Duration = Duration::from_millis(25);
const FINALITY_QUIET_PASSES: usize = 3;
const SESSION_SUBAGENT_ABORT_GRACE: Duration = Duration::from_secs(2);
const DEFAULT_EVIDENCE_LIMIT: usize = 16;

/// Lock order is `REGISTRY` -> `OWNER_INDEX` -> `SESSION_INDEX`.
/// Registration, removal, Archive and Delete all use that same order.
static SESSION_INDEX: LazyLock<Mutex<HashMap<String, HashSet<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Tombstones have a separate lock domain. Its order is `TOMBSTONES` ->
/// `TOMBSTONE_SESSION_INDEX`; no code holds either lock across an await.
static TOMBSTONE_SESSION_INDEX: LazyLock<Mutex<HashMap<String, HashSet<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionJobEvidence {
    pub session_id: String,
    pub handle: String,
    pub kind: String,
    pub status: String,
    pub execution_state: String,
    pub execution_terminal: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PurgedSessionJobs {
    pub live_jobs: usize,
    pub tombstones: usize,
}

pub(super) fn replace_live_index(
    previous_session_id: Option<&str>,
    session_id: &str,
    handle: &str,
) {
    let mut index = SESSION_INDEX.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(previous_session_id) = previous_session_id {
        remove_handle(&mut index, previous_session_id, handle);
    }
    index
        .entry(session_id.to_string())
        .or_default()
        .insert(handle.to_string());
}

pub(super) fn remove_live_index(session_id: &str, handle: &str) {
    let mut index = SESSION_INDEX.lock().unwrap_or_else(|e| e.into_inner());
    remove_handle(&mut index, session_id, handle);
}

pub(super) fn live_handles(session_id: &str) -> Vec<String> {
    let index = SESSION_INDEX.lock().unwrap_or_else(|e| e.into_inner());
    index
        .get(session_id)
        .into_iter()
        .flatten()
        .cloned()
        .collect()
}

pub(super) fn replace_tombstone_index(
    previous_session_id: Option<&str>,
    session_id: &str,
    handle: &str,
) {
    let mut index = TOMBSTONE_SESSION_INDEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(previous_session_id) = previous_session_id {
        remove_handle(&mut index, previous_session_id, handle);
    }
    index
        .entry(session_id.to_string())
        .or_default()
        .insert(handle.to_string());
}

pub(super) fn remove_tombstone_index(session_id: &str, handle: &str) {
    let mut index = TOMBSTONE_SESSION_INDEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    remove_handle(&mut index, session_id, handle);
}

pub(super) fn remove_expired_tombstone_indexes(expired: &[(String, String)]) {
    if expired.is_empty() {
        return;
    }
    let mut index = TOMBSTONE_SESSION_INDEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    for (session_id, handle) in expired {
        remove_handle(&mut index, session_id, handle);
    }
}

fn remove_handle(index: &mut HashMap<String, HashSet<String>>, session_id: &str, handle: &str) {
    if let Some(handles) = index.get_mut(session_id) {
        handles.remove(handle);
        if handles.is_empty() {
            index.remove(session_id);
        }
    }
}

fn status_label(status: &JobStatus) -> String {
    match status {
        JobStatus::Running => "running".to_string(),
        JobStatus::Exited(code) => format!("exited:{code}"),
        JobStatus::Killed => "killed".to_string(),
        JobStatus::Completed => "completed".to_string(),
        JobStatus::Failed => "failed".to_string(),
    }
}

fn execution_state(job: &BackgroundJob) -> (&'static str, bool) {
    match &job.kind {
        JobKind::Shell { pid, .. } => match job.shell_completion.as_ref() {
            Some(completion) => match &*completion.borrow() {
                ShellCompletionState::Running if job.shell_kill_requested => {
                    ("process_tree_or_replay_draining", false)
                }
                ShellCompletionState::Running => ("process_tree_running", false),
                ShellCompletionState::Terminated if job.is_running() => {
                    ("registry_terminal_status_pending", false)
                }
                ShellCompletionState::Terminated => ("terminated", true),
                ShellCompletionState::Failed(_) => ("termination_unproven", false),
            },
            None => {
                #[cfg(unix)]
                let process_tree_gone = !process_tree_exists(*pid);
                #[cfg(windows)]
                let process_tree_gone = !job.is_running();

                if !job.is_running() && process_tree_gone {
                    ("terminated", true)
                } else if job.shell_kill_requested {
                    ("process_tree_draining", false)
                } else {
                    ("process_tree_running", false)
                }
            }
        },
        JobKind::Subagent { .. } => {
            if !job.join_handle_attached {
                ("join_handle_pending", false)
            } else if job
                .join_handle
                .as_ref()
                .is_some_and(tokio::task::JoinHandle::is_finished)
                && !job.is_running()
            {
                ("terminated", true)
            } else if matches!(job.status, JobStatus::Killed) {
                ("worker_task_draining", false)
            } else if !job.is_running() {
                ("result_retention_task_draining", false)
            } else {
                ("worker_task_running", false)
            }
        }
    }
}

fn evidence_for_job(job: &BackgroundJob) -> SessionJobEvidence {
    let (kind, execution_state, execution_terminal) = match &job.kind {
        JobKind::Shell { .. } => {
            let (state, terminal) = execution_state(job);
            ("shell", state, terminal)
        }
        JobKind::Subagent { .. } => {
            let (state, terminal) = execution_state(job);
            ("subagent", state, terminal)
        }
    };
    SessionJobEvidence {
        session_id: job.session_id.clone(),
        handle: job.handle.clone(),
        kind: kind.to_string(),
        status: status_label(&job.status),
        execution_state: execution_state.to_string(),
        execution_terminal,
    }
}

fn indexed_evidence(session_ids: &[String], limit: usize) -> Vec<SessionJobEvidence> {
    let limit = limit.max(1);
    let reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    let index = SESSION_INDEX.lock().unwrap_or_else(|e| e.into_inner());
    let mut evidence = session_ids
        .iter()
        .flat_map(|session_id| index.get(session_id).into_iter().flatten())
        .filter_map(|handle| reg.get(handle))
        .map(evidence_for_job)
        .collect::<Vec<_>>();
    evidence.sort_by(|left, right| {
        left.session_id
            .cmp(&right.session_id)
            .then_with(|| left.handle.cmp(&right.handle))
    });
    evidence.truncate(limit);
    evidence
}

/// Read-only, bounded evidence for debug/WebDriver observations.
pub fn session_runtime_evidence(session_ids: &[String], limit: usize) -> Vec<SessionJobEvidence> {
    indexed_evidence(session_ids, limit)
}

/// Return only jobs whose external execution owner has not reached finality.
/// Status `killed` is deliberately insufficient for a subagent with a live
/// JoinHandle or a shell whose process/replay completion is still pending.
pub fn execution_blockers_for_sessions(
    session_ids: &[String],
    limit: usize,
) -> Vec<SessionJobEvidence> {
    let limit = limit.max(1);
    let reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    let index = SESSION_INDEX.lock().unwrap_or_else(|e| e.into_inner());
    let mut blockers = Vec::new();
    'sessions: for session_id in session_ids {
        for handle in index.get(session_id).into_iter().flatten() {
            let Some(job) = reg.get(handle) else {
                continue;
            };
            if !execution_state(job).1 {
                blockers.push(evidence_for_job(job));
                if blockers.len() >= limit {
                    break 'sessions;
                }
            }
        }
    }
    blockers.sort_by(|left, right| {
        left.session_id
            .cmp(&right.session_id)
            .then_with(|| left.handle.cmp(&right.handle))
    });
    blockers
}

#[derive(Clone)]
struct SubagentCancelRequest {
    session_id: String,
    handle: String,
    agent_name: String,
    subagent_type: String,
    broadcast_killed: bool,
    cancel_flag: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    abort_handle: Option<AbortHandle>,
    abort_immediately: bool,
}

/// Idempotently request cancellation for every execution owner in one
/// Session. The function never waits while holding a registry lock.
pub fn request_cancel_for_session(session_id: &str) -> usize {
    let (shell_requests, subagent_requests) = {
        let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
        let handles = live_handles(session_id);
        let mut shell_requests = Vec::<(String, u32, Option<CancellationToken>)>::new();
        let mut subagent_requests = Vec::<SubagentCancelRequest>::new();
        for handle in handles {
            let Some(job) = reg.get_mut(&handle) else {
                continue;
            };
            if execution_state(job).1 {
                continue;
            }
            match &job.kind {
                JobKind::Shell { pid, .. } => {
                    let newly_requested = !job.shell_kill_requested;
                    job.shell_kill_requested = true;
                    if job.shell_cancel.is_some() || newly_requested {
                        shell_requests.push((job.handle.clone(), *pid, job.shell_cancel.clone()));
                    }
                }
                JobKind::Subagent {
                    subagent_type,
                    agent_name,
                } => {
                    let broadcast_killed = job.is_running();
                    let abort_immediately =
                        !job.is_running() && !matches!(job.status, JobStatus::Killed);
                    let install_escalation = !job.session_cancel_escalation_requested;
                    job.status = JobStatus::Killed;
                    job.session_cancel_escalation_requested = true;
                    subagent_requests.push(SubagentCancelRequest {
                        session_id: job.session_id.clone(),
                        handle: job.handle.clone(),
                        agent_name: agent_name.clone(),
                        subagent_type: subagent_type.clone(),
                        broadcast_killed,
                        cancel_flag: job.cancel_flag.clone(),
                        abort_handle: install_escalation
                            .then(|| job.join_handle.as_ref().map(|handle| handle.abort_handle()))
                            .flatten(),
                        abort_immediately,
                    });
                }
            }
        }
        (shell_requests, subagent_requests)
    };

    for (handle, pid, cancel) in &shell_requests {
        if let Some(cancel) = cancel {
            cancel.cancel();
        } else {
            let handle = handle.clone();
            let pid = *pid;
            tokio::spawn(async move {
                if let Err(error) = terminate_shell_process_tree(pid).await {
                    tracing::warn!(pid, error = %error, "Archive could not stop legacy shell process tree");
                    let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(job) = reg.get_mut(&handle) {
                        job.shell_kill_requested = false;
                    }
                }
            });
        }
    }
    for request in &subagent_requests {
        if request.broadcast_killed {
            broadcast_subagent_job_changed(
                &request.session_id,
                &request.handle,
                &request.agent_name,
                &request.subagent_type,
                "killed",
            );
        }
        if let Some(cancel_flag) = &request.cancel_flag {
            cancel_flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        if let Some(abort_handle) = request.abort_handle.clone() {
            if request.abort_immediately {
                abort_handle.abort();
            } else {
                tokio::spawn(async move {
                    tokio::time::sleep(SESSION_SUBAGENT_ABORT_GRACE).await;
                    if !abort_handle.is_finished() {
                        abort_handle.abort();
                    }
                });
            }
        }
    }
    shell_requests.len() + subagent_requests.len()
}

/// Wait for shell process/replay owners and subagent JoinHandles to finish.
/// The caller owns the outer timeout. Three quiet index observations cover
/// the register-to-handle-attachment race without installing a watchdog.
pub async fn wait_for_session_finality(session_id: &str) -> Result<(), String> {
    let session_ids = vec![session_id.to_string()];
    let mut quiet_passes = 0usize;
    loop {
        request_cancel_for_session(session_id);
        let blockers = execution_blockers_for_sessions(&session_ids, DEFAULT_EVIDENCE_LIMIT);
        if blockers.is_empty() {
            quiet_passes += 1;
            if quiet_passes >= FINALITY_QUIET_PASSES {
                reap_terminal_jobs_for_session(session_id);
                return Ok(());
            }
        } else {
            quiet_passes = 0;
            if blockers
                .iter()
                .any(|job| job.execution_state == "termination_unproven")
            {
                return Err(format!(
                    "background_job_termination_unproven:{}",
                    summarize_evidence(&blockers)
                ));
            }
        }
        tokio::time::sleep(FINALITY_OBSERVATION_INTERVAL).await;
    }
}

fn reap_terminal_jobs_for_session(session_id: &str) {
    let handles = {
        let reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
        live_handles(session_id)
            .into_iter()
            .filter(|handle| reg.get(handle).is_some_and(|job| execution_state(job).1))
            .collect::<Vec<_>>()
    };
    for handle in handles {
        remove(&handle);
    }
}

pub fn summarize_evidence(evidence: &[SessionJobEvidence]) -> String {
    evidence
        .iter()
        .take(DEFAULT_EVIDENCE_LIMIT)
        .map(|job| {
            format!(
                "{}:{}:{}:{}",
                job.session_id, job.kind, job.handle, job.execution_state
            )
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// Physically forget every registry artifact owned by deleted Sessions.
/// The preflight and mutation share the same locks, so active execution can
/// never be detached by a purge race.
pub fn purge_deleted_sessions(session_ids: &[String]) -> Result<PurgedSessionJobs, String> {
    let targets = session_ids.iter().cloned().collect::<HashSet<_>>();
    let mut purged = PurgedSessionJobs::default();
    {
        let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
        let mut owner_index = OWNER_INDEX.lock().unwrap_or_else(|e| e.into_inner());
        let mut session_index = SESSION_INDEX.lock().unwrap_or_else(|e| e.into_inner());
        let handles = targets
            .iter()
            .flat_map(|session_id| session_index.get(session_id).into_iter().flatten())
            .cloned()
            .collect::<HashSet<_>>();
        let blockers = handles
            .iter()
            .filter_map(|handle| reg.get(handle))
            .filter(|job| !execution_state(job).1)
            .map(evidence_for_job)
            .take(DEFAULT_EVIDENCE_LIMIT)
            .collect::<Vec<_>>();
        if !blockers.is_empty() {
            return Err(format!(
                "team_background_jobs_not_quiesced:{}",
                summarize_evidence(&blockers)
            ));
        }
        for handle in handles {
            if let Some(job) = reg.remove(&handle) {
                if let Some(owner) = job.turn_owner.as_ref() {
                    remove_indexed_handle(&mut owner_index, owner, &handle);
                }
                purged.live_jobs += 1;
            }
        }
        for session_id in &targets {
            session_index.remove(session_id);
        }
    }

    {
        let mut tombstones = TOMBSTONES.lock().unwrap_or_else(|e| e.into_inner());
        let mut tombstone_index = TOMBSTONE_SESSION_INDEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for session_id in &targets {
            let handles = tombstone_index.remove(session_id).unwrap_or_default();
            for handle in handles {
                if tombstones.remove(&handle).is_some() {
                    purged.tombstones += 1;
                }
            }
        }
    }
    Ok(purged)
}

/// Count retained terminal receipts for exact Sessions. Used only by the
/// debug/WebDriver evidence surface and tests; no background scan is needed.
pub fn retained_tombstone_count(session_ids: &[String]) -> usize {
    let now = std::time::Instant::now();
    let mut tombstones = TOMBSTONES.lock().unwrap_or_else(|e| e.into_inner());
    let mut index = TOMBSTONE_SESSION_INDEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut retained = 0usize;
    for session_id in session_ids {
        let handles = index.get(session_id).cloned().unwrap_or_default();
        for handle in handles {
            let expired = tombstones.get(&handle).is_none_or(|tombstone| {
                now.duration_since(tombstone.created_at) >= super::TOMBSTONE_TTL
            });
            if expired {
                tombstones.remove(&handle);
                remove_handle(&mut index, session_id, &handle);
            } else {
                retained += 1;
            }
        }
    }
    retained
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Instant;

    use super::*;
    use crate::tools::impls::coding::exec::registry::{
        resolve_status_with_tombstone, Tombstone, TOMBSTONE_TTL,
    };

    #[test]
    fn expired_tombstone_is_removed_from_session_index_on_read() {
        let session_id = "expired-tombstone-index";
        let handle = "expired-tombstone-handle";
        {
            let mut tombstones = TOMBSTONES.lock().unwrap_or_else(|e| e.into_inner());
            tombstones.insert(
                handle.to_string(),
                Tombstone {
                    session_id: session_id.to_string(),
                    status: JobStatus::Exited(0),
                    kind: JobKind::Shell {
                        pid: 99_969,
                        log_path: PathBuf::from("/tmp/expired-tombstone.txt"),
                        replay_session_id: None,
                        replay_call_id: None,
                    },
                    created_at: Instant::now() - TOMBSTONE_TTL - Duration::from_secs(1),
                },
            );
            replace_tombstone_index(None, session_id, handle);
        }
        assert_eq!(retained_tombstone_count(&[session_id.into()]), 0);
        assert!(resolve_status_with_tombstone(handle).is_none());
    }
}
