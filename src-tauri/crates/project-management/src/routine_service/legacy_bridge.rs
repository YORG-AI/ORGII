//! Adapter from the editable Routine definition to the portable execution projection.
//!
//! `routine_definitions` is the sole editable source. `pm_routines` is a
//! rebuildable execution projection consumed by the portable scheduler, CLI,
//! and webhook paths. The existing `routine_id` column is the stable join key;
//! display-name changes never require a second binding table or history moves.

use std::collections::BTreeMap;

use rusqlite::{params, OptionalExtension, TransactionBehavior};

use crate::projects::io;
use crate::projects::types::{
    RoutineConcurrencyPolicy, RoutineDefinition, RoutineFire, RoutineFireResult, RoutineFireStatus,
};

use super::convert::{self, ConvertedRoutine};
use super::{RoutineActivationOutcome, RoutineInvocationTarget};

fn to_iso8601(epoch_ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(epoch_ms)
        .unwrap_or(chrono::DateTime::<chrono::Utc>::UNIX_EPOCH)
        .to_rfc3339()
}

fn portable_name_in(
    connection: &rusqlite::Connection,
    routine_id: &str,
) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT name FROM pm_routines WHERE routine_id = ?1",
            params![routine_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("routine projection lookup: {err}"))
}

pub fn portable_name(routine_id: &str) -> Result<Option<String>, String> {
    let connection = io::helpers::conn()?;
    portable_name_in(&connection, routine_id)
}

fn collision_free_name_in(
    connection: &rusqlite::Connection,
    candidate: &str,
    routine_id: &str,
) -> Result<String, String> {
    let owner: Option<String> = connection
        .query_row(
            "SELECT routine_id FROM pm_routines WHERE name = ?1",
            params![candidate],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("routine projection name lookup: {err}"))?;
    if owner.as_deref().is_none_or(|owner| owner == routine_id) {
        return Ok(candidate.to_string());
    }
    let suffix: String = routine_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect();
    Ok(format!(
        "{candidate}-{}",
        if suffix.is_empty() {
            "routine"
        } else {
            &suffix
        }
    ))
}

/// Rebuild one portable execution projection from its editable definition.
///
/// Existing rows keep their portable name so a display-name edit cannot
/// rewrite run/webhook history. Startup reconciliation calls this for every
/// definition, making a crash between the source write and this projection
/// update self-healing without introducing a second source of truth.
pub fn sync_definition(definition: &RoutineDefinition) -> Result<ConvertedRoutine, String> {
    let mut connection = io::helpers::conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("routine projection sync tx: {err}"))?;
    let converted = sync_definition_in(&tx, definition)?;
    tx.commit()
        .map_err(|err| format!("routine projection sync commit: {err}"))?;
    Ok(converted)
}

fn sync_definition_in(
    tx: &rusqlite::Transaction<'_>,
    definition: &RoutineDefinition,
) -> Result<ConvertedRoutine, String> {
    let (mut file, warnings) = convert::convert_definition(definition)?;
    if let Some(existing_name) = portable_name_in(tx, &definition.id)? {
        file.metadata.name = existing_name;
    } else {
        file.metadata.name = collision_free_name_in(tx, &file.metadata.name, &definition.id)?;
    }
    let target = convert::invocation_target(definition)?;
    let applied = super::apply_in_transaction(tx, &file)?;
    let next_fire_at = if definition.enabled {
        super::next_activation_at(&file, &chrono::Utc::now())?
    } else {
        None
    };
    tx.execute(
        "UPDATE pm_routines
                SET enabled = ?2, default_scope = ?3, next_fire_at = ?4,
                    updated_at = ?5
              WHERE name = ?1",
        params![
            applied.name,
            i64::from(definition.enabled),
            target.to_binding(),
            next_fire_at,
            chrono::Utc::now().timestamp_millis(),
        ],
    )
    .map_err(|err| format!("routine projection update: {err}"))?;

    Ok(ConvertedRoutine {
        legacy_id: definition.id.clone(),
        name: applied.name,
        revision: applied.revision,
        warnings,
    })
}

/// Persist the editable definition and rebuild its scheduler projection in one
/// transaction. No enabled source row or stale portable row can escape when
/// conversion, audit persistence, or commit fails.
pub fn upsert_definition(routine: RoutineDefinition) -> Result<RoutineDefinition, String> {
    let mut connection = io::helpers::conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("routine definition upsert tx: {err}"))?;
    let saved = io::upsert_routine_in(&tx, routine)?;
    sync_definition_in(&tx, &saved)?;
    tx.commit()
        .map_err(|err| format!("routine definition upsert commit: {err}"))?;
    notify_definition_changed(&saved.id, "updated");
    Ok(saved)
}

/// The Routines surface refreshes off this event, so every committed
/// definition mutation announces itself no matter which caller made it.
fn notify_definition_changed(routine_id: &str, status: &str) {
    crate::projects::events::notify_routine_changed(
        crate::projects::events::RoutineChangedEvent {
            routine_id: routine_id.to_string(),
            fire_id: None,
            status: status.to_string(),
        },
    );
}

pub fn delete_definition(routine_id: &str) -> Result<bool, String> {
    let mut connection = io::helpers::conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("routine definition delete tx: {err}"))?;
    let name = portable_name_in(&tx, routine_id)?;
    let removed = io::delete_routine_in(&tx, routine_id)?;
    let Some(name) = name else {
        tx.commit()
            .map_err(|err| format!("routine definition delete commit: {err}"))?;
        notify_definition_changed(routine_id, "deleted");
        return Ok(removed);
    };
    let now = chrono::Utc::now().timestamp_millis();
    tx.execute(
        "UPDATE pm_routine_activation_events
            SET status = 'skipped', error = 'Routine deleted', updated_at = ?2
          WHERE routine_name = ?1 AND status = 'queued'",
        params![name, now],
    )
    .map_err(|err| format!("routine projection cancel queue: {err}"))?;
    tx.execute(
        "DELETE FROM pm_routine_webhooks WHERE routine_name = ?1",
        params![name],
    )
    .map_err(|err| format!("routine projection delete webhook: {err}"))?;
    tx.execute(
        "DELETE FROM pm_routine_activation_guards WHERE routine_name = ?1",
        params![name],
    )
    .map_err(|err| format!("routine projection delete activation guard: {err}"))?;
    tx.execute("DELETE FROM pm_routines WHERE name = ?1", params![name])
        .map_err(|err| format!("routine projection delete: {err}"))?;
    tx.commit()
        .map_err(|err| format!("routine projection delete commit: {err}"))?;
    notify_definition_changed(routine_id, "deleted");
    Ok(removed)
}

pub fn disable_one_time(name: &str) -> Result<(), String> {
    let mut connection = io::helpers::conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("routine one-time disable tx: {err}"))?;
    let now = chrono::Utc::now().timestamp_millis();
    tx.execute(
        "UPDATE pm_routines
                SET enabled = 0, next_fire_at = NULL, updated_at = ?2
              WHERE name = ?1",
        params![name, now],
    )
    .map_err(|err| format!("routine one-time disable projection: {err}"))?;
    tx.execute(
        "UPDATE routine_definitions
                SET enabled = 0, next_fire_at = NULL, updated_at = ?2
              WHERE id = (SELECT routine_id FROM pm_routines WHERE name = ?1)",
        params![name, now],
    )
    .map_err(|err| format!("routine one-time disable definition: {err}"))?;
    tx.commit()
        .map_err(|err| format!("routine one-time disable commit: {err}"))?;
    if let Some(routine_id) = super::routine_id_for_name(name) {
        notify_definition_changed(&routine_id, "updated");
    }
    Ok(())
}

fn target_for_name(name: &str) -> Result<RoutineInvocationTarget, String> {
    let connection = io::helpers::conn()?;
    let binding: Option<String> = connection
        .query_row(
            "SELECT default_scope FROM pm_routines WHERE name = ?1",
            params![name],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("routine projection target: {err}"))?;
    Ok(binding
        .as_deref()
        .map(RoutineInvocationTarget::from_binding)
        .transpose()?
        .unwrap_or_else(|| RoutineInvocationTarget::standalone(None)))
}

fn event_fire_status(status: &str) -> Option<RoutineFireStatus> {
    match status {
        "queued" => Some(RoutineFireStatus::Queued),
        "skipped" => Some(RoutineFireStatus::Skipped),
        "coalesced" => Some(RoutineFireStatus::Coalesced),
        "failed" => Some(RoutineFireStatus::Failed),
        _ => None,
    }
}

pub fn list_fires(routine_id: &str) -> Result<Vec<RoutineFire>, String> {
    let mut fires = io::list_routine_fires(routine_id)?;
    let Some(name) = portable_name(routine_id)? else {
        return Ok(fires);
    };
    let connection = io::helpers::conn()?;
    let mut statement = connection
        .prepare(
            "SELECT id, created_at, status, root_work_item_id, updated_at
               FROM pm_routine_runs WHERE routine_name = ?1
              ORDER BY created_at DESC LIMIT 100",
        )
        .map_err(|err| format!("routine history runs: {err}"))?;
    let runs = statement
        .query_map(params![name], |row| {
            let status: String = row.get(2)?;
            let (status, error) = match status.as_str() {
                "pending" => (RoutineFireStatus::Pending, None),
                "running" => (RoutineFireStatus::Started, None),
                "succeeded" => (RoutineFireStatus::Succeeded, None),
                "cancelled" => (
                    RoutineFireStatus::Failed,
                    Some("Routine run cancelled".to_string()),
                ),
                _ => (RoutineFireStatus::Failed, None),
            };
            let created_at: i64 = row.get(1)?;
            let updated_at: i64 = row.get(4)?;
            Ok(RoutineFire {
                id: row.get(0)?,
                routine_id: routine_id.to_string(),
                fired_at: to_iso8601(created_at),
                status: status.clone(),
                session_id: None,
                agent_org_run_id: None,
                work_item_id: row.get(3)?,
                coalesced_into_fire_id: None,
                idempotency_key: None,
                started_at: (status != RoutineFireStatus::Pending).then(|| to_iso8601(created_at)),
                completed_at: matches!(
                    status,
                    RoutineFireStatus::Succeeded | RoutineFireStatus::Failed
                )
                .then(|| to_iso8601(updated_at)),
                error,
            })
        })
        .map_err(|err| format!("routine history runs: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("routine history runs: {err}"))?;
    fires.extend(runs);
    drop(statement);

    let mut statement = connection
        .prepare(
            "SELECT id, created_at, status, coalesced_run_id, error, invoke_key, updated_at
               FROM pm_routine_activation_events
              WHERE routine_name = ?1 AND status != 'dispatched'
              ORDER BY created_at DESC LIMIT 100",
        )
        .map_err(|err| format!("routine history activations: {err}"))?;
    let events = statement
        .query_map(params![name], |row| {
            let raw_status: String = row.get(2)?;
            let Some(status) = event_fire_status(&raw_status) else {
                return Ok(None);
            };
            let created_at: i64 = row.get(1)?;
            let updated_at: i64 = row.get(6)?;
            Ok(Some(RoutineFire {
                id: row.get(0)?,
                routine_id: routine_id.to_string(),
                fired_at: to_iso8601(created_at),
                status: status.clone(),
                session_id: None,
                agent_org_run_id: None,
                work_item_id: None,
                coalesced_into_fire_id: row.get(3)?,
                idempotency_key: row.get(5)?,
                started_at: None,
                completed_at: (status != RoutineFireStatus::Queued).then(|| to_iso8601(updated_at)),
                error: row.get(4)?,
            }))
        })
        .map_err(|err| format!("routine history activations: {err}"))?
        .filter_map(|row| row.transpose())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("routine history activations: {err}"))?;
    fires.extend(events);
    fires.sort_by(|left, right| right.fired_at.cmp(&left.fired_at));
    fires.truncate(100);
    Ok(fires)
}

pub fn overlay_definition(mut definition: RoutineDefinition) -> Result<RoutineDefinition, String> {
    let Some(name) = portable_name(&definition.id)? else {
        return Ok(definition);
    };
    let connection = io::helpers::conn()?;
    if let Some((enabled, next_fire_at)) = connection
        .query_row(
            "SELECT enabled, next_fire_at FROM pm_routines WHERE name = ?1",
            params![name],
            |row| Ok((row.get::<_, i64>(0)? != 0, row.get::<_, Option<i64>>(1)?)),
        )
        .optional()
        .map_err(|err| format!("routine projection overlay: {err}"))?
    {
        definition.enabled = enabled;
        definition.next_fire_at = next_fire_at.map(to_iso8601);
    }
    if let Some(latest) = list_fires(&definition.id)?.into_iter().next() {
        definition.last_fire_at = Some(latest.fired_at);
        definition.last_fire_status = Some(latest.status);
        definition.last_fire_error = latest.error;
        definition.last_fire_session_id = latest.session_id;
        definition.last_fire_work_item_id = latest.work_item_id;
    }
    Ok(definition)
}

fn portable_policy(policy: &RoutineConcurrencyPolicy) -> super::spec::ConcurrencyPolicy {
    match policy {
        RoutineConcurrencyPolicy::CoalesceIfActive => super::spec::ConcurrencyPolicy::Coalesce,
        RoutineConcurrencyPolicy::SkipIfActive => super::spec::ConcurrencyPolicy::Skip,
        RoutineConcurrencyPolicy::QueueIfActive => super::spec::ConcurrencyPolicy::Queue,
        RoutineConcurrencyPolicy::AlwaysCreate => super::spec::ConcurrencyPolicy::Always,
    }
}

pub fn fire(routine_id: &str) -> Result<RoutineFireResult, String> {
    let definition = io::read_routine(routine_id)?;
    if !definition.enabled {
        return Err(format!("Routine is disabled: {routine_id}"));
    }
    let name = portable_name(routine_id)?
        .ok_or_else(|| format!("Routine execution projection not found: {routine_id}"))?;
    let target = target_for_name(&name)?;
    let invoke_key = format!("manual:{}", uuid::Uuid::new_v4().simple());
    let fired_at_ms = chrono::Utc::now().timestamp_millis();
    let outcome = super::request_activation(
        &name,
        &target,
        &BTreeMap::new(),
        &invoke_key,
        portable_policy(&definition.output_policy.concurrency_policy),
        fired_at_ms,
    )?;
    let fire = match outcome {
        RoutineActivationOutcome::Invoked(run) => RoutineFire {
            id: run.run_id,
            routine_id: routine_id.to_string(),
            fired_at: to_iso8601(fired_at_ms),
            status: RoutineFireStatus::Started,
            session_id: None,
            agent_org_run_id: None,
            work_item_id: Some(run.root_short_id),
            coalesced_into_fire_id: None,
            idempotency_key: Some(invoke_key),
            started_at: Some(to_iso8601(fired_at_ms)),
            completed_at: None,
            error: None,
        },
        RoutineActivationOutcome::Deferred(event) => RoutineFire {
            id: event.id,
            routine_id: routine_id.to_string(),
            fired_at: to_iso8601(event.created_at),
            status: event_fire_status(&event.status).unwrap_or(RoutineFireStatus::Failed),
            session_id: None,
            agent_org_run_id: None,
            work_item_id: None,
            coalesced_into_fire_id: event.coalesced_run_id,
            idempotency_key: Some(event.invoke_key),
            started_at: None,
            completed_at: (event.status != "queued").then(|| to_iso8601(event.updated_at)),
            error: event.error,
        },
    };
    Ok(RoutineFireResult {
        fire,
        session_id: None,
        agent_org_run_id: None,
    })
}
