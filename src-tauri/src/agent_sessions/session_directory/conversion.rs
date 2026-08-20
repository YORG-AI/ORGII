//! Conversion functions for transforming backend session records into unified aggregate format.
//!
//! Each backend (CLI agent, SDE Agent, OS Agent) has its own session record type.
//! This module provides functions to convert them into the common `SessionAggregateRecord`.

use std::collections::HashSet;

use crate::agent_sessions::cli::parsers::types::CliAgentType;
use crate::agent_sessions::cli::persistence as cli_session_persistence;
use agent_core::session::persistence as session_persistence;
use core_types::key_source::KeySource;
use orgtrack_core::sources::cursor_ide::history::CursorIdeSessionRow;
use orgtrack_core::sources::imported_history::metadata::{
    SOURCE_CLAUDE_CODE, SOURCE_CODEX_APP, SOURCE_COPILOT, SOURCE_CURSOR_IDE, SOURCE_KIMI,
    SOURCE_MIMO_CODE, SOURCE_OMP, SOURCE_OPENCODE, SOURCE_PI, SOURCE_QODER_CLI, SOURCE_QWEN_CODE,
};
use orgtrack_core::sources::imported_history::ImportedHistorySessionRow;

use super::display::generate_display_label;
use super::status::is_active_status;
use super::types::{SessionAggregateRecord, SessionCategory};
use crate::orgtrack::impact_indexer::get_session_impact;

pub struct AgentMetadataResolver {
    store: std::sync::Arc<agent_core::definitions::AgentDefinitionsStore>,
}

/// Definition ids that already produced a resolution warning, deduplicated
/// process-wide. Resolvers are constructed per list/page call, so a
/// per-instance set would re-log the same stale id (e.g. a session row
/// persisted with a since-removed builtin) on every sidebar refresh.
static WARNED_DEFINITION_IDS: std::sync::OnceLock<std::sync::Mutex<HashSet<String>>> =
    std::sync::OnceLock::new();

fn warn_once_for_definition(def_id: &str, err: &str) {
    let warned = WARNED_DEFINITION_IDS.get_or_init(|| std::sync::Mutex::new(HashSet::new()));
    let mut warned = warned.lock().expect("definition warn set poisoned");
    if warned.insert(def_id.to_string()) {
        // Stale ids are routine (deleted custom agents, e2e fixtures);
        // thousands of distinct ones would drown the log at warn level.
        tracing::debug!(
            "[session_directory] Failed to resolve agent definition '{def_id}' for aggregate metadata: {err}"
        );
    }
}

fn native_impact_fields(
    session_id: &str,
) -> (Option<i64>, Option<i64>, Option<i64>, Option<Vec<String>>) {
    match get_session_impact(session_id) {
        Ok(Some(impact)) => (
            Some(impact.files_changed),
            Some(impact.lines_added),
            Some(impact.lines_removed),
            Some(impact.touched_files),
        ),
        Ok(None) => (None, None, None, None),
        Err(err) => {
            tracing::debug!(session_id = %session_id, error = %err, "[session_directory] source impact unavailable");
            (None, None, None, None)
        }
    }
}

impl Default for AgentMetadataResolver {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentMetadataResolver {
    pub fn new() -> Self {
        Self {
            store: agent_core::definitions::definitions_store(),
        }
    }

    fn resolve(
        &mut self,
        session_id: &str,
        persisted_definition_id: Option<&str>,
    ) -> (Option<String>, Option<String>, Option<String>) {
        let definition_id = persisted_definition_id.map(str::to_string).or_else(|| {
            agent_core::core::definitions::prefix_lookup::BUILTIN_PREFIX_REGISTRY
                .iter()
                .find(|entry| session_id.starts_with(entry.prefix))
                .map(|entry| entry.agent_id.to_string())
        });

        let Some(def_id) = definition_id else {
            return (None, None, None);
        };

        match agent_core::definitions::resolver::resolve_definition_by_id(
            &def_id,
            Some(&self.store),
        ) {
            Ok(definition) => (Some(def_id), definition.icon_id, Some(definition.name)),
            Err(err) => {
                warn_once_for_definition(&def_id, &err);
                (Some(def_id), None, None)
            }
        }
    }
}

// ============================================================================
// CLI Agent Conversion
// ============================================================================

/// Convert a CLI agent session to the unified aggregate record format.
pub fn cli_session_to_aggregate_record(
    session: cli_session_persistence::CodeSession,
) -> SessionAggregateRecord {
    let repo_name = session
        .repo_path
        .as_ref()
        .and_then(|p| std::path::Path::new(p).file_name())
        .and_then(|n| n.to_str())
        .map(String::from);

    let status_str = session.status.as_ref();
    let is_active = is_active_status(status_str);
    let display_label = generate_display_label(&session.name, session.user_input.as_deref());

    SessionAggregateRecord {
        session_id: session.session_id,
        name: session.name,
        status: status_str.to_string(),
        created_at: session.created_at,
        updated_at: session.updated_at,
        category: SessionCategory::Cli,
        external_history_source: None,
        user_input: session.user_input,
        repo_path: session.repo_path,
        repo_root_path: None,
        repo_remote_urls: None,
        storage_path: Some(app_paths::sessions_db().to_string_lossy().to_string()),
        repo_name,
        branch: session.branch,
        model: session.model,
        account_id: session.account_id,
        cli_agent_type: session.cli_agent_type,
        key_source: session.key_source,
        tier: session.tier,
        pid: session.pid,
        total_tokens: session.total_tokens,
        worktree_path: session.worktree_path,
        worktree_branch: session.worktree_branch,
        base_branch: session.base_branch,
        merge_status: session.merge_status,
        background: session.background,
        org_id: Some(session.org_id),
        project_id: session.project_id,
        project_name: session.project_name,
        project_slug: session.project_slug,
        work_item_id: session.work_item_id,
        agent_role: session.agent_role,
        is_active,
        display_label,
        parent_session_id: session.parent_session_id,
        org_member_id: session.org_member_id,
        agent_org_id: None,
        agent_org_name: None,
        agent_definition_id: None,
        agent_icon_id: None,
        agent_display_name: None,
        agent_exec_mode: session.agent_exec_mode,
        product_mode: session.product_mode,
        draft_text: session.draft_text,
        reply_target_event_id: session.reply_target_event_id,
        pinned: session.pinned,
        files_changed: None,
        lines_added: None,
        lines_removed: None,
        touched_files: None,
    }
}

fn imported_history_cli_agent_type(source_label: &str) -> Option<String> {
    match source_label {
        SOURCE_CLAUDE_CODE => Some(CliAgentType::ClaudeCode.as_str().to_string()),
        SOURCE_CODEX_APP => Some(CliAgentType::Codex.as_str().to_string()),
        SOURCE_CURSOR_IDE => Some(CliAgentType::CursorCli.as_str().to_string()),
        SOURCE_OPENCODE => Some(CliAgentType::OpenCode.as_str().to_string()),
        SOURCE_MIMO_CODE => Some(CliAgentType::MimoCode.as_str().to_string()),
        SOURCE_OMP => Some(CliAgentType::Omp.as_str().to_string()),
        SOURCE_PI => Some(CliAgentType::Pi.as_str().to_string()),
        SOURCE_QODER_CLI => Some(CliAgentType::QoderCli.as_str().to_string()),
        SOURCE_QWEN_CODE => Some(CliAgentType::QwenCode.as_str().to_string()),
        SOURCE_COPILOT => Some(CliAgentType::Copilot.as_str().to_string()),
        SOURCE_KIMI => Some(CliAgentType::KimiCli.as_str().to_string()),
        _ => None,
    }
}

pub fn imported_history_to_aggregate_record(
    row: ImportedHistorySessionRow,
    source_label: &str,
) -> SessionAggregateRecord {
    let display_label = generate_display_label(&row.name, None);
    let cli_agent_type = imported_history_cli_agent_type(source_label);
    SessionAggregateRecord {
        session_id: row.session_id,
        name: row.name,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
        category: SessionCategory::Cli,
        external_history_source: Some(source_label.to_string()),
        user_input: None,
        repo_path: row.repo_path,
        repo_root_path: row.repo_root_path,
        repo_remote_urls: (!row.repo_remote_urls.is_empty()).then_some(row.repo_remote_urls),
        storage_path: row.storage_path,
        repo_name: row.repo_name,
        branch: row.branch,
        model: row.model,
        account_id: None,
        cli_agent_type,
        key_source: KeySource::OwnKey,
        tier: None,
        pid: None,
        total_tokens: row.total_tokens,
        worktree_path: None,
        worktree_branch: None,
        base_branch: None,
        merge_status: None,
        background: row.background,
        org_id: None,
        project_id: None,
        project_name: None,
        project_slug: None,
        work_item_id: None,
        agent_role: None,
        is_active: row.is_active,
        display_label,
        parent_session_id: row.parent_session_id,
        org_member_id: None,
        agent_org_id: None,
        agent_org_name: None,
        agent_definition_id: None,
        agent_icon_id: None,
        agent_display_name: Some(source_label.to_string()),
        agent_exec_mode: None,
        product_mode: None,
        draft_text: None,
        reply_target_event_id: None,
        pinned: false,
        files_changed: Some(row.files_changed),
        lines_added: Some(row.lines_added),
        lines_removed: Some(row.lines_removed),
        touched_files: Some(row.touched_files),
    }
}

pub fn cursor_ide_history_to_aggregate_record(
    row: CursorIdeSessionRow,
    source_label: &str,
) -> SessionAggregateRecord {
    let display_label = generate_display_label(&row.name, None);
    SessionAggregateRecord {
        session_id: row.session_id,
        name: row.name,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
        category: SessionCategory::Cli,
        external_history_source: Some(source_label.to_string()),
        user_input: None,
        repo_path: row.repo_path,
        repo_root_path: row.repo_root_path,
        repo_remote_urls: (!row.repo_remote_urls.is_empty()).then_some(row.repo_remote_urls),
        storage_path: row.storage_path,
        repo_name: row.repo_name,
        branch: row.branch,
        model: row.model,
        account_id: None,
        cli_agent_type: imported_history_cli_agent_type(source_label),
        key_source: KeySource::OwnKey,
        tier: None,
        pid: None,
        total_tokens: row.total_tokens,
        worktree_path: None,
        worktree_branch: None,
        base_branch: None,
        merge_status: None,
        background: row.background,
        org_id: None,
        project_id: None,
        project_name: None,
        project_slug: None,
        work_item_id: None,
        agent_role: None,
        is_active: row.is_active,
        display_label,
        parent_session_id: None,
        org_member_id: None,
        agent_org_id: None,
        agent_org_name: None,
        agent_definition_id: None,
        agent_icon_id: None,
        agent_display_name: Some(source_label.to_string()),
        agent_exec_mode: None,
        product_mode: None,
        draft_text: None,
        reply_target_event_id: None,
        pinned: false,
        files_changed: Some(row.files_changed),
        lines_added: Some(row.lines_added),
        lines_removed: Some(row.lines_removed),
        touched_files: Some(row.touched_files),
    }
}

// ============================================================================
// SDE Agent Conversion
// ============================================================================

/// Convert a SDE Agent session (unified record) to the unified aggregate record format.
pub fn sde_session_to_aggregate_record(
    session: session_persistence::UnifiedSessionRecord,
    metadata_resolver: &mut AgentMetadataResolver,
) -> SessionAggregateRecord {
    let repo_name = session
        .workspace_path
        .as_ref()
        .and_then(|p| std::path::Path::new(p).file_name())
        .and_then(|n| n.to_str())
        .map(String::from);

    let is_active = is_active_status(&session.status);
    let display_label = generate_display_label(&session.name, session.user_input.as_deref());
    let (agent_definition_id, agent_icon_id, agent_display_name) =
        metadata_resolver.resolve(&session.session_id, session.agent_definition_id.as_deref());
    let (files_changed, lines_added, lines_removed, touched_files) =
        native_impact_fields(&session.session_id);
    SessionAggregateRecord {
        session_id: session.session_id,
        name: session.name,
        status: session.status,
        created_at: session.created_at,
        updated_at: session.updated_at,
        category: SessionCategory::Agent,
        external_history_source: None,
        user_input: session.user_input,
        repo_path: session.workspace_path.clone(),
        repo_root_path: None,
        repo_remote_urls: None,
        storage_path: Some(app_paths::sessions_db().to_string_lossy().to_string()),
        repo_name,
        branch: None,
        model: session.model,
        account_id: session.account_id,
        cli_agent_type: None,
        key_source: session.key_source,
        tier: None,
        pid: None,
        total_tokens: session.total_tokens,
        worktree_path: session.worktree_path,
        worktree_branch: session.worktree_branch,
        base_branch: session.base_branch,
        merge_status: session.merge_status,
        background: false,
        org_id: session.org_id,
        project_id: session.project_id,
        project_name: session.project_name,
        project_slug: session.project_slug,
        work_item_id: session.work_item_id,
        agent_role: session.agent_role,
        is_active,
        display_label,
        parent_session_id: session.parent_session_id,
        org_member_id: session.org_member_id,
        agent_org_id: None,
        agent_org_name: None,
        agent_definition_id,
        agent_icon_id,
        agent_display_name,
        agent_exec_mode: session.agent_exec_mode,
        product_mode: session.product_mode,
        draft_text: session.draft_text,
        reply_target_event_id: session.reply_target_event_id,
        pinned: session.pinned,
        files_changed,
        lines_added,
        lines_removed,
        touched_files,
    }
}

// ============================================================================
// OS Agent Conversion
// ============================================================================

/// Convert a OS Agent session (unified record) to the unified aggregate record format.
pub fn os_session_to_aggregate_record(
    session: session_persistence::UnifiedSessionRecord,
    metadata_resolver: &mut AgentMetadataResolver,
) -> SessionAggregateRecord {
    let is_active = is_active_status(&session.status);
    let display_label = generate_display_label(&session.name, session.user_input.as_deref());
    let (agent_definition_id, agent_icon_id, agent_display_name) =
        metadata_resolver.resolve(&session.session_id, session.agent_definition_id.as_deref());
    let (files_changed, lines_added, lines_removed, touched_files) =
        native_impact_fields(&session.session_id);
    SessionAggregateRecord {
        session_id: session.session_id,
        name: session.name,
        status: session.status,
        created_at: session.created_at,
        updated_at: session.updated_at,
        category: SessionCategory::Os,
        external_history_source: None,
        user_input: session.user_input,
        repo_path: None,
        repo_root_path: None,
        repo_remote_urls: None,
        storage_path: Some(app_paths::sessions_db().to_string_lossy().to_string()),
        repo_name: None,
        branch: None,
        model: session.model,
        account_id: session.account_id,
        cli_agent_type: None,
        key_source: session.key_source,
        tier: None,
        pid: None,
        total_tokens: session.total_tokens,
        worktree_path: None,
        worktree_branch: None,
        base_branch: None,
        merge_status: None,
        background: false,
        org_id: session.org_id,
        project_id: session.project_id,
        project_name: session.project_name,
        project_slug: session.project_slug,
        work_item_id: session.work_item_id,
        agent_role: session.agent_role,
        is_active,
        display_label,
        parent_session_id: session.parent_session_id,
        org_member_id: session.org_member_id,
        agent_org_id: None,
        agent_org_name: None,
        agent_definition_id,
        agent_icon_id,
        agent_display_name,
        agent_exec_mode: session.agent_exec_mode,
        product_mode: session.product_mode,
        draft_text: session.draft_text,
        reply_target_event_id: session.reply_target_event_id,
        pinned: session.pinned,
        files_changed,
        lines_added,
        lines_removed,
        touched_files,
    }
}

// ============================================================================
// Human session conversion
// ============================================================================

/// Convert a user-authored proof-of-work session into the unified directory row.
pub fn human_session_to_aggregate_record(
    session: session_persistence::UnifiedSessionRecord,
) -> SessionAggregateRecord {
    let repo_name = session
        .workspace_path
        .as_ref()
        .and_then(|path| std::path::Path::new(path).file_name())
        .and_then(|name| name.to_str())
        .map(String::from);
    let display_label = generate_display_label(&session.name, session.user_input.as_deref());
    SessionAggregateRecord {
        session_id: session.session_id,
        name: session.name,
        status: session.status,
        created_at: session.created_at,
        updated_at: session.updated_at,
        category: SessionCategory::Human,
        external_history_source: None,
        user_input: session.user_input,
        repo_path: session.workspace_path,
        repo_root_path: None,
        repo_remote_urls: None,
        storage_path: Some(app_paths::sessions_db().to_string_lossy().to_string()),
        repo_name,
        branch: None,
        model: session.model,
        account_id: session.account_id,
        cli_agent_type: None,
        key_source: session.key_source,
        tier: None,
        pid: None,
        total_tokens: session.total_tokens,
        worktree_path: None,
        worktree_branch: None,
        base_branch: None,
        merge_status: None,
        background: false,
        org_id: session.org_id,
        project_id: session.project_id,
        project_name: session.project_name,
        project_slug: session.project_slug,
        work_item_id: session.work_item_id,
        agent_role: session.agent_role,
        is_active: false,
        display_label,
        parent_session_id: None,
        org_member_id: None,
        agent_org_id: None,
        agent_org_name: None,
        agent_definition_id: None,
        agent_icon_id: Some("clipboard-list".to_string()),
        agent_display_name: Some("Human".to_string()),
        agent_exec_mode: None,
        product_mode: None,
        draft_text: None,
        reply_target_event_id: None,
        pinned: session.pinned,
        files_changed: None,
        lines_added: None,
        lines_removed: None,
        touched_files: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qwen_imported_rows_keep_the_existing_cli_agent_identity() {
        assert_eq!(
            imported_history_cli_agent_type(SOURCE_QWEN_CODE).as_deref(),
            Some(CliAgentType::QwenCode.as_str())
        );
    }

    #[test]
    fn kimi_imported_rows_keep_the_existing_cli_agent_identity() {
        assert_eq!(
            imported_history_cli_agent_type(SOURCE_KIMI).as_deref(),
            Some(CliAgentType::KimiCli.as_str())
        );
    }

    #[test]
    fn copilot_imported_rows_keep_the_existing_cli_agent_identity() {
        assert_eq!(
            imported_history_cli_agent_type(SOURCE_COPILOT).as_deref(),
            Some(CliAgentType::Copilot.as_str())
        );
    }
}
