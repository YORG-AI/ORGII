//! Background job registry — tracks backgrounded shell processes and subagents
//! for the Await tool.
//!
//! When `ExecTool` backgrounds a subprocess or `AgentTool` launches a background
//! subagent, it registers the job here so `AwaitTool` can subscribe to live output
//! and query status using a unified string handle.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

/// Status of a background job.
#[derive(Debug, Clone)]
pub enum JobStatus {
    Running,
    Exited(i32),
    Killed,
    Completed,
    Failed,
}

/// What kind of background job this is.
#[derive(Debug, Clone)]
pub enum JobKind {
    Shell {
        pid: u32,
        log_path: PathBuf,
        /// Exact durable replay identity for new run_shell jobs. `None` is
        /// retained only for legacy/test `.txt` jobs.
        replay_session_id: Option<String>,
        replay_call_id: Option<String>,
    },
    Subagent {
        subagent_type: String,
        agent_name: String,
    },
}

/// Lightweight snapshot returned by `list_jobs`.
#[derive(Debug, Clone)]
pub struct JobSnapshot {
    pub handle: String,
    pub label: String,
    pub kind_label: String,
    pub status: JobStatus,
    pub age_ms: u64,
    pub has_unread_output: bool,
    /// Final result text for completed subagent jobs (None for shell
    /// processes and still-running jobs). Lets the per-turn reminder inject
    /// the result directly instead of forcing an extra `await_output` hop.
    pub final_result: Option<String>,
    /// The stall watchdog latched this running shell as apparently blocked on
    /// an interactive prompt (no output growth + prompt-like tail). Cleared
    /// automatically if output resumes.
    pub stalled_waiting_input: bool,
}

const MAX_RECENT_LINES: usize = 200;

/// A registered background job (shell process or subagent).
pub struct BackgroundJob {
    pub handle: String,
    pub label: String,
    pub kind: JobKind,
    pub session_id: String,
    pub started_at: Instant,
    pub status: JobStatus,
    pub final_result: Option<String>,
    output_tx: broadcast::Sender<String>,
    recent_lines: VecDeque<String>,
    /// Tokio JoinHandle for background subagents — `abort()` cancels the task.
    join_handle: Option<JoinHandle<()>>,
    /// Per-job cancel flag for background subagents. Owned by the job (NOT
    /// the parent session's flag — that one is pulsed back to `false` at the
    /// parent's turn boundary, which a slow worker can miss entirely).
    /// Setting it lets the worker's `execute_turn` loop exit at the next
    /// iteration/stream checkpoint and run its own completion path
    /// (LinkedSession terminal write, worktree cleanup, registry grace
    /// period). `None` for shell jobs.
    cancel_flag: Option<Arc<AtomicBool>>,
    /// Set to `true` once the agent has read the completed job's output via
    /// `AwaitTool` (monitor/wait_for). Acknowledged completed jobs are excluded
    /// from the per-turn system reminder to avoid the stale-reminder
    /// problem common to background bash notifications.
    output_acknowledged: bool,
    /// Set to `true` once an owner-session wake has been dispatched to deliver
    /// this (completed) job's result. Distinct from `output_acknowledged`:
    /// dispatch means "we resumed the idle owner so it COULD read the result",
    /// ack means "the agent actually read it via await_output". Together they
    /// make the job-wake coordinator behaviour-independent and exactly-once:
    /// a result triggers AT MOST ONE wake dispatch, regardless of whether the
    /// woken agent goes on to read it. This single flag subsumes both the
    /// empty-wake loop (woken owner ignores the result → no re-wake) and the
    /// retry storm (a failed wake turn → no re-wake for the same result).
    /// Applies to both kinds: subagents wake their parent session, shells wake
    /// the session that launched them.
    wake_dispatched: bool,
    /// Monotonic count of output lines pushed into `recent_lines`. Unlike the
    /// bounded deque (which plateaus once full), this never stops advancing,
    /// so it serves as the progress cursor for jobs whose output only lives
    /// in the rolling buffer (subagents).
    output_seq: u64,
    /// Latched by the shell stall watchdog when output stopped growing and
    /// the tail looks like an interactive prompt. Cleared when output
    /// resumes. Always `false` for subagents.
    stalled_waiting_input: bool,
    /// Whether the stalled-state advisory has been delivered to the owner
    /// (mid-turn note or idle wake). Separate from `wake_dispatched` so a
    /// stall advisory never consumes the job's one completion wake.
    stall_delivered: bool,
}

impl BackgroundJob {
    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.output_tx.subscribe()
    }

    pub fn is_running(&self) -> bool {
        matches!(self.status, JobStatus::Running)
    }

    pub fn log_path(&self) -> Option<&PathBuf> {
        match &self.kind {
            JobKind::Shell { log_path, .. } => Some(log_path),
            JobKind::Subagent { .. } => None,
        }
    }

    pub fn push_recent_line(&mut self, line: String) {
        if self.recent_lines.len() >= MAX_RECENT_LINES {
            self.recent_lines.pop_front();
        }
        self.recent_lines.push_back(line);
        self.output_seq = self.output_seq.saturating_add(1);
    }

    pub fn recent_output(&self) -> String {
        self.recent_lines
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn snapshot(&self) -> JobSnapshot {
        let kind_label = match &self.kind {
            JobKind::Shell { .. } => "shell".to_string(),
            JobKind::Subagent { subagent_type, .. } => format!("subagent:{subagent_type}"),
        };
        let has_unread_output = !self.output_acknowledged && !self.is_running();
        JobSnapshot {
            handle: self.handle.clone(),
            label: self.label.clone(),
            kind_label,
            status: self.status.clone(),
            age_ms: self.started_at.elapsed().as_millis() as u64,
            has_unread_output,
            final_result: if has_unread_output {
                self.final_result.clone()
            } else {
                None
            },
            stalled_waiting_input: self.stalled_waiting_input && self.is_running(),
        }
    }
}

/// Mark every completed-with-result job in `handles` as acknowledged.
/// Called by the reminder builder after it inlines those results, so they
/// are delivered to the parent exactly once.
pub fn acknowledge_outputs(handles: &[String]) {
    let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    for handle in handles {
        if let Some(job) = reg.get_mut(handle) {
            job.output_acknowledged = true;
        }
    }
}

const BROADCAST_CAPACITY: usize = 512;

static REGISTRY: LazyLock<Mutex<HashMap<String, BackgroundJob>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// How long a finished job's tombstone is retained after it leaves the live
/// registry. Long enough that an `await_output` arriving just after the grace
/// eviction still gets a precise "completed" answer (with the real kind), short
/// enough that the map cannot grow unbounded. Distinct from the live-job
/// retention window in `background.rs`.
const TOMBSTONE_TTL: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// A lightweight record of a job that has left the live registry. Lets
/// `await_output` distinguish "this handle finished and was reaped" (precise
/// terminal status + real kind) from "this handle never existed" (the agent
/// mistyped it), instead of synthesising a guess from the handle string.
#[derive(Clone)]
struct Tombstone {
    status: JobStatus,
    kind: JobKind,
    created_at: Instant,
}

static TOMBSTONES: LazyLock<Mutex<HashMap<String, Tombstone>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Register a backgrounded shell process. Returns a `broadcast::Sender` the
/// caller should use to feed live output lines.
pub fn register_shell(
    pid: u32,
    command: String,
    log_path: PathBuf,
    session_id: String,
) -> broadcast::Sender<String> {
    register_shell_inner(pid, command, log_path, session_id, None)
}

/// Register a new durable shell replay job by exact Session/call identity.
pub fn register_shell_replay(
    pid: u32,
    command: String,
    log_path: PathBuf,
    session_id: String,
    call_id: String,
) -> broadcast::Sender<String> {
    let replay_session_id = session_id.clone();
    register_shell_inner(
        pid,
        command,
        log_path,
        session_id,
        Some((replay_session_id, call_id)),
    )
}

fn register_shell_inner(
    pid: u32,
    command: String,
    log_path: PathBuf,
    session_id: String,
    replay_identity: Option<(String, String)>,
) -> broadcast::Sender<String> {
    let handle = pid.to_string();
    let (tx, _) = broadcast::channel(BROADCAST_CAPACITY);
    let sender = tx.clone();
    let job = BackgroundJob {
        handle: handle.clone(),
        label: command,
        kind: JobKind::Shell {
            pid,
            log_path,
            replay_session_id: replay_identity.as_ref().map(|value| value.0.clone()),
            replay_call_id: replay_identity.map(|value| value.1),
        },
        session_id,
        started_at: Instant::now(),
        status: JobStatus::Running,
        final_result: None,
        output_tx: tx,
        recent_lines: VecDeque::new(),
        join_handle: None,
        cancel_flag: None,
        output_acknowledged: false,
        wake_dispatched: false,
        output_seq: 0,
        stalled_waiting_input: false,
        stall_delivered: false,
    };
    let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    reg.insert(handle, job);
    sender
}

/// Register a background subagent. Returns the `broadcast::Sender` the caller
/// should use to feed text summaries of subagent events, plus the job's own
/// cancel flag (to be passed into the worker's `execute_turn` so kill /
/// parent-Stop fan-out can cooperatively stop the turn loop).
pub fn register_subagent(
    handle: String,
    subagent_type: String,
    agent_name: String,
    session_id: String,
) -> (broadcast::Sender<String>, Arc<AtomicBool>) {
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let sender = register_subagent_with_flag(
        handle,
        subagent_type,
        agent_name,
        session_id,
        Arc::clone(&cancel_flag),
    );
    (sender, cancel_flag)
}

/// Register a subagent whose turn loop observes an EXISTING cancel flag.
///
/// Used by foreground subagents, whose `execute_turn` already watches the
/// parent session's cancel flag: registering with that same flag makes
/// `kill_subagent` reach them through the one chokepoint. Note the shared
/// flag means killing a foreground worker also ends the parent's turn at
/// its next checkpoint — by design: the parent is blocked on the worker
/// anyway, and Stop means stop.
pub fn register_subagent_with_flag(
    handle: String,
    subagent_type: String,
    agent_name: String,
    session_id: String,
    cancel_flag: Arc<AtomicBool>,
) -> broadcast::Sender<String> {
    let (tx, _) = broadcast::channel(BROADCAST_CAPACITY);
    let sender = tx.clone();
    let job = BackgroundJob {
        handle: handle.clone(),
        label: agent_name.clone(),
        kind: JobKind::Subagent {
            subagent_type: subagent_type.clone(),
            agent_name: agent_name.clone(),
        },
        session_id: session_id.clone(),
        started_at: Instant::now(),
        status: JobStatus::Running,
        final_result: None,
        output_tx: tx,
        recent_lines: VecDeque::new(),
        join_handle: None,
        cancel_flag: Some(Arc::clone(&cancel_flag)),
        output_acknowledged: false,
        wake_dispatched: false,
        output_seq: 0,
        stalled_waiting_input: false,
        stall_delivered: false,
    };
    let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    reg.insert(handle.clone(), job);
    drop(reg);
    broadcast_subagent_job_changed(&session_id, &handle, &agent_name, &subagent_type, "running");
    sender
}

/// Broadcast a background-subagent lifecycle change to the frontend.
///
/// The subagent counterpart of `subprocess::broadcast_process_started` /
/// `broadcast_process_exited`: drives the ActiveProcesses pin bar above the
/// chat composer so the user can see (and kill) background workers. `status`
/// is the wire string: "running" | "completed" | "failed" | "killed".
pub fn broadcast_subagent_job_changed(
    session_id: &str,
    handle: &str,
    agent_name: &str,
    subagent_type: &str,
    status: &str,
) {
    crate::bus::broadcast_event(
        "agent:subagent_job_changed",
        serde_json::json!({
            "sessionId": session_id,
            "handle": handle,
            "agentName": agent_name,
            "subagentType": subagent_type,
            "status": status,
        }),
    );
}

/// Mark a job as exited/completed/failed. The entry remains for a grace period
/// so `AwaitTool` can still read final status.
///
/// `Killed` is sticky: a cooperatively-cancelled subagent still runs its
/// normal completion path, which calls this with `Completed` — that must
/// not overwrite the user-visible "killed" verdict.
pub fn mark_exited(handle: &str, status: JobStatus) {
    let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    let Some(job) = reg.get_mut(handle) else {
        return;
    };
    if matches!(job.status, JobStatus::Killed) {
        return;
    }
    job.status = status;
    if let JobKind::Subagent {
        subagent_type,
        agent_name,
    } = &job.kind
    {
        let wire_status = match &job.status {
            JobStatus::Completed | JobStatus::Exited(_) => "completed",
            JobStatus::Failed => "failed",
            JobStatus::Killed => "killed",
            JobStatus::Running => "running",
        };
        broadcast_subagent_job_changed(
            &job.session_id,
            &job.handle,
            agent_name,
            subagent_type,
            wire_status,
        );
    }
}

/// Store the final result text for a completed subagent job.
pub fn set_final_result(handle: &str, result: String) {
    let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(job) = reg.get_mut(handle) {
        job.final_result = Some(result);
    }
}

/// Remove a job from the registry (called after grace period).
///
/// Leaves a short-lived [`Tombstone`] behind so a late `await_output` can
/// still report a precise terminal status with the real job kind, rather than
/// the caller having to guess from the handle shape. Opportunistically prunes
/// expired tombstones on the same pass so the map stays bounded without a
/// dedicated reaper.
pub fn remove(handle: &str) {
    let removed = {
        let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
        reg.remove(handle)
    };
    if let Some(job) = removed {
        let mut tombs = TOMBSTONES.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        tombs.retain(|_, t| now.duration_since(t.created_at) < TOMBSTONE_TTL);
        tombs.insert(
            handle.to_string(),
            Tombstone {
                status: job.status.clone(),
                kind: job.kind.clone(),
                created_at: now,
            },
        );
    }
}

/// Retrieve a snapshot of job metadata. Returns `None` if not found.
pub fn get_status(handle: &str) -> Option<(JobStatus, JobKind)> {
    let reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    reg.get(handle)
        .map(|job| (job.status.clone(), job.kind.clone()))
}

/// Resolve a handle's terminal status + kind, consulting the tombstone map
/// when the job has already left the live registry.
///
/// Three-way outcome:
/// - **live job present** → its real `(status, kind)`.
/// - **tombstone present (not expired)** → the reaped job's real terminal
///   `(status, kind)` — a precise "it finished" answer.
/// - **neither** → `None`, meaning the handle genuinely never existed (or its
///   tombstone expired): the caller can report a real "unknown handle" error.
///
/// This replaces the old "synthesise a Completed status and guess the kind from
/// the handle string" heuristic, which could not tell a just-reaped job from a
/// typo.
pub fn resolve_status_with_tombstone(handle: &str) -> Option<(JobStatus, JobKind)> {
    if let Some(found) = get_status(handle) {
        return Some(found);
    }
    let tombs = TOMBSTONES.lock().unwrap_or_else(|e| e.into_inner());
    tombs.get(handle).and_then(|t| {
        if Instant::now().duration_since(t.created_at) < TOMBSTONE_TTL {
            Some((t.status.clone(), t.kind.clone()))
        } else {
            None
        }
    })
}

/// Get the final result text for a job.
pub fn get_final_result(handle: &str) -> Option<String> {
    let reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    reg.get(handle).and_then(|job| job.final_result.clone())
}

/// Subscribe to a job's live output stream. Returns `None` if not found.
pub fn subscribe(handle: &str) -> Option<broadcast::Receiver<String>> {
    let reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    reg.get(handle).map(|job| job.subscribe())
}

/// List active (running) shell jobs for a session.
pub fn list_shell_for_session(session_id: &str) -> Vec<(u32, String)> {
    let reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    reg.values()
        .filter(|job| job.session_id == session_id && job.is_running())
        .filter_map(|job| match &job.kind {
            JobKind::Shell { pid, .. } => Some((*pid, job.label.clone())),
            JobKind::Subagent { .. } => None,
        })
        .collect()
}

/// List all jobs (shells + subagents). Pass `Some(session_id)` for session
/// scope, `None` for global scope.
pub fn list_jobs(session_id: Option<&str>) -> Vec<JobSnapshot> {
    let reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    reg.values()
        .filter(|job| match session_id {
            Some(sid) => job.session_id == sid,
            None => true,
        })
        .map(|job| job.snapshot())
        .collect()
}

/// Mark a completed job's output as acknowledged. Once acknowledged, the job
/// is excluded from the per-turn system-reminder injection. This avoids
/// stale "has new output" reminders for jobs whose output has already been
/// read.
pub fn acknowledge_output(handle: &str) {
    let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(job) = reg.get_mut(handle) {
        job.output_acknowledged = true;
    }
}

/// Whether a job's output has been acknowledged (read via the reminder /
/// await path). Returns `None` if the handle is no longer in the registry —
/// callers treat a missing job as "nothing left to retain" (acknowledged).
pub fn is_output_acknowledged(handle: &str) -> Option<bool> {
    let reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    reg.get(handle).map(|job| job.output_acknowledged)
}

/// List jobs that should appear in the per-turn system reminder.
///
/// Includes:
/// - All **running** jobs (agent needs to know they're still going)
/// - **Completed/failed** jobs whose output has **not** been acknowledged
///
/// Excludes:
/// - Completed jobs whose output was already read via `AwaitTool`
pub fn list_jobs_for_reminder(session_id: &str) -> Vec<JobSnapshot> {
    let reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    reg.values()
        .filter(|job| {
            job.session_id == session_id && (job.is_running() || !job.output_acknowledged)
        })
        .map(|job| job.snapshot())
        .collect()
}

/// Whether a finished job's result should ever wake its owner session.
///
/// Both kinds qualify — subagents wake the parent, shells wake the session
/// that launched them — with one exception: a **killed shell** never wakes.
/// A shell only ends up `Killed` because the model called
/// `run_shell(kill_handle=...)` or the user pressed Stop; whoever killed it
/// already knows, so resuming an idle session to announce it would be noise.
/// Killed subagents DO wake: the parent is a different session that must
/// learn its worker was cancelled to re-plan.
fn job_completion_is_wakeworthy(job: &BackgroundJob) -> bool {
    !(matches!(job.kind, JobKind::Shell { .. }) && matches!(job.status, JobStatus::Killed))
}

/// Atomically claim every undelivered job event for `session_id`, returning
/// whether any were claimed.
///
/// This is the single exactly-once primitive behind the job-wake
/// coordinator and the mid-turn note injector. Two event kinds need
/// delivery:
///   * **completion** — the job is finished (not running), wake-worthy (see
///     [`job_completion_is_wakeworthy`] — killed shells are not), not yet
///     acknowledged, and not yet wake-dispatched. Claimed by marking
///     `wake_dispatched = true`.
///   * **stall advisory** — a running shell latched as waiting for
///     interactive input whose advisory has not been delivered. Claimed by
///     marking `stall_delivered = true` (a separate flag, so an advisory
///     never consumes the job's one completion wake).
///
/// Marking in the same locked pass guarantees a given event triggers AT MOST
/// ONE delivery, no matter how many triggers fire (completion push, stall
/// watchdog, mid-turn injector, turn-end re-check — whichever runs first
/// claims it, the others see nothing). This makes exactly-once an invariant
/// of the registry, not of caller ordering — and subsumes both the
/// empty-wake loop and the failed-wake retry storm without any
/// `response.is_ok` / status gating in the callers.
pub fn claim_completion_wake_for_session(session_id: &str) -> bool {
    let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    let mut claimed = false;
    for job in reg.values_mut() {
        if job.session_id != session_id {
            continue;
        }
        if !job.is_running()
            && job_completion_is_wakeworthy(job)
            && !job.output_acknowledged
            && !job.wake_dispatched
        {
            job.wake_dispatched = true;
            claimed = true;
        }
        if job.is_running() && job.stalled_waiting_input && !job.stall_delivered {
            job.stall_delivered = true;
            claimed = true;
        }
    }
    claimed
}

/// Release a claim previously taken by `claim_completion_wake_for_session`
/// for every still-undelivered job event of `session_id`.
///
/// Used when the coordinator claimed an event but then found the owner was
/// still running (so it could not dispatch a resume turn). Releasing restores
/// the claim flags so the mid-turn injector or the turn-end re-check can
/// re-claim once possible. Only clears completion claims on jobs that are
/// still unconsumed — an already-acknowledged job needs no further wake
/// regardless.
pub fn release_completion_wake_for_session(session_id: &str) {
    let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    for job in reg.values_mut() {
        if job.session_id != session_id {
            continue;
        }
        if !job.is_running() && !job.output_acknowledged {
            job.wake_dispatched = false;
        }
        if job.is_running() && job.stalled_waiting_input {
            job.stall_delivered = false;
        }
    }
}

/// Latch a running shell as apparently blocked on an interactive prompt.
/// Returns `true` when newly latched (the watchdog announces + wakes once),
/// `false` when already latched, not running, or unknown.
pub fn mark_stalled_waiting_input(handle: &str) -> bool {
    let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    match reg.get_mut(handle) {
        Some(job) if job.is_running() && !job.stalled_waiting_input => {
            job.stalled_waiting_input = true;
            true
        }
        _ => false,
    }
}

/// Clear the stall latch after output resumed growing, re-arming the
/// advisory so a later distinct stall can be delivered again.
pub fn clear_stalled_waiting_input(handle: &str) {
    let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(job) = reg.get_mut(handle) {
        job.stalled_waiting_input = false;
        job.stall_delivered = false;
    }
}

/// Whether a running job is currently latched as waiting for interactive
/// input. `None` when the handle is not registered.
pub fn is_stalled_waiting_input(handle: &str) -> Option<bool> {
    let reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    reg.get(handle)
        .map(|job| job.stalled_waiting_input && job.is_running())
}

/// Monotonic output-line counter for a job's rolling buffer. `None` when the
/// handle is no longer registered. Used as the progress cursor for subagent
/// jobs (shell jobs use the replay bookmark / log size instead).
pub fn get_output_seq(handle: &str) -> Option<u64> {
    let reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    reg.get(handle).map(|job| job.output_seq)
}

/// Retain a finished job in the registry until its output is acknowledged
/// (read via the reminder / await path), polling at a coarse interval, then
/// remove it. Bounded by `max_retention` so an owner that never returns
/// cannot leak the entry forever. Shared GC tail for every completion path
/// (background subagent, fg→bg transition, backgrounded shell).
pub async fn retain_until_acknowledged_then_remove(
    handle: &str,
    max_retention: std::time::Duration,
    log_tag: &str,
) {
    const ACK_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);
    let retain_deadline = Instant::now() + max_retention;
    loop {
        tokio::time::sleep(ACK_POLL_INTERVAL).await;
        match is_output_acknowledged(handle) {
            None | Some(true) => break,
            Some(false) => {}
        }
        if Instant::now() >= retain_deadline {
            tracing::warn!(
                "[{log_tag}] '{handle}' result was never acknowledged within retention window; evicting"
            );
            break;
        }
    }
    remove(handle);
}

/// Lightweight snapshot of a running shell job, suitable for frontend
/// reconciliation on reload. Only includes shell jobs with `Running` status.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunningShellJob {
    pub session_id: String,
    pub call_id: String,
    pub pid: u32,
    pub command: String,
}

/// List all currently running shell jobs across all sessions.
///
/// Used by the frontend `useProcessReconciliation` hook to reseed
/// `shellProcessMapAtom` after a hot reload / page refresh.
pub fn list_running_shell_jobs() -> Vec<RunningShellJob> {
    let reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    reg.values()
        .filter(|job| job.is_running())
        .filter_map(|job| match &job.kind {
            JobKind::Shell {
                pid,
                log_path: _,
                replay_session_id: Some(replay_session_id),
                replay_call_id: Some(replay_call_id),
            } if replay_session_id == &job.session_id => Some(RunningShellJob {
                session_id: replay_session_id.clone(),
                call_id: replay_call_id.clone(),
                pid: *pid,
                command: job.label.clone(),
            }),
            // Legacy jobs lack an exact call identity and cannot safely reseed
            // a per-call frontend process row.
            JobKind::Shell { .. } => None,
            JobKind::Subagent { .. } => None,
        })
        .collect()
}

/// Lightweight snapshot of a running background subagent, the subagent
/// counterpart of [`RunningShellJob`]. Same consumer: frontend process
/// reconciliation after a hot reload / page refresh.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningSubagentJob {
    pub session_id: String,
    pub handle: String,
    pub agent_name: String,
    pub subagent_type: String,
    pub age_ms: u64,
}

/// List all currently running background subagents across all sessions.
pub fn list_running_subagent_jobs() -> Vec<RunningSubagentJob> {
    let reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    reg.values()
        .filter(|job| job.is_running())
        .filter_map(|job| match &job.kind {
            JobKind::Subagent {
                subagent_type,
                agent_name,
            } => Some(RunningSubagentJob {
                session_id: job.session_id.clone(),
                handle: job.handle.clone(),
                agent_name: agent_name.clone(),
                subagent_type: subagent_type.clone(),
                age_ms: job.started_at.elapsed().as_millis() as u64,
            }),
            JobKind::Shell { .. } => None,
        })
        .collect()
}

/// Get the recent output buffer for a subagent job (or empty string for
/// shells — use `read_log_body` for shells instead).
pub fn get_recent_output(handle: &str) -> Option<String> {
    let reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    reg.get(handle).map(|job| job.recent_output())
}

/// Append a line to the job's rolling buffer. Used by `BroadcastingHandler`
/// to keep a tail window for subagent output.
pub fn push_output_line(handle: &str, line: String) {
    let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(job) = reg.get_mut(handle) {
        job.push_recent_line(line);
    }
}

/// Store the JoinHandle for a background subagent so it can be aborted later.
pub fn set_join_handle(handle: &str, jh: JoinHandle<()>) {
    let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(job) = reg.get_mut(handle) {
        job.join_handle = Some(jh);
    }
}

#[cfg(unix)]
fn send_signal_to_process_tree(pid: u32, signal: libc::c_int) -> Result<(), std::io::Error> {
    let pid = pid as libc::pid_t;
    let group_result = unsafe { libc::kill(-pid, signal) };
    if group_result == 0 {
        return Ok(());
    }

    let group_error = std::io::Error::last_os_error();
    let process_result = unsafe { libc::kill(pid, signal) };
    if process_result == 0 {
        return Ok(());
    }

    let process_error = std::io::Error::last_os_error();
    if group_error.raw_os_error() == Some(libc::ESRCH)
        && process_error.raw_os_error() == Some(libc::ESRCH)
    {
        return Err(process_error);
    }

    Err(process_error)
}

#[cfg(unix)]
fn process_tree_exists(pid: u32) -> bool {
    let pid = pid as libc::pid_t;
    unsafe { libc::kill(-pid, 0) == 0 || libc::kill(pid, 0) == 0 }
}

#[cfg(unix)]
pub async fn terminate_shell_process_tree(pid: u32) -> Result<String, String> {
    if pid == 0 {
        return Err("Refusing to kill PID 0 (would signal entire process group)".to_string());
    }

    match send_signal_to_process_tree(pid, libc::SIGTERM) {
        Ok(()) => {}
        Err(err) if err.raw_os_error() == Some(libc::ESRCH) => {
            return Ok(format!("Process {} already exited", pid));
        }
        Err(err) => return Err(format!("Failed to send SIGTERM to {}: {}", pid, err)),
    }

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    if process_tree_exists(pid) {
        match send_signal_to_process_tree(pid, libc::SIGKILL) {
            Ok(()) => Ok(format!("Process {} killed (SIGKILL)", pid)),
            Err(err) if err.raw_os_error() == Some(libc::ESRCH) => {
                Ok(format!("Process {} terminated (SIGTERM)", pid))
            }
            Err(err) => Err(format!("Failed to send SIGKILL to {}: {}", pid, err)),
        }
    } else {
        Ok(format!("Process {} terminated (SIGTERM)", pid))
    }
}

#[cfg(windows)]
pub async fn terminate_shell_process_tree(pid: u32) -> Result<String, String> {
    if pid == 0 {
        return Err("Refusing to kill PID 0".to_string());
    }

    let mut command = tokio::process::Command::new("taskkill");
    command.args(["/PID", &pid.to_string(), "/T", "/F"]);
    // Suppress the console window `taskkill` would otherwise flash.
    command.creation_flags(app_platform::CREATE_NO_WINDOW);
    let output = command
        .output()
        .await
        .map_err(|err| format!("Failed to kill process {}: {}", pid, err))?;

    if output.status.success() {
        Ok(format!("Process {} killed", pid))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("not found") || stderr.contains("not running") {
            Ok(format!("Process {} already exited", pid))
        } else {
            Err(format!("Failed to kill process {}: {}", pid, stderr))
        }
    }
}

/// Kill a shell process by PID (SIGTERM, grace period, then SIGKILL).
/// Returns `Ok(())` on success or `Err(msg)` if the handle is not found or
/// not a shell job.
pub async fn kill_shell(handle: &str) -> Result<(), String> {
    let pid = {
        let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
        let job = reg
            .get_mut(handle)
            .ok_or_else(|| format!("handle '{handle}' not found"))?;
        let pid = match &job.kind {
            JobKind::Shell { pid, .. } => *pid,
            JobKind::Subagent { .. } => {
                return Err("not a shell job — use the agent tool to kill subagents".into())
            }
        };
        if !job.is_running() {
            return Err(format!("job '{handle}' already exited"));
        }
        job.status = JobStatus::Killed;
        pid
    };

    terminate_shell_process_tree(pid).await.map(|_| ())
}

/// Abort a background subagent.
///
/// Cooperative-first: sets the job's own cancel flag so the worker's
/// `execute_turn` exits at its next checkpoint and runs its normal
/// completion path (final-result write, LinkedSession terminal status,
/// worktree cleanup, registry grace period). A watchdog task hard-aborts
/// the JoinHandle only if the worker has not finished within the grace
/// window — a worker stuck inside a non-cancellable await must not leak
/// forever.
///
/// Returns `Ok(())` on success or `Err(msg)` if the handle is not found or
/// not a subagent.
pub fn kill_subagent(handle: &str) -> Result<(), String> {
    const HARD_ABORT_GRACE_SECS: u64 = 10;

    let (cancel_flag, join_handle, broadcast_info) = {
        let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
        let job = reg
            .get_mut(handle)
            .ok_or_else(|| format!("handle '{handle}' not found"))?;
        let broadcast_info = match &job.kind {
            JobKind::Shell { .. } => {
                return Err("not a subagent — use run_shell to kill shell processes".into())
            }
            JobKind::Subagent {
                subagent_type,
                agent_name,
            } => (
                job.session_id.clone(),
                agent_name.clone(),
                subagent_type.clone(),
            ),
        };
        if !job.is_running() {
            return Err(format!("subagent '{handle}' already finished"));
        }
        job.status = JobStatus::Killed;
        (
            job.cancel_flag.clone(),
            job.join_handle.take(),
            broadcast_info,
        )
    };

    let (session_id, agent_name, subagent_type) = broadcast_info;
    broadcast_subagent_job_changed(&session_id, handle, &agent_name, &subagent_type, "killed");

    if let Some(flag) = cancel_flag {
        flag.store(true, Ordering::SeqCst);
        if let Some(jh) = join_handle {
            // Watchdog: give the cooperative path a grace window, then abort.
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(HARD_ABORT_GRACE_SECS)).await;
                if !jh.is_finished() {
                    tracing::warn!(
                        "[job-registry] background subagent did not stop within {}s of cancel; hard-aborting task",
                        HARD_ABORT_GRACE_SECS
                    );
                    jh.abort();
                }
            });
        }
    } else if let Some(jh) = join_handle {
        // Legacy job registered without a flag — hard abort is all we have.
        jh.abort();
    }
    Ok(())
}

/// Fan out cancellation to every **running background subagent** spawned by
/// `session_id`. Called from `AgentSession::cancel_active_turn` when the
/// cancel reason's boundary effect requests worker cancellation (UserStop /
/// OrgPause / shutdown — NOT ForceSend).
///
/// Uses each job's own flag, so the parent resetting its session flag at the
/// next turn boundary cannot "un-cancel" a slow worker (the pulse-miss race).
/// Best-effort: errors on individual jobs are logged, not propagated.
pub fn cancel_subagents_for_session(session_id: &str) -> usize {
    let handles: Vec<String> = {
        let reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
        reg.values()
            .filter(|job| {
                job.session_id == session_id
                    && job.is_running()
                    && matches!(job.kind, JobKind::Subagent { .. })
            })
            .map(|job| job.handle.clone())
            .collect()
    };
    let mut cancelled = 0usize;
    for handle in &handles {
        match kill_subagent(handle) {
            Ok(()) => cancelled += 1,
            Err(err) => tracing::warn!(
                "[job-registry] failed to cancel background subagent '{}' for session {}: {}",
                handle,
                session_id,
                err
            ),
        }
    }
    if cancelled > 0 {
        tracing::info!(
            "[job-registry] cancelled {} background subagent(s) for session {}",
            cancelled,
            session_id
        );
    }
    cancelled
}
