//! Opt-in MiniCPM rolling context maintenance.
//!
//! This subsystem is intentionally a sidecar. It never rewrites canonical
//! session messages and never appends a compact boundary. When all feature
//! gates are enabled, a validated rolling summary is applied only to the
//! in-memory provider request assembled for that turn.

mod config;
mod history;
mod overlay;
mod persistence;
mod worker;

use serde::Serialize;

pub use config::{refresh_from_disk as refresh_global_config_from_disk, update_from_settings};
pub use persistence::init_schema;
pub use worker::spawn;

pub(crate) use overlay::{apply as apply_overlay, OverlayOutcome};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HousekeeperCompactionStatus {
    Disabled,
    Idle,
    Running,
    Complete,
    Error,
    Unavailable,
    Busy,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HousekeeperContextCompactionState {
    pub enabled: bool,
    pub status: HousekeeperCompactionStatus,
    pub covered_messages: usize,
    pub source_tokens: usize,
    pub summary_tokens: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl HousekeeperContextCompactionState {
    pub(crate) fn unavailable() -> Self {
        Self {
            enabled: false,
            status: HousekeeperCompactionStatus::Unavailable,
            covered_messages: 0,
            source_tokens: 0,
            summary_tokens: 0,
            last_run_at: None,
            last_error: None,
            message: Some(
                "Enable and configure MiniCPM context maintenance in Resident Housekeeper"
                    .to_string(),
            ),
        }
    }
}

pub fn status(session_id: &str) -> Result<HousekeeperContextCompactionState, String> {
    if !config::is_enabled() {
        return Ok(HousekeeperContextCompactionState::unavailable());
    }

    let record = persistence::load(session_id)?;
    let status = if !record.enabled {
        HousekeeperCompactionStatus::Disabled
    } else {
        match record.status.as_str() {
            "running" => HousekeeperCompactionStatus::Running,
            "complete" => HousekeeperCompactionStatus::Complete,
            "error" => HousekeeperCompactionStatus::Error,
            _ => HousekeeperCompactionStatus::Idle,
        }
    };
    Ok(HousekeeperContextCompactionState {
        enabled: record.enabled,
        status,
        covered_messages: record.covered_message_count,
        source_tokens: record.source_tokens,
        summary_tokens: record.summary_tokens,
        last_run_at: record.last_run_at,
        last_error: record.last_error,
        message: None,
    })
}

pub fn set_enabled(
    session_id: &str,
    enabled: bool,
) -> Result<HousekeeperContextCompactionState, String> {
    if enabled && !config::is_enabled() {
        return Ok(HousekeeperContextCompactionState::unavailable());
    }
    persistence::set_enabled(session_id, enabled)?;
    status(session_id)
}

pub async fn compact_now(
    state: &crate::state::AgentAppState,
    session_id: String,
) -> HousekeeperContextCompactionState {
    worker::run_explicit(state, session_id).await
}
