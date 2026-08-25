//! Frontend half of the remote-root conversation turn hand-off
//! (`core::coordination::conversation_turn_bridge`).

use crate::core::coordination::conversation_turn_bridge;

async fn shorten_conversation_claim_lease(
    claim: &conversation_turn_bridge::ConversationTurnClaim,
) -> Result<bool, String> {
    let dispatch_id = claim.dispatch_id.clone();
    let lease_token = claim.lease_token.clone();
    tokio::task::spawn_blocking(move || {
        // One second is the store's minimum renewal. Shortening rather than
        // mutating delivery state preserves normal fenced reclaim semantics.
        project_management::work_run_service::renew_dispatch_lease(
            &dispatch_id,
            &lease_token,
            1_000,
        )
    })
    .await
    .map_err(|error| format!("conversation turn release task failed: {error}"))?
}

#[tauri::command]
pub async fn work_run_conversation_turn_accept(
    run_id: String,
    claim_token: String,
    accepted: bool,
    reason: Option<String>,
) -> Result<Option<String>, String> {
    let outcome = if accepted {
        Ok(())
    } else {
        Err(reason.unwrap_or_else(|| "declined by frontend".to_string()))
    };
    Ok(conversation_turn_bridge::accept(
        &run_id,
        &claim_token,
        outcome,
    ))
}

#[tauri::command]
pub async fn work_run_conversation_turn_release(
    run_id: String,
    claim_token: String,
) -> Result<bool, String> {
    let Some(claim) = conversation_turn_bridge::release_claim(&run_id, &claim_token) else {
        return Ok(false);
    };
    let shortened = shorten_conversation_claim_lease(&claim).await?;
    if shortened {
        crate::core::coordination::work_item_run_dispatcher::wake_from_watermark();
    }
    Ok(true)
}

/// File a live frontend failure through the durable dispatch state machine.
/// Unlike a crash-style release, classification decides whether this exact
/// failure is terminal or receives a bounded backoff retry. Taking the claim
/// first fences late prepare/ack calls; an ack that already committed has
/// consumed the claim and makes this an idempotent no-op.
#[tauri::command]
pub async fn work_run_conversation_turn_nack(
    app: tauri::AppHandle,
    run_id: String,
    claim_token: String,
    reason: String,
) -> Result<bool, String> {
    let Some(claim) = conversation_turn_bridge::release_claim(&run_id, &claim_token) else {
        return Ok(false);
    };
    let dispatch_id = claim.dispatch_id.clone();
    let lease_token = claim.lease_token.clone();
    let failure_message = if reason.trim().is_empty() {
        "conversation turn failed before transport acknowledgement".to_string()
    } else {
        reason
    };
    let recorded = tokio::task::spawn_blocking(move || {
        project_management::work_run_service::record_dispatch_failure(
            &dispatch_id,
            &lease_token,
            &failure_message,
        )
    })
    .await
    .map_err(|error| format!("conversation turn nack task failed: {error}"))?;
    let run = match recorded {
        Ok(run) => run,
        Err(error) => {
            // If durable classification failed after the in-memory fence was
            // removed, make the lease promptly reclaimable instead of leaving
            // it at the heartbeat horizon.
            let _ = shorten_conversation_claim_lease(&claim).await;
            crate::core::coordination::work_item_run_dispatcher::wake_from_watermark();
            return Err(error);
        }
    };
    crate::orchestrator_notify::notify_routine_fire_dispatch_terminal(&run, &app).await;
    Ok(true)
}

#[tauri::command]
pub async fn work_run_conversation_turn_prepare_runner(
    run_id: String,
    claim_token: String,
    root_session_id: String,
    runner_session_id: String,
) -> Result<(), String> {
    crate::core::coordination::work_item_run_dispatcher::prepare_remote_conversation_runner(
        &run_id,
        &claim_token,
        &root_session_id,
        &runner_session_id,
    )
    .await
}

#[tauri::command]
pub async fn work_run_conversation_turn_ack_runner(
    app: tauri::AppHandle,
    run_id: String,
    claim_token: String,
    root_session_id: String,
    runner_session_id: String,
) -> Result<(), String> {
    crate::core::coordination::work_item_run_dispatcher::ack_remote_conversation_runner(
        &app,
        &run_id,
        &claim_token,
        &root_session_id,
        &runner_session_id,
    )
    .await
}
