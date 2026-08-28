//! Isolated formal-convergence fault setup and read-only evidence endpoints.
//!
//! These handlers do not click UI controls, create Tasks, issue completion
//! certificates, or manufacture receipt states. They only arm a single
//! Session-scoped EventStore failure so rendered tests can observe the real
//! final-report failure and Retry user path.

use axum::Json;

pub async fn arm_final_summary_event_store_failure(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let Some(session_id) = body
        .get("session_id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "session_id is required"
        }));
    };

    match crate::agent_sessions::event_pipeline::fault_injection::arm_next_final_summary_persist_failure(
        session_id,
    ) {
        Ok(()) => Json(serde_json::json!({
            "ok": true,
            "session_id": session_id,
            "failure": "event_store"
        })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

pub async fn clear_final_summary_event_store_failure(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let Some(session_id) = body
        .get("session_id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "session_id is required"
        }));
    };
    match crate::agent_sessions::event_pipeline::fault_injection::clear_final_summary_persist_failure(
        session_id,
    ) {
        Ok(cleared) => Json(serde_json::json!({
            "ok": true,
            "session_id": session_id,
            "cleared": cleared
        })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}
