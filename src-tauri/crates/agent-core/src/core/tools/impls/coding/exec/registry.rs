//! Background job registry — tracks backgrounded shell processes and subagents
//! for the Await tool.
//!
//! When `ExecTool` backgrounds a subprocess or `AgentTool` launches a background
//! subagent, it registers the job here so `AwaitTool` can subscribe to live output
//! and query status using a unified string handle.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::tools::call_context::{TurnProcessControl, TurnProcessOwner};

mod session_lifecycle;

pub use session_lifecycle::{
    execution_blockers_for_sessions, purge_deleted_sessions, request_cancel_for_session,
    retained_tombstone_count, session_runtime_evidence, wait_for_session_finality,
    PurgedSessionJobs, SessionJobEvidence,
};

/// Status of a background job.
#[derive(Debug, Clone)]
pub enum JobStatus {
    Running,
    Exited(i32),
    Killed,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ShellCompletionState {
    Running,
    Terminated,
    Failed(String),
}

/// Completion half retained by the subprocess monitor. The registry keeps
/// the receiver so Pause can await OS-level process-group finality without
/// taking ownership away from the one task that owns the child handle.
pub struct ShellMonitorCompletion {
    tx: watch::Sender<ShellCompletionState>,
}

impl ShellMonitorCompletion {
    pub fn finish(self, result: Result<(), String>) {
        self.tx.send_replace(match result {
            Ok(()) => ShellCompletionState::Terminated,
            Err(error) => ShellCompletionState::Failed(error),
        });
    }
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
    /// False only during the narrow register-to-spawn handoff. Exact-owner
    /// teardown cannot report terminal until the spawned task is attached and
    /// its JoinHandle has actually finished.
    join_handle_attached: bool,
    /// Per-job cancel flag for background subagents. Owned by the job (NOT
    /// the parent session's flag — that one is pulsed back to `false` at the
    /// parent's turn boundary, which a slow worker can miss entirely).
    /// Setting it lets the worker's `execute_turn` loop exit at the next
    /// iteration/stream checkpoint and run its own completion path
    /// (LinkedSession terminal write, worktree cleanup, registry grace
    /// period). `None` for shell jobs.
    cancel_flag: Option<Arc<AtomicBool>>,
    /// Exact dialog Turn that created this job. Shells always carry it when
    /// launched from a durable Turn; subagents carry it only when Agent Org
    /// requires same-Turn convergence.
    turn_owner: Option<TurnProcessOwner>,
    /// Agent Org jobs are consumed by their owner Turn and never participate
    /// in the ordinary SDE idle-wake or retention paths.
    requires_in_turn_finality: bool,
    /// Per-process cancellation. This is distinct from the Turn token so an
    /// explicit kill_handle request terminates only the selected process.
    shell_cancel: Option<CancellationToken>,
    /// Reaches a terminal state only after the process group is absent and
    /// replay readers/writer have drained.
    shell_completion: Option<watch::Receiver<ShellCompletionState>>,
    /// Cancellation was requested, but the monitor has not yet proved the
    /// process group and replay pipeline are terminal.
    shell_kill_requested: bool,
    /// Archive has installed its short, Session-scoped escalation for this
    /// subagent. Separate from `Killed`: status is user-visible, while this
    /// flag prevents repeated finality polls from spawning duplicate timers.
    session_cancel_escalation_requested: bool,
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
            if job.requires_in_turn_finality {
                continue;
            }
            job.output_acknowledged = true;
        }
    }
}

/// Snapshot only the jobs that must converge inside one exact Agent Org
/// Turn. This is an in-memory owner lookup over the already-bounded active
/// registry; it performs no database query and creates no timer.
pub fn list_jobs_for_owner(owner: &TurnProcessOwner) -> Vec<JobSnapshot> {
    let reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    let index = OWNER_INDEX.lock().unwrap_or_else(|e| e.into_inner());
    index
        .get(owner)
        .into_iter()
        .flatten()
        .filter_map(|handle| reg.get(handle))
        .filter(|job| job.requires_in_turn_finality)
        .filter(|job| job.is_running() || !job.output_acknowledged)
        .map(|job| {
            let mut snapshot = job.snapshot();
            if matches!(job.kind, JobKind::Subagent { .. }) && !owned_job_execution_finished(job) {
                // `finish_subagent` publishes the result before the spawned
                // task returns. Keep that narrow cleanup tail logically
                // Running so the parent cannot consume the result twice or
                // finalize before the JoinHandle is terminal.
                snapshot.status = JobStatus::Running;
                snapshot.final_result = None;
                snapshot.has_unread_output = false;
            }
            snapshot
        })
        .collect()
}

/// Active foreground handoff only: wait for an exact subagent whose result
/// was already delivered inline to finish its spawned task before removing
/// the registry row. This bounded owner-local wait creates no retained timer.
pub async fn await_subagent_execution_for_owner(
    owner: &TurnProcessOwner,
    handle: &str,
    timeout: Duration,
) -> Result<(), String> {
    let wait = async {
        loop {
            let finished = {
                let reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
                let Some(job) = reg.get(handle) else {
                    return Err(format!(
                        "owned subagent {handle} disappeared before finality"
                    ));
                };
                if !job.requires_in_turn_finality || job.turn_owner.as_ref() != Some(owner) {
                    return Err(format!(
                        "owned subagent {handle} no longer matches its parent Turn"
                    ));
                }
                if !matches!(job.kind, JobKind::Subagent { .. }) {
                    return Err(format!("owned job {handle} is not a subagent"));
                }
                owned_job_execution_finished(job)
            };
            if finished {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    };
    tokio::time::timeout(timeout, wait)
        .await
        .map_err(|_| format!("timed out waiting for owned subagent {handle} to finish"))?
}

/// Acknowledge terminal results only when both the handle and exact owner
/// match, then remove them immediately. Agent Org jobs never enter the
/// ordinary 5-second acknowledgement poll or 30-minute retention tail.
pub fn acknowledge_outputs_for_owner(owner: &TurnProcessOwner, handles: &[String]) {
    let removable = {
        let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
        handles
            .iter()
            .filter_map(|handle| {
                let job = reg.get_mut(handle)?;
                if !job.requires_in_turn_finality
                    || job.turn_owner.as_ref() != Some(owner)
                    || !owned_job_execution_finished(job)
                {
                    return None;
                }
                job.output_acknowledged = true;
                Some(handle.clone())
            })
            .collect::<Vec<_>>()
    };
    for handle in removable {
        remove(&handle);
    }
}

/// Remove already-terminal exact-owner jobs after a cancelled Turn (Pause)
/// has proved their external work is gone. No terminal result is delivered
/// because cancellation makes the Turn unsuccessful.
pub fn remove_terminal_jobs_for_owner(owner: &TurnProcessOwner) {
    let handles = {
        let reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
        let index = OWNER_INDEX.lock().unwrap_or_else(|e| e.into_inner());
        index
            .get(owner)
            .into_iter()
            .flatten()
            .filter_map(|handle| reg.get(handle))
            .filter(|job| job.requires_in_turn_finality && owned_job_execution_finished(job))
            .map(|job| job.handle.clone())
            .collect::<Vec<_>>()
    };
    for handle in handles {
        remove(&handle);
    }
}

const BROADCAST_CAPACITY: usize = 512;

static REGISTRY: LazyLock<Mutex<HashMap<String, BackgroundJob>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Secondary index owned by the same registry module. Every access locks
/// `REGISTRY` first and this map second, so owner lookups are O(k) in that
/// Turn's jobs without a process-wide scan or lock-order inversion.
static OWNER_INDEX: LazyLock<Mutex<HashMap<TurnProcessOwner, HashSet<String>>>> =
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
    session_id: String,
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
    register_shell_inner(ShellRegistration {
        pid,
        command,
        log_path,
        session_id,
        replay_identity: None,
        turn_owner: None,
        requires_in_turn_finality: false,
        shell_cancel: None,
        shell_completion: None,
    })
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
    register_shell_inner(ShellRegistration {
        pid,
        command,
        log_path,
        session_id,
        replay_identity: Some((replay_session_id, call_id)),
        turn_owner: None,
        requires_in_turn_finality: false,
        shell_cancel: None,
        shell_completion: None,
    })
}

/// Register a production shell with its exact Turn/runtime owner and a
/// completion barrier controlled by the background monitor.
pub fn register_owned_shell_replay(
    pid: u32,
    command: String,
    log_path: PathBuf,
    session_id: String,
    call_id: String,
    turn_control: &TurnProcessControl,
    process_cancel: CancellationToken,
) -> ShellMonitorCompletion {
    let replay_session_id = session_id.clone();
    let (completion_tx, completion_rx) = watch::channel(ShellCompletionState::Running);
    register_shell_inner(ShellRegistration {
        pid,
        command,
        log_path,
        session_id,
        replay_identity: Some((replay_session_id, call_id)),
        turn_owner: Some(turn_control.owner.clone()),
        requires_in_turn_finality: turn_control.require_owned_job_finality,
        shell_cancel: Some(process_cancel),
        shell_completion: Some(completion_rx),
    });
    ShellMonitorCompletion { tx: completion_tx }
}

struct ShellRegistration {
    pid: u32,
    command: String,
    log_path: PathBuf,
    session_id: String,
    replay_identity: Option<(String, String)>,
    turn_owner: Option<TurnProcessOwner>,
    requires_in_turn_finality: bool,
    shell_cancel: Option<CancellationToken>,
    shell_completion: Option<watch::Receiver<ShellCompletionState>>,
}

fn register_shell_inner(registration: ShellRegistration) -> broadcast::Sender<String> {
    let ShellRegistration {
        pid,
        command,
        log_path,
        session_id,
        replay_identity,
        turn_owner,
        requires_in_turn_finality,
        shell_cancel,
        shell_completion,
    } = registration;
    let indexed_owner = turn_owner.clone();
    let handle = pid.to_string();
    let (tx, _) = broadcast::channel(BROADCAST_CAPACITY);
    let sender = tx.clone();
    let indexed_session_id = session_id.clone();
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
        join_handle_attached: true,
        cancel_flag: None,
        turn_owner,
        requires_in_turn_finality,
        shell_cancel,
        shell_completion,
        shell_kill_requested: false,
        session_cancel_escalation_requested: false,
        output_acknowledged: false,
        wake_dispatched: false,
        output_seq: 0,
        stalled_waiting_input: false,
        stall_delivered: false,
    };
    let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    let replaced = reg.insert(handle.clone(), job);
    let mut owner_index = OWNER_INDEX.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(previous_owner) = replaced
        .as_ref()
        .and_then(|previous| previous.turn_owner.as_ref())
    {
        remove_indexed_handle(&mut owner_index, previous_owner, &handle);
    }
    if let Some(owner) = indexed_owner {
        owner_index.entry(owner).or_default().insert(handle.clone());
    }
    session_lifecycle::replace_live_index(
        replaced
            .as_ref()
            .map(|previous| previous.session_id.as_str()),
        &indexed_session_id,
        &handle,
    );
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
    let sender = register_subagent_inner(
        handle,
        subagent_type,
        agent_name,
        session_id,
        Arc::clone(&cancel_flag),
        None,
        false,
    );
    (sender, cancel_flag)
}

/// Register an Agent Org worker owned by one exact parent Turn. Its terminal
/// result is consumed by that Turn and therefore never starts a later generic
/// background-job wake.
pub fn register_owned_subagent(
    handle: String,
    subagent_type: String,
    agent_name: String,
    session_id: String,
    owner: TurnProcessOwner,
) -> (broadcast::Sender<String>, Arc<AtomicBool>) {
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let sender = register_subagent_inner(
        handle,
        subagent_type,
        agent_name,
        session_id,
        Arc::clone(&cancel_flag),
        Some(owner),
        true,
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
    register_subagent_inner(
        handle,
        subagent_type,
        agent_name,
        session_id,
        cancel_flag,
        None,
        false,
    )
}

fn register_subagent_inner(
    handle: String,
    subagent_type: String,
    agent_name: String,
    session_id: String,
    cancel_flag: Arc<AtomicBool>,
    turn_owner: Option<TurnProcessOwner>,
    requires_in_turn_finality: bool,
) -> broadcast::Sender<String> {
    let indexed_owner = turn_owner.clone();
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
        join_handle_attached: false,
        cancel_flag: Some(Arc::clone(&cancel_flag)),
        turn_owner,
        requires_in_turn_finality,
        shell_cancel: None,
        shell_completion: None,
        shell_kill_requested: false,
        session_cancel_escalation_requested: false,
        output_acknowledged: false,
        wake_dispatched: false,
        output_seq: 0,
        stalled_waiting_input: false,
        stall_delivered: false,
    };
    let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    let replaced = reg.insert(handle.clone(), job);
    let mut owner_index = OWNER_INDEX.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(previous_owner) = replaced
        .as_ref()
        .and_then(|previous| previous.turn_owner.as_ref())
    {
        remove_indexed_handle(&mut owner_index, previous_owner, &handle);
    }
    if let Some(owner) = indexed_owner {
        owner_index.entry(owner).or_default().insert(handle.clone());
    }
    session_lifecycle::replace_live_index(
        replaced
            .as_ref()
            .map(|previous| previous.session_id.as_str()),
        &session_id,
        &handle,
    );
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
    job.status = if job.shell_kill_requested && matches!(job.kind, JobKind::Shell { .. }) {
        JobStatus::Killed
    } else {
        status
    };
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

/// Latch cancellation before signalling the process monitor. The public job
/// remains Running until OS/process-output finality is confirmed.
pub fn mark_shell_cancel_requested(handle: &str) {
    let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(job) = reg.get_mut(handle) {
        if matches!(job.kind, JobKind::Shell { .. }) && job.is_running() {
            job.shell_kill_requested = true;
        }
    }
}

/// Store the final result text for a completed subagent job.
pub fn set_final_result(handle: &str, result: String) {
    let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(job) = reg.get_mut(handle) {
        job.final_result = Some(result);
    }
}

/// Atomically publish a subagent's terminal status and final result. Exact
/// owner finality must never observe a terminal worker before its result is
/// available for same-Turn consumption.
pub fn finish_subagent(handle: &str, status: JobStatus, result: String) {
    let broadcast = {
        let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
        let Some(job) = reg.get_mut(handle) else {
            return;
        };
        let JobKind::Subagent {
            subagent_type,
            agent_name,
        } = &job.kind
        else {
            return;
        };
        job.final_result = Some(result);
        if !matches!(job.status, JobStatus::Killed) {
            job.status = status;
        }
        let wire_status = match &job.status {
            JobStatus::Completed | JobStatus::Exited(_) => "completed",
            JobStatus::Failed => "failed",
            JobStatus::Killed => "killed",
            JobStatus::Running => "running",
        };
        Some((
            job.session_id.clone(),
            job.handle.clone(),
            agent_name.clone(),
            subagent_type.clone(),
            wire_status,
        ))
    };
    if let Some((session_id, handle, agent_name, subagent_type, wire_status)) = broadcast {
        broadcast_subagent_job_changed(
            &session_id,
            &handle,
            &agent_name,
            &subagent_type,
            wire_status,
        );
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
        let removed = reg.remove(handle);
        let mut index = OWNER_INDEX.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(owner) = removed.as_ref().and_then(|job| job.turn_owner.as_ref()) {
            remove_indexed_handle(&mut index, owner, handle);
        }
        if let Some(job) = removed.as_ref() {
            session_lifecycle::remove_live_index(&job.session_id, handle);
        }
        removed
    };
    if let Some(job) = removed {
        let mut tombs = TOMBSTONES.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let expired = tombs
            .iter()
            .filter(|(_, tombstone)| now.duration_since(tombstone.created_at) >= TOMBSTONE_TTL)
            .map(|(expired_handle, tombstone)| {
                (tombstone.session_id.clone(), expired_handle.clone())
            })
            .collect::<Vec<_>>();
        tombs.retain(|_, tombstone| now.duration_since(tombstone.created_at) < TOMBSTONE_TTL);
        session_lifecycle::remove_expired_tombstone_indexes(&expired);
        let replaced = tombs.insert(
            handle.to_string(),
            Tombstone {
                session_id: job.session_id.clone(),
                status: job.status.clone(),
                kind: job.kind.clone(),
                created_at: now,
            },
        );
        session_lifecycle::replace_tombstone_index(
            replaced
                .as_ref()
                .map(|previous| previous.session_id.as_str()),
            &job.session_id,
            handle,
        );
    }
}

fn remove_indexed_handle(
    index: &mut HashMap<TurnProcessOwner, HashSet<String>>,
    owner: &TurnProcessOwner,
    handle: &str,
) {
    if let Some(handles) = index.get_mut(owner) {
        handles.remove(handle);
        if handles.is_empty() {
            index.remove(owner);
        }
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
    let mut tombs = TOMBSTONES.lock().unwrap_or_else(|e| e.into_inner());
    let tombstone = tombs.get(handle).cloned()?;
    if Instant::now().duration_since(tombstone.created_at) < TOMBSTONE_TTL {
        Some((tombstone.status, tombstone.kind))
    } else {
        tombs.remove(handle);
        session_lifecycle::remove_tombstone_index(&tombstone.session_id, handle);
        None
    }
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

async fn wait_for_shell_completion(
    pid: u32,
    mut completion: watch::Receiver<ShellCompletionState>,
) -> Result<(), String> {
    loop {
        let state = completion.borrow().clone();
        match state {
            ShellCompletionState::Running => {}
            ShellCompletionState::Terminated => return Ok(()),
            ShellCompletionState::Failed(error) => {
                return Err(format!(
                    "background shell process group {pid} failed to stop: {error}"
                ))
            }
        }
        completion.changed().await.map_err(|_| {
            format!("background shell process group {pid} lost its completion owner")
        })?;
    }
}

/// Wait until every background shell owned by the exact Pause Turn has
/// reached OS/process-output finality. No matching jobs means foreground work
/// already completed through the synchronous tool path.
pub async fn await_shells_terminated_for_owner(
    owner: &TurnProcessOwner,
    timeout: Duration,
) -> Result<(), String> {
    let completions = {
        let reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
        let index = OWNER_INDEX.lock().unwrap_or_else(|e| e.into_inner());
        index
            .get(owner)
            .into_iter()
            .flatten()
            .filter_map(|handle| reg.get(handle))
            .filter_map(|job| match (&job.kind, &job.shell_completion) {
                (JobKind::Shell { pid, .. }, Some(completion)) => Some((*pid, completion.clone())),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let wait_all = async move {
        let results = futures::future::join_all(
            completions
                .into_iter()
                .map(|(pid, completion)| wait_for_shell_completion(pid, completion)),
        )
        .await;
        let failures = results
            .into_iter()
            .filter_map(Result::err)
            .collect::<Vec<_>>();
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    };
    tokio::time::timeout(timeout, wait_all).await.map_err(|_| {
        format!(
            "timed out after {}ms waiting for background shell process groups owned by Turn {}",
            timeout.as_millis(),
            owner.dialog_turn_generation
        )
    })?
}

/// List all jobs (shells + subagents). Pass `Some(session_id)` for session
/// scope, `None` for global scope.
pub fn list_jobs(session_id: Option<&str>) -> Vec<JobSnapshot> {
    let reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    match session_id {
        Some(session_id) => session_lifecycle::live_handles(session_id)
            .into_iter()
            .filter_map(|handle| reg.get(&handle))
            .map(BackgroundJob::snapshot)
            .collect(),
        None => reg.values().map(BackgroundJob::snapshot).collect(),
    }
}

/// Mark a completed job's output as acknowledged. Once acknowledged, the job
/// is excluded from the per-turn system-reminder injection. This avoids
/// stale "has new output" reminders for jobs whose output has already been
/// read.
pub fn acknowledge_output(handle: &str) {
    let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(job) = reg.get_mut(handle) {
        if !job.requires_in_turn_finality {
            job.output_acknowledged = true;
        }
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
            job.session_id == session_id
                && !job.requires_in_turn_finality
                && (job.is_running() || !job.output_acknowledged)
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
        if job.requires_in_turn_finality {
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
        if job.requires_in_turn_finality {
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
        job.join_handle_attached = true;
        if matches!(job.status, JobStatus::Killed) {
            jh.abort();
        }
        job.join_handle = Some(jh);
    } else {
        // A concurrent exact-owner teardown removed the registration before
        // the spawning call could attach its handle. Dropping JoinHandle would
        // detach the task, so abort it explicitly.
        jh.abort();
    }
}

fn owned_job_execution_finished(job: &BackgroundJob) -> bool {
    if job.is_running() {
        return false;
    }
    match job.kind {
        JobKind::Shell { .. } => true,
        JobKind::Subagent { .. } => {
            job.join_handle_attached
                && job
                    .join_handle
                    .as_ref()
                    .is_some_and(JoinHandle::is_finished)
        }
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
    if group_error.raw_os_error() == Some(libc::ESRCH) {
        Err(process_error)
    } else {
        Err(group_error)
    }
}

#[cfg(unix)]
pub(crate) fn process_tree_exists(pid: u32) -> bool {
    let pid = pid as libc::pid_t;
    unsafe { libc::kill(-pid, 0) == 0 || libc::kill(pid, 0) == 0 }
}

#[cfg(unix)]
async fn wait_for_process_tree_exit(pid: u32, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if !process_tree_exists(pid) {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
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

    // Preserve the existing ordinary SDE kill contract: give cooperative
    // processes the full two-second SIGTERM grace before escalating.
    if wait_for_process_tree_exit(pid, Duration::from_secs(2)).await {
        return Ok(format!("Process {} terminated (SIGTERM)", pid));
    }
    match send_signal_to_process_tree(pid, libc::SIGKILL) {
        Ok(()) => {}
        Err(err) if err.raw_os_error() == Some(libc::ESRCH) => {
            return Ok(format!("Process {} terminated (SIGTERM)", pid));
        }
        Err(err) => return Err(format!("Failed to send SIGKILL to {}: {}", pid, err)),
    }
    if wait_for_process_tree_exit(pid, Duration::from_secs(2)).await {
        Ok(format!("Process {} killed (SIGKILL)", pid))
    } else {
        Err(format!(
            "Process group {} still exists after SIGKILL verification window",
            pid
        ))
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
    let (pid, cancel, completion) = {
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
        job.shell_kill_requested = true;
        (pid, job.shell_cancel.clone(), job.shell_completion.clone())
    };

    if let Some(cancel) = cancel {
        cancel.cancel();
        if let Some(completion) = completion {
            return tokio::time::timeout(
                Duration::from_secs(10),
                wait_for_shell_completion(pid, completion),
            )
            .await
            .map_err(|_| format!("timed out waiting for shell process group {pid} to stop"))?;
        }
    }
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

    let (cancel_flag, abort_handle, broadcast_info) = {
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
            job.join_handle.as_ref().map(JoinHandle::abort_handle),
            broadcast_info,
        )
    };

    let (session_id, agent_name, subagent_type) = broadcast_info;
    broadcast_subagent_job_changed(&session_id, handle, &agent_name, &subagent_type, "killed");

    if let Some(flag) = cancel_flag {
        flag.store(true, Ordering::SeqCst);
        if let Some(abort_handle) = abort_handle {
            // Watchdog: give the cooperative path a grace window, then abort.
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(HARD_ABORT_GRACE_SECS)).await;
                if !abort_handle.is_finished() {
                    tracing::warn!(
                        "[job-registry] background subagent did not stop within {}s of cancel; hard-aborting task",
                        HARD_ABORT_GRACE_SECS
                    );
                    abort_handle.abort();
                }
            });
        }
    } else if let Some(abort_handle) = abort_handle {
        // Legacy job registered without a flag — hard abort is all we have.
        abort_handle.abort();
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

/// Fan out ordinary user Stop to every running background shell in the
/// Session. OrgPause does not call this broad API; it cancels only the active
/// Turn's token and then awaits the exact owner tuple.
pub fn cancel_shells_for_session(session_id: &str) -> usize {
    let cancellations = {
        let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
        reg.values_mut()
            .filter(|job| {
                job.session_id == session_id
                    && job.is_running()
                    && matches!(job.kind, JobKind::Shell { .. })
            })
            .filter_map(|job| {
                job.shell_kill_requested = true;
                match (&job.kind, job.shell_cancel.clone()) {
                    (JobKind::Shell { pid, .. }, cancel) => Some((*pid, cancel)),
                    _ => None,
                }
            })
            .collect::<Vec<_>>()
    };
    for (pid, cancel) in &cancellations {
        if let Some(cancel) = cancel {
            cancel.cancel();
        } else {
            let pid = *pid;
            tokio::spawn(async move {
                if let Err(error) = terminate_shell_process_tree(pid).await {
                    tracing::warn!(pid, error = %error, "failed to stop legacy background shell");
                }
            });
        }
    }
    if !cancellations.is_empty() {
        tracing::info!(
            session_id,
            count = cancellations.len(),
            "requested cancellation for background shell process groups"
        );
    }
    cancellations.len()
}

/// Cancel every background job owned by one exact Agent Org Turn and wait
/// until the shell process groups and worker tasks are actually terminal.
/// This is a bounded failure-recovery path, not a steady-state poller.
pub async fn cancel_and_await_jobs_for_owner(
    owner: &TurnProcessOwner,
    timeout: Duration,
) -> Result<(), String> {
    let (shell_cancels, subagent_handles) = {
        let mut reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
        let index = OWNER_INDEX.lock().unwrap_or_else(|e| e.into_inner());
        let mut shell_cancels = Vec::new();
        let mut subagent_handles = Vec::new();
        let handles = index.get(owner).cloned().unwrap_or_default();
        for handle in handles {
            let Some(job) = reg.get_mut(&handle) else {
                continue;
            };
            if !job.requires_in_turn_finality || !job.is_running() {
                continue;
            }
            match &job.kind {
                JobKind::Shell { .. } => {
                    job.shell_kill_requested = true;
                    if let Some(cancel) = job.shell_cancel.clone() {
                        shell_cancels.push(cancel);
                    }
                }
                JobKind::Subagent { .. } => subagent_handles.push((
                    job.handle.clone(),
                    job.join_handle.as_ref().map(JoinHandle::abort_handle),
                )),
            }
        }
        (shell_cancels, subagent_handles)
    };

    for cancel in shell_cancels {
        cancel.cancel();
    }
    for (handle, abort_handle) in subagent_handles {
        if let Err(error) = kill_subagent(&handle) {
            if get_status(&handle).is_some_and(|(status, _)| matches!(status, JobStatus::Running)) {
                return Err(format!("failed to cancel owned subagent {handle}: {error}"));
            }
        }
        if let Some(abort_handle) = abort_handle {
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(2)).await;
                if !abort_handle.is_finished() {
                    abort_handle.abort();
                }
            });
        }
    }

    let wait = async {
        await_shells_terminated_for_owner(owner, timeout).await?;
        loop {
            let all_subagents_terminal = {
                let reg = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
                let index = OWNER_INDEX.lock().unwrap_or_else(|e| e.into_inner());
                index
                    .get(owner)
                    .into_iter()
                    .flatten()
                    .filter_map(|handle| reg.get(handle))
                    .filter(|job| {
                        job.requires_in_turn_finality
                            && matches!(job.kind, JobKind::Subagent { .. })
                    })
                    .all(owned_job_execution_finished)
            };
            if all_subagents_terminal {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        Ok::<(), String>(())
    };

    tokio::time::timeout(timeout, wait).await.map_err(|_| {
        format!(
            "timed out after {}ms stopping background jobs owned by Turn {}",
            timeout.as_millis(),
            owner.dialog_turn_generation
        )
    })??;
    remove_terminal_jobs_for_owner(owner);
    Ok(())
}
