//! Debug-only Tauri command: introspect & exercise the live runtime
//! `SecurityPolicy` for an active session.
//!
//! `debug_session_security_snapshot(session_id)` rebuilds the same
//! `foundation::security::SecurityPolicy` `init/mod.rs` constructed at
//! session launch (via `AgentPolicy::to_runtime_security`) and returns
//! a frontend-friendly view of every field. This proves L4→L5 wiring:
//! whatever the user wrote into `AgentDefinition.agent_policy` is what
//! the live session is actually enforcing.
//!
//! `debug_session_validate_command(session_id, command, approved)` runs
//! the rebuilt policy's full validation pipeline (`is_command_blocked`,
//! `requires_confirmation`, `command_risk_level`, autonomy gates)
//! and returns the resolved `ValidationResult` shape so
//! audit specs can pin the exact runtime behaviour for representative
//! commands (`rm -rf /`, `git push`, `echo hi`, …) without going through
//! the LLM.
//!
//! Why this exists: every other layer of the per-agent security surface
//! already has an audit trail (CRUD specs over `agent_policy`, sibling-
//! survival specs, etc.), but the L5 hop — "the policy on disk equals
//! the policy in memory equals the policy that actually denies a
//! command" — was previously only covered by Rust unit tests. This
//! command bridges that gap so the same E2E browser harness that
//! exercises the Settings UI can also assert the runtime decisions
//! match.
//!
//! Gating mirrors `prompt_dump`: cheap rebuild, always exposed at the
//! Tauri-command layer; the frontend `__e2e` helper guards on
//! `debug_assertions || WEBDRIVER=1` so production users never see it.

use serde::{Deserialize, Serialize};

use crate::foundation::security::{policy::CommandRiskLevel, AutonomyLevel, ValidationResult};
use crate::state::AgentAppState;

/// Wire-shape mirror of [`SecurityPolicy`].
///
/// We re-serialize through this struct rather than expose the runtime
/// struct directly so the public RPC surface owns a stable schema and
/// callers do not have to reach into `Mutex`-wrapped internals.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSecuritySnapshot {
    pub session_id: String,
    pub agent_id: String,
    pub workspace_dir: String,
    /// Lowercase access-mode string (`"readonly"` / `"full"`).
    pub autonomy: String,
    pub workspace_only: bool,
    pub blocked_commands: Vec<String>,
    pub confirmation_commands: Vec<String>,
    pub forbidden_paths: Vec<String>,
    pub block_high_risk_commands: bool,
    pub medium_risk_rules: Vec<String>,
    pub high_risk_rules: Vec<String>,
    /// Tools that the runtime gates behind Ask under the current
    /// autonomy level — derived via `AutonomyLevel::ask_tools()`.
    pub ask_tools: Vec<String>,
}

#[tauri::command]
pub async fn debug_session_security_snapshot(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<SessionSecuritySnapshot, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {}", session_id))?;

    let runtime = session
        .get_runtime()
        .await
        .ok_or_else(|| format!("session runtime not initialized: {}", session_id))?;

    let workspace = runtime.resolved.workspace.clone();
    let policy = runtime.resolved.policy.to_runtime_security();

    Ok(SessionSecuritySnapshot {
        session_id: session_id.clone(),
        agent_id: session.definition.id.clone(),
        workspace_dir: workspace.display().to_string(),
        autonomy: autonomy_str(policy.autonomy).to_string(),
        workspace_only: policy.workspace_only,
        blocked_commands: policy.blocked_commands.clone(),
        confirmation_commands: policy.confirmation_commands.clone(),
        forbidden_paths: policy.forbidden_paths.clone(),
        block_high_risk_commands: policy.block_high_risk_commands,
        medium_risk_rules: policy.risk_rules.medium.clone(),
        high_risk_rules: policy.risk_rules.high.clone(),
        ask_tools: policy.autonomy.ask_tools(),
    })
}

/// Wire-shape mirror of [`ValidationResult`]. Mirrors the three-state
/// enum (`Allowed` / `NeedsApproval` / `Denied`) as a flat record so
/// the JS side does not have to peek at internal tag names.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandValidation {
    /// One of `"allowed"`, `"needs_approval"`, `"denied"`.
    pub outcome: String,
    /// Risk level (`"low"` / `"medium"` / `"high"`). Always present
    /// for `Allowed` / `NeedsApproval`; for `Denied` we also classify
    /// the command upfront so callers see why a high-risk command was
    /// rejected even when `block_high_risk_commands` is on.
    pub risk: String,
    /// Reason string produced by the policy for non-`Allowed` outcomes.
    /// `None` for `Allowed`.
    pub reason: Option<String>,
}

#[tauri::command]
pub async fn debug_session_validate_command(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    command: String,
    approved: Option<bool>,
) -> Result<CommandValidation, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {}", session_id))?;

    let runtime = session
        .get_runtime()
        .await
        .ok_or_else(|| format!("session runtime not initialized: {}", session_id))?;

    // Rebuild a fresh `SecurityPolicy` for this validation call rather
    // than reaching into the live `ToolDeps`-owned `Arc` — the
    // `Arc<SecurityPolicy>` is buried inside per-tool wrappers and not
    // directly addressable from a session-level command.
    let policy = runtime.resolved.policy.to_runtime_security();

    let approved = approved.unwrap_or(false);
    let result = policy.validate_command_execution(&command, approved);
    let pre_classified_risk = policy.command_risk_level(&command);

    Ok(match result {
        ValidationResult::Allowed(risk) => CommandValidation {
            outcome: "allowed".to_string(),
            risk: risk_str(risk).to_string(),
            reason: None,
        },
        ValidationResult::NeedsApproval(risk, reason) => CommandValidation {
            outcome: "needs_approval".to_string(),
            risk: risk_str(risk).to_string(),
            reason: Some(reason),
        },
        ValidationResult::Denied(reason) => CommandValidation {
            outcome: "denied".to_string(),
            risk: risk_str(pre_classified_risk).to_string(),
            reason: Some(reason),
        },
    })
}

fn autonomy_str(level: AutonomyLevel) -> &'static str {
    match level {
        AutonomyLevel::ReadOnly => "readonly",
        AutonomyLevel::Full => "full",
    }
}

fn risk_str(risk: CommandRiskLevel) -> &'static str {
    match risk {
        CommandRiskLevel::Low => "low",
        CommandRiskLevel::Medium => "medium",
        CommandRiskLevel::High => "high",
    }
}
