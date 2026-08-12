use std::collections::BTreeMap;

use axum::body::Bytes;
use axum::extract::Path;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use rand::RngCore;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use super::store::iso8601;
use super::{RoutineWebhookDelivery, RoutineWebhookInstallInfo, RoutineWebhookStatus};
use crate::projects::io::helpers::{conn, now_ms};
use crate::routine_service::spec::{Activation, RoutineSpecFile};

pub const ROUTINE_WEBHOOK_BASE_PATH: &str = "/routine/webhook";
const MAX_PAYLOAD_BYTES: usize = 256 * 1024;
const FAILURE_PAUSE_THRESHOLD: i64 = 5;

fn secret_hash(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}

fn mint_secret() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn secret_hint(secret: &str) -> String {
    let prefix = secret.chars().take(4).collect::<String>();
    let suffix = secret
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{prefix}…{suffix}")
}

fn routine_has_provider_activation(spec: &RoutineSpecFile) -> bool {
    spec.spec
        .activations
        .iter()
        .any(|activation| matches!(activation, Activation::ProviderEvent { .. }))
}

pub fn install(routine_name: &str) -> Result<RoutineWebhookInstallInfo, String> {
    let connection = conn()?;
    let spec_json: String = connection
        .query_row(
            "SELECT spec_json FROM pm_routines WHERE name = ?1",
            params![routine_name],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("routine webhook store: {err}"))?
        .ok_or_else(|| format!("Routine '{routine_name}' not found"))?;
    let spec: RoutineSpecFile = serde_json::from_str(&spec_json)
        .map_err(|err| format!("Routine '{routine_name}' has an invalid snapshot: {err}"))?;
    if !routine_has_provider_activation(&spec) {
        return Err(format!(
            "Routine '{routine_name}' has no provider_event activation"
        ));
    }
    let secret = mint_secret();
    let hint = secret_hint(&secret);
    let now = now_ms();
    connection
        .execute(
            "INSERT INTO pm_routine_webhooks (
                 routine_name, secret_hash, secret_hint, enabled,
                 consecutive_failures, paused_at, created_at, updated_at
             ) VALUES (?1, ?2, ?3, 1, 0, NULL, ?4, ?4)
             ON CONFLICT(routine_name) DO UPDATE SET
                 secret_hash = excluded.secret_hash,
                 secret_hint = excluded.secret_hint,
                 enabled = 1,
                 consecutive_failures = 0,
                 paused_at = NULL,
                 updated_at = excluded.updated_at",
            params![routine_name, secret_hash(&secret), hint, now],
        )
        .map_err(|err| format!("routine webhook store: {err}"))?;
    Ok(RoutineWebhookInstallInfo {
        routine_name: routine_name.to_string(),
        url_path: format!("{ROUTINE_WEBHOOK_BASE_PATH}/{routine_name}"),
        secret,
        secret_hint: hint,
        rotated_at: iso8601(now),
    })
}

pub fn status(routine_name: &str) -> Result<RoutineWebhookStatus, String> {
    let connection = conn()?;
    let row: Option<(i64, String, i64, Option<i64>)> = connection
        .query_row(
            "SELECT enabled, secret_hint, consecutive_failures, paused_at
               FROM pm_routine_webhooks WHERE routine_name = ?1",
            params![routine_name],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|err| format!("routine webhook store: {err}"))?;
    Ok(match row {
        Some((enabled, hint, failures, paused_at)) => RoutineWebhookStatus {
            routine_name: routine_name.to_string(),
            installed: true,
            enabled: enabled != 0 && paused_at.is_none(),
            secret_hint: Some(hint),
            consecutive_failures: failures.max(0) as u32,
            paused_at: paused_at.map(iso8601),
        },
        None => RoutineWebhookStatus {
            routine_name: routine_name.to_string(),
            installed: false,
            enabled: false,
            secret_hint: None,
            consecutive_failures: 0,
            paused_at: None,
        },
    })
}

pub fn set_enabled(routine_name: &str, enabled: bool) -> Result<RoutineWebhookStatus, String> {
    let connection = conn()?;
    let changed = connection
        .execute(
            "UPDATE pm_routine_webhooks
                SET enabled = ?2,
                    paused_at = CASE WHEN ?2 = 1 THEN NULL ELSE paused_at END,
                    consecutive_failures = CASE WHEN ?2 = 1 THEN 0 ELSE consecutive_failures END,
                    updated_at = ?3
              WHERE routine_name = ?1",
            params![routine_name, i64::from(enabled), now_ms()],
        )
        .map_err(|err| format!("routine webhook store: {err}"))?;
    if changed != 1 {
        return Err(format!("Routine webhook '{routine_name}' is not installed"));
    }
    status(routine_name)
}

fn json_subset(filter: &serde_json::Value, payload: &serde_json::Value) -> bool {
    match filter {
        serde_json::Value::Object(expected) => payload.as_object().is_some_and(|actual| {
            expected.iter().all(|(key, value)| {
                actual
                    .get(key)
                    .is_some_and(|found| json_subset(value, found))
            })
        }),
        serde_json::Value::Array(expected) => payload.as_array().is_some_and(|actual| {
            expected
                .iter()
                .all(|value| actual.iter().any(|found| json_subset(value, found)))
        }),
        other => other == payload,
    }
}

fn scalar_inputs(payload: &serde_json::Value) -> BTreeMap<String, String> {
    payload
        .get("inputs")
        .and_then(serde_json::Value::as_object)
        .map(|inputs| {
            inputs
                .iter()
                .filter_map(|(key, value)| {
                    let rendered = match value {
                        serde_json::Value::String(value) => value.clone(),
                        serde_json::Value::Number(value) => value.to_string(),
                        serde_json::Value::Bool(value) => value.to_string(),
                        _ => return None,
                    };
                    Some((key.clone(), rendered))
                })
                .collect()
        })
        .unwrap_or_default()
}

struct DeliveryRecord<'a> {
    routine_name: &'a str,
    provider: &'a str,
    event_kind: &'a str,
    idempotency_key: &'a str,
    payload: &'a serde_json::Value,
    status: &'a str,
    reason: Option<&'a str>,
    routine_run_id: Option<&'a str>,
    now: i64,
}

type WebhookConfigRow = (String, Option<String>, i64, i64, Option<i64>);

fn record_delivery(
    tx: &rusqlite::Transaction<'_>,
    record: DeliveryRecord<'_>,
) -> Result<RoutineWebhookDelivery, String> {
    let DeliveryRecord {
        routine_name,
        provider,
        event_kind,
        idempotency_key,
        payload,
        status,
        reason,
        routine_run_id,
        now,
    } = record;
    let id = format!("rwd_{}", uuid::Uuid::new_v4().simple());
    let payload_json = serde_json::to_string(payload)
        .map_err(|err| format!("routine webhook payload serialization: {err}"))?;
    tx.execute(
        "INSERT INTO pm_routine_webhook_deliveries (
             id, routine_name, provider, event_kind, idempotency_key,
             payload_json, status, reason, routine_run_id, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![
            id,
            routine_name,
            provider,
            event_kind,
            idempotency_key,
            payload_json,
            status,
            reason,
            routine_run_id,
            now
        ],
    )
    .map_err(|err| format!("routine webhook delivery: {err}"))?;
    Ok(RoutineWebhookDelivery {
        id,
        routine_name: routine_name.to_string(),
        provider: provider.to_string(),
        event_kind: event_kind.to_string(),
        idempotency_key: idempotency_key.to_string(),
        status: status.to_string(),
        reason: reason.map(str::to_string),
        routine_run_id: routine_run_id.map(str::to_string),
        created_at: iso8601(now),
        updated_at: iso8601(now),
    })
}

fn ingest_verified(
    routine_name: &str,
    provider: &str,
    event_kind: &str,
    idempotency_key: &str,
    payload: serde_json::Value,
    replay_of: Option<&str>,
) -> Result<RoutineWebhookDelivery, String> {
    if provider.trim().is_empty()
        || event_kind.trim().is_empty()
        || idempotency_key.trim().is_empty()
    {
        return Err("provider, event kind, and delivery id are required".to_string());
    }
    let mut connection = conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("routine webhook tx: {err}"))?;
    if replay_of.is_none() {
        let duplicate: Option<String> = tx
            .query_row(
                "SELECT id FROM pm_routine_webhook_deliveries
                  WHERE routine_name = ?1 AND idempotency_key = ?2",
                params![routine_name, idempotency_key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| format!("routine webhook delivery: {err}"))?;
        if let Some(delivery_id) = duplicate {
            tx.commit()
                .map_err(|err| format!("routine webhook commit: {err}"))?;
            return read_delivery(&delivery_id);
        }
    }
    let row: Option<WebhookConfigRow> = tx
        .query_row(
            "SELECT r.spec_json, r.default_scope, r.enabled, w.enabled, w.paused_at
               FROM pm_routines r
               JOIN pm_routine_webhooks w ON w.routine_name = r.name
              WHERE r.name = ?1",
            params![routine_name],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(|err| format!("routine webhook store: {err}"))?;
    let Some((spec_json, default_scope, routine_enabled, webhook_enabled, paused_at)) = row else {
        return Err(format!("Routine webhook '{routine_name}' is not installed"));
    };
    if routine_enabled == 0 || webhook_enabled == 0 || paused_at.is_some() {
        let delivery = record_delivery(
            &tx,
            DeliveryRecord {
                routine_name,
                provider,
                event_kind,
                idempotency_key,
                payload: &payload,
                status: "skipped",
                reason: Some("routine or webhook is disabled"),
                routine_run_id: None,
                now: now_ms(),
            },
        )?;
        tx.commit()
            .map_err(|err| format!("routine webhook commit: {err}"))?;
        return Ok(delivery);
    }
    let spec: RoutineSpecFile = serde_json::from_str(&spec_json)
        .map_err(|err| format!("routine webhook snapshot parse: {err}"))?;
    let activation = spec.spec.activations.iter().find(|activation| {
        matches!(activation, Activation::ProviderEvent {
            provider: expected_provider,
            event_kind: expected_kind,
            filter,
            ..
        } if expected_provider == provider && expected_kind == event_kind
            && filter.as_ref().is_none_or(|expected| json_subset(expected, &payload)))
    });
    let now = now_ms();
    if activation.is_none() {
        let delivery = record_delivery(
            &tx,
            DeliveryRecord {
                routine_name,
                provider,
                event_kind,
                idempotency_key,
                payload: &payload,
                status: "ignored",
                reason: Some("event did not match a provider activation or filter"),
                routine_run_id: None,
                now,
            },
        )?;
        tx.commit()
            .map_err(|err| format!("routine webhook commit: {err}"))?;
        return Ok(delivery);
    }
    let Some(scope) = default_scope else {
        let delivery = record_delivery(
            &tx,
            DeliveryRecord {
                routine_name,
                provider,
                event_kind,
                idempotency_key,
                payload: &payload,
                status: "rejected",
                reason: Some("routine has no default project scope"),
                routine_run_id: None,
                now,
            },
        )?;
        tx.commit()
            .map_err(|err| format!("routine webhook commit: {err}"))?;
        return Ok(delivery);
    };
    tx.commit()
        .map_err(|err| format!("routine webhook pre-invoke commit: {err}"))?;

    let invoke_key = replay_of
        .map(|delivery_id| format!("webhook-replay:{delivery_id}:{idempotency_key}"))
        .unwrap_or_else(|| format!("webhook:{provider}:{idempotency_key}"));
    match crate::routine_service::invoke(
        routine_name,
        &scope,
        &scalar_inputs(&payload),
        None,
        Some(&invoke_key),
    ) {
        Ok(run) => {
            let mut connection = conn()?;
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|err| format!("routine webhook result tx: {err}"))?;
            let replay_reason = replay_of.map(|id| format!("replay of {id}"));
            let delivery = record_delivery(
                &tx,
                DeliveryRecord {
                    routine_name,
                    provider,
                    event_kind,
                    idempotency_key,
                    payload: &payload,
                    status: "accepted",
                    reason: replay_reason.as_deref(),
                    routine_run_id: Some(&run.run_id),
                    now: now_ms(),
                },
            )?;
            tx.execute(
                "UPDATE pm_routine_webhooks
                    SET consecutive_failures = 0, updated_at = ?2
                  WHERE routine_name = ?1",
                params![routine_name, now_ms()],
            )
            .map_err(|err| format!("routine webhook store: {err}"))?;
            tx.commit()
                .map_err(|err| format!("routine webhook result commit: {err}"))?;
            Ok(delivery)
        }
        Err(error) => {
            let mut connection = conn()?;
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|err| format!("routine webhook failure tx: {err}"))?;
            let failures: i64 = tx
                .query_row(
                    "SELECT consecutive_failures + 1 FROM pm_routine_webhooks
                      WHERE routine_name = ?1",
                    params![routine_name],
                    |row| row.get(0),
                )
                .map_err(|err| format!("routine webhook store: {err}"))?;
            let failed_at = now_ms();
            tx.execute(
                "UPDATE pm_routine_webhooks
                    SET consecutive_failures = ?2,
                        paused_at = CASE WHEN ?2 >= ?3 THEN ?4 ELSE paused_at END,
                        updated_at = ?4
                  WHERE routine_name = ?1",
                params![routine_name, failures, FAILURE_PAUSE_THRESHOLD, failed_at],
            )
            .map_err(|err| format!("routine webhook store: {err}"))?;
            let delivery = record_delivery(
                &tx,
                DeliveryRecord {
                    routine_name,
                    provider,
                    event_kind,
                    idempotency_key,
                    payload: &payload,
                    status: "failed",
                    reason: Some(&error),
                    routine_run_id: None,
                    now: failed_at,
                },
            )?;
            tx.commit()
                .map_err(|err| format!("routine webhook failure commit: {err}"))?;
            Ok(delivery)
        }
    }
}

fn read_delivery(delivery_id: &str) -> Result<RoutineWebhookDelivery, String> {
    let connection = conn()?;
    connection
        .query_row(
            "SELECT id, routine_name, provider, event_kind, idempotency_key,
                    status, reason, routine_run_id, created_at, updated_at
               FROM pm_routine_webhook_deliveries WHERE id = ?1",
            params![delivery_id],
            |row| {
                Ok(RoutineWebhookDelivery {
                    id: row.get(0)?,
                    routine_name: row.get(1)?,
                    provider: row.get(2)?,
                    event_kind: row.get(3)?,
                    idempotency_key: row.get(4)?,
                    status: row.get(5)?,
                    reason: row.get(6)?,
                    routine_run_id: row.get(7)?,
                    created_at: iso8601(row.get(8)?),
                    updated_at: iso8601(row.get(9)?),
                })
            },
        )
        .map_err(|err| format!("routine webhook delivery: {err}"))
}

pub fn list_deliveries(
    routine_name: &str,
    limit: usize,
) -> Result<Vec<RoutineWebhookDelivery>, String> {
    let connection = conn()?;
    let mut statement = connection
        .prepare(
            "SELECT id FROM pm_routine_webhook_deliveries
              WHERE routine_name = ?1
              ORDER BY created_at DESC, id DESC LIMIT ?2",
        )
        .map_err(|err| format!("routine webhook delivery: {err}"))?;
    let ids = statement
        .query_map(params![routine_name, limit.clamp(1, 200) as i64], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|err| format!("routine webhook delivery: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("routine webhook delivery: {err}"))?;
    ids.into_iter().map(|id| read_delivery(&id)).collect()
}

pub fn replay(delivery_id: &str) -> Result<RoutineWebhookDelivery, String> {
    let connection = conn()?;
    let row: (String, String, String, String) = connection
        .query_row(
            "SELECT routine_name, provider, event_kind, payload_json
               FROM pm_routine_webhook_deliveries WHERE id = ?1",
            params![delivery_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|err| format!("routine webhook delivery: {err}"))?;
    let payload = serde_json::from_str(&row.3)
        .map_err(|err| format!("routine webhook payload decode: {err}"))?;
    ingest_verified(
        &row.0,
        &row.1,
        &row.2,
        &format!("replay:{}", uuid::Uuid::new_v4().simple()),
        payload,
        Some(delivery_id),
    )
}

pub async fn handle_http(
    Path(routine_name): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if body.len() > MAX_PAYLOAD_BYTES {
        return (StatusCode::PAYLOAD_TOO_LARGE, "payload exceeds 256 KiB").into_response();
    }
    let get_header = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    };
    let Some(token) = get_header("x-org2-webhook-token") else {
        return (StatusCode::UNAUTHORIZED, "missing webhook token").into_response();
    };
    let Some(provider) = get_header("x-org2-provider") else {
        return (StatusCode::BAD_REQUEST, "missing provider").into_response();
    };
    let Some(event_kind) = get_header("x-org2-event") else {
        return (StatusCode::BAD_REQUEST, "missing event kind").into_response();
    };
    let Some(delivery_id) = get_header("x-org2-delivery-id") else {
        return (StatusCode::BAD_REQUEST, "missing delivery id").into_response();
    };
    let connection = match conn() {
        Ok(connection) => connection,
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
    };
    let stored_hash: Option<String> = match connection
        .query_row(
            "SELECT secret_hash FROM pm_routine_webhooks WHERE routine_name = ?1",
            params![routine_name],
            |row| row.get(0),
        )
        .optional()
    {
        Ok(value) => value,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("routine webhook store: {error}"),
            )
                .into_response()
        }
    };
    let Some(stored_hash) = stored_hash else {
        return (StatusCode::NOT_FOUND, "routine webhook not found").into_response();
    };
    let candidate = secret_hash(&token);
    if stored_hash
        .as_bytes()
        .ct_eq(candidate.as_bytes())
        .unwrap_u8()
        != 1
    {
        return (StatusCode::UNAUTHORIZED, "invalid webhook token").into_response();
    }
    let payload: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(error) => {
            return (StatusCode::BAD_REQUEST, format!("invalid JSON: {error}")).into_response()
        }
    };
    match ingest_verified(
        &routine_name,
        &provider,
        &event_kind,
        &delivery_id,
        payload,
        None,
    ) {
        Ok(delivery) => {
            let status = if delivery.status == "failed" {
                StatusCode::UNPROCESSABLE_ENTITY
            } else {
                StatusCode::ACCEPTED
            };
            (status, axum::Json(delivery)).into_response()
        }
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
}
