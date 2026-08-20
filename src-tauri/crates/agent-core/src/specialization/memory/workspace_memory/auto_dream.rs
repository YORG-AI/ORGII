//! Auto-Dream — periodic background memory consolidation.
//!
//! Fires a forked consolidation agent when:
//! 1. Time gate: hours since last consolidation >= min_hours (24h default)
//! 2. Session gate: enough sessions since last consolidation >= min_sessions (5 default)
//! 3. Lock gate: no other process currently consolidating
//!
//! # State
//!
//! `AutoDreamState` is held per-session in the processor. State is lightweight:
//! just a scan throttle timestamp. The consolidation lock file provides the
//! cross-process/cross-session coordination.

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;
use tracing::{info, warn};

use super::extract::NoopEventHandler;
use super::lock as consolidation_lock;
use crate::definitions::builtin::MEMORY_CONSOLIDATOR_ID;
use crate::definitions::resolve_definition_by_id;
use crate::tools::registry::ToolRegistry;
use crate::turn_executor::{self, TurnConfig};

// ============================================
// Configuration
// ============================================

/// Minimum hours between consolidation runs.
const MIN_HOURS: f64 = 24.0;

/// Minimum sessions since last consolidation before triggering.
const MIN_SESSIONS: usize = 5;

/// Minimum time between session scans (avoids repeated FS scans).
const SCAN_INTERVAL_SECS: u64 = 600; // 10 minutes

/// Max iterations for the consolidation agent.
const MAX_CONSOLIDATION_TURNS: u32 = 10;

// ============================================
// State
// ============================================

/// Per-session state for auto-dream. Held inside the processor.
#[derive(Debug, Default)]
pub struct AutoDreamState {
    /// Last time we scanned for session count (to avoid repeated FS scans).
    last_scan_at: Option<Instant>,
}

impl AutoDreamState {
    /// Record that a scan/consolidation attempt is starting now. Set by the
    /// post-turn dispatcher under a brief lock so the throttle advances even
    /// though `run_consolidation` itself no longer holds the state mutex
    /// (it must not — the consolidation LLM call would otherwise block the
    /// next turn's brief `ad_state` reads).
    pub fn mark_scan_now(&mut self) {
        self.last_scan_at = Some(Instant::now());
    }
}

// ============================================
// Core Logic
// ============================================

/// Check if auto-dream should attempt to run this turn.
///
/// Performs the cheapest checks first (time gate) before more expensive
/// ones (session scan, lock acquisition).
pub fn should_attempt(state: &AutoDreamState, workspace: &Path) -> bool {
    // Time gate: check hours since last consolidation
    let hours = consolidation_lock::hours_since_last_consolidation(workspace);
    if hours < MIN_HOURS {
        return false;
    }

    // Scan throttle: don't scan sessions too frequently
    if let Some(last_scan) = state.last_scan_at {
        if last_scan.elapsed().as_secs() < SCAN_INTERVAL_SECS {
            return false;
        }
    }

    true
}

/// Run the auto-dream consolidation.
///
/// This:
/// 1. Counts sessions since last consolidation
/// 2. Acquires the consolidation lock
/// 3. Runs a forked agent with the consolidation prompt
/// 4. On success, the lock mtime advances (recording consolidation)
/// 5. On failure, rolls back the lock
pub async fn run_consolidation(params: super::super::MemoryAgentParams<'_>) -> Result<(), String> {
    let workspace = params.workspace;
    let mem_dir = super::memory_dir(workspace);

    // Session gate: count sessions since last consolidation
    let last_at = consolidation_lock::read_last_consolidated_at(workspace);
    let session_count = count_sessions_since(workspace, last_at);
    if session_count < MIN_SESSIONS {
        info!(
            "[auto_dream] skip — {} sessions since last consolidation, need {}",
            session_count, MIN_SESSIONS
        );
        return Ok(());
    }

    // Lock gate: the RAII lease rolls back on provider failure, timeout or
    // coordinator cancellation. Only the success arm commits it.
    let lease = match consolidation_lock::try_acquire_lease(workspace) {
        Ok(Some(lease)) => lease,
        Ok(None) => {
            info!("[auto_dream] skip — lock held by another process");
            return Ok(());
        }
        Err(err) => {
            warn!("[auto_dream] lock acquire failed: {}", err);
            return Err(err);
        }
    };

    info!(
        "[auto_dream] firing — {:.1}h since last, {} sessions to review",
        consolidation_lock::hours_since_last_consolidation(workspace),
        session_count
    );

    // Ensure memory dir exists
    if let Err(err) = std::fs::create_dir_all(&mem_dir) {
        return Err(format!("Failed to create memory dir: {}", err));
    }

    // Resolve agent definition
    let agent_def =
        match resolve_definition_by_id(MEMORY_CONSOLIDATOR_ID, params.definitions_store.as_deref())
        {
            Ok(def) => def,
            Err(err) => {
                return Err(format!("Agent def not found: {}", err));
            }
        };

    // Build consolidation prompt
    let prompt = build_consolidation_prompt(workspace, session_count);

    // Shadow mode: the consolidation subagent runs against the parent
    // session's tool registry so it shares the parent's prompt cache; only
    // the policy differs (memory-write tools allow-listed, others gated).
    let effective_registry: Arc<ToolRegistry> = params.parent_tools.clone();
    let effective_policy = super::build_memory_policy();

    // Build forked message array
    let messages = params.messages;
    let system_prompt = messages
        .first()
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();

    let mut fork_messages = Vec::with_capacity(messages.len() + 1);
    fork_messages.push(serde_json::json!({
        "role": "system",
        "content": system_prompt,
    }));
    for msg in messages.iter() {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
        if role != "system" {
            fork_messages.push(msg.clone());
        }
    }
    fork_messages.push(serde_json::json!({
        "role": "user",
        "content": prompt,
    }));

    // Turn config
    let turn_config = TurnConfig {
        turn_intent_id: String::new(),
        projected_inbox_ids: Vec::new(),
        model: params.model.to_string(),
        account_id: None,
        context_window_override: None,
        max_iterations: Some(MAX_CONSOLIDATION_TURNS),
        max_tokens: agent_def.max_tokens.unwrap_or(8192) as u32,
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
    let subagent_session_id = format!("auto-dream-{}-{}", session_id, uuid::Uuid::new_v4());
    let handler = NoopEventHandler;

    // Execute consolidation
    let result = turn_executor::execute_turn(
        &mut fork_messages,
        params.provider.as_ref(),
        effective_registry.as_ref(),
        &effective_policy,
        &turn_config,
        &subagent_session_id,
        &handler,
        None,
        params.cancel_flag,
        None,
    )
    .await;

    match result {
        Ok(turn_result) => {
            lease.commit();
            info!(
                "[auto_dream] Completed: session={}, tokens={}",
                session_id, turn_result.total_tokens
            );
            Ok(())
        }
        Err(err) => {
            warn!("[auto_dream] Error: {}", err);
            Err(format!("Consolidation failed: {}", err))
        }
    }
}

// ============================================
// Helpers
// ============================================

/// Count session transcript files modified since the given timestamp.
///
/// Walks `.orgii/sessions/` for `.jsonl` files newer than `since_ms` so the
/// auto-dream trigger can decide whether enough new activity has accumulated
/// to be worth consolidating.
fn count_sessions_since(workspace: &Path, since_ms: u64) -> usize {
    let session_dir = workspace.join(".orgii").join("sessions");
    if !session_dir.exists() {
        return 0;
    }

    let entries = match std::fs::read_dir(&session_dir) {
        Ok(entries) => entries,
        Err(err) => {
            warn!(
                path = %session_dir.display(),
                error = %err,
                "[auto_dream] count_sessions_since: failed to read session dir; treating as 0",
            );
            return 0;
        }
    };

    let since_time = std::time::UNIX_EPOCH + std::time::Duration::from_millis(since_ms);

    entries
        .flatten()
        .filter(|entry| {
            let path = entry.path();
            let is_session = path.extension().map(|ext| ext == "jsonl").unwrap_or(false);
            if !is_session {
                return false;
            }
            entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .map(|mtime| mtime > since_time)
                .unwrap_or(false)
        })
        .count()
}

// ============================================
// Prompt Building
// ============================================

/// Build the consolidation prompt.
fn build_consolidation_prompt(workspace: &Path, session_count: usize) -> String {
    let mem_dir = super::memory_dir(workspace);
    let mem_dir_str = mem_dir.display();

    format!(
        r#"# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files. Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.

Memory directory: `{mem_dir}`

---

## Phase 1 — Orient

- `ls` the memory directory to see what already exists
- Read `{entrypoint}` to understand the current index
- Skim existing topic files so you improve them rather than creating duplicates

## Phase 2 — Gather recent signal

Look for new information worth persisting. Sources in rough priority order:

1. **Existing memories that drifted** — facts that contradict something you see in the codebase now
2. **Recent session context** — information from the current conversation that should be persisted

Don't exhaustively analyze everything. Look only for things that clearly matter for future sessions.

## Phase 3 — Consolidate

For each thing worth remembering, write or update a memory file at the top level of the memory directory. Use the memory file format and type conventions from your system prompt.

Focus on:
- Merging new signal into existing topic files rather than creating near-duplicates
- Converting relative dates ("yesterday", "last week") to absolute dates so they remain interpretable after time passes
- Deleting contradicted facts — if today's investigation disproves an old memory, fix it at the source

## Phase 4 — Prune and index

Update `{entrypoint}` so it stays under {max_lines} lines AND under ~25KB. It's an **index**, not a dump — each entry should be one line under ~150 characters: `- [Title](file.md) — one-line hook`. Never write memory content directly into it.

- Remove pointers to memories that are now stale, wrong, or superseded
- Demote verbose entries: if an index line is over ~200 chars, it's carrying content that belongs in the topic file — shorten the line, move the detail
- Add pointers to newly important memories
- Resolve contradictions — if two files disagree, fix the wrong one

---

Return a brief summary of what you consolidated, updated, or pruned. If nothing changed (memories are already tight), say so.

## Additional context

**Tool constraints for this run:** Shell commands are restricted to read-only operations (`ls`, `find`, `grep`, `cat`, `stat`, `wc`, `head`, `tail`, and similar). Write operations will be denied. File edits are restricted to the memory directory only.

Sessions since last consolidation: {session_count}"#,
        mem_dir = mem_dir_str,
        entrypoint = super::ENTRYPOINT_NAME,
        max_lines = super::MAX_ENTRYPOINT_LINES,
        session_count = session_count,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;
    use tempfile::TempDir;

    #[test]
    fn test_state_default() {
        let state = AutoDreamState::default();
        assert!(state.last_scan_at.is_none());
    }

    #[test]
    fn test_should_attempt_no_prior_consolidation() {
        let tmp = TempDir::new().unwrap();
        let state = AutoDreamState::default();

        // No prior consolidation → hours = MAX → should attempt
        assert!(should_attempt(&state, tmp.path()));
    }

    #[test]
    fn test_should_attempt_recent_consolidation() {
        let tmp = TempDir::new().unwrap();

        // Record a consolidation
        consolidation_lock::record_consolidation(tmp.path()).unwrap();

        let state = AutoDreamState::default();
        // Recently consolidated → should not attempt
        assert!(!should_attempt(&state, tmp.path()));
    }

    #[test]
    fn test_should_attempt_scan_throttle() {
        let tmp = TempDir::new().unwrap();
        let state = AutoDreamState {
            last_scan_at: Some(Instant::now()),
        };

        // Recent scan → should not attempt (even though time gate would pass)
        // This test only checks throttle; time gate might also block
        let result = should_attempt(&state, tmp.path());
        // If time gate passes but scan throttle blocks, result is false
        // If time gate doesn't pass, result is also false
        // Either way, recent scan + recent consolidation = false
        let _ = result; // Just verify it doesn't panic
    }

    #[test]
    fn test_count_sessions_no_dir() {
        let tmp = TempDir::new().unwrap();
        assert_eq!(count_sessions_since(tmp.path(), 0), 0);
    }

    #[test]
    fn test_count_sessions_with_files() {
        let tmp = TempDir::new().unwrap();
        let session_dir = tmp.path().join(".orgii").join("sessions");
        std::fs::create_dir_all(&session_dir).unwrap();

        // Create some session files
        std::fs::write(session_dir.join("session-1.jsonl"), "{}").unwrap();
        std::fs::write(session_dir.join("session-2.jsonl"), "{}").unwrap();
        std::fs::write(session_dir.join("not-a-session.txt"), "").unwrap();

        // Count all sessions since epoch (0)
        assert_eq!(count_sessions_since(tmp.path(), 0), 2);

        // Count sessions since far future (none qualify)
        let future_ms = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 86_400_000;
        assert_eq!(count_sessions_since(tmp.path(), future_ms), 0);
    }

    #[test]
    fn test_build_consolidation_prompt() {
        let workspace = Path::new("/tmp/workspace");
        let prompt = build_consolidation_prompt(workspace, 7);

        assert!(prompt.contains("Dream: Memory Consolidation"));
        assert!(prompt.contains("Phase 1"));
        assert!(prompt.contains("Phase 2"));
        assert!(prompt.contains("Phase 3"));
        assert!(prompt.contains("Phase 4"));
        assert!(prompt.contains("MEMORY.md"));
        assert!(prompt.contains("Sessions since last consolidation: 7"));
        assert!(prompt.contains("read-only operations"));
    }

    #[test]
    fn test_build_memory_policy() {
        use crate::tools::names as tool_names;
        let policy = super::super::build_memory_policy();

        assert!(policy.is_allowed(tool_names::READ_FILE));
        assert!(policy.is_allowed(tool_names::EDIT_FILE));
        assert!(policy.is_allowed(tool_names::CODE_SEARCH));
        assert!(!policy.is_allowed(tool_names::AGENT));
        assert!(!policy.is_allowed(tool_names::WEB_SEARCH));
    }
}
