//! Per-turn execution pipeline.
//!
//! - [`entry`]: `process_message` — single entry point for all agent types
//! - [`processor`]: `UnifiedMessageProcessor` — orchestrates one LLM turn
//! - [`event_handler`]: `UnifiedEventHandler` — handles tool calls, persistence, hooks
//! - [`streaming`]: broadcast helpers + `StreamingError` types
//! - [`background_reminder`]: injects active background job context into prompts

/// `#[doc(hidden)]` because the only external caller is the
/// `app::api::agent::test::core::test_session_dump_background_reminder`
/// debug route, reached via `agent_core::debug::background_reminder`.
#[doc(hidden)]
pub mod background_reminder;
pub mod entry;
pub(crate) mod event_handler;
mod post_turn;
mod processor;
pub(crate) mod streaming;

/// `#[doc(hidden)]` because the only external caller is the
/// `app::api::agent::test::core` debug route, reached via
/// `agent_core::debug::turn_max_iterations_from_session_model`.
#[doc(hidden)]
pub fn turn_max_iterations_from_session_model(max_iterations: u32) -> Option<u32> {
    Some(max_iterations)
}

pub use entry::process_message;
pub use processor::TurnInput;

#[cfg(debug_assertions)]
#[doc(hidden)]
pub async fn debug_prefetch_zero_wait_probe(delay_ms: u64) -> serde_json::Value {
    use crate::core::turn_executor::TurnIterationHook;

    let hook = processor::prefetch::TurnPrefetchHook::test_with_delayed_outputs(
        std::time::Duration::from_millis(delay_ms),
        Some("# Prefetched Skills\n\nprobe-skill".to_string()),
        Some("# Workspace Memory\n\nprobe-memory".to_string()),
    );
    let mut messages = vec![
        serde_json::json!({"role": "system", "content": "stable"}),
        serde_json::json!({"role": "user", "content": "original task"}),
    ];

    let first_started = std::time::Instant::now();
    hook.before_llm_iteration("debug-prefetch-probe", 1, &mut messages)
        .await;
    let first_elapsed_ms = first_started.elapsed().as_millis();
    let first_snapshot = messages.clone();

    tokio::time::sleep(std::time::Duration::from_millis(
        delay_ms.saturating_add(25),
    ))
    .await;
    let second_started = std::time::Instant::now();
    hook.before_llm_iteration("debug-prefetch-probe", 2, &mut messages)
        .await;
    let second_elapsed_ms = second_started.elapsed().as_millis();

    serde_json::json!({
        "first_elapsed_ms": first_elapsed_ms,
        "second_elapsed_ms": second_elapsed_ms,
        "first_messages": first_snapshot,
        "second_messages": messages,
    })
}

#[cfg(debug_assertions)]
#[doc(hidden)]
pub async fn debug_prompt_cache_benchmark(
    session: std::sync::Arc<crate::state::AgentSession>,
) -> serde_json::Value {
    use super::types::AgentExecMode;
    use crate::core::session::turn::event_handler::EventHandlerConfig;
    use crate::core::session::turn::processor::{ProcessorParams, UnifiedMessageProcessor};

    let runtime = match session.runtime.read().await.clone() {
        Some(runtime) => runtime,
        None => {
            return serde_json::json!({
                "error": "Session runtime is not initialized"
            });
        }
    };

    session
        .invalidate_prompt_cache(
            crate::session::prompt::cache::PromptCacheInvalidationReason::SessionReset,
        )
        .await;

    let benchmark_model = runtime.model.clone();
    let benchmark_policy = std::sync::Arc::clone(&runtime.policy);
    let benchmark_tools = runtime
        .tool_registry
        .get_definitions_budgeted(benchmark_policy.as_ref());

    let processor = UnifiedMessageProcessor::new(ProcessorParams {
        policy: std::sync::Arc::clone(&runtime.policy),
        runtime,
        session: std::sync::Arc::clone(&session),
        channel: None,
        chat_id: None,
        agent_mode: Some(AgentExecMode::Build),
        ide_context: None,
        app_handle: None,
        screenshot_store: std::sync::Arc::new(shared_state::ScreenshotStore::new()),
        event_handler_config: EventHandlerConfig::default(),
    });

    let session_id = session.id.clone();
    let first_started = std::time::Instant::now();
    let first_system_prompt = processor.build_system_prompt(&session_id).await;
    let (first_dynamic_sections, _) = processor
        .build_dynamic_sections(&session_id, None, None)
        .await;
    let first_elapsed_us = first_started.elapsed().as_micros();
    let first_prompt_stats = session.prompt_cache.lock().await.stats();
    let first_learnings_stats = session.learnings_prompt_cache.lock().await.stats();
    let first_skill_stats = session.skill_listing_cache.lock().await.stats();
    let first_skill_delta = session.skill_listing_cache.lock().await.last_delta_stats();

    {
        session.prompt_cache.lock().await.reset_stats();
        session.learnings_prompt_cache.lock().await.reset_stats();
        session.skill_listing_cache.lock().await.reset_stats();
    }

    let second_started = std::time::Instant::now();
    let second_system_prompt = processor.build_system_prompt(&session_id).await;
    let (second_dynamic_sections, _) = processor
        .build_dynamic_sections(&session_id, None, None)
        .await;
    let second_elapsed_us = second_started.elapsed().as_micros();
    let second_prompt_stats = session.prompt_cache.lock().await.stats();
    let second_learnings_stats = session.learnings_prompt_cache.lock().await.stats();
    let second_skill_stats = session.skill_listing_cache.lock().await.stats();
    let second_skill_delta = session.skill_listing_cache.lock().await.last_delta_stats();

    let cache_break_probe_stats = {
        let system_blocks = vec![crate::session::prompt::cache::RenderedSystemBlock::new(
            second_system_prompt.0.clone(),
            crate::session::prompt::cache::RenderedSystemBlockScope::Session,
        )];
        let mut tracker = session.prompt_cache_break_tracker.lock().await;
        tracker.record(
            &system_blocks,
            Some(&benchmark_tools),
            &benchmark_model,
            100,
            0,
            100,
        );
        tracker.record(
            &system_blocks,
            Some(&benchmark_tools),
            &benchmark_model,
            100,
            0,
            90,
        );
        tracker.stats()
    };

    serde_json::json!({
        "firstElapsedUs": first_elapsed_us,
        "secondElapsedUs": second_elapsed_us,
        "speedupRatio": if second_elapsed_us == 0 {
            serde_json::Value::Null
        } else {
            serde_json::json!(first_elapsed_us as f64 / second_elapsed_us as f64)
        },
        "firstPromptStats": first_prompt_stats,
        "secondPromptStats": second_prompt_stats,
        "firstLearningsPromptStats": first_learnings_stats,
        "secondLearningsPromptStats": second_learnings_stats,
        "firstSkillListingStats": first_skill_stats,
        "secondSkillListingStats": second_skill_stats,
        "firstSkillListingDelta": first_skill_delta,
        "secondSkillListingDelta": second_skill_delta,
        "cacheBreakProbeStats": cache_break_probe_stats,
        "systemPromptsEqual": first_system_prompt == second_system_prompt,
        "dynamicSectionsEqual": first_dynamic_sections == second_dynamic_sections,
        "secondDynamicSectionsSuppressedSkillListing": second_dynamic_sections.len() < first_dynamic_sections.len(),
        "systemPromptBytes": second_system_prompt.0.len(),
        "volatilePromptBytes": second_system_prompt.1.len(),
        "dynamicSectionCount": second_dynamic_sections.len(),
        "dynamicSectionBytes": second_dynamic_sections.iter().map(|section| section.len()).sum::<usize>(),
    })
}

/// Re-export for the boot path: `lib.rs` installs the production
/// `MemberShutdownHook` here. Keeping the rest of `processor` private
/// (sister modules such as `compaction`/`execute` are turn-pipeline
/// internals).
pub mod inbox_drain {
    pub use super::processor::inbox_drain::*;
}

/// Re-export for the boot path: `lib.rs` installs the production
/// `MemberIdleHook` here. The processor's success path uses
/// `maybe_emit_member_idle` to fire a `MemberIdle` notification to the
/// coordinator's inbox at every member-turn end.
pub mod member_idle {
    pub use super::processor::member_idle::*;
}
