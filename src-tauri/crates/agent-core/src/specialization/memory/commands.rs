//! Learning system Tauri commands — lives in agent_core so ALL agent types can use it.
//!
//! - `session_trigger_reflection` — manually trigger post-session reflection
//! - `session_list_learnings` — list active learnings for a scope
//! - `session_deprecate_learning` — manually deprecate a learning
//! - Learnings Browser:
//!   - `learnings_list` — filtered list for the browser's list panel
//!   - `learnings_update_body` — edit `takeaway` / `content`
//!   - `learnings_set_status` — whitelisted status transitions
//!   - `learnings_delete` — hard delete (user-created noise only)
//!   - `learnings_get_status` — Consolidation Status card
//!
//! Per-agent enable/disable is handled by `learnings.enabled` on the
//! session's `AgentDefinition` — there is no per-session toggle.

use serde::{Deserialize, Serialize};
use tracing::info;

use super::learnings::{
    self, LearningCategory, LearningListFilter, LearningSource, LearningStatus, GLOBAL_AGENT_SCOPE,
};
use crate::foundation::db_bridge::get_connection;
use crate::session::prompt::cache::PromptCacheInvalidationReason;
use crate::state::AgentAppState;

// ── Types ──

#[derive(Debug, Serialize, Deserialize)]
pub struct LearningRecord {
    pub id: String,
    pub content: String,
    /// Compressed one-line rule. May be null for older rows.
    pub takeaway: Option<String>,
    pub category: String,
    pub importance: f64,
    pub confidence: f64,
    /// Lifecycle state: pending / active / merged / deprecated / abandoned.
    pub status: String,
    /// Write-trigger category: reflection / pattern_extraction / active_observation.
    pub source: String,
    /// Hash-dedup reinforcement counter (>= 1).
    pub reinforcement_count: i64,
    /// SHA-256-derived dedup key (first 16 hex chars); null for rows that
    /// failed backfill.
    pub content_hash: Option<String>,
    /// Billing account for per-account consolidation. Null for bridged rows.
    pub account_id: Option<String>,
    pub created_at: String,
    /// Expose `updated_at` so the Browser can sort on it.
    pub updated_at: String,
    /// Surface the agent scope so UI can group across scopes.
    pub agent_scope: String,
    /// Included for completeness; the Browser uses it for the
    /// detail pane.
    pub last_recalled_at: Option<String>,
    /// Included for parent/child link rendering.
    pub parent_id: Option<String>,
}

fn to_record(l: learnings::Learning) -> LearningRecord {
    LearningRecord {
        id: l.id,
        content: l.content,
        takeaway: l.takeaway,
        category: l.category.as_str().to_string(),
        importance: l.importance,
        confidence: l.confidence,
        status: l.status.as_str().to_string(),
        source: l.source.as_str().to_string(),
        reinforcement_count: l.reinforcement_count as i64,
        content_hash: l.content_hash,
        account_id: l.account_id,
        created_at: l.created_at,
        updated_at: l.updated_at,
        agent_scope: l.agent_scope,
        last_recalled_at: l.last_recalled_at,
        parent_id: l.parent_id,
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReflectionResult {
    pub learnings_stored: usize,
    pub session_id: String,
}

// ── Commands ──

/// Manually trigger post-session reflection.
#[tauri::command]
pub async fn session_trigger_reflection(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<ReflectionResult, String> {
    let _permit = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        crate::memory::background::acquire_memory_permit(),
    )
    .await
    .map_err(|_| {
        "Memory system is busy with background work; try again in a moment".to_string()
    })??;
    let count = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        crate::memory::reflection::maybe_reflect_on_session(&session_id),
    )
    .await
    .map_err(|_| "Manual reflection timed out after 120s".to_string())??;
    if count > 0 {
        state
            .invalidate_prompt_caches(PromptCacheInvalidationReason::LearningsChanged)
            .await;
    }
    Ok(ReflectionResult {
        learnings_stored: count,
        session_id,
    })
}

/// List active + pending learnings for a given scope (legacy entry — kept
/// for the debug HTTP endpoints + E2E suite). the Learnings Browser
/// uses `learnings_list` (below) which supports filtering.
#[tauri::command]
pub async fn session_list_learnings(
    agent_scope: Option<String>,
) -> Result<Vec<LearningRecord>, String> {
    tokio::task::spawn_blocking(move || {
        let scope = agent_scope.unwrap_or_else(|| GLOBAL_AGENT_SCOPE.to_string());
        let conn = get_connection().map_err(|e| e.to_string())?;
        let active = learnings::load_active_learnings(&conn, &scope)
            .map_err(|e| format!("Failed to load learnings: {}", e))?;

        Ok(active.into_iter().map(to_record).collect())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Deprecate (soft-delete) a specific learning.
#[tauri::command]
pub async fn session_deprecate_learning(learning_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|e| e.to_string())?;
        learnings::deprecate_learning(&conn, &learning_id)
            .map_err(|e| format!("Failed to deprecate learning: {}", e))?;
        info!("[learning] Deprecated learning '{}'", learning_id);
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

// ── Learnings Browser ──

// These three filter parsers reject typo'd wire payloads with a
// command error rather than silently treating the typo as "no
// filter" (`None` here means "no filter" in `LearningListFilter`,
// so the previous `parse_str` catch-all silently widened a typo'd
// `status="actve"` to "all statuses"). Empty / missing strings keep
// "no filter" semantics; anything non-empty must round-trip cleanly.
fn parse_status_opt(s: Option<String>) -> Result<Option<LearningStatus>, String> {
    match s {
        None => Ok(None),
        Some(v) if v.is_empty() => Ok(None),
        Some(v) => LearningStatus::parse(&v)
            .map(Some)
            .ok_or_else(|| format!("unknown learning status filter '{}'", v)),
    }
}

fn parse_source_opt(s: Option<String>) -> Result<Option<LearningSource>, String> {
    match s {
        None => Ok(None),
        Some(v) if v.is_empty() => Ok(None),
        Some(v) => LearningSource::parse(&v)
            .map(Some)
            .ok_or_else(|| format!("unknown learning source filter '{}'", v)),
    }
}

fn parse_category_opt(s: Option<String>) -> Result<Option<LearningCategory>, String> {
    match s {
        None => Ok(None),
        Some(v) if v.is_empty() => Ok(None),
        Some(v) => LearningCategory::parse(&v)
            .map(Some)
            .ok_or_else(|| format!("unknown learning category filter '{}'", v)),
    }
}

/// Filtered browse endpoint. All filters optional; scope defaults to
/// `"_global"` to match `session_list_learnings`.
#[tauri::command]
pub async fn learnings_list(
    agent_scope: Option<String>,
    status: Option<String>,
    source: Option<String>,
    category: Option<String>,
    search: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<LearningRecord>, String> {
    tokio::task::spawn_blocking(move || {
        let scope = agent_scope.unwrap_or_else(|| GLOBAL_AGENT_SCOPE.to_string());
        let filter = LearningListFilter {
            status: parse_status_opt(status)?,
            source: parse_source_opt(source)?,
            category: parse_category_opt(category)?,
            search,
            limit,
        };
        let conn = get_connection().map_err(|e| e.to_string())?;
        let rows = learnings::list_learnings(&conn, &scope, &filter)
            .map_err(|e| format!("Failed to list learnings: {}", e))?;
        Ok(rows.into_iter().map(to_record).collect())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Edit the body of a learning (takeaway + content). Status-preserving.
#[tauri::command]
pub async fn learnings_update_body(
    state: tauri::State<'_, AgentAppState>,
    learning_id: String,
    takeaway: Option<String>,
    content: String,
) -> Result<(), String> {
    if content.trim().is_empty() {
        return Err("content must not be empty".to_string());
    }
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|e| e.to_string())?;
        learnings::update_learning_body(&conn, &learning_id, takeaway.as_deref(), &content)
            .map_err(|e| format!("Failed to update learning: {}", e))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;
    state
        .invalidate_prompt_caches(PromptCacheInvalidationReason::LearningsChanged)
        .await;
    Ok(())
}

/// Whitelisted status transition. Allowed edges:
///   - pending → active   (user promotes without waiting for consolidation)
///   - active → deprecated (soft removal)
///   - deprecated → active (undo deprecate)
/// `abandoned` is an internal consolidation terminal state and is not manually
/// assignable through this command.
/// Everything else is rejected to keep the consolidation DAG consistent
/// (see plan §5.4 "Allowed edits" table and §A.5 risk analysis).
#[tauri::command]
pub async fn learnings_set_status(
    state: tauri::State<'_, AgentAppState>,
    learning_id: String,
    next: String,
) -> Result<(), String> {
    // Reject typo'd wire payloads instead of silently downgrading them
    // to `Pending` (which the prior `parse_str` catch-all did). A
    // typo'd transition would otherwise re-queue the row for
    // consolidation on every tick and silently undo a user's
    // intentional `active` / `deprecated` move.
    let next_status = LearningStatus::parse(&next)
        .ok_or_else(|| format!("unknown learning status '{}'", next))?;
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|e| e.to_string())?;
        let existing = learnings::load_learning_by_id(&conn, &learning_id)
            .map_err(|e| format!("Failed to load learning: {}", e))?
            .ok_or_else(|| format!("Learning '{}' not found", learning_id))?;

        match (existing.status, next_status) {
            (LearningStatus::Pending, LearningStatus::Active) => {
                learnings::promote_pending_to_active(&conn, &learning_id)
                    .map_err(|e| format!("Failed to promote to active: {}", e))?;
            }
            (LearningStatus::Active, LearningStatus::Deprecated) => {
                learnings::deprecate_learning(&conn, &learning_id)
                    .map_err(|e| format!("Failed to deprecate: {}", e))?;
            }
            (LearningStatus::Deprecated, LearningStatus::Active) => {
                learnings::reactivate_learning(&conn, &learning_id)
                    .map_err(|e| format!("Failed to reactivate: {}", e))?;
            }
            (from, to) if from == to => {
                // Idempotent no-op.
            }
            (from, to) => {
                return Err(format!(
                    "Transition not allowed: {} → {}",
                    from.as_str(),
                    to.as_str()
                ));
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;
    state
        .invalidate_prompt_caches(PromptCacheInvalidationReason::LearningsChanged)
        .await;
    Ok(())
}

/// Hard delete a learning. Intended for user-created noise. Callers should
/// prefer `learnings_set_status(id, "deprecated")` for reversible removal.
///
/// Refuses rows with `status = 'merged'` or `status = 'abandoned'`: merged rows
/// participate in the consolidation DAG via `parent_id`; abandoned rows are the
/// audit trail for failed consolidation attempts. The UI should hide them from
/// destructive affordances where appropriate, but the backend enforces the
/// invariant so no frontend bug can erase lifecycle evidence.
#[tauri::command]
pub async fn learnings_delete(
    state: tauri::State<'_, AgentAppState>,
    learning_id: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|e| e.to_string())?;
        let existing = learnings::load_learning_by_id(&conn, &learning_id)
            .map_err(|e| format!("Failed to load learning: {}", e))?
            .ok_or_else(|| format!("Learning '{}' not found", learning_id))?;
        if matches!(
            existing.status,
            LearningStatus::Merged | LearningStatus::Abandoned
        ) {
            return Err(format!(
                "Refusing to delete {} learning '{}': terminal lifecycle rows are retained for audit.",
                existing.status.as_str(),
                learning_id
            ));
        }
        learnings::delete_learning(&conn, &learning_id)
            .map_err(|e| format!("Failed to delete learning: {}", e))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;
    state
        .invalidate_prompt_caches(PromptCacheInvalidationReason::LearningsChanged)
        .await;
    Ok(())
}

// ── Consolidation Status card ──

#[derive(Debug, Serialize, Deserialize)]
pub struct ConsolidationRunSummary {
    pub trigger: String,
    pub mode: String,
    pub pending_input: u32,
    pub added: u32,
    pub updated: u32,
    pub deleted: u32,
    pub none_count: u32,
    pub abandoned: u32,
    pub reinforced: u32,
    pub error: Option<String>,
    pub started_at: String,
    pub finished_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LearningsStatusReport {
    pub agent_scope: String,
    pub pending_count: u64,
    pub active_count: u64,
    pub merged_count: u64,
    pub deprecated_count: u64,
    pub abandoned_count: u64,
    pub last_run: Option<ConsolidationRunSummary>,
    /// Human-readable hint — e.g. `"forced (>50 pending)"`, `"lazy (~12h since last run)"`, `"idle"`.
    pub next_trigger_hint: String,
}

/// Status card backing query. Read-only; aggregates `learnings` + latest
/// `consolidation_runs` row.
#[tauri::command]
pub async fn learnings_get_status(
    agent_scope: Option<String>,
) -> Result<LearningsStatusReport, String> {
    tokio::task::spawn_blocking(move || -> Result<LearningsStatusReport, String> {
        let scope = agent_scope.unwrap_or_else(|| GLOBAL_AGENT_SCOPE.to_string());
        let conn = get_connection().map_err(|e| e.to_string())?;
        let counts = learnings::count_status_per_scope(&conn, &scope)
            .map_err(|e| format!("Failed to count learnings: {}", e))?;
        let last = learnings::latest_consolidation_run(&conn, &scope)
            .map_err(|e| format!("Failed to load latest run: {}", e))?;

        let next_trigger_hint = build_next_trigger_hint(counts.pending, last.as_ref());

        let last_run = last.map(|r| ConsolidationRunSummary {
            trigger: r.trigger,
            mode: r.mode,
            pending_input: r.pending_input,
            added: r.added,
            updated: r.updated,
            deleted: r.deleted,
            none_count: r.none_count,
            abandoned: r.abandoned,
            reinforced: r.reinforced,
            error: r.error,
            started_at: r.started_at,
            finished_at: r.finished_at,
        });

        Ok(LearningsStatusReport {
            agent_scope: scope,
            pending_count: counts.pending,
            active_count: counts.active,
            merged_count: counts.merged,
            deprecated_count: counts.deprecated,
            abandoned_count: counts.abandoned,
            last_run,
            next_trigger_hint,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Derive a user-facing hint for when consolidation will next fire. Mirrors
/// the trigger truth table in consolidation.rs: `forced` (>50 pending) /
/// `idle` (session quiet 5 min) / `lazy` (>24h since last run).
fn build_next_trigger_hint(
    pending: u64,
    last: Option<&learnings::ConsolidationRunRecord>,
) -> String {
    if pending > 50 {
        return format!("forced (>{} pending)", 50);
    }
    let hours_since_last = match last {
        Some(run) => hours_since(&run.finished_at).unwrap_or(f64::INFINITY),
        None => f64::INFINITY,
    };
    if hours_since_last >= 24.0 {
        return "lazy (>24h since last run)".to_string();
    }
    "idle (next tick in <5 min)".to_string()
}

fn hours_since(rfc3339: &str) -> Option<f64> {
    let parsed = chrono::DateTime::parse_from_rfc3339(rfc3339).ok()?;
    let now = chrono::Utc::now();
    let delta = now.signed_duration_since(parsed.with_timezone(&chrono::Utc));
    Some(delta.num_seconds() as f64 / 3600.0)
}

// ========================================================================
// Workspace Memory (L2) Commands
// ========================================================================

use super::workspace_memory;
use super::workspace_memory::lock as consolidation_lock;
use std::path::Path;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMemoryEntry {
    pub filename: String,
    pub description: Option<String>,
    pub memory_type: Option<String>,
    pub mtime_ms: u64,
    pub age_display: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMemoryDetail {
    pub filename: String,
    pub description: Option<String>,
    pub memory_type: Option<String>,
    pub mtime_ms: u64,
    pub age_display: String,
    pub freshness_caveat: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMemoryStatus {
    pub memory_count: usize,
    pub last_consolidated_at: u64,
    pub hours_since_consolidation: f64,
    pub sessions_since_consolidation: usize,
    pub lock_held: bool,
    pub memory_dir: String,
}

/// List all workspace memory files for a workspace.
#[tauri::command]
pub async fn workspace_memory_list(workspace: String) -> Result<Vec<WorkspaceMemoryEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let ws = Path::new(&workspace);
        let mem_dir = workspace_memory::memory_dir(ws);
        let headers = workspace_memory::scan_memory_files(&mem_dir);
        Ok(headers
            .into_iter()
            .map(|header| WorkspaceMemoryEntry {
                filename: header.filename,
                description: header.description,
                memory_type: header.memory_type.map(|mt| mt.as_str().to_string()),
                mtime_ms: header.mtime_ms,
                age_display: workspace_memory::memory_age(header.mtime_ms),
            })
            .collect())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Reject filenames that escape the workspace memory directory.
///
/// `Path::join` does not normalize, so `mem_dir.join("../../x.md")` still
/// .starts_with(mem_dir) string-wise. Bare-name only: no separators, no
/// parent components.
fn reject_memory_traversal(filename: &str) -> Result<(), String> {
    if filename.contains('/')
        || filename.contains('\\')
        || filename.split('/').any(|seg| seg == "..")
    {
        return Err("Path traversal rejected".to_string());
    }
    Ok(())
}

/// Read a single workspace memory file.
#[tauri::command]
pub async fn workspace_memory_read(
    workspace: String,
    filename: String,
) -> Result<WorkspaceMemoryDetail, String> {
    reject_memory_traversal(&filename)?;
    tokio::task::spawn_blocking(move || {
        let ws = Path::new(&workspace);
        let mem_dir = workspace_memory::memory_dir(ws);
        let file_path = mem_dir.join(&filename);

        if !file_path.starts_with(&mem_dir) {
            return Err("Path traversal rejected".to_string());
        }

        let content =
            std::fs::read_to_string(&file_path).map_err(|e| format!("Read failed: {}", e))?;

        let first_lines: String = content.lines().take(30).collect::<Vec<_>>().join("\n");
        let (frontmatter, _) = workspace_memory::parse_frontmatter(&first_lines);

        let mtime_ms = file_path
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        Ok(WorkspaceMemoryDetail {
            filename,
            description: frontmatter.get("description").cloned(),
            memory_type: frontmatter.get("type").cloned(),
            mtime_ms,
            age_display: workspace_memory::memory_age(mtime_ms),
            freshness_caveat: workspace_memory::memory_freshness_text(mtime_ms),
            content,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Delete a single workspace memory file.
///
/// Mirrors the path-traversal guard in `workspace_memory_read`: rejects any
/// filename that escapes the canonical `memory_dir`.
#[tauri::command]
pub async fn workspace_memory_delete(workspace: String, filename: String) -> Result<(), String> {
    reject_memory_traversal(&filename)?;
    tokio::task::spawn_blocking(move || {
        let ws = Path::new(&workspace);
        let mem_dir = workspace_memory::memory_dir(ws);
        let file_path = mem_dir.join(&filename);
        if !file_path.starts_with(&mem_dir) {
            return Err("Path traversal rejected".to_string());
        }
        if !file_path.exists() {
            return Ok(());
        }
        std::fs::remove_file(&file_path).map_err(|e| format!("Delete failed: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Clear ALL workspace memory files for a workspace.
///
/// Wipes every `*.md` under `memory_dir` (including `MEMORY.md`) so the
/// workspace starts fresh. Leaves the directory in place so later writes
/// don't have to recreate it.
#[tauri::command]
pub async fn workspace_memory_clear(workspace: String) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let ws = Path::new(&workspace);
        let mem_dir = workspace_memory::memory_dir(ws);
        if !mem_dir.exists() {
            return Ok(0usize);
        }
        let mut removed = 0usize;
        for entry in std::fs::read_dir(&mem_dir).map_err(|e| format!("Scan failed: {}", e))? {
            let entry = entry.map_err(|e| format!("Scan failed: {}", e))?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if path.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            std::fs::remove_file(&path).map_err(|e| format!("Delete failed: {}", e))?;
            removed += 1;
        }
        Ok(removed)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Get L2 workspace memory status (consolidation state, file count, etc.).
#[tauri::command]
pub async fn workspace_memory_status(workspace: String) -> Result<WorkspaceMemoryStatus, String> {
    tokio::task::spawn_blocking(move || {
        let ws = Path::new(&workspace);
        let mem_dir = workspace_memory::memory_dir(ws);
        let headers = workspace_memory::scan_memory_files(&mem_dir);

        let last_at = consolidation_lock::read_last_consolidated_at(ws);
        let hours = consolidation_lock::hours_since_last_consolidation(ws);

        let session_dir = ws.join(".orgii").join("sessions");
        let sessions_since = if session_dir.exists() && last_at > 0 {
            let since_time = std::time::UNIX_EPOCH + std::time::Duration::from_millis(last_at);
            // Silent `unwrap_or(0)` on `read_dir` failure would tell the
            // user "0 sessions since last consolidation" — i.e. the
            // memory looks fresh — when in reality we just couldn't
            // enumerate the directory (permission flip, partial mount).
            // Warn so the falsely-fresh status is traceable.
            match std::fs::read_dir(&session_dir) {
                Ok(entries) => entries
                    .flatten()
                    .filter(|entry| {
                        let path = entry.path();
                        let is_session =
                            path.extension().map(|ext| ext == "jsonl").unwrap_or(false);
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
                    .count(),
                Err(err) => {
                    tracing::warn!(
                        dir = %session_dir.display(),
                        error = %err,
                        "memory::workspace_memory_status: session dir read_dir failed; reporting 0 sessions-since but the count is unreliable"
                    );
                    0
                }
            }
        } else {
            0
        };

        // try_acquire failure (e.g. file create error from disk-full,
        // permission flip, parent dir vanished) is NOT the same thing
        // as "lock not held" — but we report the same UI status. Warn
        // so the operator can correlate a `false` with the actual
        // I/O fault. Behavior is preserved (still surfaces as
        // "lock_held: false") but the cause is no longer silent.
        let lock_held = match consolidation_lock::try_acquire(ws) {
            Ok(Some(prior)) => {
                consolidation_lock::rollback(ws, prior);
                false
            }
            Ok(None) => true,
            Err(err) => {
                tracing::warn!(
                    workspace = %ws.display(),
                    error = %err,
                    "memory::workspace_memory_status: try_acquire failed; reporting lock_held=false but the actual lock state is unknown"
                );
                false
            }
        };

        Ok(WorkspaceMemoryStatus {
            memory_count: headers.len(),
            last_consolidated_at: last_at,
            hours_since_consolidation: if hours == f64::MAX { -1.0 } else { hours },
            sessions_since_consolidation: sessions_since,
            lock_held,
            memory_dir: mem_dir.to_string_lossy().to_string(),
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Read the MEMORY.md index file for a workspace.
#[tauri::command]
pub async fn workspace_memory_index(workspace: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let ws = Path::new(&workspace);
        let mem_dir = workspace_memory::memory_dir(ws);
        Ok(workspace_memory::load_memory_index(&mem_dir))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Write (overwrite) a single workspace memory file.
///
/// Creates the memory directory if it does not exist. Applies the same
/// path-traversal guard as `workspace_memory_read` and `workspace_memory_delete`.
/// Content must be non-empty. Filename must end in `.md`.
#[tauri::command]
pub async fn workspace_memory_write(
    workspace: String,
    filename: String,
    content: String,
) -> Result<(), String> {
    if content.trim().is_empty() {
        return Err("content must not be empty".to_string());
    }
    if !filename.ends_with(".md") {
        return Err("filename must end with .md".to_string());
    }
    reject_memory_traversal(&filename)?;
    tokio::task::spawn_blocking(move || {
        let ws = Path::new(&workspace);
        let mem_dir = workspace_memory::memory_dir(ws);
        let file_path = mem_dir.join(&filename);
        if !file_path.starts_with(&mem_dir) {
            return Err("Path traversal rejected".to_string());
        }
        if !mem_dir.exists() {
            std::fs::create_dir_all(&mem_dir)
                .map_err(|e| format!("Failed to create memory dir: {}", e))?;
        }
        std::fs::write(&file_path, content).map_err(|e| format!("Write failed: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

// ========================================================================
// Debug-only e2e helpers
// ========================================================================
//
// These commands exist solely so audit specs (see tests/e2e/specs/audit-
// memory-*.spec.mjs) can drive the L3/L2 surfaces structurally without
// having to either trigger reflection (slow, requires LLM) or scrape the
// debug HTTP server. Both commands are gated on `#[cfg(debug_assertions)]`
// so release binaries never ship them. Mirrors the gating used by the
// existing `prompt_dump` debug command.

/// Seed a single learning row directly into the `learnings` table.
///
/// Used by `audit-memory-crud.spec.mjs` and `audit-memory-llm.spec.mjs`
/// to populate L3 memory without an LLM round trip. Validates `status`
/// and `source` against the canonical enums and refuses typo'd payloads
/// the same way `learnings_set_status` / `test_learnings_seed` do.
#[tauri::command]
pub async fn debug_seed_learning(
    state: tauri::State<'_, AgentAppState>,
    agent_scope: String,
    content: String,
    takeaway: Option<String>,
    status: Option<String>,
    source: Option<String>,
    category: Option<String>,
) -> Result<String, String> {
    use super::learnings::{
        self, EvolutionType, Learning, LearningCategory, LearningSource, LearningStatus,
    };

    if content.trim().is_empty() {
        return Err("content must not be empty".to_string());
    }

    let category_parsed = match category.as_deref() {
        None | Some("") => LearningCategory::Pattern,
        Some(other) => {
            LearningCategory::parse(other).ok_or_else(|| format!("unknown category '{}'", other))?
        }
    };
    let status_parsed = match status.as_deref() {
        None | Some("") | Some("active") => LearningStatus::Active,
        Some("pending") => LearningStatus::Pending,
        Some("merged") => LearningStatus::Merged,
        Some("deprecated") => LearningStatus::Deprecated,
        Some("abandoned") => LearningStatus::Abandoned,
        Some(other) => return Err(format!("unknown status '{}'", other)),
    };
    let source_parsed = match source.as_deref() {
        None | Some("") => LearningSource::Reflection,
        Some(other) => {
            LearningSource::parse(other).ok_or_else(|| format!("unknown source '{}'", other))?
        }
    };

    let content_hash = Some(learnings::compute_content_hash(&content, category_parsed));
    let learning = Learning {
        id: String::new(),
        agent_scope,
        content,
        takeaway,
        category: category_parsed,
        importance: 0.5,
        confidence: 0.9,
        embedding: Vec::new(),
        embedding_model: None,
        status: status_parsed,
        content_hash,
        reinforcement_count: 1,
        source: source_parsed,
        account_id: None,
        evolution_type: EvolutionType::Original,
        parent_id: None,
        last_recalled_at: None,
        source_session_id: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
    };

    let learning_id = tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|e| e.to_string())?;
        learnings::insert_learning(&conn, &learning).map_err(|e| format!("insert failed: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;
    state
        .invalidate_prompt_caches(PromptCacheInvalidationReason::LearningsChanged)
        .await;
    Ok(learning_id)
}

/// Render the workspace-memory prompt section that the live processor
/// would inject on the next turn for a given workspace.
///
/// Pure function over the on-disk memory files: returns the same string
/// `processor::build_dynamic_sections` constructs via
/// `prefetch::build_memory_prompt_section`. Returns `None` when neither
/// `MEMORY.md` nor any `*.md` files exist under the memory dir — same
/// semantics as the live path.
#[tauri::command]
pub async fn debug_memory_prefetch_section(
    workspace: String,
    user_query: Option<String>,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let ws = Path::new(&workspace);
        let query = user_query.unwrap_or_default();
        let memories = workspace_memory::prefetch::select_memories_offline(ws, &query);
        Ok(workspace_memory::prefetch::build_memory_prompt_section(
            ws, &memories,
        ))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
