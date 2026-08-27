use crate::projects::io as project_io;

use super::error;

/// Outcome of an idempotency-guarded operation.
pub enum IdempotencyOutcome {
    /// The operation executed now.
    Fresh(serde_json::Value),
    /// The stored response for the same canonical request was replayed.
    Replayed(serde_json::Value),
}

/// Idempotency guard over `(actor, operation, scope, key)` per the frozen
/// wire contract §14.4.
pub fn run_idempotent(
    actor_id: &str,
    operation: &str,
    scope_id: &str,
    key: &str,
    canonical_request: &serde_json::Value,
    execute: impl FnOnce() -> Result<serde_json::Value, String>,
) -> Result<IdempotencyOutcome, String> {
    const TAKEOVER_AFTER_MS: i64 = 30_000;
    const WAIT_STEP_MS: u64 = 100;
    const WAIT_BUDGET_STEPS: u32 = 20;

    let canonical =
        serde_json::to_string(canonical_request).map_err(|err| format!("canonicalize: {err}"))?;
    let mut connection = project_io::helpers::conn()?;

    let mut waited: u32 = 0;
    loop {
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| format!("pm idempotency tx: {err}"))?;
        let existing: Option<(String, Option<String>, i64)> = tx
            .query_row(
                "SELECT request_hash, response_json, created_at FROM pm_idempotency
                 WHERE actor_id = ?1 AND operation = ?2 AND scope_id = ?3 AND idem_key = ?4",
                rusqlite::params![actor_id, operation, scope_id, key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map(Some)
            .or_else(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(format!("pm idempotency: {other}")),
            })?;

        match existing {
            Some((stored_request, _, _)) if stored_request != canonical => {
                return Err(format!(
                    "{}:{}:{}",
                    error::IDEMPOTENCY_CONFLICT,
                    operation,
                    key
                ));
            }
            Some((_, Some(stored_response), _)) => {
                let response =
                    serde_json::from_str(&stored_response).unwrap_or(serde_json::Value::Null);
                return Ok(IdempotencyOutcome::Replayed(response));
            }
            Some((_, None, reserved_at)) => {
                let age = chrono::Utc::now().timestamp_millis() - reserved_at;
                if age < TAKEOVER_AFTER_MS {
                    drop(tx);
                    if waited >= WAIT_BUDGET_STEPS {
                        return Err(format!(
                            "{}:{}:{}:in_progress",
                            error::IDEMPOTENCY_CONFLICT,
                            operation,
                            key
                        ));
                    }
                    waited += 1;
                    std::thread::sleep(std::time::Duration::from_millis(WAIT_STEP_MS));
                    continue;
                }
                tx.execute(
                    "UPDATE pm_idempotency SET created_at = ?5
                     WHERE actor_id = ?1 AND operation = ?2 AND scope_id = ?3 AND idem_key = ?4",
                    rusqlite::params![
                        actor_id,
                        operation,
                        scope_id,
                        key,
                        chrono::Utc::now().timestamp_millis(),
                    ],
                )
                .map_err(|err| format!("pm idempotency takeover: {err}"))?;
                tx.commit()
                    .map_err(|err| format!("pm idempotency takeover commit: {err}"))?;
                break;
            }
            None => {
                tx.execute(
                    "INSERT INTO pm_idempotency
                        (actor_id, operation, scope_id, idem_key, request_hash, response_json, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)",
                    rusqlite::params![
                        actor_id,
                        operation,
                        scope_id,
                        key,
                        canonical,
                        chrono::Utc::now().timestamp_millis(),
                    ],
                )
                .map_err(|err| format!("pm idempotency reserve: {err}"))?;
                tx.commit()
                    .map_err(|err| format!("pm idempotency reserve commit: {err}"))?;
                break;
            }
        }
    }

    match execute() {
        Ok(response) => {
            let response_raw = serde_json::to_string(&response)
                .map_err(|err| format!("serialize response: {err}"))?;
            connection
                .execute(
                    "UPDATE pm_idempotency SET response_json = ?5
                     WHERE actor_id = ?1 AND operation = ?2 AND scope_id = ?3 AND idem_key = ?4",
                    rusqlite::params![actor_id, operation, scope_id, key, response_raw],
                )
                .map_err(|err| format!("pm idempotency record: {err}"))?;
            Ok(IdempotencyOutcome::Fresh(response))
        }
        Err(err) => {
            let _ = connection.execute(
                "DELETE FROM pm_idempotency
                 WHERE actor_id = ?1 AND operation = ?2 AND scope_id = ?3 AND idem_key = ?4
                   AND response_json IS NULL",
                rusqlite::params![actor_id, operation, scope_id, key],
            );
            Err(err)
        }
    }
}
