//! Insert path for new CLI code-session rows, including the wire-typo
//! guards and the frozen transcript-source decision.

use rusqlite::{params, Result as SqliteResult};

use agent_core::session::AgentExecMode;
use database::db::get_connection;

use crate::agent_sessions::cli::native_transcript;
use crate::agent_sessions::cli::persistence::types::{CodeSession, CreateCodeSessionParams};
use crate::agent_sessions::cli::types::{
    session_defaults, KeySource, SessionRunner, SessionStatus, DEFAULT_CODE_SESSION_FLOW,
    PERSONAL_ORG_ID,
};

use super::read::get_session;
use super::shared::{now_iso, sync_orgtrack_mirror};

/// Create a new code session. Returns the session ID.
pub fn create_session(
    session_id: &str,
    params: &CreateCodeSessionParams,
) -> SqliteResult<CodeSession> {
    let conn = get_connection()?;
    let ts = now_iso();
    let name = params
        .name
        .clone()
        .unwrap_or_else(|| session_defaults::CODE_SESSION_NAME.to_string());
    let flow = params
        .flow
        .clone()
        .unwrap_or_else(|| DEFAULT_CODE_SESSION_FLOW.to_string());
    // Wire-typo guard: `runner` is read back via `SessionRunner::parse`
    // (typed enum) at every read site. If the caller passes a typo'd
    // string here, the row would be persisted as garbage and every
    // subsequent `row_to_session` would reject it as a
    // `FromSqlConversionFailure` — i.e. the session would be created
    // but unloadable. Reject at the entry point instead.
    let runner = match params.runner.as_deref().filter(|s| !s.is_empty()) {
        Some(raw) => SessionRunner::parse(raw)
            .ok_or_else(|| {
                rusqlite::Error::ToSqlConversionFailure(
                    format!("unknown SessionRunner value: {raw:?}").into(),
                )
            })?
            .to_string(),
        None => SessionRunner::Local.to_string(),
    };

    let background = params.background.unwrap_or(false);

    // Wire-typo guard for `key_source` — same reasoning as `runner`.
    // `row_to_session` will fail-closed on an unknown column value, so
    // accepting an unvalidated string here would create an unloadable
    // session row (the frontend would see a created session that can
    // never be opened). Validate at the write boundary.
    let key_source_str = match params.key_source.as_deref().filter(|s| !s.is_empty()) {
        Some(raw) => KeySource::parse(raw)
            .ok_or_else(|| {
                rusqlite::Error::ToSqlConversionFailure(
                    format!("unknown KeySource value: {raw:?}").into(),
                )
            })?
            .to_string(),
        None => KeySource::default().to_string(),
    };

    let org_id = params
        .org_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| PERSONAL_ORG_ID.to_string());

    let additional_dirs_json: Option<String> = params
        .additional_directories
        .as_ref()
        .filter(|v| !v.is_empty())
        .map(|v| serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string()));
    let product_mode = if params.work_item_id.is_some() {
        "project".to_string()
    } else {
        params
            .product_mode
            .clone()
            .filter(|mode| matches!(mode.as_str(), "build" | "plan" | "ask" | "project"))
            .unwrap_or_else(|| "build".to_string())
    };

    // Native-transcript capability is decided once at creation and frozen:
    // a later capability flip must never re-route an existing session's
    // replay away from where its turns were actually persisted.
    let transcript_source = key_vault::key_store::ModelType::from_str(&params.cli_agent_type)
        .filter(native_transcript::native_transcript_enabled)
        .map(|_| native_transcript::TRANSCRIPT_SOURCE_NATIVE)
        .unwrap_or(native_transcript::TRANSCRIPT_SOURCE_CHUNKS);

    conn.execute(
        "INSERT INTO code_sessions
            (session_id, name, status, flow, runner, cli_agent_type, model, tier,
             account_id, repo_path, branch, proxy_token, proxy_url, hosted_token,
             proxy_session_id, background, key_source, additional_directories,
             parent_session_id, org_member_id, org_id, project_id, project_name,
             project_slug, work_item_id, agent_role, created_at, updated_at,
             transcript_source, product_mode, agent_exec_mode)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31)",
        params![
            session_id, name, SessionStatus::Pending.as_ref(), flow, runner, params.cli_agent_type,
            params.model, params.tier, params.account_id,
            params.repo_path, params.branch, params.proxy_token, params.proxy_url,
            params.hosted_token, params.proxy_session_id, background, key_source_str,
            additional_dirs_json, params.parent_session_id, params.org_member_id,
            org_id, params.project_id, params.project_name, params.project_slug,
            params.work_item_id, params.agent_role, ts, ts, transcript_source,
            product_mode, AgentExecMode::Build.as_str(),
        ],
    )?;

    let session = get_session(session_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    sync_orgtrack_mirror(session_id);
    Ok(session)
}
