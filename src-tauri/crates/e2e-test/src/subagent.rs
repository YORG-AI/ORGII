//! Subagent dispatch scenarios — pin the parameter-resolution contract of
//! `AgentTool::execute()` against the two failures reported on 2026-04-13
//! (screenshot from a teammate's SDE session):
//!
//!   1) "Invalid parameters: missing 'agent_id' (required for delegate mode)"
//!      → now falls back to `builtin:general` + warn log.
//!   2) "Executor failed: No persisted history found for session '<id>'"
//!      → now rejected upfront via a shape pre-check on `resume_session_id`.
//!   3) Subagents recursing into more subagents (custom agents with
//!      `inherit_all: true` + empty deny list) — now blocked at the top
//!      of `AgentTool::execute()` by `subagent_of_subagent_rejection`.
//!
//! The deterministic scenarios drive the debug-only
//! `/agent/test/subagent/dispatch-check` endpoint and finish sub-second.

use super::config::Config;
use super::harness;

// ── Deterministic dispatch-check scenarios ─────────────────────────

/// POST to the debug dispatch-check endpoint with the given params.
async fn dispatch_check(
    cfg: &Config,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/agent/test/subagent/dispatch-check", cfg.base_url);
    let resp = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("client")
        .post(&url)
        .json(&params)
        .send()
        .await
        .map_err(|err| format!("HTTP error: {err}"))?;

    resp.json::<serde_json::Value>()
        .await
        .map_err(|err| format!("JSON parse error: {err}"))
}

/// Delegate mode without `agent_id` → falls back to `builtin:general` with
/// `fallback=true`. Pins the fix for Error 1; used to return `InvalidParams`.
pub async fn dispatch_delegate_no_agent_id(cfg: &Config) -> bool {
    let params = serde_json::json!({ "prompt": "do something" });
    match dispatch_check(cfg, params).await {
        Err(err) => harness::print_error("Dispatch: delegate without agent_id", &err),
        Ok(json) => {
            let resolved = json
                .get("resolved_agent_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let fallback = json
                .get("agent_id_fallback")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            harness::print_result(
                "Dispatch: delegate without agent_id",
                &json.to_string(),
                &[
                    (
                        "resolved_agent_id == builtin:general",
                        resolved == "builtin:general",
                    ),
                    ("agent_id_fallback == true", fallback),
                ],
            )
        }
    }
}

/// Delegate mode with explicit `agent_id` → honored, fallback=false.
/// Control case for the happy path LLMs are supposed to hit.
pub async fn dispatch_delegate_with_agent_id(cfg: &Config) -> bool {
    let params = serde_json::json!({
        "agent_id": "builtin:explore",
        "prompt": "find stale sessions",
    });
    match dispatch_check(cfg, params).await {
        Err(err) => harness::print_error("Dispatch: delegate with explicit agent_id", &err),
        Ok(json) => {
            let resolved = json
                .get("resolved_agent_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let fallback = json
                .get("agent_id_fallback")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            harness::print_result(
                "Dispatch: delegate with explicit agent_id",
                &json.to_string(),
                &[
                    (
                        "resolved_agent_id == builtin:explore",
                        resolved == "builtin:explore",
                    ),
                    ("agent_id_fallback == false", !fallback),
                ],
            )
        }
    }
}

/// Shadow mode without `agent_id` → resolved to `builtin:general` BUT
/// `fallback=false` (shadow legitimately ignores this field, so it's not
/// a miss). Protects the distinction introduced by the fix.
pub async fn dispatch_shadow_no_agent_id(cfg: &Config) -> bool {
    let params = serde_json::json!({
        "mode": "shadow",
        "prompt": "parallel subtask",
    });
    match dispatch_check(cfg, params).await {
        Err(err) => harness::print_error("Dispatch: shadow without agent_id", &err),
        Ok(json) => {
            let resolved = json
                .get("resolved_agent_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let fallback = json
                .get("agent_id_fallback")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            harness::print_result(
                "Dispatch: shadow without agent_id",
                &json.to_string(),
                &[
                    (
                        "resolved_agent_id == builtin:general",
                        resolved == "builtin:general",
                    ),
                    (
                        "agent_id_fallback == false (shadow is not a miss)",
                        !fallback,
                    ),
                ],
            )
        }
    }
}

/// Resume with the exact hallucinated id from the 2026-04-13 screenshot
/// (first segment is 9 chars — not a valid UUID). Shape check must reject
/// so the runtime never hits `load_llm_history` with garbage.
pub async fn dispatch_resume_hallucinated(cfg: &Config) -> bool {
    let hallucinated = "01dc8f8ae-3b3b-7fdc-aa27-50ebe0c15839";
    let params = serde_json::json!({
        "agent_id": "builtin:general",
        "prompt": "continue",
        "resume_session_id": hallucinated,
    });
    match dispatch_check(cfg, params).await {
        Err(err) => harness::print_error("Dispatch: hallucinated resume_session_id rejected", &err),
        Ok(json) => {
            let shape_valid = json.get("resume_shape_valid").and_then(|v| v.as_bool());
            harness::print_result(
                "Dispatch: hallucinated resume_session_id rejected",
                &json.to_string(),
                &[
                    ("resume_shape_valid is non-null", shape_valid.is_some()),
                    ("resume_shape_valid == false", shape_valid == Some(false)),
                ],
            )
        }
    }
}

/// Resume with a canonical `<prefix>-<agent_id>-<uuid>` handle → shape
/// check passes (the runtime still defers existence to `load_llm_history`).
/// Documents the boundary between "shape invalid" and "shape valid but unknown".
pub async fn dispatch_resume_canonical(cfg: &Config) -> bool {
    let real_handle = format!("agent-builtin:general-{}", uuid::Uuid::new_v4());
    let params = serde_json::json!({
        "agent_id": "builtin:general",
        "prompt": "continue",
        "resume_session_id": real_handle,
    });
    match dispatch_check(cfg, params).await {
        Err(err) => {
            harness::print_error("Dispatch: canonical resume_session_id passes shape", &err)
        }
        Ok(json) => {
            let shape_valid = json.get("resume_shape_valid").and_then(|v| v.as_bool());
            harness::print_result(
                "Dispatch: canonical resume_session_id passes shape",
                &json.to_string(),
                &[("resume_shape_valid == true", shape_valid == Some(true))],
            )
        }
    }
}

/// Subagent-of-subagent guard: the root session (empty `delegation_chain`)
/// MUST be allowed to call `agent`; any non-empty chain MUST be rejected
/// with a structured error that echoes the chain so misconfigured custom
/// agents are debuggable. Drives the same `/dispatch-check` endpoint as
/// the other deterministic scenarios so it finishes sub-second.
pub async fn dispatch_subagent_cannot_spawn_subagent(cfg: &Config) -> bool {
    let root_params = serde_json::json!({
        "prompt": "spawn explore from the root session",
        "delegation_chain": [],
    });
    let root_ok = match dispatch_check(cfg, root_params).await {
        Err(err) => {
            println!("  [root] HTTP error: {err}");
            false
        }
        Ok(json) => {
            let rejected = json
                .get("subagent_recursion_rejected")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            !rejected
        }
    };

    let sub_params = serde_json::json!({
        "prompt": "try to spawn another subagent from inside a subagent",
        "delegation_chain": ["custom:manager", "custom:worker"],
    });
    let (sub_rejected, msg_echoes_chain, msg_has_rule) = match dispatch_check(cfg, sub_params).await
    {
        Err(err) => {
            println!("  [subagent] HTTP error: {err}");
            (false, false, false)
        }
        Ok(json) => {
            let rejected = json
                .get("subagent_recursion_rejected")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let message = json
                .get("subagent_recursion_message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let echoes_chain =
                message.contains("custom:manager") && message.contains("custom:worker");
            let has_rule = message
                .to_lowercase()
                .contains("subagents cannot spawn other subagents");
            (rejected, echoes_chain, has_rule)
        }
    };

    harness::print_result(
        "Dispatch: subagents cannot spawn other subagents (guard chokepoint)",
        "see individual checks",
        &[
            ("Root session (empty chain) is allowed", root_ok),
            ("Subagent (non-empty chain) is rejected", sub_rejected),
            ("Rejection message states the rule", msg_has_rule),
            (
                "Rejection message echoes the full delegation chain for debugging",
                msg_echoes_chain,
            ),
        ],
    )
}

/// Subagent-completion push-wake: a background subagent that finishes while
/// its parent is idle must wake the parent's turn loop so the result is
/// consumed — without this, the parent silently never continues. Mirrors
/// Claude Code's task-notification → idle-queue-processor wake.
///
/// Flow:
///   turn 1 (no_cleanup): parent launches an Explore subagent with
///     `background:true` and is instructed to END ITS TURN IMMEDIATELY so it
///     goes idle while the worker is still running.
///   wait: poll the parent transcript. The production
///     `JobCompletionWakeHook` (installed in lib.rs) fires when the
///     worker terminates and resumes the parent via
///     `send_message_impl_for_job_wake`. The resumed turn carries the
///     Background Jobs reminder with the completed worker's unread output, so
///     the parent's message count grows AFTER the HTTP call returned.
///
/// Assertions:
///   - turn 1 actually dispatched a background subagent (tool_calls has
///     `agent`), proving the worker path ran.
///   - the parent transcript GROWS after going idle (the auto-woken turn),
///     proving the push-wake fired without any second user message.
pub async fn subagent_completion_wakes_parent(cfg: &Config) -> bool {
    let session_id = format!("{}-wake-parent", cfg.session_prefix);
    let project = crate::sde::tmp_workspace_path("wake-parent");

    // Turn 1: launch a background subagent, then stop the turn immediately.
    let opts = harness::SdeMessageOpts {
        no_cleanup: true,
        ..Default::default()
    };
    let turn1 = harness::send_sde_message_with_opts(
        cfg,
        "Use the `agent` tool with agent_id=\"builtin:explore\" and background=true \
         to launch ONE background subagent whose prompt is: \"List the files in the \
         repository root and report what you find.\" \
         As soon as the agent tool returns the launch confirmation, STOP and END YOUR \
         TURN IMMEDIATELY with a one-sentence acknowledgement. Do NOT call await_output, \
         do NOT wait for the subagent, do NOT do any other work this turn.",
        &session_id,
        "build",
        &project,
        &opts,
    )
    .await;

    let turn1 = match turn1 {
        Err(err) => return harness::print_error("Subagent completion wakes idle parent", &err),
        Ok(resp) => resp,
    };

    let launched_background = harness::assert_sde_tool_used(&turn1, "agent");

    // Snapshot the parent's message count right after it went idle.
    let baseline = harness::fetch_transcript(cfg, &session_id)
        .await
        .map(|t| t.messages.len())
        .unwrap_or(0);

    // Poll for the auto-woken turn: the worker finishes within a few seconds,
    // the wake hook resumes the parent, and its transcript grows.
    //
    // CRITICAL (anti-false-positive): a resume that 400s on assistant-prefill
    // does NOT append to `load_llm_history` (failed turns aren't persisted as
    // LLM rows), so a bare "len grew" check is necessary but not sufficient.
    // We additionally require the woken turn to END with a non-empty
    // **assistant** message — proving the resumed turn actually produced model
    // output instead of erroring. This is exactly the gap that let the earlier
    // version pass while the real app 400'd.
    let mut grew_to = baseline;
    let mut woke = false;
    let mut produced_assistant = false;
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        if let Ok(snap) = harness::fetch_transcript(cfg, &session_id).await {
            if snap.messages.len() > baseline {
                grew_to = snap.messages.len();
                woke = true;
                produced_assistant = snap.messages.iter().rev().any(|m| {
                    m.get("role").and_then(|v| v.as_str()) == Some("assistant")
                        && m.get("content")
                            .and_then(|v| v.as_str())
                            .map(|s| !s.trim().is_empty())
                            .unwrap_or(false)
                });
                if produced_assistant {
                    break;
                }
            }
        }
    }

    let _ = harness::cleanup_sde_session(cfg, &session_id).await;

    harness::print_result(
        "Subagent completion wakes idle parent",
        &format!(
            "turn1 tools={:?}, baseline_msgs={}, grew_to={}, produced_assistant={}",
            turn1.tool_calls, baseline, grew_to, produced_assistant
        ),
        &[
            (
                "Turn 1 dispatched a background subagent (agent tool)",
                launched_background,
            ),
            ("Parent had a transcript after going idle", baseline > 0),
            (
                "Parent was auto-woken (transcript grew with no new user message)",
                woke,
            ),
            (
                "Woken turn produced a real assistant response (no prefill 400)",
                produced_assistant,
            ),
        ],
    )
}

/// Wake-race close: the parent launches a background subagent, polls ONCE
/// with `await_output` (which returns `running`), then ends its turn — and the
/// worker finishes a moment later, while the parent is still mid-turn. The
/// completion push is suppressed by `should_wake_owner`'s running gate, so if
/// nothing re-fired the wake once the turn ended, the parent would silently
/// never consume the result.
///
/// The fix is the turn-end re-check in `finalize_session`: it re-invokes the
/// job-wake coordinator, which atomically claims the unconsumed result
/// (`claim_completion_wake_for_session`) and resumes the now-idle parent. This
/// scenario drives the poll-then-stop path and asserts the parent still
/// resumes.
pub async fn subagent_wake_race_after_poll(cfg: &Config) -> bool {
    let session_id = format!("{}-wake-race", cfg.session_prefix);
    let project = crate::sde::tmp_workspace_path("wake-race");

    let opts = harness::SdeMessageOpts {
        no_cleanup: true,
        ..Default::default()
    };
    // Mirror the real session: launch in background, poll progress ONCE,
    // then stop — inviting the race where the worker finishes during this
    // same turn.
    let turn1 = harness::send_sde_message_with_opts(
        cfg,
        "Use the `agent` tool with agent_id=\"builtin:explore\" and background=true \
         to launch ONE background subagent whose prompt is: \"List the files in the \
         repository root and summarize the structure.\" \
         After it launches, call await_output EXACTLY ONCE to peek at its progress, \
         then END YOUR TURN with a one-sentence status — do NOT loop on await_output, \
         do NOT wait for completion.",
        &session_id,
        "build",
        &project,
        &opts,
    )
    .await;

    let turn1 = match turn1 {
        Err(err) => return harness::print_error("Subagent wake race (poll-then-stop)", &err),
        Ok(resp) => resp,
    };

    let launched_background = harness::assert_sde_tool_used(&turn1, "agent");

    let baseline = harness::fetch_transcript(cfg, &session_id)
        .await
        .map(|t| t.messages.len())
        .unwrap_or(0);

    let mut grew_to = baseline;
    let mut woke = false;
    let mut produced_assistant = false;
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        if let Ok(snap) = harness::fetch_transcript(cfg, &session_id).await {
            if snap.messages.len() > baseline {
                grew_to = snap.messages.len();
                woke = true;
                produced_assistant = snap.messages.iter().rev().any(|m| {
                    m.get("role").and_then(|v| v.as_str()) == Some("assistant")
                        && m.get("content")
                            .and_then(|v| v.as_str())
                            .map(|s| !s.trim().is_empty())
                            .unwrap_or(false)
                });
                if produced_assistant {
                    break;
                }
            }
        }
    }

    let _ = harness::cleanup_sde_session(cfg, &session_id).await;

    harness::print_result(
        "Subagent wake race (poll-then-stop)",
        &format!(
            "turn1 tools={:?}, baseline_msgs={}, grew_to={}, produced_assistant={}",
            turn1.tool_calls, baseline, grew_to, produced_assistant
        ),
        &[
            (
                "Turn 1 dispatched a background subagent (agent tool)",
                launched_background,
            ),
            ("Parent had a transcript after the turn", baseline > 0),
            (
                "Parent self-woke after the race (transcript grew, no new user message)",
                woke,
            ),
            (
                "Woken turn produced a real assistant response (no prefill 400)",
                produced_assistant,
            ),
        ],
    )
}

/// Background-launch message contract: when a subagent is launched with
/// `background:true`, the tool_result handed back to the parent agent must
/// (a) carry the subagent's session_id (the DB key), (b) hand the parent a
/// ready-made `sqlite3 ... agent_messages` query for progress, and (c) NOT
/// push the parent toward `await_output` polling. Pins the 2026-06-14 fix
/// that replaced "Use await_output(handle=...) to monitor progress" with
/// session-DB browsing guidance to stop the infinite-poll loop.
pub async fn background_launch_msg_no_poll(cfg: &Config) -> bool {
    let session_id = "agent-builtin:general-launchmsg-fixture";
    let params = serde_json::json!({
        "prompt": "explore the codebase in the background",
        "launch_agent_name": "Explore",
        "launch_session_id": session_id,
    });
    match dispatch_check(cfg, params).await {
        Err(err) => harness::print_error("Dispatch: background launch message no-poll", &err),
        Ok(json) => {
            let msg = json
                .get("launch_message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let lower = msg.to_lowercase();
            harness::print_result(
                "Dispatch: background launch message no-poll",
                &msg,
                &[
                    (
                        "Message carries the subagent session_id",
                        msg.contains(session_id),
                    ),
                    (
                        "Tells the parent NOT to poll with await_output",
                        lower.contains("do not call await_output"),
                    ),
                    (
                        "Hands the parent a sqlite3 agent_messages query",
                        msg.contains("sqlite3") && msg.contains("agent_messages"),
                    ),
                    (
                        "Promises automatic completion notification",
                        lower.contains("notified automatically"),
                    ),
                    (
                        "Does NOT tell the parent to monitor via await_output handle",
                        !lower.contains("await_output(handle"),
                    ),
                ],
            )
        }
    }
}
