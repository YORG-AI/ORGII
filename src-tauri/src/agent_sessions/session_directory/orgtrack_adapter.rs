use database::db::get_connection;
use orgtrack_core::canonical::{
    AgentMetadata, SessionRecord, SOURCE_ORGII_CLI_SESSIONS, SOURCE_ORGII_RUST_AGENTS,
};
use orgtrack_core::privacy::ORGTRACK_SCHEMA_VERSION;
use orgtrack_core::store::{sqlite::SqliteRecordStore, RecordStore};

use super::types::{SessionAggregateRecord, SessionCategory};

pub fn upsert_aggregate_sessions(records: &[SessionAggregateRecord]) -> Result<(), String> {
    if records.is_empty() {
        return Ok(());
    }
    let conn = get_connection().map_err(|err| err.to_string())?;
    let store = SqliteRecordStore::new(&conn);
    for record in records {
        store.upsert_session(&aggregate_to_core_session(record))?;
    }
    Ok(())
}

/// One-time startup reconcile of the orgtrack session mirror.
///
/// The write-path hooks keep the mirror fresh going forward; this pass
/// repairs history from before they existed:
/// - drops ORGII-source rows whose native session is gone — including
///   imported-history ids the old per-list upsert mislabeled as
///   `orgii_cli_sessions` (the import scan re-upserts those under their
///   real source), and
/// - re-mirrors every current native session so titles/status/timestamps
///   are trustworthy for orgtrack readers.
pub fn reconcile_native_session_mirror() -> Result<(), String> {
    {
        let conn = get_connection().map_err(|err| err.to_string())?;
        conn.execute(
            "DELETE FROM orgtrack_core_sessions
             WHERE source = ?1
               AND session_id NOT IN (SELECT session_id FROM code_sessions)",
            rusqlite::params![SOURCE_ORGII_CLI_SESSIONS],
        )
        .map_err(|err| format!("purge stale cli mirror rows: {err}"))?;
        conn.execute(
            "DELETE FROM orgtrack_core_sessions
             WHERE source = ?1
               AND session_id NOT IN (SELECT session_id FROM agent_sessions)",
            rusqlite::params![SOURCE_ORGII_RUST_AGENTS],
        )
        .map_err(|err| format!("purge stale agent mirror rows: {err}"))?;
    }

    let native = super::aggregation::list_all_sessions(Some(&super::types::SessionFilter {
        category: Some("cli,agent,os".to_string()),
        include_external_history: Some(false),
        ..Default::default()
    }))?;
    upsert_aggregate_sessions(&native.sessions)?;

    // Project usage/cost rows for sessions written before the projection's
    // write-path hooks existed. Bounded and missing-rows-only, so steady-state
    // startups scan the candidate ids and do nothing.
    let conn = get_connection().map_err(|err| err.to_string())?;
    orgtrack_core::session_usage::backfill_session_usage(&conn, USAGE_BACKFILL_LIMIT)
        .map(|_| ())
        .map_err(|err| format!("session usage backfill: {err}"))
}

/// Upper bound on projection rows repaired per startup pass. Keeps the
/// reconcile thread bounded on first launch against a large history; anything
/// beyond the cap is picked up by subsequent startups.
const USAGE_BACKFILL_LIMIT: usize = 20_000;

/// Drop a deleted ORGII session's mirror row and its usage projection.
/// Scoped to ORGII sources so an id collision can never remove an
/// imported-history row. Fired from the delete paths in both persistence
/// layers (the upsert hook cannot serve deletes: re-reading a deleted
/// session would resurrect a stub row).
pub fn remove_mirrored_session(session_id: &str) -> Result<(), String> {
    let conn = get_connection().map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM orgtrack_core_sessions
         WHERE session_id = ?1 AND source IN (?2, ?3)",
        rusqlite::params![
            session_id,
            SOURCE_ORGII_CLI_SESSIONS,
            SOURCE_ORGII_RUST_AGENTS
        ],
    )
    .map_err(|err| format!("remove mirrored session: {err}"))?;
    conn.execute(
        "DELETE FROM orgtrack_core_session_usage
         WHERE session_id = ?1 AND source IN (?2, ?3)",
        rusqlite::params![
            session_id,
            SOURCE_ORGII_CLI_SESSIONS,
            SOURCE_ORGII_RUST_AGENTS
        ],
    )
    .map_err(|err| format!("remove session usage projection: {err}"))?;
    Ok(())
}

/// Mirror one ORGII-launched CLI session into orgtrack's canonical session
/// store. Called from the CLI persistence write path (create / status /
/// name / model / exec-mode changes) so the mirror follows writes instead
/// of piggybacking on every list query. Missing sessions are a no-op.
pub fn upsert_cli_session(session_id: &str) -> Result<(), String> {
    let Some(session) = crate::agent_sessions::cli::persistence::get_session(session_id)
        .map_err(|err| err.to_string())?
    else {
        return Ok(());
    };
    upsert_aggregate_sessions(&[super::conversion::cli_session_to_aggregate_record(
        session,
    )])
}

/// Mirror one Rust-agent session into orgtrack's canonical session store.
/// Reuses the event pipeline's record mapping so patch-driven metadata
/// changes (rename, model swap) land without waiting for the next
/// artifact-persistence pass.
pub fn upsert_rust_agent_session(session_id: &str) -> Result<(), String> {
    let record = crate::agent_sessions::event_pipeline::commands::runtime_artifact_session_record(
        session_id,
    )?;
    let conn = get_connection().map_err(|err| err.to_string())?;
    let store = SqliteRecordStore::new(&conn);
    store.upsert_session(&record)
}

fn aggregate_to_core_session(record: &SessionAggregateRecord) -> SessionRecord {
    let source = match record.category {
        SessionCategory::Cli => SOURCE_ORGII_CLI_SESSIONS,
        SessionCategory::Agent | SessionCategory::Os => SOURCE_ORGII_RUST_AGENTS,
    };
    SessionRecord {
        schema_version: ORGTRACK_SCHEMA_VERSION,
        source: source.to_string(),
        source_session_id: record.session_id.clone(),
        session_id: record.session_id.clone(),
        title: record.name.clone(),
        status: Some(record.status.clone()),
        created_at: Some(record.created_at.clone()),
        updated_at: Some(record.updated_at.clone()),
        completed_at: None,
        workspace_path: record
            .repo_path
            .clone()
            .or_else(|| record.worktree_path.clone()),
        branch: record
            .branch
            .clone()
            .or_else(|| record.worktree_branch.clone()),
        parent_session_id: record.parent_session_id.clone(),
        org_member_id: record.org_member_id.clone(),
        collaboration_origin: None,
        metadata: AgentMetadata {
            dispatch_category: Some(dispatch_category_for(record.category).to_string()),
            rust_agent_type: rust_agent_type_for(record),
            cli_agent_type: record.cli_agent_type.clone(),
            agent_exec_mode: record.agent_exec_mode.clone(),
            provider_model_type: None,
            model: record.model.clone(),
            key_source: Some(record.key_source.to_string()),
            origin: Some(source.to_string()),
            display_name: record
                .agent_display_name
                .clone()
                .or_else(|| record.display_label.clone())
                .or_else(|| Some(record.name.clone())),
            parsed_categories: Default::default(),
        },
    }
}

fn dispatch_category_for(category: SessionCategory) -> &'static str {
    match category {
        SessionCategory::Cli => "cli_agent",
        SessionCategory::Agent | SessionCategory::Os => "rust_agent",
    }
}

fn rust_agent_type_for(record: &SessionAggregateRecord) -> Option<String> {
    match record.category {
        SessionCategory::Os => Some("os".to_string()),
        SessionCategory::Agent => {
            if record.session_id.starts_with("sdeagent-") {
                Some("sde".to_string())
            } else if record.session_id.starts_with("gateway-") {
                Some("gateway".to_string())
            } else {
                Some("custom".to_string())
            }
        }
        SessionCategory::Cli => None,
    }
}
