use rusqlite::{params, Connection, OptionalExtension, Result as SqliteResult};

use crate::definitions::orgs::{AgentOrgsStore, OrgDefinition, OrgMember};
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
                work_item_id,
                project_slug,
                routine_fire_id,
                summary,
                last_error,
                created_at,
                updated_at,
                completed_at
         FROM agent_org_runs
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
                work_item_id,
                project_slug,
                routine_fire_id,
                summary,
                last_error,
                created_at,
                updated_at,
                completed_at
         FROM agent_org_runs
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
        work_item_id: row.get(7)?,
        project_slug: row.get(8)?,
        routine_fire_id: row.get(9)?,
        summary: row.get(10)?,
        last_error: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        completed_at: row.get(14)?,
    })
}

pub(super) fn context_for_run_record(
    run: &AgentOrgRunRecord,
    org_store: &AgentOrgsStore,
) -> Result<AgentOrgRunContext, String> {
    if let Some(snapshot_json) = run.org_snapshot_json.as_deref() {
        let snapshot: OrgDefinition = serde_json::from_str(snapshot_json).map_err(|err| {
            format!(
                "failed to parse Agent Org launch snapshot for run {}: {}",
                run.id, err
            )
        })?;
        return Ok(context_from_run_and_org(run, &snapshot));
    }

    let org = org_store.get(&run.org_id)?;
    Ok(context_from_run_and_org(run, &org))
}

pub(super) fn context_from_run_and_org(
    run: &AgentOrgRunRecord,
    org: &OrgDefinition,
) -> AgentOrgRunContext {
    AgentOrgRunContext {
        run_id: run.id.clone(),
        org_id: org.id.clone(),
        org_name: org.name.clone(),
        org_role: org.role.clone(),
        coordinator_agent_id: run.coordinator_agent_id.clone(),
        coordinator_name: DEFAULT_COORDINATOR_DISPLAY_NAME.to_string(),
        coordinator_role: org.role.clone(),
        coordinator_instructions: org.instructions.clone(),
        members: flatten_members(&org.children, None),
        hierarchy_mode: org.hierarchy_mode,
        plan_approval_policy: org.plan_approval_policy,
        root_session_id: run.root_session_id.clone(),
    }
}

/// Flatten the `OrgMember` tree into a `Vec<AgentOrgContextMember>`,
/// preserving each member's parent id (the immediate parent in
/// `OrgDefinition.children`). A `None` parent means the member is a
/// direct report of the coordinator.
///
/// In `HierarchyMode::Flat` the parent ids are still emitted but the
/// system prompt and routing layer ignore them.
pub(super) fn flatten_members(
    members: &[OrgMember],
    parent_id: Option<&str>,
) -> Vec<AgentOrgContextMember> {
    let mut flattened = Vec::new();
    for member in members {
        flattened.push(AgentOrgContextMember {
            member_id: member.id.clone(),
            name: member.name.clone(),
            role: member.role.clone(),
            agent_id: member.agent_id.clone(),
            instructions: member.instructions.clone(),
            parent_member_id: parent_id.map(|id| id.to_string()),
        });
        flattened.extend(flatten_members(&member.children, Some(&member.id)));
    }
    flattened
}

pub(super) fn insert_run(conn: &Connection, run: &AgentOrgRunRecord) -> SqliteResult<()> {
    conn.execute(
        "INSERT INTO agent_org_runs (
            id,
            org_id,
            coordinator_agent_id,
            root_session_id,
            org_snapshot_json,
            entry_mode,
            status,
            work_item_id,
            project_slug,
            routine_fire_id,
            summary,
            last_error,
            created_at,
            updated_at,
            completed_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            &run.id,
            &run.org_id,
            &run.coordinator_agent_id,
            run.root_session_id.as_deref(),
            run.org_snapshot_json.as_deref(),
            run.entry_mode.as_str(),
            run.status.as_str(),
            run.work_item_id.as_deref(),
            run.project_slug.as_deref(),
            run.routine_fire_id.as_deref(),
            run.summary.as_deref(),
            run.last_error.as_deref(),
            &run.created_at,
            &run.updated_at,
            run.completed_at.as_deref(),
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
