//! Debug-only fault setup and read-only evidence for UserDirectedWork.
//!
//! These endpoints cannot submit, retry, pause, resume, archive, or delete a
//! Team. They only arm one BuildFast fault or inspect bounded durable rows so
//! Computer Use can remain the sole operator of every visible user action.

use axum::Json;
use rusqlite::params;

pub async fn test_agent_org_user_directed_fault(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let Some(mode) = body.get("mode").and_then(serde_json::Value::as_str) else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "mode is required"
        }));
    };
    match agent_core::state::commands::session::org_tasks::arm_next_group_delivery_fault(mode) {
        Ok(()) => Json(serde_json::json!({ "ok": true, "mode": mode })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

pub async fn test_agent_org_user_directed_evidence(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let Some(org_run_id) = body
        .get("org_run_id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
    else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "org_run_id is required"
        }));
    };

    let result = tokio::task::spawn_blocking(move || load_evidence(&org_run_id)).await;
    match result {
        Err(error) => Json(serde_json::json!({
            "ok": false,
            "error": format!("evidence worker failed: {error}")
        })),
        Ok(Err(error)) => Json(serde_json::json!({ "ok": false, "error": error })),
        Ok(Ok(value)) => Json(value),
    }
}

fn load_evidence(org_run_id: &str) -> Result<serde_json::Value, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    let mut delivery_statement = conn
        .prepare(
            "SELECT delivery_id,session_id,turn_intent_id,root_authority_turn_id,
                    parent_delivery_id,parent_inbox_id,source_kind,source_inbox_id,
                    dispatch_member_id,member_dispatch_sequence,depth,delivery_ordinal,status
             FROM agent_org_runtime_user_directed_deliveries
             WHERE org_run_id=?1
             ORDER BY delivery_id
             LIMIT 200",
        )
        .map_err(|error| error.to_string())?;
    let deliveries = delivery_statement
        .query_map([org_run_id], |row| {
            Ok(serde_json::json!({
                "delivery_id": row.get::<_, i64>(0)?,
                "session_id": row.get::<_, String>(1)?,
                "turn_intent_id": row.get::<_, String>(2)?,
                "root_authority_turn_id": row.get::<_, String>(3)?,
                "parent_delivery_id": row.get::<_, Option<i64>>(4)?,
                "parent_inbox_id": row.get::<_, Option<i64>>(5)?,
                "source_kind": row.get::<_, String>(6)?,
                "source_inbox_id": row.get::<_, Option<i64>>(7)?,
                "dispatch_member_id": row.get::<_, String>(8)?,
                "member_dispatch_sequence": row.get::<_, i64>(9)?,
                "depth": row.get::<_, i64>(10)?,
                "delivery_ordinal": row.get::<_, i64>(11)?,
                "status": row.get::<_, String>(12)?,
            }))
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;

    let mut binding_statement = conn
        .prepare(
            "SELECT binding_id,session_id,turn_intent_id,root_authority_turn_id,
                    parent_delivery_id,parent_inbox_id,source_inbox_id,depth,
                    delivery_ordinal,status
             FROM agent_org_runtime_user_directed_coordinator_bindings
             WHERE org_run_id=?1
             ORDER BY binding_id
             LIMIT 200",
        )
        .map_err(|error| error.to_string())?;
    let coordinator_bindings = binding_statement
        .query_map([org_run_id], |row| {
            Ok(serde_json::json!({
                "binding_id": row.get::<_, i64>(0)?,
                "session_id": row.get::<_, String>(1)?,
                "turn_intent_id": row.get::<_, String>(2)?,
                "root_authority_turn_id": row.get::<_, String>(3)?,
                "parent_delivery_id": row.get::<_, i64>(4)?,
                "parent_inbox_id": row.get::<_, Option<i64>>(5)?,
                "source_inbox_id": row.get::<_, i64>(6)?,
                "depth": row.get::<_, i64>(7)?,
                "delivery_ordinal": row.get::<_, i64>(8)?,
                "status": row.get::<_, String>(9)?,
            }))
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;

    let mut inbox_statement = conn
        .prepare(
            "SELECT id,recipient_member_id,sender_member_id,read_at
             FROM agent_org_runtime_inbox
             WHERE org_run_id=?1 AND delivery_class='user_directed'
             ORDER BY id
             LIMIT 200",
        )
        .map_err(|error| error.to_string())?;
    let inbox = inbox_statement
        .query_map([org_run_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, i64>(0)?,
                "recipient_member_id": row.get::<_, Option<String>>(1)?,
                "sender_member_id": row.get::<_, Option<String>>(2)?,
                "read_at": row.get::<_, Option<String>>(3)?,
            }))
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;

    let (root_count, context_count, intent_count, tool_receipt_count): (i64, i64, i64, i64) = conn
        .query_row(
            "SELECT
                 (SELECT COUNT(*) FROM agent_org_runtime_user_directed_roots
                  WHERE org_run_id=?1),
                 (SELECT COUNT(*) FROM agent_org_runtime_turn_contexts
                  WHERE org_run_id=?1 AND (
                    turn_kind='user_directed_work'
                    OR (turn_kind='coordinator' AND source_kind='member_inbox')
                  )),
                 (SELECT COUNT(*) FROM session_turn_intents WHERE org_run_id=?1),
                 (SELECT COUNT(*) FROM agent_org_runtime_tool_call_receipts
                  WHERE org_run_id=?1)",
            params![org_run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|error| error.to_string())?;

    Ok(serde_json::json!({
        "ok": true,
        "org_run_id": org_run_id,
        "bounded": true,
        "row_limit": 200,
        "counts": {
            "roots": root_count,
            "user_directed_contexts": context_count,
            "all_run_intents": intent_count,
            "tool_receipts": tool_receipt_count,
            "deliveries": deliveries.len(),
            "coordinator_bindings": coordinator_bindings.len(),
            "user_directed_inbox": inbox.len(),
        },
        "deliveries": deliveries,
        "coordinator_bindings": coordinator_bindings,
        "inbox": inbox,
    }))
}
