//! Turn orchestration.
//!
//! [`UnifiedMessageProcessor::process`] — the single entry point that runs one
//! LLM turn end to end: persist the user message, load history, start
//! prefetch, build the prompt, repair/compact the message list, execute the
//! turn, record usage, and dispatch post-turn work.

use serde_json::Value;
use std::sync::atomic::Ordering;
use tracing::{info, warn};

use crate::core::session::prompt::cache::RenderedSystemBlockScope;
use crate::core::session::types::{DialogTurnState, ProcessingContext, ProcessingResult};

use super::compaction::CompactionPhaseOutcome;
use super::message_shaping::{reconcile_inbox_transcript_replay, scoped_system_message};
use super::{
    inbox_drain, member_idle, post_turn_dispatch, unified_persistence, UnifiedMessageProcessor,
};

impl UnifiedMessageProcessor {
    pub async fn process(
        &self,
        session_id: &str,
        content: &str,
        context: ProcessingContext,
    ) -> Result<ProcessingResult, String> {
        // 0. Use the AgentSession turn id when available so active_turn,
        // live stream broadcasts, and terminal markers describe the same turn.
        let turn_id = context
            .turn_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        // Anchor for the receipt-fallback audit window: CLI writes during
        // this turn carry occurred_at >= this instant.
        let turn_started_at_ms = chrono::Utc::now().timestamp_millis();

        // Any newly accepted turn means the session is active again. Cancel
        // coordinator generations left by the prior turn (especially the
        // quiescence-debounced reflection/observation jobs) before they can
        // race the new transcript.
        crate::memory::background::cancel_memory_jobs_for_session(session_id);

        // 0b. Restore persisted SM state on first turn (lazy init)
        if self.sm_config.enabled {
            let mut sm_state = self.sm_state.lock().await;
            if !sm_state.initialized && sm_state.content.is_none() {
                let sid = session_id.to_string();
                let restored = tokio::task::block_in_place(|| {
                    unified_persistence::load_session_memory_state(&sid)
                });
                if let Ok(persisted) = restored {
                    if persisted.content.is_some() {
                        info!(
                            "[unified_processor] Restored SM state from disk for session {} ({} chars)",
                            session_id,
                            persisted.content.as_ref().map(|c| c.len()).unwrap_or(0),
                        );
                        sm_state.content = persisted.content;
                        sm_state.last_summarized_seq = persisted.last_seq;
                        sm_state.initialized = true;
                    }
                }
            }
        }

        // 1a. Take pre-message snapshot (if enabled)
        self.take_pre_message_snapshot(session_id).await;

        // 1. Persist user message
        //
        // For a Resume turn the frontend sends content="" so no new user message
        // is visible — the original user prompt that caused the error is still the
        // last user row in the DB and serves as the turn anchor.  Persisting an
        // empty string here would insert {"role":"user","content":""} into the
        // LLM history, which causes Anthropic/Kimi to return HTTP 400
        // ("text content is empty") on the very next request.
        let should_save_user_msg = !(context.is_resume && content.is_empty());
        if should_save_user_msg {
            let message_id = tokio::task::block_in_place(|| {
                unified_persistence::save_user_msg(session_id, content, context.images.as_deref())
            })
            .map_err(|err| format!("Failed to save user message: {}", err))?;

            if let Some(handle) = self.app_handle.as_ref() {
                if let Err(err) = tokio::task::block_in_place(|| {
                    crate::bus::event_pipeline_bridge::persist_user_message_event(
                        handle,
                        session_id,
                        &message_id,
                        content,
                        context.display_text.as_deref(),
                        context.images.as_deref(),
                        crate::bus::event_pipeline_bridge::PersistedUserMessageSource::User,
                        context.turn_intent_id.as_str(),
                    )
                }) {
                    tracing::warn!(
                        session_id,
                        error = %err,
                        "[unified_processor] failed to persist user-message UI event"
                    );
                }
            }
        }

        // 2. Load history once, after the user message is persisted. The provider request
        // must see the same DB snapshot; load failures must fail the turn instead of
        // silently becoming an empty transcript.
        let history =
            tokio::task::block_in_place(|| unified_persistence::load_llm_history(session_id))
                .map_err(|err| format!("Failed to load LLM history: {}", err))?;

        // 2b. Skill + memory relevance prefetch.
        //
        // Start side queries here, but do not await them on the hot path.
        // `TurnPrefetchHook` performs a
        // zero-wait collect before each LLM iteration; if a side query is still
        // pending, the first token/tool call is not delayed.
        {
            let mut hook_slot = self.turn_prefetch_hook.lock().await;
            if let Some(previous_hook) = hook_slot.take() {
                previous_hook.abort_pending();
            }
            *hook_slot = self
                .start_turn_prefetch(session_id, content, &history)
                .await;
        }

        // 3. Build system prompt, split into the stable cacheable prefix and
        // the volatile per-turn body (environment/IDE/presence/mode suffix).
        let (system_prompt, volatile_prompt) = self.build_system_prompt(session_id).await;

        // 4. Build provider messages from the already-loaded history.
        let mut messages: Vec<Value> = Vec::with_capacity(history.len() + 3);

        // Stable system prefix (cacheable across turns).
        messages.push(scoped_system_message(
            system_prompt,
            RenderedSystemBlockScope::Session,
        ));
        messages.extend(history);

        // 4b. Interrupt/crash repair.
        //
        // A user-initiated Stop is already represented by the persisted
        // `last_turn_cancelled` bit. Consume that bit here so crash-recovery
        // heuristics do not treat the prior partial turn as an unclean crash,
        // but do not inject a synthetic user message into the next normal turn:
        // providers may over-prioritize that sentinel and answer it instead of
        // the fresh user message.
        let previous_turn_cancelled = unified_persistence::take_turn_cancelled(session_id);
        let suppress_crash_repair = self
            .session
            .suppress_next_crash_repair
            .swap(false, Ordering::SeqCst);
        if previous_turn_cancelled {
            let removed = super::super::super::recovery::filter_unresolved_tool_uses(&mut messages);
            info!(
                "[unified_processor] Previous turn was cancelled — consumed marker and filtered {} orphan tool_use message(s) without injecting interrupt sentinel (session={})",
                removed, session_id
            );
        }

        if context.is_resume {
            self.session
                .invalidate_prompt_cache(
                    crate::session::prompt::cache::PromptCacheInvalidationReason::Resume,
                )
                .await;
            let removed = super::super::super::recovery::filter_unresolved_tool_uses(&mut messages);
            if removed > 0 {
                info!(
                    "[unified_processor] Resume: filtered {} orphan tool_use message(s) for session {}",
                    removed, session_id
                );
            }
        } else if !previous_turn_cancelled
            && !suppress_crash_repair
            // With a fresh user prompt at the tail, pairing is restored by
            // `ensure_tool_result_pairing` below, and the "continue from
            // where you left off" nudge would land AFTER the fresh prompt —
            // misdirecting the model to resume stale work instead of
            // answering the user. Only run crash repair when the history
            // actually ends mid-turn.
            && messages
                .last()
                .map(crate::turn_executor::msg_role)
                != Some("user")
            && super::super::super::recovery::repair_interrupted_history(&mut messages)
        {
            info!(
                "[unified_processor] Repaired interrupted turn for session {}",
                session_id
            );
        }

        if super::super::super::recovery::ensure_tool_result_pairing(&mut messages) {
            info!(
                "[unified_processor] Normalized tool_result pairing before pre-turn context work for session {}",
                session_id
            );
        }

        // 4c. Agent-org inbox drain.
        //
        // For sessions running inside an `AgentOrgRun`, fetch every
        // unread `agent_inbox` row addressed to this agent within this
        // run, render them as a typed user attachment, and append a
        // single trailing user message — keeping the turn-boundary
        // invariant (no insertion between an open `tool_use` and its
        // `tool_result`). Sessions that don't belong to an org run
        // skip this entirely.
        //
        // Done after 4c so the skill-prefetch prefix still binds to
        // the original user input, not to the inbox attachment — the
        // attachment is its own message and stands alone.
        // The drain has two outputs:
        // 1. XML attachment appended to the in-memory provider `messages`.
        // 2. Human-readable transcript persisted as this turn's visible input.
        //
        // Persist the transcript before executing the LLM so chat history keeps
        // the same order as Claude Code team mode: incoming teammate/mailbox
        // messages are part of the turn input, not a post-response artifact.
        // Once that durable write succeeds, the inbox rows can be marked read;
        // if the LLM call fails, the next turn still sees the message through
        // normal history rather than silently losing it.
        if context.is_resume && content.trim().is_empty() {
            if let Some(org_context) = self.runtime.agent_org_context.as_ref() {
                let running = matches!(
                    crate::coordination::agent_org_runs::AgentOrgRunStore::get_run_status(
                        &org_context.run_id
                    ),
                    Ok(Some(
                        crate::coordination::agent_org_runs::AgentOrgRunStatus::Running
                    ))
                );
                if !running {
                    // Fail closed before inbox drain/provider invocation. The
                    // unread rows stay durable for a later explicit resume.
                    info!(run_id = %org_context.run_id, session_id = %session_id, "[unified_processor] queued Agent Org wake cancelled because run is no longer running");
                    return Ok(ProcessingResult {
                        turn_id,
                        ..ProcessingResult::default()
                    });
                }
            }
        }

        let message_count_before_inbox = messages.len();
        let mut inbox_had_real_input = false;
        let mut inbox_guard = self.runtime.agent_org_context.as_ref().map(|org_context| {
            inbox_drain::drain_and_render_deferred(
                org_context,
                &self.agent_id,
                self.runtime.agent_org_current_member_id.as_deref(),
                &mut messages,
                Some(self.session.as_ref()),
            )
        });
        if let Some(guard) = inbox_guard.as_mut() {
            inbox_had_real_input = guard.has_pending_input();
            if let Some(transcript_content) = guard.transcript_content() {
                if !transcript_content.trim().is_empty() {
                    let (stable_message_id, stable_intent_id) = guard
                        .transcript_identity(session_id)
                        .expect("a non-empty drained transcript has stable source row ids");
                    let (materialization, inserted) = tokio::task::block_in_place(|| {
                        unified_persistence::materialize_agent_org_inbox_transcript(
                            session_id,
                            guard.new_materialization_ids(),
                            &stable_message_id,
                            &stable_intent_id,
                            transcript_content,
                        )
                    })
                    .map_err(|err| {
                        format!("Failed to materialize Agent Org inbox transcript: {err}")
                    })?;

                    if !inserted {
                        // The stable transcript row is already part of the
                        // history loaded at the beginning of this turn. Drain
                        // appended the same attachment once more in memory;
                        // remove only that newly-rendered tail so the provider
                        // sees one copy, while leaving the source inbox rows
                        // unread until this replayed turn succeeds.
                        reconcile_inbox_transcript_replay(
                            &mut messages,
                            message_count_before_inbox,
                            inserted,
                        );
                    }
                    guard.remember_materialization(materialization);
                }
            }

            if let Some(handle) = self.app_handle.as_ref() {
                // Ensure every durable transcript has its matching stable UI
                // event on both first delivery and replay. Persistence happens
                // before the in-memory merge; failure leaves source rows unread
                // and aborts the provider call so the next Wake can repair it.
                for materialization in guard.materializations() {
                    tokio::task::block_in_place(|| {
                        crate::bus::event_pipeline_bridge::persist_user_message_event(
                            handle,
                            session_id,
                            &materialization.message_id,
                            &materialization.content,
                            None,
                            None,
                            crate::bus::event_pipeline_bridge::PersistedUserMessageSource::AgentOrgInboxTranscript,
                            &materialization.intent_id,
                        )
                    })
                    .map_err(|err| {
                        format!("Failed to persist Agent Org inbox transcript event: {err}")
                    })?;
                }
            }
        }

        // An Agent Org wake is only a doorbell. If another worker consumed the
        // work before this turn started, do not manufacture an empty user
        // nudge and spend a provider call. A later unread inbox row or
        // explicit TaskAssigned delivery will trigger a fresh wake.
        if context.is_resume
            && content.trim().is_empty()
            && self.runtime.agent_org_context.is_some()
            && !inbox_had_real_input
            && messages.len() == message_count_before_inbox
        {
            info!(session_id = %session_id, "[unified_processor] Agent Org wake had no durable work; returning WakeNoop");
            return Ok(ProcessingResult {
                turn_id,
                ..ProcessingResult::default()
            });
        }

        // 4d. Subagent-wake prefill safety net.
        //
        // A background-job completion (subagent or backgrounded shell)
        // resumes the owner with empty content (no persisted user row → same
        // round, no new bubble). But a plain SDE session has no inbox_drain
        // to append a trailing user message, so the conversation can still
        // end on the owner's last assistant turn ("已在后台启动。").
        // Providers (Anthropic, OpenAI) reject that with HTTP 400
        // "conversation must end with a user message". When a resume leaves
        // an assistant-tailed message list, append a single TRANSIENT user
        // nudge — in-memory only, never persisted, so it neither creates a
        // round nor a visible bubble. Mirrors inbox_drain's transient
        // injection, generalized to the SDE path.
        if context.is_resume {
            Self::inject_job_wake_nudge_if_needed(&mut messages, session_id);
        }

        // 5/5b/6. Pre-turn message-list compaction (microcompact +
        // aggregate budget + LLM context compaction + compact-fork).
        if let CompactionPhaseOutcome::ForkRedirect(redirect) = self
            .run_pre_turn_compaction(session_id, &mut messages)
            .await
        {
            if let Some(prefetch_hook) = self.turn_prefetch_hook.lock().await.take() {
                prefetch_hook.abort_pending();
            }
            return Ok(redirect);
        }

        // Optional MiniCPM sidecar overlay. The canonical transcript and the
        // existing automatic/manual compaction state remain untouched: this
        // replaces a validated old prefix only in the provider request view.
        // Apply it after the normal compaction pipeline so that pipeline keeps
        // its original trigger, persistence, and compact-fork semantics.
        match tokio::task::block_in_place(|| {
            crate::session::housekeeper_compaction::apply_overlay(
                session_id,
                &mut messages,
            )
        }) {
            Ok(crate::session::housekeeper_compaction::OverlayOutcome::Applied {
                covered_messages,
            }) => info!(
                "[unified_processor] Applied MiniCPM context overlay for session {} ({} canonical messages covered)",
                session_id, covered_messages
            ),
            Ok(_) => {}
            Err(err) => warn!(
                "[unified_processor] MiniCPM context overlay skipped for session {}: {}",
                session_id, err
            ),
        }

        // Build dynamic context only after every no-provider early return
        // (terminal/paused wake, WakeNoop, compact-fork redirect). For a
        // coordinator this stages the exact work revision rendered into the
        // live task-board snapshot. A later successful provider turn may
        // observe that revision; an empty wake must never consume it.
        let (dynamic_sections, coordinator_presented_work_revision) = self
            .build_dynamic_sections(session_id, None, Some(content))
            .await;

        if super::super::super::recovery::ensure_tool_result_pairing(&mut messages) {
            info!(
                "[unified_processor] Normalized tool_result pairing before provider request for session {}",
                session_id
            );
        }

        // 6c. Volatile context reminder — the per-turn system-prompt body
        // (environment/IDE/presence/mode suffix) plus the dynamic sections,
        // appended AFTER the history as a `<system-reminder>` user message
        // (or folded into a trailing tool result — see
        // `attach_volatile_context_reminder` for the shape guard).
        // Anything placed before the history would change every turn and
        // invalidate the provider prompt-cache prefix for the whole
        // conversation; at the tail it sits after the sliding cache
        // breakpoint instead. Never persisted — rebuilt fresh each turn.
        {
            let mut volatile_parts: Vec<String> = Vec::new();
            if !volatile_prompt.is_empty() {
                volatile_parts.push(volatile_prompt);
            }
            volatile_parts.extend(dynamic_sections);
            if !volatile_parts.is_empty() {
                crate::session::prompt::cache::attach_volatile_context_reminder(
                    &mut messages,
                    &volatile_parts.join("\n\n"),
                );
            }
        }

        // 7. Execute turn (with reactive ContextTooLong recovery).
        // Reasoning trigger words are detected on the CURRENT user input
        // only (never history) so escalation stays per-turn.
        let reasoning_trigger = crate::providers::thinking_mode::detect_reasoning_trigger(content);
        let projected_inbox_ids = inbox_guard
            .as_ref()
            .map(|guard| guard.pending_ids().to_vec())
            .unwrap_or_default();
        let turn_result = self
            .execute_turn_with_reactive_retry(
                session_id,
                &turn_id,
                &mut messages,
                reasoning_trigger,
                &context.turn_intent_id,
                projected_inbox_ids,
            )
            .await;
        if let Some(prefetch_hook) = self.turn_prefetch_hook.lock().await.take() {
            prefetch_hook.abort_pending();
        }
        let (result, handler) = turn_result?;

        let response_text = result.content.clone().unwrap_or_default();
        let tool_calls_count = handler.tool_call_count();

        // Flush any pending streaming content before completing the turn.
        handler.flush_streaming(session_id);

        // Update nag-reminder counter based on whether manage_todo was called
        // during this turn. Reset to 0 on any todo call; increment otherwise.
        // (An uninitialized counter stays None — the read path lazily rebuilds
        // it from the transcript, which already includes this turn's rows.)
        {
            let mut rounds = self.rounds_since_todo.lock().await;
            if handler.todo_was_called() {
                *rounds = Some(0);
            } else if let Some(r) = rounds.as_mut() {
                *r = r.saturating_add(1);
            }
        }

        // Same cadence tracking for the subagent-delegation reminder: an
        // `agent` call proves the model remembers delegation, so reset.
        {
            let mut rounds = self.rounds_since_subagent_reminder.lock().await;
            if handler.agent_was_called() {
                *rounds = Some(0);
            } else if let Some(r) = rounds.as_mut() {
                *r = r.saturating_add(1);
            }
        }

        // Assistant-message persistence is driven per-iteration from
        // `turn_executor::execute_turn` via `TurnEventHandler::on_assistant_iteration_complete`,
        // so the full say-then-tool-then-say transcript is preserved.

        // 8. Record token usage
        self.record_token_usage(session_id, &result);
        self.record_usage_telemetry(session_id, &turn_id, &result);

        let final_turn_state = if self
            .session
            .cancel_flag
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            DialogTurnState::Cancelled
        } else {
            DialogTurnState::Completed
        };

        // A successful provider response is not enough when the user pressed
        // Stop concurrently. Only a genuinely Completed turn acknowledges
        // Inbox input. On Cancelled, dropping the guard preserves unread rows;
        // the durable transcript receipt makes the later retry idempotent.
        if matches!(final_turn_state, DialogTurnState::Completed) {
            if let Some(guard) = inbox_guard.take() {
                guard.commit();
            }
        }

        if matches!(final_turn_state, DialogTurnState::Completed) {
            if let (Some(org_context), Some(presented_work_revision)) = (
                self.runtime.agent_org_context.as_ref(),
                coordinator_presented_work_revision,
            ) {
                if self.runtime.agent_org_current_member_id.as_deref()
                    == Some(crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID)
                {
                    let run_id = org_context.run_id.clone();
                    match tokio::task::spawn_blocking(move || {
                        crate::coordination::agent_org_runs::AgentOrgRunStore::mark_coordinator_observed_work_revision(
                            &run_id,
                            presented_work_revision,
                        )
                    })
                    .await
                    {
                        Ok(Ok(_)) => {}
                        Ok(Err(error)) => warn!(
                            run_id = %org_context.run_id,
                            presented_work_revision,
                            error = %error,
                            "[unified_processor] failed to record Agent Org work revision observed by coordinator provider turn"
                        ),
                        Err(error) => warn!(
                            run_id = %org_context.run_id,
                            presented_work_revision,
                            error = %error,
                            "[unified_processor] coordinator work-revision observation task failed"
                        ),
                    }
                }
            }
        }

        info!(
            "[unified_processor] Turn {}: session={}, state={:?}, tokens={}, tool_calls={}",
            turn_id, session_id, final_turn_state, result.total_tokens, tool_calls_count
        );

        // 9–10. Post-turn dispatch (broadcast, Stop hook, CU lock,
        // session-memory / extract-memories / auto-dream / digest spawns).
        // The SM gate inputs are computed here because the dispatcher no
        // longer sees the in-memory transcript: provider-reported prompt
        // tokens when available, a local count only as fallback.
        let sm_current_tokens = if result.prompt_tokens > 0 {
            result.prompt_tokens as usize
        } else {
            crate::model_context::tokenizer::count_messages_tokens(&messages)
        };
        let sm_last_turn_has_tool_calls =
            crate::model_context::session_memory::last_turn_has_tool_calls(&messages);
        self.dispatch_post_turn_work(post_turn_dispatch::PostTurnInputs {
            session_id,
            turn_id: &turn_id,
            response_text: &response_text,
            result: &result,
            tool_calls_count,
            final_turn_state,
            turn_started_at_ms,
            sm_current_tokens,
            sm_last_turn_has_tool_calls,
        })
        .await;

        // 11. Agent-org member-idle notification.
        //
        // If this session is a worker in an agent-org run, post a
        // `MemberIdle` envelope to the coordinator's inbox so the
        // coordinator's next turn-boundary drain renders a
        // `<member_idle .../>` line and the leader's LLM is told the
        // worker is now available again. No-op for the coordinator
        // itself and for non-org sessions; see
        // `member_idle::maybe_emit_member_idle` for the gating.
        //
        // Covers success and interrupted transitions. Failed member turns
        // are emitted from lifecycle finalization after `process` returns
        // an error, so model/provider failures still notify the coordinator.
        let idle_reason = match final_turn_state {
            DialogTurnState::Cancelled => {
                crate::coordination::agent_inbox::MemberIdleReason::Interrupted
            }
            _ => crate::coordination::agent_inbox::MemberIdleReason::Available,
        };
        let unfinished_task_ids = match self
            .runtime
            .agent_org_context
            .as_ref()
            .zip(self.runtime.agent_org_current_member_id.as_deref())
        {
            Some((org_context, member_id)) => {
                match member_idle::unfinished_build_task_ids_for_member(
                    &org_context.run_id,
                    member_id,
                ) {
                    Ok(task_ids) => task_ids,
                    Err(error) => {
                        warn!(
                            run_id = %org_context.run_id,
                            member_id = %member_id,
                            error = %error,
                            "failed to inspect unfinished Agent Org tasks before MemberIdle"
                        );
                        Vec::new()
                    }
                }
            }
            None => Vec::new(),
        };
        member_idle::maybe_emit_member_idle_with_details(
            self.runtime.agent_org_context.as_ref(),
            self.runtime.agent_org_current_member_id.as_deref(),
            idle_reason,
            self.agent_mode,
            None,
            None,
            unfinished_task_ids,
        );

        Ok(ProcessingResult {
            turn_id,
            content: response_text,
            total_tokens: result.total_tokens,
            prompt_tokens: result.prompt_tokens,
            completion_tokens: result.completion_tokens,
            tool_calls_count,
            truncated: false,
            turn_summary: None,
            fork_redirect: None,
        })
    }
}
