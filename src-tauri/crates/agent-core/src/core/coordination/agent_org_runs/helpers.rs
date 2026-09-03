use rusqlite::{params, Connection, OptionalExtension, Result as SqliteResult};

use crate::definitions::orgs::{
    validate_launch_snapshot, AgentOrgCapabilityIndex, AgentOrgLaunchSnapshot,
};
use database::db::get_connection;

use super::{
    AgentOrgContextMember, AgentOrgRunContext, AgentOrgRunEntryMode, AgentOrgRunRecord,
    AgentOrgRunStatus, DEFAULT_COORDINATOR_DISPLAY_NAME,
};

/// Single-column lookup for the parent of `session_id` in persisted runtime
/// session tables. Used by `context_for_session_with_parent_walk` to avoid
/// pulling full session rows on every hop — the walk only needs the
/// `parent_session_id` string.
///
/// Returns `Ok(None)` for both "session does not exist" and "session exists
/// but has no parent". Both cases terminate the walk identically;
/// distinguishing them would not change the resolver outcome.
pub(super) fn parent_session_id_of(session_id: &str) -> SqliteResult<Option<String>> {
    let conn = get_connection()?;
    let parent = conn
        .query_row(
            "SELECT parent_session_id FROM agent_sessions WHERE session_id = ?1",
            params![session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    if parent.is_some() {
        return Ok(parent);
    }

    conn.query_row(
        "SELECT parent_session_id FROM code_sessions WHERE session_id = ?1",
        params![session_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(|outer| outer.flatten())
}

pub(super) fn load_by_id(run_id: &str) -> SqliteResult<Option<AgentOrgRunRecord>> {
    let conn = get_connection()?;
    conn.query_row(
        "SELECT id,
                org_id,
                coordinator_agent_id,
                root_session_id,
                org_snapshot_json,
                entry_mode,
                status,
                activation_generation,
                has_initial_work,
                work_item_id,
                project_slug,
                routine_fire_id,
                summary,
                last_error,
                failure_json,
                last_activity_outcome,
                created_at,
                updated_at,
                idled_at,
                archived_at,
                archive_receipt_id
         FROM agent_org_runtime_runs
         WHERE id = ?1
         LIMIT 1",
        params![run_id],
        row_to_run,
    )
    .optional()
}

pub(super) fn load_by_root_session(
    root_session_id: &str,
) -> SqliteResult<Option<AgentOrgRunRecord>> {
    let conn = get_connection()?;
    conn.query_row(
        "SELECT id,
                org_id,
                coordinator_agent_id,
                root_session_id,
                org_snapshot_json,
                entry_mode,
                status,
                activation_generation,
                has_initial_work,
                work_item_id,
                project_slug,
                routine_fire_id,
                summary,
                last_error,
                failure_json,
                last_activity_outcome,
                created_at,
                updated_at,
                idled_at,
                archived_at,
                archive_receipt_id
         FROM agent_org_runtime_runs
         WHERE root_session_id = ?1
         ORDER BY created_at DESC
         LIMIT 1",
        params![root_session_id],
        row_to_run,
    )
    .optional()
}

pub(super) fn row_to_run(row: &rusqlite::Row<'_>) -> SqliteResult<AgentOrgRunRecord> {
    let entry_mode_raw: String = row.get(5)?;
    let status_raw: String = row.get(6)?;
    let entry_mode = AgentOrgRunEntryMode::parse(&entry_mode_raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            5,
            rusqlite::types::Type::Text,
            format!("unknown AgentOrgRunEntryMode value: {entry_mode_raw:?}").into(),
        )
    })?;
    let status = AgentOrgRunStatus::parse(&status_raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            6,
            rusqlite::types::Type::Text,
            format!("unknown AgentOrgRunStatus value: {status_raw:?}").into(),
        )
    })?;
    Ok(AgentOrgRunRecord {
        id: row.get(0)?,
        org_id: row.get(1)?,
        coordinator_agent_id: row.get(2)?,
        root_session_id: row.get(3)?,
        org_snapshot_json: row.get(4)?,
        entry_mode,
        status,
        activation_generation: row.get(7)?,
        has_initial_work: row.get::<_, i64>(8)? != 0,
        work_item_id: row.get(9)?,
        project_slug: row.get(10)?,
        routine_fire_id: row.get(11)?,
        summary: row.get(12)?,
        last_error: row.get(13)?,
        failure_json: row.get(14)?,
        last_activity_outcome: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
        idled_at: row.get(18)?,
        archived_at: row.get(19)?,
        archive_receipt_id: row.get(20)?,
    })
}

pub(super) fn context_for_run_record(
    run: &AgentOrgRunRecord,
) -> Result<AgentOrgRunContext, String> {
    let snapshot_json = run
        .org_snapshot_json
        .as_deref()
        .ok_or_else(|| format!("Agent Org run {} has no immutable launch snapshot", run.id))?;
    let snapshot: AgentOrgLaunchSnapshot = serde_json::from_str(snapshot_json).map_err(|err| {
        format!(
            "failed to parse Agent Org launch snapshot for run {}: {}",
            run.id, err
        )
    })?;
    validate_launch_snapshot(&snapshot).map_err(|err| {
        format!(
            "Agent Org run {} has invalid launch snapshot: {err}",
            run.id
        )
    })?;
    Ok(context_from_run_and_snapshot(run, &snapshot))
}

pub(super) fn context_from_run_and_snapshot(
    run: &AgentOrgRunRecord,
    snapshot: &AgentOrgLaunchSnapshot,
) -> AgentOrgRunContext {
    AgentOrgRunContext {
        run_id: run.id.clone(),
        org_id: snapshot.org_id.clone(),
        org_name: snapshot.org_name.clone(),
        org_role: snapshot.coordinator_role.clone(),
        coordinator_agent_id: run.coordinator_agent_id.clone(),
        coordinator_name: DEFAULT_COORDINATOR_DISPLAY_NAME.to_string(),
        coordinator_role: snapshot.coordinator_role.clone(),
        members: flatten_members(&snapshot.members),
        plan_approval_policy: snapshot.plan_approval_policy,
        capability_index: AgentOrgCapabilityIndex::from_snapshot(snapshot),
        root_session_id: run.root_session_id.clone(),
    }
}

/// Project the immutable flat snapshot roster into runtime context rows.
pub(super) fn flatten_members(
    members: &[crate::definitions::orgs::FlatOrgMember],
) -> Vec<AgentOrgContextMember> {
    members
        .iter()
        .map(|member| AgentOrgContextMember {
            member_id: member.member_id.clone(),
            name: member.name.clone(),
            role: member.role.clone(),
            agent_id: member.agent_id.clone(),
        })
        .collect()
}

pub(super) fn insert_run(conn: &Connection, run: &AgentOrgRunRecord) -> SqliteResult<()> {
    conn.execute(
        "INSERT INTO agent_org_runtime_runs (
            id,
            org_id,
            coordinator_agent_id,
            root_session_id,
            org_snapshot_json,
            entry_mode,
            status,
            activation_generation,
            has_initial_work,
            work_item_id,
            project_slug,
            routine_fire_id,
            summary,
            last_error,
            failure_json,
            last_activity_outcome,
            created_at,
            updated_at,
            idled_at,
            archived_at,
            archive_receipt_id
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
        params![
            &run.id,
            &run.org_id,
            &run.coordinator_agent_id,
            run.root_session_id.as_deref(),
            run.org_snapshot_json.as_deref(),
            run.entry_mode.as_str(),
            run.status.as_str(),
            run.activation_generation,
            i64::from(run.has_initial_work),
            run.work_item_id.as_deref(),
            run.project_slug.as_deref(),
            run.routine_fire_id.as_deref(),
            run.summary.as_deref(),
            run.last_error.as_deref(),
            run.failure_json.as_deref(),
            run.last_activity_outcome.as_deref(),
            &run.created_at,
            &run.updated_at,
            run.idled_at.as_deref(),
            run.archived_at.as_deref(),
            run.archive_receipt_id.as_deref(),
        ],
    )?;
    Ok(())
}

pub(super) fn validate_entry_mode(value: &str) -> Result<AgentOrgRunEntryMode, String> {
    AgentOrgRunEntryMode::parse(value)
        .ok_or_else(|| format!("unknown AgentOrgRunEntryMode value: {value:?}"))
}

pub(super) fn validate_status(value: &str) -> Result<AgentOrgRunStatus, String> {
    AgentOrgRunStatus::parse(value)
        .ok_or_else(|| format!("unknown AgentOrgRunStatus value: {value:?}"))
}
