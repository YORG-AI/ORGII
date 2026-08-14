//! Post-turn memory/evolution dispatch.
//!
//! The turn path submits lightweight jobs to the process-wide memory
//! coordinator. The coordinator owns admission, per-session coalescing,
//! deadlines and cancellation. Transcripts are loaded from the canonical
//! message store only once a job actually runs, and only as a bounded tail —
//! never the full history: session-memory extraction
//! starts right after its turn (context-pipeline work, never queued behind
//! evolution jobs), while the heavy forked agents wait for the bounded
//! global memory permit.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;
use tracing::info;

use super::super::persistence as unified_persistence;
use super::streaming::broadcast_agent_warning;
use crate::config::ReliabilityConfig;
use crate::memory::background::{
    bridge_cancel_flag, memory_job_is_enabled, submit_memory_job, MemoryJob, MemoryJobKind,
    MemoryJobOutcome,
};
use crate::memory::workspace_memory::auto_dream::{self as auto_dream, AutoDreamState};
use crate::memory::workspace_memory::extract::{self as extract_memories, ExtractMemoriesState};
use crate::model_context::session_memory::{self, SessionMemoryConfig, SessionMemoryState};
use crate::providers::LLMProvider;
use crate::session::workspace::SessionWorkspace;
use crate::tools::registry::ToolRegistry;
use core_types::providers::NativeHarnessType;

const SESSION_MEMORY_TIMEOUT: Duration = Duration::from_secs(60);
const WORKSPACE_EXTRACTION_TIMEOUT: Duration = Duration::from_secs(180);
const AUTO_DREAM_TIMEOUT: Duration = Duration::from_secs(300);
const MEMORY_TRANSCRIPT_MAX_BYTES: usize = 512 * 1024;

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

/// The bounded loader stops reading once the tail is guaranteed to exceed
/// the budget, so peak allocation is proportional to
/// `MEMORY_TRANSCRIPT_MAX_BYTES` while `bound_memory_transcript` still sees
/// every message it could possibly keep — its output is byte-identical to
/// bounding a full load.
fn load_durable_history(session_id: &str) -> Result<(Vec<serde_json::Value>, Vec<i64>), String> {
    let (messages, start_seqs) = unified_persistence::load_llm_history_text_only_bounded(
        session_id,
        MEMORY_TRANSCRIPT_MAX_BYTES,
    )
    .map_err(|err| format!("Failed to load durable memory transcript: {err}"))?;
    Ok(bound_memory_transcript(
        messages,
        start_seqs,
        MEMORY_TRANSCRIPT_MAX_BYTES,
    ))
}

/// SQLite loads are synchronous; keep them off the async runtime threads,
/// matching every other async caller of the history loaders.
async fn load_durable_history_blocking(
    session_id: String,
) -> Result<(Vec<serde_json::Value>, Vec<i64>), String> {
    tokio::task::spawn_blocking(move || load_durable_history(&session_id))
        .await
        .map_err(|err| format!("history loader worker failed: {err}"))?
}

fn message_estimated_bytes(message: &serde_json::Value) -> usize {
    serde_json::to_vec(message).map_or(0, |encoded| encoded.len())
}

/// Keep a recent suffix under the memory-job input budget while preserving an
/// assistant tool-call row together with all immediately following tool rows.
/// An oversized newest group is kept intact: structural validity beats a hard
/// byte cut that would make every provider retry fail.
///
/// `start_seqs` is truncated in lockstep so sequence anchors stay aligned
/// with the surviving suffix.
fn bound_memory_transcript(
    messages: Vec<serde_json::Value>,
    start_seqs: Vec<i64>,
    max_bytes: usize,
) -> (Vec<serde_json::Value>, Vec<i64>) {
    if messages.is_empty() || max_bytes == 0 {
        return (messages, start_seqs);
    }

    let mut paired: Vec<(serde_json::Value, i64)> = Vec::with_capacity(messages.len());
    let mut seqs = start_seqs.into_iter();
    for message in messages {
        let seq = seqs.next().unwrap_or(i64::MAX);
        paired.push((message, seq));
    }

    let mut groups: Vec<Vec<(serde_json::Value, i64)>> = Vec::new();
    for entry in paired {
        let role = entry.0.get("role").and_then(|value| value.as_str());
        if role == Some("tool") {
            if let Some(last) = groups.last_mut() {
                last.push(entry);
                continue;
            }
        }
        groups.push(vec![entry]);
    }

    let mut kept: Vec<Vec<(serde_json::Value, i64)>> = Vec::new();
    let mut used = 0usize;
    for group in groups.into_iter().rev() {
        let group_bytes = group
            .iter()
            .map(|(message, _)| message_estimated_bytes(message))
            .sum::<usize>();
        if !kept.is_empty() && used.saturating_add(group_bytes) > max_bytes {
            break;
        }
        used = used.saturating_add(group_bytes);
        kept.push(group);
    }
    kept.reverse();
    kept.into_iter().flatten().unzip()
}

// ── Session memory extraction (step 9b) ─────────────────────────────

pub(super) struct SessionMemoryExtractionInput<'a> {
    pub session_id: &'a str,
    pub agent_id: Option<String>,
    pub current_tokens: usize,
    pub sm_state: Arc<Mutex<SessionMemoryState>>,
    pub sm_config: SessionMemoryConfig,
    pub fork_provider: ForkProviderSpec,
}

/// The extraction gate and counter bookkeeping already ran at dispatch
/// (`post_turn_dispatch` 9b), so the job body only loads, extracts, and
/// persists. SM is context-pipeline state — no learnings policy check here.
pub(super) fn spawn_session_memory_extraction(input: SessionMemoryExtractionInput<'_>) {
    let SessionMemoryExtractionInput {
        session_id,
        agent_id,
        current_tokens,
        sm_state,
        sm_config,
        fork_provider,
    } = input;
    let sid = session_id.to_string();
    let job_sid = sid.clone();
    let cleanup_sid = sid.clone();
    let cleanup_state = Arc::clone(&sm_state);

    let job = MemoryJob::new(
        sid,
        agent_id,
        MemoryJobKind::SessionMemory,
        SESSION_MEMORY_TIMEOUT,
        move |cancel| async move {
            let (messages, start_seqs) = load_durable_history_blocking(job_sid.clone()).await?;

            info!(
                session_id = %job_sid,
                current_tokens,
                "[memory_background] starting session-memory extraction"
            );
            let provider = fresh_fork_provider(&fork_provider).await?;
            let cancel_bridge = bridge_cancel_flag(cancel);
            let result = session_memory::extract_session_memory(
                &messages,
                &start_seqs,
                Arc::clone(&sm_state),
                &sm_config,
                provider.as_ref(),
                &fork_provider.model,
                current_tokens,
                Some(cancel_bridge.flag()),
            )
            .await;

            let content = result?;
            let last_seq = sm_state.lock().await.last_summarized_seq;
            let persist_sid = job_sid.clone();
            tokio::task::spawn_blocking(move || {
                unified_persistence::save_session_memory_state(&persist_sid, &content, last_seq)
            })
            .await
            .map_err(|err| format!("SM persist worker failed: {err}"))?
            .map_err(|err| format!("Failed to persist session memory state: {err}"))?;
            Ok(())
        },
    )
    .with_cleanup(move |outcome| async move {
        match outcome {
            MemoryJobOutcome::Completed | MemoryJobOutcome::Cancelled => {}
            MemoryJobOutcome::Failed | MemoryJobOutcome::TimedOut => {
                broadcast_agent_warning(
                    &cleanup_sid,
                    "Session memory extraction did not complete; it will retry on a later turn",
                    "session_memory",
                );
            }
        }
        if outcome != MemoryJobOutcome::Completed {
            cleanup_state.lock().await.extraction_in_progress = false;
        }
    });
    submit_memory_job(job);
}

// ── Workspace-memory extraction (step 9c) ──────────────────────────

pub(super) struct ExtractMemoriesInput<'a> {
    pub session_id: &'a str,
    pub agent_id: Option<String>,
    pub ws_path: PathBuf,
    pub em_state: Arc<Mutex<ExtractMemoriesState>>,
    pub fork_provider: ForkProviderSpec,
    pub tool_registry: Arc<ToolRegistry>,
}

pub(super) fn spawn_extract_memories(input: ExtractMemoriesInput<'_>) {
    let ExtractMemoriesInput {
        session_id,
        agent_id,
        ws_path,
        em_state,
        fork_provider,
        tool_registry,
    } = input;
    let sid = session_id.to_string();
    let job_sid = sid.clone();
    let job_agent_id = agent_id.clone();
    let cleanup_state = Arc::clone(&em_state);

    let job = MemoryJob::new(
        sid,
        agent_id,
        MemoryJobKind::WorkspaceExtraction,
        WORKSPACE_EXTRACTION_TIMEOUT,
        move |cancel| async move {
            if let Some(agent_id) = job_agent_id.as_deref() {
                if !memory_job_is_enabled(agent_id, MemoryJobKind::WorkspaceExtraction) {
                    return Ok(());
                }
            }

            let (messages, start_seqs) = load_durable_history_blocking(job_sid.clone()).await?;
            let main_wrote = {
                let mut state = em_state.lock().await;
                extract_memories::skip_if_main_agent_wrote_memory(
                    &mut state,
                    &messages,
                    &start_seqs,
                    ws_path.as_path(),
                )
            };
            let should_run = if main_wrote {
                false
            } else {
                let state = em_state.lock().await;
                extract_memories::should_extract(
                    &state,
                    &messages,
                    &start_seqs,
                    Some(ws_path.as_path()),
                )
            };
            if !should_run {
                return Ok(());
            }

            let provider = fresh_fork_provider(&fork_provider).await?;
            let cancel_bridge = bridge_cancel_flag(cancel);
            let params = crate::memory::MemoryAgentParams {
                messages: &messages,
                provider,
                model: &fork_provider.model,
                workspace: &ws_path,
                parent_tools: tool_registry,
                session_id: &job_sid,
                definitions_store: None,
                cancel_flag: Some(cancel_bridge.flag()),
            };
            extract_memories::run_extraction(Arc::clone(&em_state), params, &start_seqs).await
        },
    )
    .with_cleanup(move |outcome| async move {
        if outcome != MemoryJobOutcome::Completed {
            cleanup_state.lock().await.clear_in_progress();
        }
    });
    submit_memory_job(job);
}

// ── Auto-dream consolidation (step 9d) ─────────────────────────────

pub(super) struct AutoDreamInput<'a> {
    pub session_id: &'a str,
    pub agent_id: Option<String>,
    pub ws_path: PathBuf,
    pub ad_state: Arc<Mutex<AutoDreamState>>,
    pub fork_provider: ForkProviderSpec,
    pub tool_registry: Arc<ToolRegistry>,
}

pub(super) fn spawn_auto_dream(input: AutoDreamInput<'_>) {
    let AutoDreamInput {
        session_id,
        agent_id,
        ws_path,
        ad_state,
        fork_provider,
        tool_registry,
    } = input;
    let sid = session_id.to_string();
    let job_sid = sid.clone();
    let job_agent_id = agent_id.clone();

    let job = MemoryJob::new(
        sid,
        agent_id,
        MemoryJobKind::AutoDream,
        AUTO_DREAM_TIMEOUT,
        move |cancel| async move {
            if let Some(agent_id) = job_agent_id.as_deref() {
                if !memory_job_is_enabled(agent_id, MemoryJobKind::AutoDream) {
                    return Ok(());
                }
            }
            {
                let mut state = ad_state.lock().await;
                if !auto_dream::should_attempt(&state, &ws_path) {
                    return Ok(());
                }
                state.mark_scan_now();
            }

            let (messages, _start_seqs) = load_durable_history_blocking(job_sid.clone()).await?;
            let provider = fresh_fork_provider(&fork_provider).await?;
            let cancel_bridge = bridge_cancel_flag(cancel);
            let params = crate::memory::MemoryAgentParams {
                messages: &messages,
                provider,
                model: &fork_provider.model,
                workspace: &ws_path,
                parent_tools: tool_registry,
                session_id: &job_sid,
                definitions_store: None,
                cancel_flag: Some(cancel_bridge.flag()),
            };
            auto_dream::run_consolidation(params).await
        },
    );
    submit_memory_job(job);
}

#[cfg(test)]
mod tests {
    use super::*;
    use test_helpers::test_env;

    fn seed_agent_session(session_id: &str) {
        let conn = database::db::get_connection().expect("get_connection");
        crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                tool_name TEXT,
                tool_call_id TEXT,
                tool_input TEXT,
                tool_output TEXT,
                model TEXT,
                sequence INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                images TEXT,
                compact_from_sequence INTEGER,
                compact_tokens_before INTEGER,
                compact_tokens_after INTEGER
             );",
        )
        .expect("create agent_messages table");
        conn.execute(
            "INSERT OR IGNORE INTO agent_sessions
             (session_id, session_type, status, created_at, updated_at)
             VALUES (?1, 'agent', 'running', datetime('now'), datetime('now'))",
            [session_id],
        )
        .expect("seed session row");
    }

    /// One conversation turn: user text, a two-result tool group, and an
    /// assistant reply, all sized by `payload_bytes`.
    fn save_turn(session_id: &str, turn: usize, payload_bytes: usize) {
        let payload = format!("t{turn}-{}", "x".repeat(payload_bytes));
        unified_persistence::save_user_msg(session_id, &payload, None).expect("save user");
        let call_id = format!("call-{turn}");
        unified_persistence::save_tool_call_msg(
            session_id,
            &call_id,
            "read_file",
            &format!("{{\"path\":\"/tmp/{turn}\"}}"),
        )
        .expect("save tool call");
        unified_persistence::save_tool_result_msg(session_id, &call_id, "read_file", &payload)
            .expect("save tool result");
        unified_persistence::save_tool_result_msg(session_id, &call_id, "read_file", "short")
            .expect("save second tool result");
        unified_persistence::save_assistant_msg(session_id, &payload, "test-model")
            .expect("save assistant");
    }

    fn full_load_then_truncate(
        session_id: &str,
        max_bytes: usize,
    ) -> (Vec<serde_json::Value>, Vec<i64>) {
        let (messages, start_seqs) =
            unified_persistence::load_llm_history_text_only(session_id).expect("full load");
        bound_memory_transcript(messages, start_seqs, max_bytes)
    }

    fn bounded_load_then_truncate(
        session_id: &str,
        max_bytes: usize,
    ) -> (Vec<serde_json::Value>, Vec<i64>) {
        let (messages, start_seqs) =
            unified_persistence::load_llm_history_text_only_bounded(session_id, max_bytes)
                .expect("bounded load");
        bound_memory_transcript(messages, start_seqs, max_bytes)
    }

    fn assert_byte_identical(session_id: &str, max_bytes: usize) {
        let expected = full_load_then_truncate(session_id, max_bytes);
        let actual = bounded_load_then_truncate(session_id, max_bytes);
        assert_eq!(
            actual.1, expected.1,
            "start sequences diverged at cap {max_bytes}"
        );
        assert_eq!(
            serde_json::to_vec(&actual.0).expect("serialize actual"),
            serde_json::to_vec(&expected.0).expect("serialize expected"),
            "messages diverged at cap {max_bytes}"
        );
    }

    /// Acceptance bar for the bounded loader: on a transcript larger than
    /// the real memory budget, bounded-load-then-truncate must be
    /// byte-identical to full-load-then-truncate.
    #[test]
    fn bounded_load_matches_full_load_at_memory_budget() {
        let _sandbox = test_env::sandbox();
        let session_id = "memory-bounded-equivalence";
        seed_agent_session(session_id);

        save_turn(session_id, 0, 4 * 1024);
        let anchor_id = unified_persistence::save_user_msg(session_id, "recent user", None)
            .expect("save anchor user");
        let anchor = unified_persistence::message_anchor(session_id, &anchor_id)
            .expect("resolve anchor")
            .expect("anchor row exists");
        unified_persistence::append_compact_boundary(
            session_id,
            "summary of the first turn",
            anchor.sequence,
            None,
            None,
        )
        .expect("append boundary");
        for turn in 1..16 {
            save_turn(session_id, turn, 16 * 1024);
        }

        let (full, _) =
            unified_persistence::load_llm_history_text_only(session_id).expect("full load");
        let full_bytes: usize = full
            .iter()
            .map(|message| serde_json::to_vec(message).map_or(0, |encoded| encoded.len()))
            .sum();
        assert!(
            full_bytes > MEMORY_TRANSCRIPT_MAX_BYTES,
            "fixture must exceed the memory budget, got {full_bytes} bytes"
        );

        assert_byte_identical(session_id, MEMORY_TRANSCRIPT_MAX_BYTES);

        let (bounded, _) = unified_persistence::load_llm_history_text_only_bounded(
            session_id,
            MEMORY_TRANSCRIPT_MAX_BYTES,
        )
        .expect("bounded load");
        assert!(
            bounded.len() < full.len(),
            "oversized transcript must not be fully materialized"
        );
    }

    /// Budget edges that land inside tool groups, on the anchor row itself,
    /// below one message, and above the whole transcript must all agree
    /// with the full-load pipeline.
    #[test]
    fn bounded_load_matches_full_load_across_budgets() {
        let _sandbox = test_env::sandbox();
        let session_id = "memory-bounded-budget-sweep";
        seed_agent_session(session_id);
        for turn in 0..8 {
            save_turn(session_id, turn, 512);
        }
        let final_call = "call-final";
        unified_persistence::save_tool_call_msg(session_id, final_call, "list_dir", "{}")
            .expect("save trailing tool call");
        unified_persistence::save_tool_result_msg(session_id, final_call, "list_dir", "entries")
            .expect("save trailing tool result");

        for max_bytes in [1, 100, 700, 1500, 4 * 1024, 16 * 1024, 1024 * 1024] {
            assert_byte_identical(session_id, max_bytes);
        }
    }

    #[test]
    fn transcript_budget_keeps_recent_suffix() {
        let messages = vec![
            serde_json::json!({"role": "user", "content": "old".repeat(100)}),
            serde_json::json!({"role": "assistant", "content": "middle"}),
            serde_json::json!({"role": "user", "content": "new"}),
        ];
        let (bounded, seqs) = bound_memory_transcript(messages, vec![10, 20, 30], 100);
        assert_eq!(bounded.len(), 2);
        assert_eq!(bounded[0]["content"], "middle");
        assert_eq!(bounded[1]["content"], "new");
        assert_eq!(seqs, vec![20, 30], "seqs truncate in lockstep");
    }

    #[test]
    fn transcript_budget_never_splits_tool_group() {
        let messages = vec![
            serde_json::json!({"role": "user", "content": "old".repeat(100)}),
            serde_json::json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{"id": "call-1", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}]
            }),
            serde_json::json!({"role": "tool", "tool_call_id": "call-1", "content": "result"}),
        ];
        let (bounded, seqs) = bound_memory_transcript(messages, vec![1, 2, 2], 1);
        assert_eq!(bounded.len(), 2, "newest oversized group stays intact");
        assert_eq!(bounded[0]["role"], "assistant");
        assert_eq!(bounded[1]["role"], "tool");
        assert_eq!(seqs, vec![2, 2]);
    }
}
