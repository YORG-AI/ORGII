//! Post-turn background work.
//!
//! Fire-and-forget tasks that run after the user has received `agent:complete`:
//! session-memory extraction, workspace-memory extraction, and auto-dream consolidation.
//! Each helper is a thin wrapper around a `tokio::spawn` block — kept out of
//! `processor::process` so the core turn orchestration stays readable.
//!
//! All post-turn work is gated by `should_run_post_turn_work` on the caller
//! side; cancelled turns skip every branch (never do background LLM work for
//! a turn the user explicitly stopped).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::Mutex;
use tracing::{info, warn};

use super::super::persistence as unified_persistence;
use super::streaming::broadcast_agent_warning;
use crate::config::ReliabilityConfig;
use crate::memory::workspace_memory::auto_dream::{self as auto_dream, AutoDreamState};
use crate::memory::workspace_memory::extract::{self as extract_memories, ExtractMemoriesState};
use crate::model_context::session_memory::{self, SessionMemoryConfig, SessionMemoryState};
use crate::providers::LLMProvider;
use crate::session::workspace::SessionWorkspace;
use crate::tools::registry::ToolRegistry;
use core_types::providers::NativeHarnessType;

#[derive(Clone)]
pub(super) struct ForkProviderSpec {
    pub model: String,
    pub account_id: Option<String>,
    pub reliability: ReliabilityConfig,
    pub native_harness_type: Option<NativeHarnessType>,
    pub workspace: SessionWorkspace,
}

async fn fresh_fork_provider(spec: &ForkProviderSpec) -> Result<Arc<dyn LLMProvider>, String> {
    crate::providers::factory::create_provider_with_native_harness_preflight(
        &spec.model,
        spec.account_id.as_deref(),
        &spec.reliability,
        spec.native_harness_type,
        Some(spec.workspace.clone()),
    )
    .await
    .map(Arc::from)
    .map_err(|err| format!("Failed to create fork provider: {err}"))
}

// ── Session memory extraction (step 9b) ─────────────────────────────

/// Input bundle for [`spawn_session_memory_extraction`].
pub(super) struct SessionMemoryExtractionInput<'a> {
    pub session_id: &'a str,
    pub messages: &'a [Value],
    pub prompt_tokens: i64,
    pub tool_calls_count: u32,
    pub sm_state: Arc<Mutex<SessionMemoryState>>,
    pub sm_config: SessionMemoryConfig,
    pub fork_provider: ForkProviderSpec,
}

/// Spawn the session-memory extractor if `should_extract` returns true.
///
/// Runs with a 60s timeout. Persists the result to the SM-state DB on success;
/// broadcasts `agent:warning` on failure or timeout.
pub(super) async fn spawn_session_memory_extraction(input: SessionMemoryExtractionInput<'_>) {
    let SessionMemoryExtractionInput {
        session_id,
        messages,
        prompt_tokens,
        tool_calls_count,
        sm_state,
        sm_config,
        fork_provider,
    } = input;

    // Everything below — including the `sm_state.lock()` gate pre-check —
    // runs inside a detached task. This is the turn-completion hot path:
    // `dispatch_post_turn_work` awaits this fn and the scheduler only emits
    // the idle queue-status (which hides the "Planning…" footer) AFTER
    // `process()` returns. The previous version `await`ed the `sm_state.lock()`
    // pre-check directly here, so when the PRIOR turn's extractor still held
    // that lock across its (up-to-60s) LLM round-trip, this turn's completion
    // signal was blocked for the whole extraction. Spawning the entire body
    // keeps the function a true fire-and-forget so completion is instant.
    let sm_messages = messages.to_vec();
    let sm_session_id = session_id.to_string();

    tokio::spawn(async move {
        let current_tokens = if prompt_tokens > 0 {
            prompt_tokens as usize
        } else {
            crate::model_context::tokenizer::count_messages_tokens(&sm_messages)
        };
        let has_tool_calls = session_memory::last_turn_has_tool_calls(&sm_messages);
        let mut sm_state_guard = sm_state.lock().await;

        sm_state_guard.record_tool_calls(tool_calls_count as usize);

        if !session_memory::should_extract(
            &sm_state_guard,
            &sm_config,
            current_tokens,
            has_tool_calls,
        ) {
            return;
        }

        info!(
            "[unified_processor] Spawning async SM extraction for session {} (tokens={}, tc_since={})",
            sm_session_id, current_tokens, sm_state_guard.tool_calls_since_extraction
        );
        drop(sm_state_guard);

        const SM_TIMEOUT: Duration = Duration::from_secs(60);

        let extraction = async {
            let provider = fresh_fork_provider(&fork_provider).await?;
            // `extract_session_memory` now manages the `sm_state` lock
            // internally (brief prepare + finalize, never across the LLM
            // call), so we pass the Arc instead of holding the guard here.
            let result = session_memory::extract_session_memory(
                &sm_messages,
                sm_state.clone(),
                &sm_config,
                provider.as_ref(),
                &fork_provider.model,
            )
            .await;

            if let Ok(ref sm_content) = result {
                let sid = sm_session_id.clone();
                let content = sm_content.clone();
                let last_idx = sm_state.lock().await.last_summarized_msg_idx;
                tokio::task::block_in_place(|| {
                    if let Err(err) =
                        unified_persistence::save_session_memory_state(&sid, &content, last_idx)
                    {
                        warn!("[sm_extraction] Failed to persist SM state: {}", err);
                    }
                });

                let embed_cfg = crate::state::integrations_store::integrations_store()
                    .snapshot()
                    .embedding;
                let embedder = crate::memory::embeddings::AutoEmbeddingProvider::new(
                    embed_cfg.provider,
                    embed_cfg.model,
                );
                match crate::memory::embeddings::EmbeddingProvider::embed(&embedder, &content).await {
                    Ok(embedding) => {
                        let sid = sm_session_id.clone();
                        let content = content.clone();
                        let model = embedding.model.clone();
                        let vector = embedding.vector;
                        tokio::task::block_in_place(|| {
                            if let Err(err) = unified_persistence::save_session_memory_index(
                                &sid,
                                &content,
                                &vector,
                                Some(&model),
                            ) {
                                warn!("[sm_extraction] Failed to persist SM embedding index: {}", err);
                            }
                        });
                    }
                    Err(err) => {
                        warn!(
                            "[sm_extraction] Session-memory embedding failed for {}: {}",
                            sm_session_id, err
                        );
                    }
                }
            }
            result
        };

        match tokio::time::timeout(SM_TIMEOUT, extraction).await {
            Ok(Ok(_)) => {
                info!("[sm_extraction] Completed for session {}", sm_session_id);
            }
            Ok(Err(err)) => {
                warn!(
                    "[sm_extraction] Failed for session {}: {}",
                    sm_session_id, err
                );
                broadcast_agent_warning(
                    &sm_session_id,
                    &format!("Session memory extraction failed: {}", err),
                    "session_memory",
                );
            }
            Err(_elapsed) => {
                warn!(
                    "[sm_extraction] Timed out after {}s for session {}",
                    SM_TIMEOUT.as_secs(),
                    sm_session_id
                );
                broadcast_agent_warning(
                    &sm_session_id,
                    &format!(
                        "Session memory extraction timed out after {}s",
                        SM_TIMEOUT.as_secs()
                    ),
                    "session_memory",
                );
            }
        }
    });
}

// ── Extract memories (step 9c) ──────────────────────────────────────

/// Input bundle for [`spawn_extract_memories`].
pub(super) struct ExtractMemoriesInput<'a> {
    pub session_id: &'a str,
    pub ws_path: PathBuf,
    pub messages: &'a [Value],
    pub final_text: Option<&'a str>,
    pub em_state: Arc<Mutex<ExtractMemoriesState>>,
    pub fork_provider: ForkProviderSpec,
    pub tool_registry: Arc<ToolRegistry>,
}

/// Spawn the workspace-memory extractor agent if the gate conditions pass.
///
/// Gate stages:
/// 1. Skip if the main agent already wrote `memory_*` this turn — its
///    edits already captured the relevant facts; just advance the cursor
///    and return.
/// 2. If `should_extract` says no, stash-on-in-progress so a trailing run
///    picks up this transcript when the current fork completes. This is
///    what guarantees we never silently drop a transcript that arrived
///    while an extraction was already running.
/// 3. Spawn the fork; the task loops so it drains any pending trailing
///    transcript after its main extraction finishes, restoring the
///    "at most one extractor in flight, no transcript left behind"
///    invariant.
pub(super) async fn spawn_extract_memories(input: ExtractMemoriesInput<'_>) {
    let ExtractMemoriesInput {
        session_id,
        ws_path,
        messages,
        final_text,
        em_state,
        fork_provider,
        tool_registry,
    } = input;

    // Build synthetic transcript that includes the assistant's final reply.
    // For text-only turns execute_turn does NOT append the assistant message,
    // so count_new_messages would under-count and gate us off.
    let mut em_messages = messages.to_vec();
    if let Some(text) = final_text {
        if !text.is_empty() {
            em_messages.push(serde_json::json!({
                "role": "assistant",
                "content": text,
            }));
        }
    }
    let messages = em_messages;

    // Everything below — including the gate pre-checks that lock `em_state` —
    // runs inside a detached task. This is the turn-completion hot path:
    // `dispatch_post_turn_work` awaits this fn, and the scheduler only
    // broadcasts the idle queue-status (which hides the "Planning…" footer)
    // AFTER `process()` returns. The previous version `await`ed the
    // `em_state.lock()` gate pre-checks directly here, so when the PRIOR
    // turn's extractor still held that lock across its (minutes-long) LLM
    // round-trip, this turn's completion signal was blocked for the whole
    // extraction — the footer kept spinning "Figuring out what to do next…"
    // long after the agent had clearly finished. Spawning the entire body
    // keeps the function a true fire-and-forget so completion is instant.
    let sid = session_id.to_string();
    tokio::spawn(async move {
        run_extract_memories_task(RunExtractMemoriesTask {
            session_id: sid,
            ws_path,
            messages,
            em_state,
            fork_provider,
            tool_registry,
        })
        .await;
    });
}

struct RunExtractMemoriesTask {
    session_id: String,
    ws_path: PathBuf,
    messages: Vec<Value>,
    em_state: Arc<Mutex<ExtractMemoriesState>>,
    fork_provider: ForkProviderSpec,
    tool_registry: Arc<ToolRegistry>,
}

/// Owned-data body of [`spawn_extract_memories`], run inside a detached task.
///
/// Performs the gate pre-checks (Stages 1–2) and then the extraction loop.
/// All `em_state` lock contention lives here, off the turn-completion path.
async fn run_extract_memories_task(task: RunExtractMemoriesTask) {
    let RunExtractMemoriesTask {
        session_id,
        ws_path,
        messages,
        em_state,
        fork_provider,
        tool_registry,
    } = task;

    // Stage 1: main agent wrote memory → skip + advance cursor.
    let main_wrote = {
        let mut state = em_state.lock().await;
        extract_memories::skip_if_main_agent_wrote_memory(&mut state, &messages, ws_path.as_path())
    };

    let should_run = if main_wrote {
        false
    } else {
        let state = em_state.lock().await;
        extract_memories::should_extract(&state, &messages, Some(ws_path.as_path()))
    };

    // Stage 2: in_progress blocked us → stash for a trailing run.
    let stashed_for_trailing = !should_run && !main_wrote && {
        let state = em_state.lock().await;
        state.is_in_progress()
    };
    if stashed_for_trailing {
        let mut state = em_state.lock().await;
        extract_memories::stash_pending(&mut state, &messages);
        info!(
            "[extract_memories] Stashed trailing-run context for session {}",
            session_id
        );
    }

    if !should_run {
        let mut state = em_state.lock().await;
        extract_memories::record_turn(&mut state);
        return;
    }

    let sid = session_id;
    info!(
        "[unified_processor] Spawning extract_memories for session {}",
        sid
    );

    // Already inside a detached task (see `spawn_extract_memories`); run the
    // extraction loop inline. Loop until no pending trailing transcript
    // remains. Each iteration runs the extractor on the current transcript
    // and, if a new transcript was stashed while we were running, picks it up
    // on the next pass — guaranteeing every transcript is processed even when
    // extractions arrive faster than they finish.
    let mut current_msgs = messages;
    loop {
        // `fresh_fork_provider` and `run_extraction` both run WITHOUT holding
        // `em_state` — provider creation can do a network preflight and the
        // extractor runs a multi-iteration forked agent, neither of which may
        // block the next turn's brief `em_state` reads. `run_extraction`
        // manages the lock internally (brief prepare + finalize).
        let provider = match fresh_fork_provider(&fork_provider).await {
            Ok(provider) => provider,
            Err(err) => {
                warn!("[extract_memories] Failed for session {}: {}", sid, err);
                em_state.lock().await.clear_in_progress();
                break;
            }
        };
        let params = crate::memory::MemoryAgentParams {
            messages: &current_msgs,
            provider,
            model: &fork_provider.model,
            workspace: &ws_path,
            parent_tools: tool_registry.clone(),
            session_id: &sid,
            definitions_store: None,
        };
        if let Err(err) = extract_memories::run_extraction(em_state.clone(), params).await {
            warn!("[extract_memories] Failed for session {}: {}", sid, err);
            // Still drain pending to avoid stashed work becoming stuck.
        }
        let trailing = {
            let mut state = em_state.lock().await;
            extract_memories::take_pending(&mut state)
        };
        match trailing {
            Some(next) => {
                info!(
                    "[extract_memories] Running trailing extraction for session {}",
                    sid
                );
                current_msgs = next;
            }
            None => break,
        }
    }
}

// ── Auto-dream consolidation (step 9d) ──────────────────────────────

/// Input bundle for [`spawn_auto_dream`].
pub(super) struct AutoDreamInput<'a> {
    pub session_id: &'a str,
    pub ws_path: PathBuf,
    pub messages: Vec<Value>,
    pub ad_state: Arc<Mutex<AutoDreamState>>,
    pub fork_provider: ForkProviderSpec,
    pub tool_registry: Arc<ToolRegistry>,
}

/// Spawn periodic auto-dream consolidation if the gate says so.
pub(super) async fn spawn_auto_dream(input: AutoDreamInput<'_>) {
    let AutoDreamInput {
        session_id,
        ws_path,
        messages,
        ad_state,
        fork_provider,
        tool_registry,
    } = input;

    // Everything below — including the `ad_state.lock()` gate pre-check —
    // runs inside a detached task. This is the turn-completion hot path:
    // `dispatch_post_turn_work` awaits this fn and the scheduler only emits
    // the idle queue-status (which hides the "Planning…" footer) AFTER
    // `process()` returns. The previous version `await`ed the `ad_state.lock()`
    // pre-check directly here, so when the PRIOR turn's consolidation still
    // held that lock across its (minutes-long) LLM round-trip, this turn's
    // completion signal was blocked. Spawning the entire body keeps the
    // function a true fire-and-forget so completion is instant.
    let sid = session_id.to_string();
    tokio::spawn(async move {
        // Brief lock ONLY for the throttle gate + advance — never held across
        // the consolidation LLM call below.
        {
            let mut state = ad_state.lock().await;
            if !auto_dream::should_attempt(&state, &ws_path) {
                return;
            }
            state.mark_scan_now();
        }

        info!(
            "[unified_processor] Spawning auto_dream for session {}",
            sid
        );

        let params = crate::memory::MemoryAgentParams {
            messages: &messages,
            provider: match fresh_fork_provider(&fork_provider).await {
                Ok(provider) => provider,
                Err(err) => {
                    warn!("[auto_dream] Failed for session {}: {}", sid, err);
                    return;
                }
            },
            model: &fork_provider.model,
            workspace: &ws_path,
            parent_tools: tool_registry,
            session_id: &sid,
            definitions_store: None,
        };
        if let Err(err) = auto_dream::run_consolidation(params).await {
            warn!("[auto_dream] Failed for session {}: {}", sid, err);
        }
    });
}
