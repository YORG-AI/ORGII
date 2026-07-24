//! Forked-agent runner for memory extraction.
//!
//! Spawns the `builtin:memory-extractor` agent against the parent's
//! prompt-cache-shared message history, with a restricted tool policy
//! that allows reads everywhere but writes only inside the workspace's
//! workspace-memory directory. Mutates the cursor + overlap-guard fields on
//! `ExtractMemoriesState` once the fork returns.

use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::definitions::builtin::MEMORY_EXTRACTOR_ID;
use crate::definitions::resolve_definition_by_id;
use crate::tools::names as tool_names;
use crate::tools::registry::ToolRegistry;
use crate::turn_executor::{self, TurnConfig};

use super::gating::count_new_messages;
use super::state::ExtractMemoriesState;

/// Max iterations for the extraction forked agent.
const MAX_EXTRACTION_TURNS: u32 = 5;

/// Run extraction as a fire-and-forget background task.
///
/// This spawns a forked agent that:
/// 1. Inherits the parent conversation as message prefix (prompt cache sharing)
/// 2. Gets the extraction prompt as its user message
/// 3. Has a restricted tool set (read-only + edit within memory dir)
/// 4. Runs for at most MAX_EXTRACTION_TURNS iterations
pub async fn run_extraction(
    em_state: Arc<Mutex<ExtractMemoriesState>>,
    params: super::super::super::MemoryAgentParams<'_>,
) -> Result<(), String> {
    // ── Prepare: brief lock to flag in-progress + read the cursor. The mutex
    // is NOT held across the fork/LLM call below — otherwise the next turn's
    // brief `em_state` reads (the gate pre-check that decides whether to
    // stash) would block for the whole extraction. The `in_progress` flag
    // (kept true until finalize) is what preserves the "at most one extractor"
    // invariant during the lock-free window.
    let last_processed_idx = {
        let mut state = em_state.lock().await;
        state.in_progress = true;
        state.turns_since_extraction = 0;
        state.last_processed_idx
    };

    let workspace = params.workspace;
    let mem_dir = super::super::memory_dir(workspace);

    if let Err(err) = std::fs::create_dir_all(&mem_dir) {
        em_state.lock().await.in_progress = false;
        return Err(format!("Failed to create memory dir: {}", err));
    }

    let agent_def =
        match resolve_definition_by_id(MEMORY_EXTRACTOR_ID, params.definitions_store.as_deref()) {
            Ok(def) => def,
            Err(err) => {
                em_state.lock().await.in_progress = false;
                return Err(format!(
                    "Agent definition not found: {}: {}",
                    MEMORY_EXTRACTOR_ID, err
                ));
            }
        };

    let messages = params.messages;
    let new_count = count_new_messages(messages, last_processed_idx);
    let existing_memories =
        super::super::format_memory_manifest(&super::super::scan_memory_files(&mem_dir));
    let user_prompt = build_extraction_prompt(new_count, &existing_memories, &mem_dir);

    // Shadow mode: the fork sees the *same* tool list as the parent —
    // tools are part of the prompt cache key, so sharing them preserves
    // cache hits. What the fork is *allowed* to invoke is gated at
    // runtime by `memory_policy`, not by pruning the registry.
    let effective_registry: Arc<ToolRegistry> = params.parent_tools.clone();
    let effective_policy = super::super::build_memory_policy();

    // Prompt-cache-critical: clone the parent transcript VERBATIM (system
    // message included). Re-stringifying the system content through
    // `as_str()` silently turned structured block arrays into "" and any
    // re-serialization breaks byte-identity with the parent request, so the
    // fork stopped sharing the parent prompt cache prefix entirely. The only
    // addition allowed is the extraction instruction appended at the tail.
    let mut fork_messages = Vec::with_capacity(messages.len() + 1);
    fork_messages.extend(messages.iter().cloned());
    fork_messages.push(serde_json::json!({
        "role": "user",
        "content": user_prompt,
    }));

    let turn_config = TurnConfig {
        turn_intent_id: String::new(),
        projected_inbox_ids: Vec::new(),
        model: params.model.to_string(),
        account_id: None,
        context_window_override: None,
        max_iterations: Some(MAX_EXTRACTION_TURNS),
        max_tokens: agent_def.max_tokens.unwrap_or(4096) as u32,
        temperature: agent_def.temperature.unwrap_or(0.0) as f32,
        max_tool_use_concurrency: agent_def
            .max_tool_use_concurrency
            .unwrap_or(crate::core::definitions::schema::DEFAULT_MAX_TOOL_USE_CONCURRENCY)
            as usize,
        screenshot_store: None,
        iteration_hook: None,
        persist_cancel_marker: false,
        steering_queue: None,
        auto_continue: false,
    };

    let session_id = params.session_id;
    let subagent_session_id = format!("extract-mem-{}-{}", session_id, uuid::Uuid::new_v4());

    let handler = super::NoopEventHandler;

    info!(
        "[extract_memories] Starting extraction: session={}, new_messages={}, memory_dir={}",
        session_id,
        new_count,
        mem_dir.display()
    );

    let result = turn_executor::execute_turn(
        &mut fork_messages,
        params.provider.as_ref(),
        effective_registry.as_ref(),
        &effective_policy,
        &turn_config,
        &subagent_session_id,
        &handler,
        None,
        None,
        None,
    )
    .await;

    // ── Finalize: brief lock to clear the in-progress flag + advance the
    // cursor on success.
    let mut state = em_state.lock().await;
    state.in_progress = false;

    match result {
        Ok(turn_result) => {
            state.last_processed_idx = Some(messages.len().saturating_sub(1));

            info!(
                "[extract_memories] Completed: session={}, tokens={}",
                session_id, turn_result.total_tokens
            );
            Ok(())
        }
        Err(err) => {
            warn!(
                "[extract_memories] Error: session={}, err={}",
                session_id, err
            );
            Err(format!("Extraction failed: {}", err))
        }
    }
}

/// Build the extraction user prompt.
fn build_extraction_prompt(
    new_message_count: usize,
    existing_memories: &str,
    mem_dir: &std::path::Path,
) -> String {
    let manifest = if existing_memories.is_empty() {
        String::new()
    } else {
        format!(
            "\n\n## Existing memory files\n\n{}\n\nCheck this list before writing — update an existing file rather than creating a duplicate.",
            existing_memories
        )
    };

    let mem_dir_str = mem_dir.display();

    format!(
        r#"You are now acting as the memory extraction subagent. Analyze the most recent ~{count} messages above and use them to update your persistent memory systems.

Available tools: {read}, {search}, {list_dir}, read-only {shell} (ls/find/cat/stat/wc/head/tail and similar), and {edit} for paths inside {dir} only. All other tools will be denied.

You have a limited turn budget. {edit} requires a prior {read} of the same file, so the efficient strategy is: turn 1 — issue all {read} calls in parallel for every file you might update; turn 2 — issue all {edit} calls in parallel. Do not interleave reads and writes across multiple turns.

You MUST only use content from the last ~{count} messages to update your persistent memories. Do not waste any turns attempting to research or verify that content further — no grepping source files, no reading code to confirm a pattern exists, no git commands.{manifest}

{save_on_request}

{types}
{not_to_save}

{how_to_save}"#,
        count = new_message_count,
        read = tool_names::READ_FILE,
        search = tool_names::CODE_SEARCH,
        list_dir = tool_names::LIST_DIR,
        shell = tool_names::RUN_SHELL,
        edit = tool_names::EDIT_FILE,
        dir = mem_dir_str,
        manifest = manifest,
        save_on_request = super::super::prompt_sections::SAVE_ON_EXPLICIT_REQUEST,
        types = super::super::prompt_sections::TYPES_SECTION,
        not_to_save = super::super::prompt_sections::WHAT_NOT_TO_SAVE,
        how_to_save = super::super::prompt_sections::how_to_save_section(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_build_extraction_prompt_content() {
        let prompt = build_extraction_prompt(
            10,
            "- [user] prefs.md (2024-04-07): User preferences",
            Path::new("/tmp/memory"),
        );

        assert!(prompt.contains("memory extraction subagent"));
        assert!(prompt.contains("~10 messages"));
        assert!(prompt.contains("prefs.md"));
        assert!(prompt.contains("Existing memory files"));
        assert!(prompt.contains("## Types of memory"));
        assert!(prompt.contains("## What NOT to save"));
        assert!(prompt.contains("MEMORY.md"));
        // Save protocol comes from the shared prompt_sections pieces — the
        // extraction prompt and the main-agent memory section must describe
        // the identical on-disk format.
        assert!(prompt.contains(super::super::super::prompt_sections::SAVE_ON_EXPLICIT_REQUEST));
        assert!(prompt.contains(&super::super::super::prompt_sections::how_to_save_section()));
    }

    #[test]
    fn test_build_extraction_prompt_no_existing() {
        let prompt = build_extraction_prompt(5, "", Path::new("/tmp/memory"));

        assert!(prompt.contains("~5 messages"));
        assert!(!prompt.contains("Existing memory files"));
    }
}
