//! Work-item action handlers (`start_item`, `find`).
//!
//! The duplicate CRUD surface (`list_items`/`read_item`/`create_item`/
//! `update_item`/`delete_item`) was consolidated into `manage_work_item`
//! (Orgtrack migration Phase 8): one tool owns work-item CRUD, this tool
//! keeps only the capabilities `manage_work_item` does not have —
//! starting a work item's orchestrator run and cross-workspace search.
//! The dispatcher returns structured guidance for the retired actions.

use crate::tools::traits::ToolError;

pub(super) async fn start(
    slug: &str,
    short_id: &str,
    app_handle: Option<&tauri::AppHandle>,
    session_account_id: Option<&str>,
    agent_model: &str,
) -> Result<String, ToolError> {
    let app = app_handle.ok_or_else(|| {
        ToolError::ExecutionFailed(
            "start_item requires app_handle (not available in this context)".to_string(),
        )
    })?;
    let override_account = session_account_id.filter(|acct| !acct.is_empty());
    let override_model = if !agent_model.trim().is_empty() {
        Some(agent_model)
    } else {
        None
    };
    crate::tool_infra::start_work_item(slug, short_id, app, override_account, override_model)
        .await
        .map_err(ToolError::ExecutionFailed)
}

pub(super) async fn find(query: &str) -> Result<String, ToolError> {
    crate::tool_infra::find_across_workspaces(query)
        .await
        .map_err(ToolError::ExecutionFailed)
}
