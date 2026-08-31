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
#[path = "routines_tests.rs"]
mod tests;
