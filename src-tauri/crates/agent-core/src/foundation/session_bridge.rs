//! IoC bridge to `agent_sessions` persistence and CLI launch primitives.
//!
//! The slots here are the last back-edges that prevented `agent_core`
//! from compiling as its own workspace crate:
//!
//! 1. **`launch_cli_agent`** — `state::commands::session::launch` orchestrates
//!    a CLI session create+run when the launcher routes to `cli_agent`.
//!    The real implementation lives in `agent_sessions::cli::commands` and
//!    needs `agent_sessions::cli::persistence::CreateCodeSessionParams`.
//!    We expose a leaner projection (`CliLaunchParams`) that only carries
//!    the fields the call site actually fills in, plus a tiny
//!    `CliLaunchOutcome` projection (only `session_id` + `created_at` are
//!    read).
//!
//! 2. **`record_token_usage`** — `core::session::turn::processor` writes a
//!    per-turn row into `session_token_usage`. The real implementation is
//!    `session_persistence::token_usage::insert_token_usage_record`.
//!
//! 3. **`clear_cli_resume_state`** — file-history rewind runs inside
//!    `agent_core`, while CLI native conversation IDs live in the wire-side
//!    `agent_sessions::cli` module. Rewind must invalidate those IDs and record
//!    why the next CLI prompt should distrust native conversation state without
//!    adding a dependency from `agent_core` back to the app crate.
//!
//! Same shape as [`super::db_bridge`] / [`super::event_pipeline_bridge`]:
//! the wire crate registers function pointers at startup; agent_core call
//! sites go through the wrappers here.

use std::sync::OnceLock;

// ---------------------------------------------------------------------------
// 1. CLI session launch
// ---------------------------------------------------------------------------

/// Lean projection of `agent_sessions::cli::persistence::CreateCodeSessionParams`
/// holding only the fields the launcher actually populates. The wire-side
/// adapter in `agent_sessions::cli::commands` rebuilds the full
/// `CreateCodeSessionParams` from this and forwards to `cli_agent_create`.
#[derive(Debug, Clone)]
pub struct CliLaunchParams {
    pub name: Option<String>,
    /// CLI agent type (e.g. `"claude_code"`, `"cursor_cli"`). Maps to the
    /// `platform` JSON field on the wire.
    pub cli_agent_type: String,
    pub model: Option<String>,
    pub tier: Option<String>,
    pub account_id: Option<String>,
    pub repo_path: Option<String>,
    pub branch: Option<String>,
    pub hosted_token: Option<String>,
    pub isolate: bool,
    pub background: bool,
    pub key_source: Option<String>,
    pub additional_directories: Option<Vec<String>>,
    pub parent_session_id: Option<String>,
    pub org_member_id: Option<String>,
    pub org_id: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub project_slug: Option<String>,
    pub work_item_id: Option<String>,
    pub agent_role: Option<String>,

    // Run-side params
    pub user_input: String,
    pub ide_context: Option<crate::session::IdeContext>,
    pub mode: Option<String>,
    pub images: Option<Vec<String>>,
}

/// What the launcher needs back from the CLI side to populate
/// `SessionLaunchResult`.
#[derive(Debug, Clone)]
pub struct CliLaunchOutcome {
    pub session_id: String,
    pub created_at: String,
}

/// `Box<dyn Future>` because the underlying `cli_agent_create` /
/// `cli_agent_run` are `async`. Returns once the session row is committed
/// (the run task runs in the background).
pub type LaunchCliAgentFn = fn(
    CliLaunchParams,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<CliLaunchOutcome, String>> + Send>,
>;

static LAUNCH_CLI_AGENT: OnceLock<LaunchCliAgentFn> = OnceLock::new();

/// Wire-side: register the `cli_agent_create` + `cli_agent_run` adapter.
pub fn register_launch_cli_agent(implementation: LaunchCliAgentFn) {
    let _ = LAUNCH_CLI_AGENT.set(implementation);
}

/// Read-side: run the CLI launch chain via the registered adapter.
///
/// Returns `Err` (not panic) if the slot is empty so the launcher can
/// surface a normal error to the frontend instead of crashing the
/// process. Every CLI launch path runs after `app::run` startup, so an
/// empty slot is a wiring bug — we log it at `error!` to make sure boot
/// smoke catches it.
pub async fn launch_cli_agent(params: CliLaunchParams) -> Result<CliLaunchOutcome, String> {
    match LAUNCH_CLI_AGENT.get() {
        Some(implementation) => implementation(params).await,
        None => {
            tracing::error!(
                cli_agent_type = %params.cli_agent_type,
                "[session-bridge] launch_cli_agent called before register; \
                 agent_sessions::cli::agent_core_bridge::register() must run \
                 during app::run startup"
            );
            Err("session-bridge: launch_cli_agent slot not registered; \
                 agent_sessions::cli::agent_core_bridge::register() must \
                 run during app::run startup"
                .to_string())
        }
    }
}

pub type DeleteCliSessionFn = fn(&str) -> Result<bool, String>;

static DELETE_CLI_SESSION: OnceLock<DeleteCliSessionFn> = OnceLock::new();

pub fn register_delete_cli_session(implementation: DeleteCliSessionFn) {
    let _ = DELETE_CLI_SESSION.set(implementation);
}

pub fn delete_cli_session(session_id: &str) -> Result<bool, String> {
    match DELETE_CLI_SESSION.get() {
        Some(implementation) => implementation(session_id),
        None => {
            tracing::error!(
                session_id = %session_id,
                "[session-bridge] delete_cli_session called before register"
            );
            Err("session-bridge: delete_cli_session slot not registered".to_string())
        }
    }
}

// ---------------------------------------------------------------------------
// 2. Token usage recording
// ---------------------------------------------------------------------------

/// One per-turn token-usage row, mirroring the shape that the live
/// `session_persistence::token_usage::insert_token_usage_record` takes.
/// Boxed up so the IoC slot stays a single function pointer.
#[derive(Debug, Clone)]
pub struct TokenUsageRow<'a> {
    pub session_id: &'a str,
    pub session_type: &'a str,
    pub model: Option<&'a str>,
    pub account_id: Option<&'a str>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub total_tokens: i64,
    pub context_tokens: i64,
    pub context_usage_json: Option<String>,
}

pub type RecordTokenUsageFn = fn(TokenUsageRow<'_>) -> rusqlite::Result<i64>;

static RECORD_TOKEN_USAGE: OnceLock<RecordTokenUsageFn> = OnceLock::new();

pub fn register_record_token_usage(implementation: RecordTokenUsageFn) {
    let _ = RECORD_TOKEN_USAGE.set(implementation);
}

/// Read-side: persist a per-turn token-usage row. Returns the new row id.
///
/// Unlike the launch slot this is a best-effort write — the caller is in a
/// `block_in_place` and we don't want to crash a turn just because billing
/// telemetry is unwired. Returns `Ok(0)` if the slot is empty so callers
/// can keep their existing match arms.
pub fn record_token_usage(row: TokenUsageRow<'_>) -> rusqlite::Result<i64> {
    match RECORD_TOKEN_USAGE.get() {
        Some(implementation) => implementation(row),
        None => {
            tracing::warn!(
                "[session-bridge] record_token_usage called before register; \
                 dropping telemetry row for session_id={}",
                row.session_id
            );
            Ok(0)
        }
    }
}

// ---------------------------------------------------------------------------
// 3. CLI effective tool snapshot
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct CliToolsSnapshot {
    pub session_id: String,
    pub cli_agent_type: String,
    pub agent_exec_mode: String,
    pub registered_tool_names: Vec<String>,
    pub prompt_tool_names: Vec<String>,
}

pub type GetCliToolsSnapshotFn = fn(&str) -> Result<Option<CliToolsSnapshot>, String>;

static GET_CLI_TOOLS_SNAPSHOT: OnceLock<GetCliToolsSnapshotFn> = OnceLock::new();

pub fn register_get_cli_tools_snapshot(implementation: GetCliToolsSnapshotFn) {
    let _ = GET_CLI_TOOLS_SNAPSHOT.set(implementation);
}

pub fn get_cli_tools_snapshot(session_id: &str) -> Result<Option<CliToolsSnapshot>, String> {
    match GET_CLI_TOOLS_SNAPSHOT.get() {
        Some(implementation) => implementation(session_id),
        None => {
            tracing::warn!(
                "[session-bridge] get_cli_tools_snapshot called before register; \
                 no CLI snapshot available for session_id={}",
                session_id
            );
            Ok(None)
        }
    }
}

// ---------------------------------------------------------------------------
// 5. CLI plan approval response
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct CliPlanApprovalResponseParams {
    pub session_id: String,
    pub choice: String,
    pub edited_content: Option<String>,
    pub model: Option<String>,
    pub account_id: Option<String>,
    pub workspace_path: Option<String>,
}

pub type RespondCliPlanApprovalFn =
    fn(
        CliPlanApprovalResponseParams,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>;

static RESPOND_CLI_PLAN_APPROVAL: OnceLock<RespondCliPlanApprovalFn> = OnceLock::new();

pub fn register_respond_cli_plan_approval(implementation: RespondCliPlanApprovalFn) {
    let _ = RESPOND_CLI_PLAN_APPROVAL.set(implementation);
}

pub async fn respond_cli_plan_approval(
    params: CliPlanApprovalResponseParams,
) -> Result<(), String> {
    match RESPOND_CLI_PLAN_APPROVAL.get() {
        Some(implementation) => implementation(params).await,
        None => {
            tracing::warn!(
                "[session-bridge] respond_cli_plan_approval called before register; \
                 cannot respond for session_id={}",
                params.session_id
            );
            Err("session-bridge: respond_cli_plan_approval slot not registered".to_string())
        }
    }
}

// ---------------------------------------------------------------------------
// 6. CLI native resume invalidation
// ---------------------------------------------------------------------------

pub const CLI_HISTORY_MUTATION_FILE_REWIND: &str = "file_rewind";
pub const CLI_HISTORY_MUTATION_MESSAGE_TRUNCATE: &str = "message_truncate";
pub const CLI_HISTORY_MUTATION_SNAPSHOT_RESTORE: &str = "snapshot_restore";

pub type ClearCliResumeStateFn = fn(&str, &str) -> rusqlite::Result<bool>;

static CLEAR_CLI_RESUME_STATE: OnceLock<ClearCliResumeStateFn> = OnceLock::new();

pub fn register_clear_cli_resume_state(implementation: ClearCliResumeStateFn) {
    let _ = CLEAR_CLI_RESUME_STATE.set(implementation);
}

/// Read-side: clear native CLI conversation IDs for a session after ORGII
/// mutates history outside the CLI provider, such as message truncate or file
/// rewind. Returning `Ok(false)` means no CLI session row existed for the id.
pub fn clear_cli_resume_state(session_id: &str, mutation_reason: &str) -> rusqlite::Result<bool> {
    match CLEAR_CLI_RESUME_STATE.get() {
        Some(implementation) => implementation(session_id, mutation_reason),
        None => {
            tracing::warn!(
                "[session-bridge] clear_cli_resume_state called before register; \
                 skipping CLI resume invalidation for session_id={}",
                session_id
            );
            Ok(false)
        }
    }
}

// ---------------------------------------------------------------------------
// 7. Turn intent lifecycle writes
// ---------------------------------------------------------------------------
//
// `agent_core` (specifically `DialogScheduler` and `send_message_impl`) needs
// to transition rows in `session_turn_intents` as turns walk through queue →
// run → terminal. The actual table CRUD lives in
// `session_persistence::turn_intents`, so we route through this IoC slot so
// `agent_core` does not take a back-edge on the session_persistence crate.
//
// The transitions exposed here are the minimum surface the scheduler /
// message pipeline need. Plain enum values are used over the
// `TurnIntentStatus` / `TurnIntentSource` types from session_persistence so
// the bridge signature stays leaf-level and the adapter parses them.

#[derive(Debug, Clone, Copy)]
pub enum TurnIntentBridgeStatus {
    Optimistic,
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
    Stale,
}

impl TurnIntentBridgeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Optimistic => "optimistic",
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Stale => "stale",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum TurnIntentBridgeSource {
    UserSubmit,
    Queue,
    ForceSend,
    Resume,
    AgentOrg,
    Wingman,
    MobileRemote,
}

impl TurnIntentBridgeSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UserSubmit => "user_submit",
            Self::Queue => "queue",
            Self::ForceSend => "force_send",
            Self::Resume => "resume",
            Self::AgentOrg => "agent_org",
            Self::Wingman => "wingman",
            Self::MobileRemote => "mobile_remote",
        }
    }
}

pub type UpsertTurnIntentFn = fn(
    session_id: &str,
    turn_intent_id: &str,
    client_message_id: Option<&str>,
    source: TurnIntentBridgeSource,
    status: TurnIntentBridgeStatus,
);

pub type UpdateTurnIntentStatusFn =
    fn(session_id: &str, turn_intent_id: &str, new_status: TurnIntentBridgeStatus);

pub type MarkPendingTurnIntentsStaleFn = fn(session_id: &str);

static UPSERT_TURN_INTENT: OnceLock<UpsertTurnIntentFn> = OnceLock::new();
static UPDATE_TURN_INTENT_STATUS: OnceLock<UpdateTurnIntentStatusFn> = OnceLock::new();
static MARK_PENDING_TURN_INTENTS_STALE: OnceLock<MarkPendingTurnIntentsStaleFn> = OnceLock::new();

pub fn register_upsert_turn_intent(implementation: UpsertTurnIntentFn) {
    let _ = UPSERT_TURN_INTENT.set(implementation);
}

pub fn register_update_turn_intent_status(implementation: UpdateTurnIntentStatusFn) {
    let _ = UPDATE_TURN_INTENT_STATUS.set(implementation);
}

pub fn register_mark_pending_turn_intents_stale(implementation: MarkPendingTurnIntentsStaleFn) {
    let _ = MARK_PENDING_TURN_INTENTS_STALE.set(implementation);
}

/// Upsert a new lifecycle row. Idempotent: a re-enqueue with the same
/// `turn_intent_id` observes the existing row without overwriting.
pub fn upsert_turn_intent(
    session_id: &str,
    turn_intent_id: &str,
    client_message_id: Option<&str>,
    source: TurnIntentBridgeSource,
    status: TurnIntentBridgeStatus,
) {
    if turn_intent_id.is_empty() {
        return;
    }
    if let Some(implementation) = UPSERT_TURN_INTENT.get() {
        implementation(
            session_id,
            turn_intent_id,
            client_message_id,
            source,
            status,
        );
    }
}

/// Patch the status of an existing lifecycle row. Illegal transitions are
/// silently rejected by the implementation — callers do not need to handle
/// the error case.
pub fn update_turn_intent_status(
    session_id: &str,
    turn_intent_id: &str,
    new_status: TurnIntentBridgeStatus,
) {
    if turn_intent_id.is_empty() {
        return;
    }
    if let Some(implementation) = UPDATE_TURN_INTENT_STATUS.get() {
        implementation(session_id, turn_intent_id, new_status);
    }
}

/// Bulk-mark every `optimistic` / `queued` row for the session as `stale`.
/// Called by `DialogScheduler::invalidate_pending` so the durable log
/// catches up with the in-memory generation bump.
pub fn mark_pending_turn_intents_stale(session_id: &str) {
    if let Some(implementation) = MARK_PENDING_TURN_INTENTS_STALE.get() {
        implementation(session_id);
    }
}
