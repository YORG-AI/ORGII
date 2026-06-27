//! Interactive-tool lifecycle E2E scenarios.
//!
//! Pins the invariant that was the root cause of the disappearing
//! `AskQuestionCard`: when `agent:complete` fires mid-turn, the frontend
//! proxy calls `EventStore::complete_last_running()`, which used to flip any
//! `Running` event to `Completed`. Tool calls that block the agent on user
//! input (`ask_user_questions`, `ask_user_permissions`, `suggest_mode_switch`,
//! `create_plan`) are now initialized as `AwaitingUser` and MUST only
//! transition to `Completed` via `agent:interaction_finalized` → `merge_events`.
//!
//! These scenarios drive the deterministic debug endpoint
//! `POST /agent/test/event-store/complete-last-running`, which mirrors the
//! production call path (build an `EventStore`, invoke the function, observe
//! resulting statuses). No LLM turn required.
//!
//! Following the positive+negative assertion convention, each scenario asserts both a
//! positive outcome (the `Running` event, if any, became `Completed`) and a
//! negative outcome (no `AwaitingUser` event was mutated).

use super::super::{config::Config, harness};

pub async fn plan_approval_lifecycle_keeps_revision_timestamp(cfg: &Config) -> bool {
    let result = match harness::probe_plan_approval_lifecycle_order(cfg).await {
        Err(err) => {
            return harness::print_error("Plan approval lifecycle keeps revision timestamp", &err);
        }
        Ok(result) => result,
    };

    let archived_event = result
        .plan_events
        .iter()
        .find(|event| event.plan_revision_id == "call_first" && event.status == "archived");
    let second_event = result
        .plan_events
        .iter()
        .find(|event| event.plan_revision_id == "call_second");
    let first_iso =
        chrono::DateTime::<chrono::Utc>::from_timestamp_millis(result.first_created_at_ms)
            .map(|timestamp| timestamp.to_rfc3339())
            .unwrap_or_default();
    let second_iso =
        chrono::DateTime::<chrono::Utc>::from_timestamp_millis(result.second_created_at_ms)
            .map(|timestamp| timestamp.to_rfc3339())
            .unwrap_or_default();

    let old_plan_archived = archived_event.is_some();
    let new_plan_pending = second_event
        .map(|event| event.status.as_str() == "pending")
        .unwrap_or(false);
    let archived_uses_original_time = archived_event
        .map(|event| event.created_at == first_iso)
        .unwrap_or(false);
    let archived_not_restamped_to_update_time = archived_event
        .map(|event| event.created_at != second_iso)
        .unwrap_or(false);

    harness::print_result(
        "Plan approval lifecycle keeps revision timestamp",
        &format!(
            "first_ms={}, second_ms={}, events={:?}",
            result.first_created_at_ms,
            result.second_created_at_ms,
            result
                .plan_events
                .iter()
                .map(|event| (&event.id, &event.status, &event.created_at))
                .collect::<Vec<_>>()
        ),
        &[
            ("old revision became archived", old_plan_archived),
            ("new revision remained pending", new_plan_pending),
            (
                "archived event kept original revision created_at",
                archived_uses_original_time,
            ),
            (
                "archived event was not restamped to update time",
                archived_not_restamped_to_update_time,
            ),
        ],
    )
}

/// Mixed case: one `Running` tool_call + one `AwaitingUser` tool_call.
///
/// Positive: the `Running` event transitions to `Completed`; the endpoint
/// reports it via `completed_id`.
/// Negative: the `AwaitingUser` event stays `AwaitingUser` — it is the exact
/// surface the original bug corrupted (ask_user_questions was mid-flight).
pub async fn awaiting_user_survives_complete_last_running(cfg: &Config) -> bool {
    let result = match harness::probe_event_store_complete_last_running(
        cfg,
        &[
            ("tool-call-ask", "awaiting_user"),
            ("tool-call-read", "running"),
        ],
    )
    .await
    {
        Err(err) => {
            return harness::print_error("AwaitingUser survives complete_last_running", &err);
        }
        Ok(r) => r,
    };

    let completed_is_running = result.completed_id.as_deref() == Some("tool-call-read");
    let read_now_completed = result.status_of("tool-call-read") == Some("completed");
    let ask_unchanged = result.status_of("tool-call-ask") == Some("awaiting_user");

    harness::print_result(
        "AwaitingUser survives complete_last_running",
        &format!(
            "completed_id={:?}, ask={:?}, read={:?}",
            result.completed_id,
            result.status_of("tool-call-ask"),
            result.status_of("tool-call-read"),
        ),
        &[
            (
                "completed_id targets the Running event",
                completed_is_running,
            ),
            ("Running event now Completed", read_now_completed),
            (
                "AwaitingUser event NOT mutated (the ask_user_questions card stays visible)",
                ask_unchanged,
            ),
        ],
    )
}

/// Reverse-scan traversal: a `Running` event preceded in the event list by
/// two `AwaitingUser` events must still be picked up. `complete_last_running`
/// walks the events in reverse — it must skip `AwaitingUser` entries rather
/// than short-circuit on them.
///
/// Positive: `completed_id` equals the `Running` event id; that event is now
/// `Completed`.
/// Negative: both `AwaitingUser` events remain untouched.
pub async fn running_event_completes_past_awaiting_user(cfg: &Config) -> bool {
    let result = match harness::probe_event_store_complete_last_running(
        cfg,
        &[
            ("tool-call-read", "running"),
            ("tool-call-ask-1", "awaiting_user"),
            ("tool-call-ask-2", "awaiting_user"),
        ],
    )
    .await
    {
        Err(err) => {
            return harness::print_error("Running completes past AwaitingUser", &err);
        }
        Ok(r) => r,
    };

    let completed_is_running = result.completed_id.as_deref() == Some("tool-call-read");
    let read_now_completed = result.status_of("tool-call-read") == Some("completed");
    let ask1_unchanged = result.status_of("tool-call-ask-1") == Some("awaiting_user");
    let ask2_unchanged = result.status_of("tool-call-ask-2") == Some("awaiting_user");

    harness::print_result(
        "Running completes past AwaitingUser",
        &format!(
            "completed_id={:?}, read={:?}, ask-1={:?}, ask-2={:?}",
            result.completed_id,
            result.status_of("tool-call-read"),
            result.status_of("tool-call-ask-1"),
            result.status_of("tool-call-ask-2"),
        ),
        &[
            (
                "completed_id picked the Running event past two AwaitingUser events",
                completed_is_running,
            ),
            ("Running event now Completed", read_now_completed),
            ("First AwaitingUser event NOT mutated", ask1_unchanged),
            ("Second AwaitingUser event NOT mutated", ask2_unchanged),
        ],
    )
}

/// Pure-AwaitingUser case (negative-only): no `Running` event exists, so
/// `complete_last_running` MUST return `None` and MUST NOT touch any event.
///
/// This is the exact scenario `agent:complete` landed the original bug in:
/// the only in-flight event was an `ask_user_questions` tool call, and the
/// pre-fix function eagerly flipped it to `Completed`.
pub async fn awaiting_user_only_completes_nothing(cfg: &Config) -> bool {
    let result = match harness::probe_event_store_complete_last_running(
        cfg,
        &[
            ("tool-call-ask-1", "awaiting_user"),
            ("tool-call-ask-2", "awaiting_user"),
        ],
    )
    .await
    {
        Err(err) => {
            return harness::print_error("AwaitingUser-only → no completion", &err);
        }
        Ok(r) => r,
    };

    let nothing_completed = result.completed_id.is_none();
    let ask1_unchanged = result.status_of("tool-call-ask-1") == Some("awaiting_user");
    let ask2_unchanged = result.status_of("tool-call-ask-2") == Some("awaiting_user");

    harness::print_result(
        "AwaitingUser-only → no completion",
        &format!(
            "completed_id={:?}, ask-1={:?}, ask-2={:?}",
            result.completed_id,
            result.status_of("tool-call-ask-1"),
            result.status_of("tool-call-ask-2"),
        ),
        &[
            (
                "completed_id is null (no Running event existed)",
                nothing_completed,
            ),
            ("First AwaitingUser event NOT mutated", ask1_unchanged),
            ("Second AwaitingUser event NOT mutated", ask2_unchanged),
        ],
    )
}
