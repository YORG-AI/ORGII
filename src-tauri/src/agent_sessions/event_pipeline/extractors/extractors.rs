//! Data Extractors
//!
//! Rust port of the TypeScript `dataExtractors.ts`.
//! Pulls structured rendering data from SessionEvent args/result fields.

use crate::agent_sessions::event_pipeline::extractors::types::*;
use crate::agent_sessions::event_pipeline::types::{EventDisplayVariant, SessionEvent};
use agent_core::core::tools::builtin_tools::resolve_effective_app_subtool;
use agent_core::core::tools::names as tool_names;
use agent_core::core::tools::ui_metadata::AppSubtool;

use super::file_extractor::{extract_edit, extract_file};
use super::helpers::obj_str;
use super::misc_extractor::extract_delete_file;
use super::misc_extractor::{
    extract_message, extract_org_task, extract_subagent, extract_thinking, extract_todo,
    extract_web_search,
};
use super::search_extractor::{extract_glob, extract_list_dir, extract_search};
use super::shell_extractor::{extract_await, extract_shell};

pub use super::lang::detect_language;
pub use super::lang::strip_line_number_prefixes_pub;

// ============================================================================
// Public Extraction API
// ============================================================================

/// Extract structured rendering data from a SessionEvent.
/// Returns `None` for event types that don't need pre-computation (e.g. approvals).
pub fn extract_event_data(event: &SessionEvent) -> Option<ExtractedData> {
    let args = event.args.as_object();
    let result = event.result.as_object();

    match event.display_variant {
        EventDisplayVariant::Thinking => {
            Some(ExtractedData::Thinking(extract_thinking(args, result)))
        }

        EventDisplayVariant::Message => Some(ExtractedData::Message(extract_message(event))),

        EventDisplayVariant::Session => None,

        EventDisplayVariant::ToolCall => extract_tool_call_data(event, args, result),

        EventDisplayVariant::Error => Some(ExtractedData::Message(ExtractedMessageData {
            content: result.and_then(|r| {
                obj_str(r, "error")
                    .or_else(|| obj_str(r, "error_message"))
                    .or_else(|| obj_str(r, "observation"))
            }),
            is_user: false,
        })),

        _ => None,
    }
}

fn extract_tool_call_data(
    event: &SessionEvent,
    args: Option<&serde_json::Map<String, serde_json::Value>>,
    result: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Option<ExtractedData> {
    // Resolve action from args (primary source) then fall back to
    // event.action_type. Some wire formats send action under args.action,
    // others set the normalized SessionEvent.action_type.
    let action = args
        .and_then(|a| a.get("action").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
        .unwrap_or_else(|| event.action_type.clone());
    let action_opt: Option<&str> = if action.is_empty() {
        None
    } else {
        Some(&action)
    };

    let tool = if !event.ui_canonical.is_empty() {
        event.ui_canonical.as_str()
    } else {
        event.function_name.as_str()
    };

    let org_task_tool = if matches!(
        tool,
        tool_names::TASK_CREATE
            | tool_names::TASK_UPDATE
            | tool_names::TASK_LIST
            | tool_names::TASK_GET
    ) {
        Some(tool)
    } else if matches!(
        event.function_name.as_str(),
        tool_names::TASK_CREATE
            | tool_names::TASK_UPDATE
            | tool_names::TASK_LIST
            | tool_names::TASK_GET
    ) {
        Some(event.function_name.as_str())
    } else {
        None
    };

    if let Some(org_task_tool) = org_task_tool {
        return Some(ExtractedData::OrgTask(extract_org_task(
            org_task_tool,
            args,
            result,
            &event.display_status,
        )));
    }

    // Resolved AppSubtool is the single dispatch key. Built-in tools always
    // resolve; dynamic/unknown tools fall through to OtherTool.
    let subtool = resolve_effective_app_subtool(tool, action_opt)
        .or_else(|| resolve_effective_app_subtool(&event.function_name, action_opt))
        .unwrap_or(AppSubtool::OtherTool);

    match subtool {
        AppSubtool::FileRead => Some(ExtractedData::File(extract_file(args, result))),
        AppSubtool::FileWrite => {
            // Delete-file actions carry only a path, not a diff.
            if action_opt == Some("delete") || tool == "delete_file" {
                Some(ExtractedData::DeleteFile(extract_delete_file(args, result)))
            } else {
                Some(ExtractedData::Edit(extract_edit(args, result)))
            }
        }
        AppSubtool::Shell => {
            // await_output shares the Shell subtool but has its own payload shape.
            if tool == "await_output" {
                Some(ExtractedData::Await(extract_await(args, result)))
            } else {
                Some(ExtractedData::Shell(extract_shell(args, result)))
            }
        }
        AppSubtool::Search => Some(ExtractedData::Search(extract_search(args, result))),
        AppSubtool::Glob => Some(ExtractedData::Glob(extract_glob(args, result))),
        AppSubtool::Explore => Some(ExtractedData::ListDir(extract_list_dir(args, result))),
        AppSubtool::Browser => {
            // web_search has structured results; other browser actions fall through.
            if tool == "web_search" {
                Some(ExtractedData::WebSearch(extract_web_search(args, result)))
            } else {
                None
            }
        }
        AppSubtool::Todo => Some(ExtractedData::Todo(extract_todo(args, result))),
        AppSubtool::Subagent => Some(ExtractedData::Subagent(extract_subagent(args, result))),
        // Message/Thinking are handled by extract_event_data directly via
        // display_variant. The remaining subtools don't have a specialized
        // extractor yet; generic tool calls fall back to file extraction
        // when a file_path hint is present.
        AppSubtool::InternalBrowser
        | AppSubtool::Project
        | AppSubtool::Message
        | AppSubtool::OtherInteractions
        | AppSubtool::Thinking
        | AppSubtool::OtherTool => {
            if event.file_path.is_some() {
                Some(ExtractedData::File(extract_file(args, result)))
            } else {
                None
            }
        }
    }
}

// ============================================================================
// Batch Extraction
// ============================================================================

/// Extract rendering data for a batch of events.
/// Returns pairs of (event_id, extracted_data) for events that have extractable data.
pub fn extract_batch(events: &[SessionEvent]) -> Vec<(String, ExtractedData)> {
    events
        .iter()
        .filter_map(|event| extract_event_data(event).map(|data| (event.id.clone(), data)))
        .collect()
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
#[path = "tests/extractors_tests.rs"]
mod tests;
