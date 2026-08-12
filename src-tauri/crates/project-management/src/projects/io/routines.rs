//! SQLite-backed RoutineDefinition and RoutineFire IO.

use rusqlite::{params, OptionalExtension};

use super::super::routine_schedule;
use super::helpers::{conn, from_iso8601, map_db, now_ms, to_iso8601};
use crate::projects::types::{
    RoutineConcurrencyPolicy, RoutineDefinition, RoutineFire, RoutineFireStatus,
    RoutineOutputPolicy, RoutineRunTemplate, RoutineTrigger,
};

fn timestamp_id(prefix: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{prefix}-{nanos}")
}

fn encode_json<T: serde::Serialize>(label: &str, value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|err| format!("serialize {label}: {err}"))
}

fn row_to_routine(row: &rusqlite::Row<'_>) -> rusqlite::Result<RoutineDefinition> {
    let trigger_json: String = row.get(4)?;
    let template_json: String = row.get(5)?;
    let output_policy_json: String = row.get(6)?;

    Ok(RoutineDefinition {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        enabled: row.get::<_, i64>(3)? != 0,
        trigger: serde_json::from_str::<RoutineTrigger>(&trigger_json).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(err))
        })?,
        run_template: serde_json::from_str::<RoutineRunTemplate>(&template_json).map_err(
            |err| {
                rusqlite::Error::FromSqlConversionFailure(
                    5,
                    rusqlite::types::Type::Text,
                    Box::new(err),
                )
            },
        )?,
        output_policy: decode_output_policy(&output_policy_json)?,
        last_evaluated_at: row.get::<_, Option<i64>>(9)?.map(to_iso8601),
        next_fire_at: row.get::<_, Option<i64>>(10)?.map(to_iso8601),
        last_fire_at: row.get::<_, Option<i64>>(11)?.map(to_iso8601),
        last_fire_status: row
            .get::<_, Option<String>>(12)?
            .map(|status| parse_fire_status(&status, 12))
            .transpose()?,
        last_fire_error: row.get(13)?,
        last_fire_session_id: row.get(14)?,
        last_fire_work_item_id: row.get(15)?,
        created_at: to_iso8601(row.get(7)?),
        updated_at: to_iso8601(row.get(8)?),
    })
}

const ROUTINE_SELECT_COLUMNS: &str =
    "routine.id, routine.name, routine.description, routine.enabled,
     routine.trigger_json, routine.run_template_json, routine.output_policy_json,
     routine.created_at, routine.updated_at, routine.last_evaluated_at,
     routine.next_fire_at,
     latest_fire.fired_at, latest_fire.status, latest_fire.error,
     latest_fire.session_id, latest_fire.work_item_id";

const ROUTINE_FROM: &str = "routine_definitions AS routine
     LEFT JOIN routine_fires AS latest_fire ON latest_fire.id = (
       SELECT fire.id FROM routine_fires AS fire
       WHERE fire.routine_id = routine.id
       ORDER BY fire.fired_at DESC, fire.id DESC LIMIT 1
     )";

const FIRE_SELECT_COLUMNS: &str = "id, routine_id, fired_at, status, session_id, agent_org_run_id,
     work_item_id, coalesced_into_fire_id, idempotency_key, started_at,
     completed_at, error";

fn decode_output_policy(raw: &str) -> rusqlite::Result<RoutineOutputPolicy> {
    if raw.trim().is_empty() || raw.trim() == "{}" {
        return Ok(RoutineOutputPolicy::default());
    }
    serde_json::from_str::<RoutineOutputPolicy>(raw).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(err))
    })
}

fn row_to_fire(row: &rusqlite::Row<'_>) -> rusqlite::Result<RoutineFire> {
    let status_raw: String = row.get(3)?;
    let status = parse_fire_status(&status_raw, 3)?;

    Ok(RoutineFire {
        id: row.get(0)?,
        routine_id: row.get(1)?,
        fired_at: to_iso8601(row.get(2)?),
        status,
        session_id: row.get(4)?,
        agent_org_run_id: row.get(5)?,
        work_item_id: row.get(6)?,
        coalesced_into_fire_id: row.get(7)?,
        idempotency_key: row.get(8)?,
        started_at: row.get::<_, Option<i64>>(9)?.map(to_iso8601),
        completed_at: row.get::<_, Option<i64>>(10)?.map(to_iso8601),
        error: row.get(11)?,
    })
}

fn parse_fire_status(raw: &str, column: usize) -> rusqlite::Result<RoutineFireStatus> {
    Ok(match raw {
        "pending" => RoutineFireStatus::Pending,
        "started" => RoutineFireStatus::Started,
        "succeeded" => RoutineFireStatus::Succeeded,
        "failed" => RoutineFireStatus::Failed,
        "skipped" => RoutineFireStatus::Skipped,
        "coalesced" => RoutineFireStatus::Coalesced,
        "queued" => RoutineFireStatus::Queued,
        other => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                column,
                rusqlite::types::Type::Text,
                format!("unknown routine fire status: {other}").into(),
            ));
        }
    })
}

fn status_to_str(status: &RoutineFireStatus) -> &'static str {
    match status {
        RoutineFireStatus::Pending => "pending",
        RoutineFireStatus::Started => "started",
        RoutineFireStatus::Succeeded => "succeeded",
        RoutineFireStatus::Failed => "failed",
        RoutineFireStatus::Skipped => "skipped",
        RoutineFireStatus::Coalesced => "coalesced",
        RoutineFireStatus::Queued => "queued",
    }
}

pub fn list_routines() -> Result<Vec<RoutineDefinition>, String> {
    let connection = conn()?;
    let mut stmt = map_db(connection.prepare(&format!(
        "SELECT {ROUTINE_SELECT_COLUMNS}
         FROM {ROUTINE_FROM}
         ORDER BY routine.updated_at DESC, routine.created_at DESC",
    )))?;
    let rows = map_db(stmt.query_map([], row_to_routine))?;
    let mut routines = Vec::new();
    for entry in rows {
        routines.push(map_db(entry)?);
    }
    Ok(routines)
}

/// Current cross-process PM change watermark (design §13.0). External
/// writers (the org2 PM CLI) bump this inside every mutation
/// transaction; the desktop host polls it to notice foreign commits.
pub fn read_pm_change_seq() -> Result<i64, String> {
    let connection = super::helpers::conn()?;
    connection
        .query_row("SELECT seq FROM pm_change_seq WHERE id = 1", [], |row| {
            row.get(0)
        })
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(0),
            other => Err(format!("pm_change_seq: {other}")),
        })
}

/// List enabled routines for scheduler evaluation.
pub fn list_enabled_routines() -> Result<Vec<RoutineDefinition>, String> {
    let connection = conn()?;
    let mut stmt = map_db(connection.prepare(&format!(
        "SELECT {ROUTINE_SELECT_COLUMNS}
         FROM {ROUTINE_FROM}
         WHERE routine.enabled = 1
         ORDER BY routine.created_at ASC",
    )))?;
    let rows = map_db(stmt.query_map([], row_to_routine))?;
    let mut routines = Vec::new();
    for entry in rows {
        routines.push(map_db(entry)?);
    }
    Ok(routines)
}

pub fn read_routine(id: &str) -> Result<RoutineDefinition, String> {
    let connection = conn()?;
    let routine = map_db(
        connection
            .query_row(
                &format!(
                    "SELECT {ROUTINE_SELECT_COLUMNS}
                     FROM {ROUTINE_FROM}
                     WHERE routine.id = ?1",
                ),
                params![id],
                row_to_routine,
            )
            .optional(),
    )?;
    routine.ok_or_else(|| format!("Routine not found: {id}"))
}

pub fn upsert_routine(mut routine: RoutineDefinition) -> Result<RoutineDefinition, String> {
    let connection = conn()?;
    let now = now_ms();
    if routine.id.trim().is_empty() {
        routine.id = timestamp_id("routine");
    }
    if routine.created_at.trim().is_empty() {
        routine.created_at = to_iso8601(now);
    }
    routine.updated_at = to_iso8601(now);

    let created_at_ms = from_iso8601(&routine.created_at);
    let trigger_json = encode_json("routine trigger", &routine.trigger)?;
    let template_json = encode_json("routine run template", &routine.run_template)?;
    let output_policy_json = encode_json("routine output policy", &routine.output_policy)?;
    let computed_next_fire =
        routine_schedule::next_occurrence(&routine.trigger, &chrono::Utc::now())?;
    let next_fire_at_ms = if routine.enabled {
        computed_next_fire.map(|value| value.timestamp_millis())
    } else {
        None
    };

    map_db(connection.execute(
        "INSERT INTO routine_definitions (
            id, name, description, enabled, trigger_json, run_template_json,
            output_policy_json, created_at, updated_at, last_evaluated_at,
            next_fire_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            enabled = excluded.enabled,
            trigger_json = excluded.trigger_json,
            run_template_json = excluded.run_template_json,
            output_policy_json = excluded.output_policy_json,
            last_evaluated_at = CASE
                WHEN routine_definitions.trigger_json != excluded.trigger_json
                THEN excluded.last_evaluated_at
                ELSE routine_definitions.last_evaluated_at
            END,
            next_fire_at = excluded.next_fire_at,
            updated_at = excluded.updated_at",
        params![
            routine.id,
            routine.name,
            routine.description,
            if routine.enabled { 1 } else { 0 },
            trigger_json,
            template_json,
            output_policy_json,
            created_at_ms,
            now,
            next_fire_at_ms,
        ],
    ))?;

    read_routine(&routine.id)
}

pub fn delete_routine(id: &str) -> Result<bool, String> {
    let connection = conn()?;
    let removed =
        map_db(connection.execute("DELETE FROM routine_definitions WHERE id = ?1", [id]))?;
    Ok(removed > 0)
}

/// Persist the scheduler evaluation watermark and the next computed fire time.
/// Deliberately does NOT touch `updated_at` — scheduler bookkeeping is not a
/// user edit and must not reorder the routines list.
pub fn update_routine_schedule_marks(
    id: &str,
    last_evaluated_at_ms: i64,
    next_fire_at_ms: Option<i64>,
) -> Result<(), String> {
    let connection = conn()?;
    map_db(connection.execute(
        "UPDATE routine_definitions
         SET last_evaluated_at = ?2, next_fire_at = ?3
         WHERE id = ?1",
        params![id, last_evaluated_at_ms, next_fire_at_ms],
    ))?;
    Ok(())
}

/// Disable a routine without touching `updated_at` (used by the scheduler
/// after a one-time trigger fires).
pub fn disable_routine(id: &str) -> Result<(), String> {
    let connection = conn()?;
    map_db(connection.execute(
        "UPDATE routine_definitions SET enabled = 0 WHERE id = ?1",
        params![id],
    ))?;
    Ok(())
}

pub fn list_routine_fires(routine_id: &str) -> Result<Vec<RoutineFire>, String> {
    let connection = conn()?;
    let mut stmt = map_db(connection.prepare(
        "SELECT id, routine_id, fired_at, status, session_id, agent_org_run_id,
                work_item_id, coalesced_into_fire_id, idempotency_key, started_at,
                completed_at, error
         FROM routine_fires
         WHERE routine_id = ?1
         ORDER BY fired_at DESC
         LIMIT 100",
    ))?;
    let rows = map_db(stmt.query_map([routine_id], row_to_fire))?;
    let mut fires = Vec::new();
    for entry in rows {
        fires.push(map_db(entry)?);
    }
    Ok(fires)
}

pub fn create_routine_fire(routine_id: &str) -> Result<RoutineFire, String> {
    let mut connection = conn()?;
    let transaction =
        map_db(connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
    let fire = insert_routine_fire_in_transaction(
        &transaction,
        routine_id,
        RoutineFireInsert {
            status: RoutineFireStatus::Pending,
            ..Default::default()
        },
    )?;
    map_db(transaction.commit())?;
    Ok(fire)
}

pub fn create_routine_fire_for_policy(
    routine_id: &str,
    policy: &RoutineOutputPolicy,
) -> Result<RoutineFire, String> {
    create_routine_fire_for_policy_with_key(routine_id, policy, None)
}

/// Like [`create_routine_fire_for_policy`], with an optional idempotency key.
///
/// If a fire with the same key already exists (unique index), the existing
/// fire is returned unchanged — the caller must treat a non-Pending result
/// as "do not execute".
pub fn create_routine_fire_for_policy_with_key(
    routine_id: &str,
    policy: &RoutineOutputPolicy,
    idempotency_key: Option<&str>,
) -> Result<RoutineFire, String> {
    let mut connection = conn()?;
    let transaction =
        map_db(connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;

    if let Some(key) = idempotency_key {
        let existing = map_db(
            transaction
                .query_row(
                    &format!(
                        "SELECT {FIRE_SELECT_COLUMNS}
                         FROM routine_fires
                         WHERE idempotency_key = ?1",
                    ),
                    params![key],
                    row_to_fire,
                )
                .optional(),
        )?;
        if let Some(existing_fire) = existing {
            map_db(transaction.commit())?;
            return Ok(existing_fire);
        }
    }

    let active = find_active_routine_fire_in_transaction(&transaction, routine_id)?;
    let fire = match active {
        None => insert_routine_fire_in_transaction(
            &transaction,
            routine_id,
            RoutineFireInsert {
                status: RoutineFireStatus::Pending,
                idempotency_key: idempotency_key.map(str::to_string),
                ..Default::default()
            },
        )?,
        Some(active_fire) => match policy.concurrency_policy {
            RoutineConcurrencyPolicy::CoalesceIfActive => insert_routine_fire_in_transaction(
                &transaction,
                routine_id,
                RoutineFireInsert {
                    status: RoutineFireStatus::Coalesced,
                    coalesced_into_fire_id: Some(active_fire.id),
                    idempotency_key: idempotency_key.map(str::to_string),
                    error: Some("Coalesced into active routine fire".to_string()),
                    completed_at_ms: Some(now_ms()),
                    ..Default::default()
                },
            )?,
            RoutineConcurrencyPolicy::SkipIfActive => insert_routine_fire_in_transaction(
                &transaction,
                routine_id,
                RoutineFireInsert {
                    status: RoutineFireStatus::Skipped,
                    idempotency_key: idempotency_key.map(str::to_string),
                    error: Some(format!(
                        "Skipped because routine has active fire {}",
                        active_fire.id
                    )),
                    completed_at_ms: Some(now_ms()),
                    ..Default::default()
                },
            )?,
            RoutineConcurrencyPolicy::QueueIfActive => insert_routine_fire_in_transaction(
                &transaction,
                routine_id,
                RoutineFireInsert {
                    status: RoutineFireStatus::Queued,
                    idempotency_key: idempotency_key.map(str::to_string),
                    error: Some(format!("Queued behind active fire {}", active_fire.id)),
                    ..Default::default()
                },
            )?,
            RoutineConcurrencyPolicy::AlwaysCreate => insert_routine_fire_in_transaction(
                &transaction,
                routine_id,
                RoutineFireInsert {
                    status: RoutineFireStatus::Pending,
                    idempotency_key: idempotency_key.map(str::to_string),
                    ..Default::default()
                },
            )?,
        },
    };
    map_db(transaction.commit())?;
    Ok(fire)
}

fn find_active_routine_fire_in_transaction(
    transaction: &rusqlite::Transaction<'_>,
    routine_id: &str,
) -> Result<Option<RoutineFire>, String> {
    map_db(
        transaction
            .query_row(
                "SELECT id, routine_id, fired_at, status, session_id, agent_org_run_id,
                        work_item_id, coalesced_into_fire_id, idempotency_key, started_at,
                        completed_at, error
                 FROM routine_fires
                 WHERE routine_id = ?1 AND status IN ('pending', 'started', 'queued')
                 ORDER BY fired_at DESC
                 LIMIT 1",
                params![routine_id],
                row_to_fire,
            )
            .optional(),
    )
}

struct RoutineFireInsert {
    status: RoutineFireStatus,
    session_id: Option<String>,
    coalesced_into_fire_id: Option<String>,
    idempotency_key: Option<String>,
    error: Option<String>,
    completed_at_ms: Option<i64>,
}

impl Default for RoutineFireInsert {
    fn default() -> Self {
        Self {
            status: RoutineFireStatus::Pending,
            session_id: None,
            coalesced_into_fire_id: None,
            idempotency_key: None,
            error: None,
            completed_at_ms: None,
        }
    }
}

fn insert_routine_fire_in_transaction(
    transaction: &rusqlite::Transaction<'_>,
    routine_id: &str,
    input: RoutineFireInsert,
) -> Result<RoutineFire, String> {
    let now = now_ms();
    let fire = RoutineFire {
        id: timestamp_id("routine-fire"),
        routine_id: routine_id.to_string(),
        fired_at: to_iso8601(now),
        status: input.status,
        session_id: input.session_id,
        agent_org_run_id: None,
        work_item_id: None,
        coalesced_into_fire_id: input.coalesced_into_fire_id,
        idempotency_key: input.idempotency_key,
        started_at: None,
        completed_at: input.completed_at_ms.map(to_iso8601),
        error: input.error,
    };
    map_db(transaction.execute(
        "INSERT INTO routine_fires (
            id, routine_id, fired_at, status, session_id, agent_org_run_id,
            work_item_id, coalesced_into_fire_id, idempotency_key, started_at,
            completed_at, error
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            &fire.id,
            &fire.routine_id,
            now,
            status_to_str(&fire.status),
            &fire.session_id,
            &fire.agent_org_run_id,
            &fire.work_item_id,
            &fire.coalesced_into_fire_id,
            &fire.idempotency_key,
            fire.started_at.as_deref().map(from_iso8601),
            fire.completed_at.as_deref().map(from_iso8601),
            &fire.error,
        ],
    ))?;
    Ok(fire)
}

pub fn mark_routine_fire_started(
    fire_id: &str,
    session_id: &str,
    agent_org_run_id: Option<&str>,
) -> Result<RoutineFire, String> {
    let connection = conn()?;
    let now = now_ms();
    map_db(connection.execute(
        "UPDATE routine_fires
         SET status = ?2, session_id = ?3, agent_org_run_id = ?4, started_at = ?5, error = NULL
         WHERE id = ?1",
        params![fire_id, "started", session_id, agent_org_run_id, now],
    ))?;
    read_routine_fire(fire_id)
}

pub fn mark_routine_fire_work_item_created(
    fire_id: &str,
    work_item_id: &str,
) -> Result<RoutineFire, String> {
    let connection = conn()?;
    let now = now_ms();
    map_db(connection.execute(
        "UPDATE routine_fires
         SET status = ?2, work_item_id = ?3, started_at = ?4, completed_at = ?5, error = NULL
         WHERE id = ?1",
        params![fire_id, "succeeded", work_item_id, now, now],
    ))?;
    read_routine_fire(fire_id)
}

/// Link a fire to a work item and mark it `Started` — used when the routine
/// drives a work item whose session lifecycle determines the fire's terminal
/// state (CreateWorkItem with auto_start, UpdateExistingWorkItem).
pub fn mark_routine_fire_work_item_started(
    fire_id: &str,
    work_item_id: &str,
    session_id: Option<&str>,
) -> Result<RoutineFire, String> {
    let connection = conn()?;
    let now = now_ms();
    map_db(connection.execute(
        "UPDATE routine_fires
         SET status = ?2, work_item_id = ?3, session_id = ?4, started_at = ?5, error = NULL
         WHERE id = ?1",
        params![fire_id, "started", work_item_id, session_id, now],
    ))?;
    read_routine_fire(fire_id)
}

pub fn mark_routine_fire_failed(fire_id: &str, error: &str) -> Result<RoutineFire, String> {
    let connection = conn()?;
    let now = now_ms();
    map_db(connection.execute(
        "UPDATE routine_fires
         SET status = ?2, error = ?3, completed_at = ?4
         WHERE id = ?1",
        params![fire_id, "failed", error, now],
    ))?;
    read_routine_fire(fire_id)
}

/// Mark a fire as succeeded (session reached a successful terminal state).
pub fn mark_routine_fire_succeeded(fire_id: &str) -> Result<RoutineFire, String> {
    let connection = conn()?;
    let now = now_ms();
    map_db(connection.execute(
        "UPDATE routine_fires
         SET status = ?2, completed_at = ?3, error = NULL
         WHERE id = ?1",
        params![fire_id, "succeeded", now],
    ))?;
    read_routine_fire(fire_id)
}

/// Recover Routine fires whose newest durable execution episode is terminal
/// failed. This includes both a failure before the first Session was linked
/// and a typed Retry that failed before it could resume or replace the
/// original Session.
pub fn reconcile_terminal_dispatch_fires() -> Result<Vec<RoutineFire>, String> {
    let connection = conn()?;
    let candidates = {
        let mut statement = map_db(connection.prepare(
            "WITH RECURSIVE run_lineage(id, root_trigger_json) AS (
                 SELECT id, trigger_json
                 FROM pm_work_item_runs
                 WHERE parent_run_id IS NULL
                 UNION ALL
                 SELECT child.id, parent.root_trigger_json
                 FROM pm_work_item_runs child
                 JOIN run_lineage parent ON child.parent_run_id = parent.id
             )
             SELECT fire_id, error
             FROM (
                 SELECT fire.id AS fire_id,
                        COALESCE(json_extract(run.failure_json, '$.message'),
                                 'Work Item dispatch terminated before Session launch') AS error,
                        fire.fired_at,
                        run.status AS run_status,
                        ROW_NUMBER() OVER (
                            PARTITION BY fire.id
                            ORDER BY run.attempt DESC, run.created_at DESC
                        ) AS terminal_rank
                 FROM routine_fires fire
                 JOIN run_lineage lineage
                   ON json_extract(lineage.root_trigger_json, '$.kind') = 'routine'
                  AND json_extract(lineage.root_trigger_json, '$.fireId') = fire.id
                 JOIN pm_work_item_runs run ON run.id = lineage.id
                 WHERE fire.status IN ('pending', 'started')
             )
             WHERE terminal_rank = 1 AND run_status IN ('failed', 'cancelled')
             ORDER BY fired_at ASC",
        ))?;
        let rows = map_db(statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }))?;
        map_db(rows.collect::<rusqlite::Result<Vec<_>>>())?
    };

    let now = now_ms();
    for (fire_id, error) in &candidates {
        map_db(connection.execute(
            "UPDATE routine_fires
             SET status = 'failed', error = ?2, completed_at = ?3
             WHERE id = ?1 AND status IN ('pending', 'started')",
            params![fire_id, error, now],
        ))?;
    }

    candidates
        .into_iter()
        .map(|(fire_id, _)| read_routine_fire(&fire_id))
        .collect()
}

/// Look up the non-terminal fire that launched `session_id`, if any.
/// Used by the session-terminal write-back path.
pub fn find_started_fire_by_session(session_id: &str) -> Result<Option<RoutineFire>, String> {
    let connection = conn()?;
    map_db(
        connection
            .query_row(
                &format!(
                    "SELECT {FIRE_SELECT_COLUMNS}
                     FROM routine_fires
                     WHERE session_id = ?1 AND status IN ('pending', 'started')
                     ORDER BY fired_at DESC
                     LIMIT 1",
                ),
                params![session_id],
                row_to_fire,
            )
            .optional(),
    )
}

/// Look up the non-terminal fire that drives `work_item_id`, if any.
/// Used when the work item orchestrator reaches a terminal phase
/// (CreateWorkItem auto_start / UpdateExistingWorkItem fires).
pub fn find_started_fire_by_work_item(work_item_id: &str) -> Result<Option<RoutineFire>, String> {
    let connection = conn()?;
    map_db(
        connection
            .query_row(
                &format!(
                    "SELECT {FIRE_SELECT_COLUMNS}
                     FROM routine_fires
                     WHERE work_item_id = ?1 AND status IN ('pending', 'started')
                     ORDER BY fired_at DESC
                     LIMIT 1",
                ),
                params![work_item_id],
                row_to_fire,
            )
            .optional(),
    )
}

/// Atomically promote the oldest `Queued` fire of a routine to `Pending`,
/// returning it for execution. Returns `None` when nothing is queued.
/// Only valid to call after the previously active fire reached a terminal
/// state — the promotion itself is guarded inside one immediate transaction.
pub fn take_next_queued_fire(routine_id: &str) -> Result<Option<RoutineFire>, String> {
    let mut connection = conn()?;
    let transaction =
        map_db(connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;

    // Another pending/started fire may have appeared in the meantime;
    // promoting a queued fire next to it would violate the concurrency policy.
    let still_active = map_db(
        transaction
            .query_row(
                "SELECT id FROM routine_fires
                 WHERE routine_id = ?1 AND status IN ('pending', 'started')
                 LIMIT 1",
                params![routine_id],
                |row| row.get::<_, String>(0),
            )
            .optional(),
    )?;
    if still_active.is_some() {
        map_db(transaction.commit())?;
        return Ok(None);
    }

    let queued = map_db(
        transaction
            .query_row(
                &format!(
                    "SELECT {FIRE_SELECT_COLUMNS}
                     FROM routine_fires
                     WHERE routine_id = ?1 AND status = 'queued'
                     ORDER BY fired_at ASC
                     LIMIT 1",
                ),
                params![routine_id],
                row_to_fire,
            )
            .optional(),
    )?;

    let Some(mut fire) = queued else {
        map_db(transaction.commit())?;
        return Ok(None);
    };

    map_db(transaction.execute(
        "UPDATE routine_fires SET status = 'pending', error = NULL WHERE id = ?1",
        params![fire.id],
    ))?;
    map_db(transaction.commit())?;
    fire.status = RoutineFireStatus::Pending;
    fire.error = None;
    Ok(Some(fire))
}

fn read_routine_fire(fire_id: &str) -> Result<RoutineFire, String> {
    let connection = conn()?;
    let fire = map_db(
        connection
            .query_row(
                "SELECT id, routine_id, fired_at, status, session_id, agent_org_run_id,
                        work_item_id, coalesced_into_fire_id, idempotency_key, started_at,
                        completed_at, error
                 FROM routine_fires
                 WHERE id = ?1",
                params![fire_id],
                row_to_fire,
            )
            .optional(),
    )?;
    fire.ok_or_else(|| format!("Routine fire not found: {fire_id}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::types::{
        RoutineCatchUpPolicy, RoutineOutputMode, RoutineResourceSelection, RoutineRunTarget,
        RoutineWorkspaceTarget,
    };
    use test_helpers::test_env;

    fn routine_fixture(id: &str, policy: RoutineOutputPolicy) -> RoutineDefinition {
        RoutineDefinition {
            id: id.to_string(),
            name: format!("Routine {id}"),
            description: "Routine test fixture".to_string(),
            enabled: true,
            trigger: RoutineTrigger::OneTime {
                at: "2026-05-30T00:00:00Z".to_string(),
            },
            run_template: RoutineRunTemplate {
                prompt: "Ask about the fixture".to_string(),
                target: RoutineRunTarget::AgentDefinition {
                    agent_definition_id: Some("builtin:sde".to_string()),
                },
                resources: RoutineResourceSelection {
                    key_source: Some("own_key".to_string()),
                    account_id: Some("account-1".to_string()),
                    model: Some("model-1".to_string()),
                    native_harness_type: None,
                },
                workspace: RoutineWorkspaceTarget::LocalWorkspace {
                    workspace_path: "/tmp/orgii-routine-test".to_string(),
                    additional_directories: vec![],
                },
                mode: Some("ask".to_string()),
                name: Some("Routine fixture session".to_string()),
            },
            output_policy: policy,
            last_evaluated_at: None,
            next_fire_at: None,
            last_fire_at: None,
            last_fire_status: None,
            last_fire_error: None,
            last_fire_session_id: None,
            last_fire_work_item_id: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn policy(concurrency_policy: RoutineConcurrencyPolicy) -> RoutineOutputPolicy {
        RoutineOutputPolicy {
            mode: RoutineOutputMode::DirectSession,
            concurrency_policy,
            catch_up_policy: RoutineCatchUpPolicy::RunOnce,
            max_catch_up_runs: 1,
            idempotency_scope: "routine_fire".to_string(),
            create_work_item_status: "planned".to_string(),
            create_work_item_project_slug: None,
            create_work_item_title: None,
            create_work_item_body: None,
            auto_start: true,
            update_work_item_short_id: None,
            update_work_item_project_slug: None,
        }
    }

    #[test]
    fn upsert_round_trips_output_policy() {
        let _sandbox = test_env::sandbox();
        let saved = upsert_routine(routine_fixture(
            "routine-roundtrip",
            policy(RoutineConcurrencyPolicy::QueueIfActive),
        ))
        .expect("upsert routine");

        assert_eq!(
            saved.output_policy.concurrency_policy,
            RoutineConcurrencyPolicy::QueueIfActive
        );
        assert_eq!(saved.output_policy.mode, RoutineOutputMode::DirectSession);
        assert_eq!(saved.output_policy.idempotency_scope, "routine_fire");

        let read = read_routine("routine-roundtrip").expect("read routine");
        assert_eq!(read.output_policy, saved.output_policy);
    }

    #[test]
    fn upsert_computes_next_fire_immediately_in_declared_timezone() {
        use chrono::Timelike;

        let _sandbox = test_env::sandbox();
        let mut routine = routine_fixture(
            "routine-next-fire",
            policy(RoutineConcurrencyPolicy::AlwaysCreate),
        );
        routine.trigger = RoutineTrigger::Cron {
            cron: "0 9 * * *".to_string(),
            timezone: "America/Vancouver".to_string(),
        };

        let saved = upsert_routine(routine).expect("upsert routine");
        let next = saved.next_fire_at.expect("next fire projected on save");
        let next = chrono::DateTime::parse_from_rfc3339(&next)
            .expect("next fire is RFC3339")
            .with_timezone(&"America/Vancouver".parse::<chrono_tz::Tz>().unwrap());
        assert_eq!(next.hour(), 9);
        assert_eq!(next.minute(), 0);
    }

    #[test]
    fn routine_projects_the_latest_fire_result() {
        let _sandbox = test_env::sandbox();
        upsert_routine(routine_fixture(
            "routine-latest-result",
            policy(RoutineConcurrencyPolicy::AlwaysCreate),
        ))
        .expect("upsert routine");
        let fire = create_routine_fire("routine-latest-result").expect("create fire");
        mark_routine_fire_work_item_created(&fire.id, "ABC-0001").expect("link work item");

        let routine = read_routine("routine-latest-result").expect("read routine");
        assert_eq!(routine.last_fire_status, Some(RoutineFireStatus::Succeeded));
        assert_eq!(routine.last_fire_work_item_id.as_deref(), Some("ABC-0001"));
        assert!(routine.last_fire_at.is_some());
    }

    #[test]
    fn empty_output_policy_json_decodes_to_default_policy() {
        assert_eq!(
            decode_output_policy("{}").expect("decode default"),
            RoutineOutputPolicy::default()
        );
        assert_eq!(
            decode_output_policy("   ").expect("decode blank default"),
            RoutineOutputPolicy::default()
        );
    }

    #[test]
    fn coalesce_policy_records_pointer_without_session() {
        let _sandbox = test_env::sandbox();
        upsert_routine(routine_fixture(
            "routine-coalesce",
            policy(RoutineConcurrencyPolicy::CoalesceIfActive),
        ))
        .expect("upsert routine");

        let first = create_routine_fire_for_policy(
            "routine-coalesce",
            &policy(RoutineConcurrencyPolicy::CoalesceIfActive),
        )
        .expect("first fire");
        let second = create_routine_fire_for_policy(
            "routine-coalesce",
            &policy(RoutineConcurrencyPolicy::CoalesceIfActive),
        )
        .expect("second fire");

        assert_eq!(first.status, RoutineFireStatus::Pending);
        assert_eq!(second.status, RoutineFireStatus::Coalesced);
        assert_eq!(
            second.coalesced_into_fire_id.as_deref(),
            Some(first.id.as_str())
        );
        assert!(second.session_id.is_none());
        assert!(second.completed_at.is_some());
    }

    #[test]
    fn skip_policy_records_terminal_fire_without_session() {
        let _sandbox = test_env::sandbox();
        upsert_routine(routine_fixture(
            "routine-skip",
            policy(RoutineConcurrencyPolicy::SkipIfActive),
        ))
        .expect("upsert routine");

        let first = create_routine_fire_for_policy(
            "routine-skip",
            &policy(RoutineConcurrencyPolicy::SkipIfActive),
        )
        .expect("first fire");
        let second = create_routine_fire_for_policy(
            "routine-skip",
            &policy(RoutineConcurrencyPolicy::SkipIfActive),
        )
        .expect("second fire");

        assert_eq!(first.status, RoutineFireStatus::Pending);
        assert_eq!(second.status, RoutineFireStatus::Skipped);
        assert!(second.session_id.is_none());
        assert!(second.completed_at.is_some());
        assert!(second
            .error
            .as_deref()
            .is_some_and(|error| error.contains(first.id.as_str())));
    }

    #[test]
    fn queue_policy_records_non_terminal_queued_fire() {
        let _sandbox = test_env::sandbox();
        upsert_routine(routine_fixture(
            "routine-queue",
            policy(RoutineConcurrencyPolicy::QueueIfActive),
        ))
        .expect("upsert routine");

        let first = create_routine_fire_for_policy(
            "routine-queue",
            &policy(RoutineConcurrencyPolicy::QueueIfActive),
        )
        .expect("first fire");
        let second = create_routine_fire_for_policy(
            "routine-queue",
            &policy(RoutineConcurrencyPolicy::QueueIfActive),
        )
        .expect("second fire");

        assert_eq!(first.status, RoutineFireStatus::Pending);
        assert_eq!(second.status, RoutineFireStatus::Queued);
        assert!(second.session_id.is_none());
        assert!(second.completed_at.is_none());
        assert!(second
            .error
            .as_deref()
            .is_some_and(|error| error.contains(first.id.as_str())));
    }

    #[test]
    fn always_create_policy_ignores_active_fire() {
        let _sandbox = test_env::sandbox();
        upsert_routine(routine_fixture(
            "routine-always",
            policy(RoutineConcurrencyPolicy::AlwaysCreate),
        ))
        .expect("upsert routine");

        let first = create_routine_fire_for_policy(
            "routine-always",
            &policy(RoutineConcurrencyPolicy::AlwaysCreate),
        )
        .expect("first fire");
        let second = create_routine_fire_for_policy(
            "routine-always",
            &policy(RoutineConcurrencyPolicy::AlwaysCreate),
        )
        .expect("second fire");

        assert_eq!(first.status, RoutineFireStatus::Pending);
        assert_eq!(second.status, RoutineFireStatus::Pending);
        assert_ne!(first.id, second.id);
    }

    #[test]
    fn mark_started_and_failed_update_fire_metadata() {
        let _sandbox = test_env::sandbox();
        upsert_routine(routine_fixture(
            "routine-status",
            policy(RoutineConcurrencyPolicy::CoalesceIfActive),
        ))
        .expect("upsert routine");
        let fire = create_routine_fire("routine-status").expect("create fire");

        let started = mark_routine_fire_started(&fire.id, "session-1", Some("org-run-1"))
            .expect("mark started");
        assert_eq!(started.status, RoutineFireStatus::Started);
        assert_eq!(started.session_id.as_deref(), Some("session-1"));
        assert_eq!(started.agent_org_run_id.as_deref(), Some("org-run-1"));
        assert!(started.started_at.is_some());
        assert!(started.error.is_none());

        let failed =
            mark_routine_fire_failed(&fire.id, "provider unavailable").expect("mark failed");
        assert_eq!(failed.status, RoutineFireStatus::Failed);
        assert_eq!(failed.error.as_deref(), Some("provider unavailable"));
        assert_eq!(failed.session_id.as_deref(), Some("session-1"));
        assert!(failed.completed_at.is_some());
    }

    #[test]
    fn reconciliation_closes_pre_session_terminal_dispatch_fire() {
        use crate::projects::types::{
            EnqueueWorkItemRunRequest, WorkItemRunTarget, WorkItemRunTargetSnapshot,
            WorkItemRunTrigger,
        };
        use crate::work_service::{self, CreateWorkItemRequest};

        let _sandbox = test_env::sandbox();
        upsert_routine(routine_fixture(
            "routine-reconcile-dispatch",
            policy(RoutineConcurrencyPolicy::CoalesceIfActive),
        ))
        .expect("upsert routine");
        let fire = create_routine_fire("routine-reconcile-dispatch").expect("create fire");

        work_service::tests_support::seed_project("demo", "project-1");
        work_service::create_project_work_item(
            "demo",
            "AAA-0001",
            &CreateWorkItemRequest {
                title: "Routine dispatch".to_string(),
                ..Default::default()
            },
            None,
        )
        .expect("seed work item");
        mark_routine_fire_work_item_started(&fire.id, "AAA-0001", None)
            .expect("link fire before dispatch");

        crate::work_run_service::enqueue(EnqueueWorkItemRunRequest {
            project_slug: Some("demo".to_string()),
            org_id: "personal-org".to_string(),
            work_item_id: "AAA-0001".to_string(),
            trigger: WorkItemRunTrigger::Routine {
                routine_id: "routine-reconcile-dispatch".to_string(),
                fire_id: fire.id.clone(),
            },
            target_snapshot: WorkItemRunTargetSnapshot::new(WorkItemRunTarget::StartWorkItem {
                account_id: Some("account-1".to_string()),
                model_id: Some("model-1".to_string()),
            }),
            input: serde_json::json!({"prompt": "run"}),
            idempotency_key: format!("routine-fire:{}", fire.id),
            max_attempts: 3,
            parent_run_id: None,
        })
        .expect("enqueue run");
        let lease = crate::work_run_service::claim_next_dispatch("desktop-test", 30_000)
            .expect("claim")
            .expect("lease");
        crate::work_run_service::record_dispatch_failure(
            &lease.dispatch_id,
            &lease.lease_token,
            "Unauthorized: invalid API key (status 401)",
        )
        .expect("terminalize dispatch");

        let recovered = reconcile_terminal_dispatch_fires().expect("reconcile");
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].id, fire.id);
        assert_eq!(recovered[0].status, RoutineFireStatus::Failed);
        assert!(recovered[0].session_id.is_none());
        assert!(recovered[0]
            .error
            .as_deref()
            .is_some_and(|error| error.contains("Unauthorized")));
        assert!(reconcile_terminal_dispatch_fires()
            .expect("idempotent reconcile")
            .is_empty());
    }

    #[test]
    fn reconciliation_follows_retry_ancestry_to_close_started_fire() {
        use crate::projects::types::{
            EnqueueWorkItemRunRequest, WorkItemRunTarget, WorkItemRunTargetSnapshot,
            WorkItemRunTrigger, WorkItemRunUsage,
        };
        use crate::work_run_service::WorkItemRunTerminalOutcome;
        use crate::work_service::{self, CreateWorkItemRequest};

        let _sandbox = test_env::sandbox();
        upsert_routine(routine_fixture(
            "routine-reconcile-retry",
            policy(RoutineConcurrencyPolicy::CoalesceIfActive),
        ))
        .expect("upsert routine");
        let fire = create_routine_fire("routine-reconcile-retry").expect("create fire");
        work_service::tests_support::seed_project("demo", "project-1");
        work_service::create_project_work_item(
            "demo",
            "AAA-0001",
            &CreateWorkItemRequest {
                title: "Routine retry dispatch".to_string(),
                ..Default::default()
            },
            None,
        )
        .expect("seed work item");

        let first = crate::work_run_service::enqueue(EnqueueWorkItemRunRequest {
            project_slug: Some("demo".to_string()),
            org_id: "personal-org".to_string(),
            work_item_id: "AAA-0001".to_string(),
            trigger: WorkItemRunTrigger::Routine {
                routine_id: "routine-reconcile-retry".to_string(),
                fire_id: fire.id.clone(),
            },
            target_snapshot: WorkItemRunTargetSnapshot::new(WorkItemRunTarget::StartWorkItem {
                account_id: Some("account-1".to_string()),
                model_id: Some("model-1".to_string()),
            }),
            input: serde_json::json!({"prompt": "run"}),
            idempotency_key: format!("routine-fire:{}", fire.id),
            max_attempts: 3,
            parent_run_id: None,
        })
        .expect("enqueue first run");
        let first_lease = crate::work_run_service::claim_next_dispatch("desktop-test", 30_000)
            .expect("claim first")
            .expect("first lease");
        crate::work_run_service::acknowledge_dispatch_started(
            &first_lease.dispatch_id,
            &first_lease.lease_token,
            "session-retry",
        )
        .expect("ack first");
        mark_routine_fire_work_item_started(&fire.id, "AAA-0001", Some("session-retry"))
            .expect("link started fire");
        crate::work_run_service::record_run_terminal(
            &first.id,
            Some("session-retry"),
            WorkItemRunTerminalOutcome::Failed,
            WorkItemRunUsage::default(),
            Some("request timed out"),
        )
        .expect("fail first run");

        let retry = crate::work_run_service::retry(&first.id, "retry:fire-reconcile")
            .expect("enqueue retry");
        let retry_lease = crate::work_run_service::claim_next_dispatch("desktop-test", 30_000)
            .expect("claim retry")
            .expect("retry lease");
        assert_eq!(retry_lease.run.id, retry.id);
        crate::work_run_service::record_dispatch_failure(
            &retry_lease.dispatch_id,
            &retry_lease.lease_token,
            "invalid input while resuming Session",
        )
        .expect("fail retry dispatch");

        let recovered = reconcile_terminal_dispatch_fires().expect("reconcile retry ancestry");
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].id, fire.id);
        assert_eq!(recovered[0].status, RoutineFireStatus::Failed);
        assert_eq!(recovered[0].session_id.as_deref(), Some("session-retry"));
        assert!(recovered[0]
            .error
            .as_deref()
            .is_some_and(|error| error.contains("invalid input")));
    }

    #[test]
    fn mark_work_item_created_links_fire_without_session() {
        let _sandbox = test_env::sandbox();
        upsert_routine(routine_fixture(
            "routine-work-item-link",
            policy(RoutineConcurrencyPolicy::CoalesceIfActive),
        ))
        .expect("upsert routine");
        let fire = create_routine_fire("routine-work-item-link").expect("create fire");

        let linked = mark_routine_fire_work_item_created(&fire.id, "AAA-0001")
            .expect("mark work item created");
        assert_eq!(linked.status, RoutineFireStatus::Succeeded);
        assert_eq!(linked.work_item_id.as_deref(), Some("AAA-0001"));
        assert!(linked.session_id.is_none());
        assert!(linked.agent_org_run_id.is_none());
        assert!(linked.started_at.is_some());
        assert!(linked.completed_at.is_some());
        assert!(linked.error.is_none());
    }

    #[test]
    fn idempotency_key_dedupes_fires() {
        let _sandbox = test_env::sandbox();
        upsert_routine(routine_fixture(
            "routine-idem",
            policy(RoutineConcurrencyPolicy::AlwaysCreate),
        ))
        .expect("upsert routine");

        let first = create_routine_fire_for_policy_with_key(
            "routine-idem",
            &policy(RoutineConcurrencyPolicy::AlwaysCreate),
            Some("routine-idem:2026-06-10T09:00:00Z"),
        )
        .expect("first fire");
        let second = create_routine_fire_for_policy_with_key(
            "routine-idem",
            &policy(RoutineConcurrencyPolicy::AlwaysCreate),
            Some("routine-idem:2026-06-10T09:00:00Z"),
        )
        .expect("second fire");

        assert_eq!(first.id, second.id, "same key must return the same fire");
        assert_eq!(
            second.idempotency_key.as_deref(),
            Some("routine-idem:2026-06-10T09:00:00Z")
        );
    }

    #[test]
    fn mark_succeeded_completes_started_fire() {
        let _sandbox = test_env::sandbox();
        upsert_routine(routine_fixture(
            "routine-succeed",
            policy(RoutineConcurrencyPolicy::CoalesceIfActive),
        ))
        .expect("upsert routine");
        let fire = create_routine_fire("routine-succeed").expect("create fire");
        mark_routine_fire_started(&fire.id, "session-9", None).expect("mark started");

        let succeeded = mark_routine_fire_succeeded(&fire.id).expect("mark succeeded");
        assert_eq!(succeeded.status, RoutineFireStatus::Succeeded);
        assert!(succeeded.completed_at.is_some());
        assert!(succeeded.error.is_none());
    }

    #[test]
    fn find_started_fire_by_session_matches_only_active() {
        let _sandbox = test_env::sandbox();
        upsert_routine(routine_fixture(
            "routine-find",
            policy(RoutineConcurrencyPolicy::CoalesceIfActive),
        ))
        .expect("upsert routine");
        let fire = create_routine_fire("routine-find").expect("create fire");
        mark_routine_fire_started(&fire.id, "session-find", None).expect("mark started");

        let found = find_started_fire_by_session("session-find")
            .expect("query")
            .expect("fire found");
        assert_eq!(found.id, fire.id);

        mark_routine_fire_succeeded(&fire.id).expect("mark succeeded");
        assert!(find_started_fire_by_session("session-find")
            .expect("query")
            .is_none());
    }

    #[test]
    fn take_next_queued_fire_promotes_oldest_when_idle() {
        let _sandbox = test_env::sandbox();
        upsert_routine(routine_fixture(
            "routine-dequeue",
            policy(RoutineConcurrencyPolicy::QueueIfActive),
        ))
        .expect("upsert routine");

        let active = create_routine_fire_for_policy(
            "routine-dequeue",
            &policy(RoutineConcurrencyPolicy::QueueIfActive),
        )
        .expect("active fire");
        let queued = create_routine_fire_for_policy(
            "routine-dequeue",
            &policy(RoutineConcurrencyPolicy::QueueIfActive),
        )
        .expect("queued fire");
        assert_eq!(queued.status, RoutineFireStatus::Queued);

        // Active fire still pending → nothing to dequeue.
        assert!(take_next_queued_fire("routine-dequeue")
            .expect("dequeue")
            .is_none());

        mark_routine_fire_failed(&active.id, "boom").expect("fail active");

        let promoted = take_next_queued_fire("routine-dequeue")
            .expect("dequeue")
            .expect("queued fire promoted");
        assert_eq!(promoted.id, queued.id);
        assert_eq!(promoted.status, RoutineFireStatus::Pending);

        // Promotion is one-shot.
        assert!(take_next_queued_fire("routine-dequeue")
            .expect("dequeue")
            .is_none());
    }

    #[test]
    fn schedule_marks_round_trip_without_touching_updated_at() {
        let _sandbox = test_env::sandbox();
        let saved = upsert_routine(routine_fixture(
            "routine-marks",
            policy(RoutineConcurrencyPolicy::CoalesceIfActive),
        ))
        .expect("upsert routine");

        update_routine_schedule_marks("routine-marks", 1_750_000_000_000, Some(1_750_000_060_000))
            .expect("update marks");

        let read = read_routine("routine-marks").expect("read routine");
        assert!(read.last_evaluated_at.is_some());
        assert!(read.next_fire_at.is_some());
        assert_eq!(read.updated_at, saved.updated_at);
    }

    #[test]
    fn unknown_fire_status_is_a_decode_error() {
        let _sandbox = test_env::sandbox();
        upsert_routine(routine_fixture(
            "routine-bad-status",
            policy(RoutineConcurrencyPolicy::CoalesceIfActive),
        ))
        .expect("upsert routine");
        let connection = conn().expect("conn");
        connection
            .execute(
                "INSERT INTO routine_fires (
                    id, routine_id, fired_at, status, session_id, agent_org_run_id,
                    work_item_id, coalesced_into_fire_id, idempotency_key, started_at,
                    completed_at, error
                 ) VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)",
                params!["bad-fire", "routine-bad-status", now_ms(), "mystery"],
            )
            .expect("insert bad fire");

        let error = list_routine_fires("routine-bad-status").expect_err("decode should fail");
        assert!(
            error.contains("unknown routine fire status"),
            "unexpected error: {error}"
        );
    }
}
