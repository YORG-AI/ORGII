//! Goal continuation loop — ORGII's take on the Ralph loop (Hermes Agent
//! `/goal`, Codex CLI 0.128.0).
//!
//! When the user's presence policy enables the goal loop (Invisible by
//! default, or any custom mode with `goalMaxTurns > 0`), every completed
//! turn is judged against the session's standing goal — the most recent
//! real user message. If the judge says the goal is not yet achieved, a
//! continuation prompt is enqueued as a plain user message (source
//! `Queue`, so it never resets the goal) and the agent keeps working.
//!
//! Verified mechanics borrowed from Hermes:
//!   * **Judge is conservative** — `done` only when the response clearly
//!     confirms completion, the deliverable is clearly produced, or the
//!     goal is blocked/unachievable.
//!   * **Fail-open** — a judge error counts as `continue`; the turn
//!     budget is the real backstop.
//!   * **Budget** — `goalMaxTurns` continuations per goal (per-mode,
//!     user-configurable); exhaustion auto-pauses with a visible notice.
//!   * **User messages always preempt** — pending real messages skip the
//!     continuation; a new user message resets the goal + counter.
//!   * **Prompt-cache safe** — the continuation is an ordinary user
//!     message; the system prompt is untouched.
//!   * **Persistent** — goal state lives in sqlite and survives restart.
//!
//! The judge reuses the session's own model/account (a fresh fork
//! provider, same spec as post-turn memory extraction) — no auxiliary
//! model, no extra settings.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use tracing::{info, warn};

use database::db::get_connection;

use crate::interaction::presence_policy::GoalLoopPolicy;
use crate::interaction::presence_state;

// ============================================================================
// Persistence
// ============================================================================

/// Goal-loop state row. One per session; replaced when a new real user
/// message arrives.
#[derive(Debug, Clone)]
pub struct GoalState {
    pub session_id: String,
    pub goal_text: String,
    pub turns_used: u32,
    /// "active" | "paused". Paused goals are never auto-continued; a new
    /// user message replaces them with a fresh active goal.
    pub status: String,
}

/// Initialize the `goal_loop_state` table. Called once per process from
/// app setup (same hook as the plan-approval schema).
pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS goal_loop_state (
            session_id  TEXT PRIMARY KEY,
            goal_text   TEXT NOT NULL,
            turns_used  INTEGER NOT NULL DEFAULT 0,
            status      TEXT NOT NULL DEFAULT 'active',
            updated_at  INTEGER NOT NULL
        ) WITHOUT ROWID;",
    )
}

fn load_state(session_id: &str) -> Option<GoalState> {
    let conn = get_connection().ok()?;
    conn.query_row(
        "SELECT session_id, goal_text, turns_used, status
         FROM goal_loop_state WHERE session_id = ?1",
        params![session_id],
        |row| {
            Ok(GoalState {
                session_id: row.get(0)?,
                goal_text: row.get(1)?,
                turns_used: row.get::<_, i64>(2)? as u32,
                status: row.get(3)?,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

fn save_state(state: &GoalState) {
    let Ok(conn) = get_connection() else { return };
    let now_ms = chrono::Utc::now().timestamp_millis();
    let result = conn.execute(
        "INSERT INTO goal_loop_state (session_id, goal_text, turns_used, status, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(session_id) DO UPDATE SET
            goal_text  = excluded.goal_text,
            turns_used = excluded.turns_used,
            status     = excluded.status,
            updated_at = excluded.updated_at",
        params![
            state.session_id,
            state.goal_text,
            state.turns_used as i64,
            state.status,
            now_ms
        ],
    );
    if let Err(err) = result {
        warn!("[goal_loop] state save failed: {err}");
    }
}

fn clear_state(session_id: &str) {
    if let Ok(conn) = get_connection() {
        let _ = conn.execute(
            "DELETE FROM goal_loop_state WHERE session_id = ?1",
            params![session_id],
        );
    }
}

// ============================================================================
// Goal lifecycle
// ============================================================================

/// Record a real user message as the session's standing goal. Called from
/// the user-submit dispatch path only — continuations (source `Queue`)
/// never reset the goal, so the counter survives the loop's own messages.
///
/// `display_text` is the compact human-readable form of the user's message
/// before pill/skill references are expanded (e.g. `speckit-implement
/// [skill:/speckit-implement]` rather than the 13 KB SKILL.md body). When
/// present, it is preferred as the goal text so the judge receives the
/// user's *intent* — not multi-thousand-character expanded context — and
/// truncation does not silently drop implementation instructions.
pub fn on_user_message(session_id: &str, content: &str, display_text: Option<&str>) {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return;
    }

    // Prefer display_text when it is a shorter, more focused
    // representation of the same intent. This prevents skill-pill expansions
    // (e.g. a 13 KB SKILL.md body) from replacing the actual goal sentence
    // with truncated skill instructions that the judge cannot fully evaluate.
    let goal_source = display_text
        .map(str::trim)
        .filter(|d| !d.is_empty() && d.len() < trimmed.len())
        .unwrap_or(trimmed);

    save_state(&GoalState {
        session_id: session_id.to_string(),
        goal_text: crate::utils::safe_truncate_chars_to_string(&goal_source, 8_000),
        turns_used: 0,
        status: "active".to_string(),
    });
}

// ============================================================================
// Judge
// ============================================================================

/// Judge verdict, parsed from the model's strict-JSON reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JudgeVerdict {
    Done { reason: String },
    Continue { reason: String },
}

/// Parse the judge model's output. Accepts the JSON object anywhere in
/// the text (models sometimes wrap it in prose/fences). Fail-open: any
/// parse failure is `Continue` — the budget is the backstop.
pub fn parse_judge_verdict(raw: &str) -> JudgeVerdict {
    let candidate = raw
        .find('{')
        .and_then(|start| raw.rfind('}').map(|end| &raw[start..=end]))
        .unwrap_or(raw);

    match serde_json::from_str::<Value>(candidate) {
        Ok(value) => {
            let done = value.get("done").and_then(Value::as_bool);
            let reason = value
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            match done {
                Some(true) => JudgeVerdict::Done { reason },
                Some(false) => JudgeVerdict::Continue { reason },
                None => JudgeVerdict::Continue {
                    reason: "judge reply missing 'done' field".to_string(),
                },
            }
        }
        Err(_) => JudgeVerdict::Continue {
            reason: "judge reply was not valid JSON".to_string(),
        },
    }
}

const JUDGE_SYSTEM_PROMPT: &str = "You are a strict completion judge. You are given a user's \
standing goal and the tail of an AI agent's most recent reply. Decide whether the goal is \
fully satisfied. Be conservative: answer done=true ONLY when the reply explicitly confirms \
the goal is complete, the final deliverable is clearly produced, or the goal is \
unachievable/blocked (treat blocked as done so no budget is wasted). Saying \"next I \
could…\", asking questions, or partial progress means done=false. Reply with STRICT JSON \
only: {\"done\": <bool>, \"reason\": \"<one short sentence>\"}";

/// Tail budget for the judged reply, mirroring Hermes' ~4KB window.
const JUDGE_REPLY_TAIL_BYTES: usize = 4 * 1024;

fn build_judge_messages(goal_text: &str, response_text: &str) -> Vec<Value> {
    let tail: String = if response_text.len() > JUDGE_REPLY_TAIL_BYTES {
        let mut start = response_text.len() - JUDGE_REPLY_TAIL_BYTES;
        while !response_text.is_char_boundary(start) {
            start += 1;
        }
        format!("…{}", &response_text[start..])
    } else {
        response_text.to_string()
    };
    vec![
        serde_json::json!({ "role": "system", "content": JUDGE_SYSTEM_PROMPT }),
        serde_json::json!({
            "role": "user",
            "content": format!(
                "## Standing goal\n{goal_text}\n\n## Agent's latest reply (tail)\n{tail}\n\nIs the goal fully satisfied? Reply with the strict JSON object only."
            ),
        }),
    ]
}

// ============================================================================
// Turn-end evaluation
// ============================================================================

/// Everything the post-turn hook hands over so the evaluation can run
/// detached from the processor.
pub struct GoalLoopTurnEnd {
    pub session_id: String,
    /// Final assistant text of the completed turn.
    pub response_text: String,
    /// Fresh-provider spec (same model/account as the session).
    pub model: String,
    pub account_id: Option<String>,
    pub reliability: crate::config::ReliabilityConfig,
    pub native_harness_type: Option<core_types::providers::NativeHarnessType>,
    pub workspace: crate::session::workspace::SessionWorkspace,
    pub app_handle: Option<tauri::AppHandle>,
}

/// Evaluate a completed turn against the standing goal and enqueue a
/// continuation when warranted. Spawned fire-and-forget from the
/// post-turn dispatch — never blocks the turn pipeline.
pub fn spawn_turn_end_evaluation(input: GoalLoopTurnEnd) {
    // Cheap gate before spawning: policy off → nothing to do.
    let policy = presence_state::global_policy();
    let GoalLoopPolicy::On { max_turns } = policy.goal_loop else {
        return;
    };

    tokio::spawn(async move {
        evaluate_turn_end(input, max_turns).await;
    });
}

async fn evaluate_turn_end(input: GoalLoopTurnEnd, max_turns: u32) {
    let session_id = input.session_id.clone();

    let Some(mut state) = load_state(&session_id) else {
        return;
    };
    if state.status != "active" || state.goal_text.is_empty() {
        return;
    }

    // Budget backstop.
    if state.turns_used >= max_turns {
        state.status = "paused".to_string();
        save_state(&state);
        broadcast_goal_event(
            &session_id,
            "paused",
            state.turns_used,
            max_turns,
            &format!(
                "Goal paused — {}/{} continuation turns used. Send a message to keep going.",
                state.turns_used, max_turns
            ),
        );
        return;
    }

    // User preemption: a real pending message wins over the continuation.
    if session_has_pending_messages(&input.app_handle, &session_id).await {
        info!("[goal_loop] pending user message preempts continuation (session={session_id})");
        return;
    }

    // Judge — session's own model via a fresh fork provider. Fail-open.
    let verdict = run_judge(&input, &state.goal_text).await;

    match verdict {
        JudgeVerdict::Done { reason } => {
            info!("[goal_loop] goal achieved (session={session_id}): {reason}");
            clear_state(&session_id);
            broadcast_goal_event(
                &session_id,
                "achieved",
                state.turns_used,
                max_turns,
                &format!("Goal achieved: {reason}"),
            );
        }
        JudgeVerdict::Continue { reason } => {
            // Re-check presence right before enqueue — the user may have
            // come back online while the judge was running.
            let policy = presence_state::global_policy();
            if policy.goal_loop == GoalLoopPolicy::Off {
                info!(
                    "[goal_loop] presence switched mid-judge; loop stopped (session={session_id})"
                );
                return;
            }
            // Idempotence against duplicate evaluations: re-load and
            // compare the counter before committing.
            let Some(current) = load_state(&session_id) else {
                return;
            };
            if current.turns_used != state.turns_used || current.status != "active" {
                return;
            }
            state.turns_used += 1;
            save_state(&state);

            broadcast_goal_event(
                &session_id,
                "continuing",
                state.turns_used,
                max_turns,
                &reason,
            );

            enqueue_continuation(&input, state.turns_used, max_turns, &reason).await;
        }
    }
}

async fn run_judge(input: &GoalLoopTurnEnd, goal_text: &str) -> JudgeVerdict {
    let provider = crate::providers::factory::create_provider_with_native_harness_preflight(
        &input.model,
        input.account_id.as_deref(),
        &input.reliability,
        input.native_harness_type,
        Some(input.workspace.clone()),
    )
    .await;

    let provider = match provider {
        Ok(provider) => provider,
        Err(err) => {
            warn!("[goal_loop] judge provider creation failed (fail-open → continue): {err}");
            return JudgeVerdict::Continue {
                reason: "judge unavailable; continuing toward the goal".to_string(),
            };
        }
    };

    let messages = build_judge_messages(goal_text, &input.response_text);
    let judge_call = provider.chat(&messages, None, &input.model, 512, 0.0);
    match tokio::time::timeout(std::time::Duration::from_secs(60), judge_call).await {
        Ok(Ok(response)) => parse_judge_verdict(response.content.as_deref().unwrap_or("")),
        Ok(Err(err)) => {
            warn!("[goal_loop] judge call failed (fail-open → continue): {err}");
            JudgeVerdict::Continue {
                reason: "judge call failed; continuing toward the goal".to_string(),
            }
        }
        Err(_) => {
            warn!("[goal_loop] judge call timed out (fail-open → continue)");
            JudgeVerdict::Continue {
                reason: "judge timed out; continuing toward the goal".to_string(),
            }
        }
    }
}

async fn session_has_pending_messages(
    app_handle: &Option<tauri::AppHandle>,
    session_id: &str,
) -> bool {
    use tauri::Manager;
    let Some(handle) = app_handle else {
        return false;
    };
    let Some(state) = handle.try_state::<crate::state::AgentAppState>() else {
        return false;
    };
    match state.get_session(session_id).await {
        Some(session) => session.scheduler.pending_count() > 0,
        None => false,
    }
}

async fn enqueue_continuation(
    input: &GoalLoopTurnEnd,
    turns_used: u32,
    max_turns: u32,
    reason: &str,
) {
    use tauri::Manager;
    let Some(handle) = input.app_handle.as_ref() else {
        warn!("[goal_loop] no app handle; cannot enqueue continuation");
        return;
    };
    let Some(state) = handle.try_state::<crate::state::AgentAppState>() else {
        warn!("[goal_loop] AgentAppState unavailable; cannot enqueue continuation");
        return;
    };

    let content = format!(
        "[Goal continuation {turns_used}/{max_turns}] The user is not watching and your \
         standing goal is not achieved yet: {reason}\n\nContinue working toward the original \
         goal. Do not ask questions; make the best decisions you can and keep going until \
         the goal is fully achieved."
    );
    let display_text = format!("↻ Continuing toward goal ({turns_used}/{max_turns}): {reason}");

    let result = crate::state::commands::session::message::send_message_impl(
        &state,
        input.session_id.clone(),
        content,
        Some(display_text),
        crate::state::commands::session::identity::IdentityOverrides::default(),
        None,
        None,
        None,
        false,
        false,
        None,
        None,
        crate::foundation::session_bridge::TurnIntentBridgeSource::Queue,
    )
    .await;

    match result {
        Ok(_) => info!(
            "[goal_loop] continuation {turns_used}/{max_turns} enqueued (session={})",
            input.session_id
        ),
        Err(err) => warn!(
            "[goal_loop] continuation enqueue failed (session={}): {err}",
            input.session_id
        ),
    }
}

/// Broadcast a goal lifecycle event for the chat chip / status UI.
fn broadcast_goal_event(
    session_id: &str,
    status: &str,
    turns_used: u32,
    max_turns: u32,
    message: &str,
) {
    crate::bus::broadcast_event(
        "agent:goal_loop",
        serde_json::json!({
            "sessionId": session_id,
            "status": status,
            "turnsUsed": turns_used,
            "maxTurns": max_turns,
            "message": message,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verdict_parses_strict_json() {
        assert_eq!(
            parse_judge_verdict(r#"{"done": true, "reason": "all files created"}"#),
            JudgeVerdict::Done {
                reason: "all files created".to_string()
            }
        );
        assert_eq!(
            parse_judge_verdict(r#"{"done": false, "reason": "2 of 4 remain"}"#),
            JudgeVerdict::Continue {
                reason: "2 of 4 remain".to_string()
            }
        );
    }

    #[test]
    fn verdict_parses_json_wrapped_in_prose_or_fences() {
        let wrapped =
            "Sure — here is my verdict:\n```json\n{\"done\": true, \"reason\": \"ok\"}\n```";
        assert!(matches!(
            parse_judge_verdict(wrapped),
            JudgeVerdict::Done { .. }
        ));
    }

    #[test]
    fn verdict_fails_open_on_garbage() {
        assert!(matches!(
            parse_judge_verdict("I think it's probably done?"),
            JudgeVerdict::Continue { .. }
        ));
        assert!(matches!(
            parse_judge_verdict(""),
            JudgeVerdict::Continue { .. }
        ));
        assert!(matches!(
            parse_judge_verdict(r#"{"reason": "missing done"}"#),
            JudgeVerdict::Continue { .. }
        ));
    }

    #[test]
    fn judge_messages_tail_respects_char_boundaries() {
        // Multibyte content larger than the tail budget must not panic.
        let long = "界".repeat(3 * 1024); // 3 bytes each → 9KB
        let messages = build_judge_messages("goal", &long);
        assert_eq!(messages.len(), 2);
        let user = messages[1]["content"].as_str().unwrap();
        assert!(user.contains('…'));
    }

    mod store {
        use super::super::*;
        use test_helpers::test_env::sandbox;

        fn prepare() -> test_helpers::test_env::SandboxGuard {
            let guard = sandbox();
            let conn = get_connection().expect("test sqlite connection");
            init_schema(&conn).expect("goal_loop schema");
            let _ = conn.execute("DELETE FROM goal_loop_state", []);
            guard
        }

        #[test]
        fn user_message_sets_goal_and_resets_counter() {
            let _lock = prepare();
            on_user_message("s_goal", "fix every failing test", None);
            let state = load_state("s_goal").expect("state");
            assert_eq!(state.goal_text, "fix every failing test");
            assert_eq!(state.turns_used, 0);
            assert_eq!(state.status, "active");

            // Simulate consumed budget, then a fresh user message resets.
            save_state(&GoalState {
                session_id: "s_goal".to_string(),
                goal_text: "old".to_string(),
                turns_used: 5,
                status: "paused".to_string(),
            });
            on_user_message("s_goal", "new goal", None);
            let state = load_state("s_goal").expect("state");
            assert_eq!(state.goal_text, "new goal");
            assert_eq!(state.turns_used, 0);
            assert_eq!(state.status, "active");
        }

        #[test]
        fn empty_user_message_is_ignored() {
            let _lock = prepare();
            on_user_message("s_empty", "   ", None);
            assert!(load_state("s_empty").is_none());
        }

        #[test]
        fn clear_state_removes_row() {
            let _lock = prepare();
            on_user_message("s_clear", "goal", None);
            clear_state("s_clear");
            assert!(load_state("s_clear").is_none());
        }

        #[test]
        fn display_text_preferred_over_expanded_skill_content() {
            let _lock = prepare();
            // Simulate a pill-expanded user message: display_text is the short
            // form the user typed; content is the expanded SKILL.md body.
            let short_intent = "speckit-implement [skill:/speckit-implement]";
            let expanded_content = format!(
                "{}\n\n---\n**Referenced content (auto-expanded):**\n\n{}",
                short_intent,
                "x".repeat(12_000) // simulate large SKILL.md body
            );
            on_user_message("s_display", &expanded_content, Some(short_intent));
            let state = load_state("s_display").expect("state");
            // Goal text must reflect the user's intent, not the expanded body.
            assert_eq!(state.goal_text, short_intent);
        }

        #[test]
        fn display_text_ignored_when_longer_than_content() {
            let _lock = prepare();
            // If display_text is somehow longer (e.g. debug paths), fall back
            // to the raw content so the goal is never empty.
            let content = "short";
            let longer_display = "a very long display text that exceeds content length";
            on_user_message("s_longer", content, Some(longer_display));
            let state = load_state("s_longer").expect("state");
            assert_eq!(state.goal_text, content);
        }
    }
}
