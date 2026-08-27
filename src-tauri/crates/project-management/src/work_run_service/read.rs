use rusqlite::{params, OptionalExtension, Transaction};

use crate::projects::io::helpers::conn;
use crate::projects::types::WorkItemRun;

use super::store::{canonical_standalone_org_id, db, require_run, scope_key};
use super::{error, MAX_RUN_ATTEMPTS};

pub fn read(run_id: &str) -> Result<WorkItemRun, String> {
    let connection = conn()?;
    require_run(&connection, run_id)
}

pub(crate) fn read_in_transaction(
    tx: &Transaction<'_>,
    run_id: &str,
) -> Result<WorkItemRun, String> {
    require_run(tx, run_id)
}

/// List execution episodes whose dispatch already owns a Session but whose
/// Run has not reached a durable terminal state yet.
///
/// Startup recovery uses this projection after the Session store has marked
/// process-interrupted sessions as abandoned. Keeping the query in the Run
/// service preserves the package boundary: agent-core never reaches into PM
/// tables directly.
pub fn list_active_session_runs() -> Result<Vec<WorkItemRun>, String> {
    let connection = conn()?;
    let ids = {
        let mut statement = db(connection.prepare(
            "SELECT id FROM pm_work_item_runs
             WHERE session_id IS NOT NULL
               AND status IN ('dispatching', 'running', 'waiting')
             ORDER BY COALESCE(started_at, created_at) ASC, created_at ASC, id ASC",
        ))?;
        let rows = db(statement.query_map([], |row| row.get::<_, String>(0)))?;
        db(rows.collect::<rusqlite::Result<Vec<_>>>())?
    };
    ids.into_iter()
        .map(|run_id| require_run(&connection, &run_id))
        .collect()
}

pub fn list_for_work_item(
    project_slug: Option<&str>,
    org_id: &str,
    work_item_id: &str,
    limit: usize,
) -> Result<Vec<WorkItemRun>, String> {
    let connection = conn()?;
    let canonical_org_id = match project_slug {
        Some(slug) => db(connection
            .query_row(
                "SELECT org_id FROM projects WHERE slug = ?1",
                params![slug],
                |row| row.get::<_, String>(0),
            )
            .optional())?
        .unwrap_or_else(|| org_id.to_string()),
        None => canonical_standalone_org_id(&connection, org_id)?,
    };
    let scope = scope_key(project_slug, &canonical_org_id);
    let bounded_limit = limit.clamp(1, 200) as i64;
    let mut statement = db(connection.prepare(
        "SELECT id FROM pm_work_item_runs
         WHERE scope_key = ?1 AND work_item_id = ?2
         ORDER BY created_at DESC, id DESC LIMIT ?3",
    ))?;
    let ids = db(
        statement.query_map(params![scope, work_item_id, bounded_limit], |row| {
            row.get::<_, String>(0)
        }),
    )?;
    let mut runs = Vec::new();
    for id in ids {
        runs.push(require_run(&connection, &db(id)?)?);
    }
    Ok(runs)
}

/// Newest execution episode attached to a Session, regardless of terminal
/// state. Used to attribute automatic goal-loop continuations as follow-ups
/// without conflating them with a fresh manual start.
pub fn latest_for_session(session_id: &str) -> Result<Option<WorkItemRun>, String> {
    if session_id.trim().is_empty() {
        return Err(format!("{}:session_id is required", error::INVALID_REQUEST));
    }
    let connection = conn()?;
    let run_id: Option<String> = db(connection
        .query_row(
            "SELECT id FROM pm_work_item_runs
             WHERE session_id = ?1
             ORDER BY COALESCE(started_at, created_at) DESC, created_at DESC, id DESC
             LIMIT 1",
            params![session_id],
            |row| row.get(0),
        )
        .optional())?;
    run_id
        .map(|run_id| require_run(&connection, &run_id))
        .transpose()
}

/// Resolve the Routine that owns a Run, following typed retry ancestry.
///
/// Retry episodes intentionally keep `trigger = retry` for auditability, so
/// consumers that project execution back onto a Routine fire must consult the
/// immutable parent chain rather than treating the newest trigger as the
/// whole provenance record.
pub fn routine_origin(run_id: &str) -> Result<Option<(String, String)>, String> {
    let mut current_id = run_id.to_string();
    for _ in 0..=MAX_RUN_ATTEMPTS {
        let run = read(&current_id)?;
        if let crate::projects::types::WorkItemRunTrigger::Routine {
            routine_id,
            fire_id,
        } = run.trigger
        {
            return Ok(Some((routine_id, fire_id)));
        }
        let Some(parent_run_id) = run.parent_run_id else {
            return Ok(None);
        };
        current_id = parent_run_id;
    }
    Err(format!(
        "{}:{} has a retry ancestry deeper than {MAX_RUN_ATTEMPTS}",
        error::INVALID_REQUEST,
        run_id
    ))
}
