//! Shared record fixture for the aggregation submodule tests.

use core_types::key_source::KeySource;

use crate::agent_sessions::session_directory::display::generate_display_label;
use crate::agent_sessions::session_directory::status::is_active_status;
use crate::agent_sessions::session_directory::types::{SessionAggregateRecord, SessionCategory};

pub(super) fn make_session(
    id: &str,
    status: &str,
    category: SessionCategory,
    key_source: KeySource,
) -> SessionAggregateRecord {
    let name = format!("Session {}", id);
    SessionAggregateRecord {
        session_id: id.to_string(),
        name: name.clone(),
        status: status.to_string(),
        created_at: "2024-01-01T00:00:00Z".to_string(),
        updated_at: "2024-01-01T01:00:00Z".to_string(),
        category,
        external_history_source: None,
        user_input: None,
        repo_path: None,
        repo_root_path: None,
        repo_remote_urls: None,
        storage_path: None,
        repo_name: None,
        branch: None,
        model: Some("gpt-4".to_string()),
        account_id: None,
        cli_agent_type: None,
        key_source,
        tier: None,
        pid: None,
        total_tokens: 1000,
        worktree_path: None,
        worktree_branch: None,
        base_branch: None,
        merge_status: None,
        background: false,
        org_id: None,
        project_id: None,
        project_name: None,
        project_slug: None,
        work_item_id: None,
        agent_role: None,
        is_active: is_active_status(status),
        display_label: generate_display_label(&name, None),
        parent_session_id: None,
        org_member_id: None,
        agent_org_id: None,
        agent_org_name: None,
        agent_definition_id: None,
        agent_icon_id: None,
        agent_display_name: None,
        agent_exec_mode: None,
        product_mode: None,
        draft_text: None,
        reply_target_event_id: None,
        pinned: false,
        files_changed: None,
        lines_added: None,
        lines_removed: None,
        touched_files: None,
        client_origin: None,
        client_origin_raw: None,
    }
}
