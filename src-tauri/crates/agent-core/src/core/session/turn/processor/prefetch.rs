//! Per-turn skill and workspace-memory prefetch.
//!
//! Side queries are started once at turn entry and the main LLM loop
//! proceeds. The FIRST LLM iteration waits a short, bounded time for the
//! prefetch to settle (a relevant skill/memory changes how the model
//! approaches the task, so a sub-second delay is a good trade); subsequent
//! iterations perform a zero-wait collect — if a prefetch has not settled
//! yet it is skipped and retried on the next tool-loop iteration.

use std::sync::Arc;
#[cfg(debug_assertions)]
use std::time::Duration;
use std::time::Instant;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::Value;
use tokio::task::JoinHandle;
use tracing::{debug, warn};

use super::UnifiedMessageProcessor;
use crate::core::turn_executor::TurnIterationHook;
use crate::memory::workspace_memory::surface_state::WorkspaceMemorySurfaceState;

/// Bounded wait applied on the FIRST LLM iteration only. Long enough for a
/// warm side-query to land, short enough to not visibly delay first-token.
const FIRST_ITERATION_PREFETCH_WAIT_MS: u64 = 700;

struct SkillPrefetchState {
    task: Option<JoinHandle<Option<String>>>,
    injected: bool,
    started_at: Instant,
}

struct MemoryPrefetchState {
    task: Option<JoinHandle<MemoryPrefetchOutput>>,
    injected: bool,
    started_at: Instant,
    surface_state: Option<Arc<tokio::sync::Mutex<WorkspaceMemorySurfaceState>>>,
}

struct MemoryPrefetchOutput {
    section: Option<String>,
    surfaced_paths: Vec<String>,
}

pub(in crate::core::session::turn) struct TurnPrefetchHook {
    skill: Mutex<Option<SkillPrefetchState>>,
    memory: Mutex<Option<MemoryPrefetchState>>,
}

impl TurnPrefetchHook {
    fn new(
        skill_task: Option<JoinHandle<Option<String>>>,
        memory_task: Option<JoinHandle<MemoryPrefetchOutput>>,
        memory_surface_state: Option<Arc<tokio::sync::Mutex<WorkspaceMemorySurfaceState>>>,
    ) -> Self {
        Self {
            skill: Mutex::new(skill_task.map(|task| SkillPrefetchState {
                task: Some(task),
                injected: false,
                started_at: Instant::now(),
            })),
            memory: Mutex::new(memory_task.map(|task| MemoryPrefetchState {
                task: Some(task),
                injected: false,
                started_at: Instant::now(),
                surface_state: memory_surface_state,
            })),
        }
    }

    #[cfg(debug_assertions)]
    pub(in crate::core::session::turn) fn test_with_delayed_outputs(
        delay: Duration,
        skill_section: Option<String>,
        memory_section: Option<String>,
    ) -> Self {
        let skill_task = tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            skill_section
        });
        let memory_task = tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            MemoryPrefetchOutput {
                section: memory_section,
                surfaced_paths: Vec::new(),
            }
        });
        Self::new(Some(skill_task), Some(memory_task), None)
    }

    pub fn abort_pending(&self) {
        if let Some(state) = self.skill.lock().as_ref() {
            if let Some(task) = state.task.as_ref() {
                task.abort();
            }
        }
        if let Some(state) = self.memory.lock().as_ref() {
            if let Some(task) = state.task.as_ref() {
                task.abort();
            }
        }
    }

    async fn collect_skill(&self, session_id: &str, messages: &mut [Value], max_wait_ms: u64) {
        let mut task = {
            let mut guard = self.skill.lock();
            let Some(state) = guard.as_mut() else {
                return;
            };
            if state.injected {
                return;
            }
            let Some(task) = state.task.as_ref() else {
                state.injected = true;
                return;
            };
            if !task.is_finished() && max_wait_ms == 0 {
                debug!(
                    session_id = %session_id,
                    elapsed_ms = state.started_at.elapsed().as_millis(),
                    "[turn-prefetch] skill prefetch not settled; skipping zero-wait collect"
                );
                return;
            }
            state.task.take()
        };

        let Some(task_handle) = task.take() else {
            return;
        };
        // Bounded first-iteration wait: give the side query a short window
        // to settle so the first LLM call already sees the relevant skill.
        let mut task_handle = task_handle;
        let result = if max_wait_ms > 0 && !task_handle.is_finished() {
            match tokio::time::timeout(
                std::time::Duration::from_millis(max_wait_ms),
                &mut task_handle,
            )
            .await
            {
                Ok(join_result) => join_result,
                Err(_elapsed) => {
                    debug!(
                        session_id = %session_id,
                        max_wait_ms,
                        "[turn-prefetch] skill prefetch missed the first-iteration window; deferring"
                    );
                    // Put the still-running task back for later iterations.
                    if let Some(state) = self.skill.lock().as_mut() {
                        state.task = Some(task_handle);
                    }
                    return;
                }
            }
        } else {
            task_handle.await
        };

        match result {
            Ok(Some(section)) => {
                if prepend_to_last_user_message(messages, &section) {
                    debug!(
                        session_id = %session_id,
                        section_chars = section.len(),
                        "[turn-prefetch] injected settled skill prefetch"
                    );
                }
            }
            Ok(None) => {}
            Err(err) => {
                warn!(
                    session_id = %session_id,
                    "[turn-prefetch] skill prefetch task failed: {}",
                    err
                );
            }
        }

        if let Some(state) = self.skill.lock().as_mut() {
            state.injected = true;
        }
    }

    async fn collect_memory(&self, session_id: &str, messages: &mut Vec<Value>) {
        let task_with_state = {
            let mut guard = self.memory.lock();
            let Some(state) = guard.as_mut() else {
                return;
            };
            if state.injected {
                return;
            }
            let Some(task) = state.task.as_ref() else {
                state.injected = true;
                return;
            };
            if !task.is_finished() {
                debug!(
                    session_id = %session_id,
                    elapsed_ms = state.started_at.elapsed().as_millis(),
                    "[turn-prefetch] memory prefetch not settled; skipping zero-wait collect"
                );
                return;
            }
            state
                .task
                .take()
                .map(|task| (task, state.surface_state.clone()))
        };

        let Some((task, surface_state)) = task_with_state else {
            return;
        };
        match task.await {
            Ok(output) => {
                if let Some(section) = output.section {
                    let injected = insert_system_after_existing_system(messages, section.clone());
                    // Only memory-bearing sections count against the session
                    // budget: an index-only section (no surfaced paths) is
                    // small, repeats every turn, and would otherwise drain
                    // the budget without injecting any memory content.
                    if injected && !output.surfaced_paths.is_empty() {
                        if let Some(surface_state) = surface_state {
                            let mut surface_state = surface_state.lock().await;
                            surface_state.record_paths(output.surfaced_paths.iter().cloned());
                            surface_state.record_bytes(section.len());
                        }
                    }
                    debug!(
                        session_id = %session_id,
                        section_chars = section.len(),
                        "[turn-prefetch] injected settled memory prefetch"
                    );
                }
            }
            Err(err) => {
                warn!(
                    session_id = %session_id,
                    "[turn-prefetch] memory prefetch task failed: {}",
                    err
                );
            }
        }

        if let Some(state) = self.memory.lock().as_mut() {
            state.injected = true;
        }
    }
}

impl Drop for TurnPrefetchHook {
    fn drop(&mut self) {
        self.abort_pending();
    }
}

#[async_trait]
impl TurnIterationHook for TurnPrefetchHook {
    async fn before_llm_iteration(
        &self,
        session_id: &str,
        iteration: u32,
        messages: &mut Vec<Value>,
    ) {
        // First iteration: bounded wait so the opening LLM call already
        // sees the selected skill. Later iterations: zero-wait collect.
        let max_wait_ms = if iteration <= 1 {
            FIRST_ITERATION_PREFETCH_WAIT_MS
        } else {
            0
        };
        self.collect_memory(session_id, messages).await;
        self.collect_skill(session_id, messages, max_wait_ms).await;
    }
}

impl UnifiedMessageProcessor {
    pub(super) async fn start_turn_prefetch(
        &self,
        session_id: &str,
        content: &str,
        history: &[Value],
    ) -> Option<Arc<TurnPrefetchHook>> {
        let skill_task = self.start_skill_prefetch_task(session_id, content).await;
        let memory_task = self
            .start_memory_prefetch_task(session_id, content, history)
            .await;

        let memory_surface_state = memory_task
            .as_ref()
            .map(|_| Arc::clone(&self.session.workspace_memory_surface_state));

        if skill_task.is_none() && memory_task.is_none() {
            return None;
        }

        Some(Arc::new(TurnPrefetchHook::new(
            skill_task,
            memory_task,
            memory_surface_state,
        )))
    }

    async fn start_skill_prefetch_task(
        &self,
        session_id: &str,
        content: &str,
    ) -> Option<JoinHandle<Option<String>>> {
        if !self.runtime.resolved.skills.enabled || content.is_empty() {
            return None;
        }

        let workspace_root = match self.workspace_root() {
            Some(path) => path,
            None => {
                warn!(
                    session_id = %session_id,
                    "[turn-prefetch] skill prefetch: workspace_root unexpectedly None; skipping",
                );
                return None;
            }
        };
        let (provider, model) = match self.side_query_provider(session_id, "skill-prefetch").await {
            Ok(route) => route,
            Err(err) => {
                warn!(
                    session_id = %session_id,
                    "[turn-prefetch] skill prefetch provider failed: {}",
                    err
                );
                return None;
            }
        };

        let user_message = content.to_string();
        let skills_root = workspace_root.join(".orgii");
        let disabled_skills = self.runtime.resolved.skills.disabled.clone();
        let source_dirs = self.runtime.resolved.skills.source_dirs.clone();
        let agent_id = self
            .runtime
            .agent_definition_id
            .clone()
            .unwrap_or_else(|| self.agent_id.clone());
        let load_workspace_resources = self.runtime.resolved.load_workspace_resources;

        Some(tokio::spawn(async move {
            let result = crate::skills::prefetch::select_skills(
                provider.as_ref(),
                &user_message,
                &skills_root,
                &model,
                &disabled_skills,
                &source_dirs,
                &agent_id,
                load_workspace_resources,
            )
            .await;
            result.build_prompt_section()
        }))
    }

    async fn start_memory_prefetch_task(
        &self,
        session_id: &str,
        content: &str,
        history: &[Value],
    ) -> Option<JoinHandle<MemoryPrefetchOutput>> {
        let workspace_root = self.workspace_root()?;
        let (provider, side_query_model) = match self
            .side_query_provider(session_id, "memory-prefetch")
            .await
        {
            Ok(route) => route,
            Err(err) => {
                warn!(
                    session_id = %session_id,
                    "[turn-prefetch] memory prefetch provider failed: {}",
                    err
                );
                return None;
            }
        };
        let recent_tools =
            crate::memory::workspace_memory::prefetch::extract_recent_tools_from_history(history);
        let (already_surfaced, remaining_session_budget) = {
            let surface_state = self.session.workspace_memory_surface_state.lock().await;
            (
                surface_state.snapshot(),
                surface_state.remaining_budget(
                    crate::memory::workspace_memory::surface_state::MAX_SESSION_MEMORY_BYTES,
                ),
            )
        };
        // Session budget exhausted: skip the prefetch entirely instead of
        // burning an LLM side-query on memories we would refuse to inject.
        if remaining_session_budget == 0 {
            debug!(
                session_id = %session_id,
                "[turn-prefetch] session memory budget exhausted; skipping memory prefetch"
            );
            return None;
        }
        let byte_budget = crate::memory::workspace_memory::prefetch::MAX_MEMORY_INJECTION_BYTES
            .min(remaining_session_budget);
        let user_message = content.to_string();
        let model = side_query_model;

        Some(tokio::spawn(async move {
            let memories = crate::memory::workspace_memory::prefetch::select_memories(
                provider.as_ref(),
                &workspace_root,
                &user_message,
                &model,
                &recent_tools,
                &already_surfaced,
                byte_budget,
            )
            .await;
            let surfaced_paths = memories
                .iter()
                .map(|memory| memory.path.clone())
                .collect::<Vec<_>>();
            let section = crate::memory::workspace_memory::prefetch::build_memory_prompt_section(
                &workspace_root,
                &memories,
            );
            MemoryPrefetchOutput {
                section,
                surfaced_paths,
            }
        }))
    }
}

fn prepend_to_last_user_message(messages: &mut [Value], prefix: &str) -> bool {
    let Some(last_user) = messages
        .iter_mut()
        .rev()
        .find(|message| message.get("role").and_then(|role| role.as_str()) == Some("user"))
    else {
        return false;
    };

    let Some(existing_content) = last_user
        .get("content")
        .and_then(|content| content.as_str())
        .map(str::to_string)
    else {
        return false;
    };

    last_user["content"] = Value::String(format!("{}\n\n{}", prefix, existing_content));
    true
}

fn insert_system_after_existing_system(messages: &mut Vec<Value>, content: String) -> bool {
    let insert_at = messages
        .iter()
        .position(|message| message.get("role").and_then(|role| role.as_str()) != Some("system"))
        .unwrap_or(messages.len());
    messages.insert(
        insert_at,
        serde_json::json!({
            "role": "system",
            "content": content,
        }),
    );
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepend_to_last_user_message_updates_latest_user_only() {
        let mut messages = vec![
            serde_json::json!({"role": "user", "content": "first"}),
            serde_json::json!({"role": "assistant", "content": "assistant"}),
            serde_json::json!({"role": "user", "content": "second"}),
        ];

        assert!(prepend_to_last_user_message(&mut messages, "prefetch"));
        assert_eq!(messages[0]["content"], "first");
        assert_eq!(messages[2]["content"], "prefetch\n\nsecond");
    }

    #[test]
    fn insert_system_after_existing_system_keeps_system_prefix_grouped() {
        let mut messages = vec![
            serde_json::json!({"role": "system", "content": "stable"}),
            serde_json::json!({"role": "user", "content": "hi"}),
        ];

        insert_system_after_existing_system(&mut messages, "prefetched memory".to_string());
        assert_eq!(messages[0]["content"], "stable");
        assert_eq!(messages[1]["role"], "system");
        assert_eq!(messages[1]["content"], "prefetched memory");
        assert_eq!(messages[2]["content"], "hi");
    }
}
