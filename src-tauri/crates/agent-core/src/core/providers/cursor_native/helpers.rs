//! Miscellaneous helpers used across the `cursor_native` provider.
//!
//! These functions have no shared mutable state and exist purely to keep the
//! main provider loop readable.

use std::path::Path;

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::super::proto::agent_v1 as pb;
use super::super::tools::{
    encode_exec_tool_result_message, encode_mcp_exec_tool_result_message, HistoricToolCall,
};
use super::super::CursorNativeWorkspaceContext;
use crate::providers::traits::ProviderError;

// ---------------------------------------------------------------------------
// Conversation-ID helpers
// ---------------------------------------------------------------------------

pub(super) fn stable_conversation_id(session_id: &str) -> String {
    let digest = Sha256::digest(format!("orgii:cursor-native:{session_id}").as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

// ---------------------------------------------------------------------------
// Tool-continuation policy
// ---------------------------------------------------------------------------

use super::ToolContinuationPolicy;
use crate::tools::names as tool_names;

pub(super) fn continuation_policy_for_tool(tool_name: &str) -> ToolContinuationPolicy {
    match tool_name {
        tool_names::CREATE_PLAN | tool_names::SUGGEST_MODE_SWITCH => {
            ToolContinuationPolicy::EndLogicalTurn
        }
        _ => ToolContinuationPolicy::ContinueSameStream,
    }
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

pub(super) fn find_tool_result<'a>(messages: &'a [Value], tool_call_id: &str) -> Option<&'a Value> {
    messages.iter().rev().find(|message| {
        message.get("role").and_then(Value::as_str) == Some("tool")
            && message.get("tool_call_id").and_then(Value::as_str) == Some(tool_call_id)
    })
}

pub(super) fn current_user_request_from_messages(messages: &[Value]) -> Option<String> {
    messages
        .iter()
        .rev()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .map(message_content_text)
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

pub(super) fn message_content_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<String>(),
        _ => String::new(),
    }
}

pub(super) fn tool_result_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(value) => value.to_string(),
        None => String::new(),
    }
}

pub(super) fn mcp_same_stream_result_text(
    result_text: &str,
    current_user_request: Option<&str>,
) -> String {
    let Some(request) = current_user_request
        .map(str::trim)
        .filter(|request| !request.is_empty())
    else {
        return result_text.to_string();
    };
    format!("{result_text}\n\n<current_user_request>\n{request}\n</current_user_request>")
}

// ---------------------------------------------------------------------------
// Paused-run tool result delivery
// ---------------------------------------------------------------------------

pub(super) fn send_tool_result_to_paused_run(
    pending: &super::PendingCursorRun,
    tool_result: &Value,
) -> Result<(), ProviderError> {
    use super::exec_bridge::{map_client_error, ToolResultKind};

    let result_text = match pending.result_kind {
        ToolResultKind::Mcp => mcp_same_stream_result_text(
            &tool_result_text(tool_result),
            pending.current_user_request.as_deref(),
        ),
        ToolResultKind::Native => tool_result_text(tool_result),
    };
    let call = HistoricToolCall {
        tool_call_id: pending.tool_call.id.clone(),
        tool_name: pending.tool_call.name.clone(),
        arguments: pending.tool_call.arguments.clone(),
        result_text,
    };
    let result_message = match pending.result_kind {
        ToolResultKind::Mcp => encode_mcp_exec_tool_result_message(&call),
        ToolResultKind::Native => encode_exec_tool_result_message(&call),
    };
    pending
        .stream
        .send(&pb::AgentClientMessage {
            message: Some(pb::agent_client_message::Message::ExecClientMessage(
                pb::ExecClientMessage {
                    id: pending.exec_message_id,
                    exec_id: pending.exec_id.clone(),
                    message: Some(result_message),
                },
            )),
        })
        .map_err(map_client_error)?;
    pending
        .stream
        .send(&pb::AgentClientMessage {
            message: Some(pb::agent_client_message::Message::ExecClientControlMessage(
                pb::ExecClientControlMessage {
                    message: Some(pb::exec_client_control_message::Message::StreamClose(
                        pb::ExecClientStreamClose {
                            id: pending.exec_message_id,
                        },
                    )),
                },
            )),
        })
        .map_err(map_client_error)
}

// ---------------------------------------------------------------------------
// Variant-name diagnostics
// ---------------------------------------------------------------------------

pub(super) fn interaction_update_variant_name(update: &pb::InteractionUpdate) -> &'static str {
    match update.message.as_ref() {
        Some(pb::interaction_update::Message::TextDelta(_)) => "TextDelta",
        Some(pb::interaction_update::Message::PartialToolCall(_)) => "PartialToolCall",
        Some(pb::interaction_update::Message::ToolCallDelta(_)) => "ToolCallDelta",
        Some(pb::interaction_update::Message::ToolCallStarted(_)) => "ToolCallStarted",
        Some(pb::interaction_update::Message::ToolCallCompleted(_)) => "ToolCallCompleted",
        Some(pb::interaction_update::Message::ThinkingDelta(_)) => "ThinkingDelta",
        Some(pb::interaction_update::Message::ThinkingCompleted(_)) => "ThinkingCompleted",
        Some(pb::interaction_update::Message::UserMessageAppended(_)) => "UserMessageAppended",
        Some(pb::interaction_update::Message::TokenDelta(_)) => "TokenDelta",
        Some(pb::interaction_update::Message::Summary(_)) => "Summary",
        Some(pb::interaction_update::Message::SummaryStarted(_)) => "SummaryStarted",
        Some(pb::interaction_update::Message::SummaryCompleted(_)) => "SummaryCompleted",
        Some(pb::interaction_update::Message::ShellOutputDelta(_)) => "ShellOutputDelta",
        Some(pb::interaction_update::Message::Heartbeat(_)) => "Heartbeat",
        Some(pb::interaction_update::Message::TurnEnded(_)) => "TurnEnded",
        Some(pb::interaction_update::Message::StepStarted(_)) => "StepStarted",
        Some(pb::interaction_update::Message::StepCompleted(_)) => "StepCompleted",
        None => "None",
    }
}

pub(super) fn server_message_variant_name(
    message: &pb::agent_server_message::Message,
) -> &'static str {
    match message {
        pb::agent_server_message::Message::InteractionUpdate(_) => "InteractionUpdate",
        pb::agent_server_message::Message::ExecServerMessage(_) => "ExecServerMessage",
        pb::agent_server_message::Message::ExecServerControlMessage(_) => {
            "ExecServerControlMessage"
        }
        pb::agent_server_message::Message::ConversationCheckpointUpdate(_) => {
            "ConversationCheckpointUpdate"
        }
        pb::agent_server_message::Message::KvServerMessage(_) => "KvServerMessage",
        pb::agent_server_message::Message::InteractionQuery(_) => "InteractionQuery",
    }
}

pub(super) fn exec_message_variant_name(
    message: &pb::exec_server_message::Message,
) -> &'static str {
    match message {
        pb::exec_server_message::Message::RequestContextArgs(_) => "RequestContextArgs",
        pb::exec_server_message::Message::McpArgs(_) => "McpArgs",
        pb::exec_server_message::Message::ReadArgs(_) => "ReadArgs",
        pb::exec_server_message::Message::LsArgs(_) => "LsArgs",
        pb::exec_server_message::Message::GrepArgs(_) => "GrepArgs",
        pb::exec_server_message::Message::WriteArgs(_) => "WriteArgs",
        pb::exec_server_message::Message::DeleteArgs(_) => "DeleteArgs",
        pb::exec_server_message::Message::ShellArgs(_) => "ShellArgs",
        pb::exec_server_message::Message::ShellStreamArgs(_) => "ShellStreamArgs",
        pb::exec_server_message::Message::BackgroundShellSpawnArgs(_) => "BackgroundShellSpawnArgs",
        pb::exec_server_message::Message::WriteShellStdinArgs(_) => "WriteShellStdinArgs",
        pb::exec_server_message::Message::DiagnosticsArgs(_) => "DiagnosticsArgs",
        pb::exec_server_message::Message::ListMcpResourcesExecArgs(_) => "ListMcpResourcesExecArgs",
        pb::exec_server_message::Message::ReadMcpResourceExecArgs(_) => "ReadMcpResourceExecArgs",
        pb::exec_server_message::Message::FetchArgs(_) => "FetchArgs",
        pb::exec_server_message::Message::RecordScreenArgs(_) => "RecordScreenArgs",
        pb::exec_server_message::Message::ComputerUseArgs(_) => "ComputerUseArgs",
    }
}

// ---------------------------------------------------------------------------
// Workspace / request-context helpers
// ---------------------------------------------------------------------------

pub(super) fn should_expose_as_cursor_native_mcp_tool(_tool_name: &str) -> bool {
    true
}

pub(super) fn build_request_context(
    tool_definitions: &[pb::McpToolDefinition],
    workspace_context: Option<&CursorNativeWorkspaceContext>,
) -> Option<pb::RequestContext> {
    if tool_definitions.is_empty() && workspace_context.is_none() {
        return None;
    }

    Some(pb::RequestContext {
        env: workspace_context.map(|context| pb::RequestContextEnv {
            workspace_paths: context
                .workspace_paths
                .iter()
                .map(|path| display_path(path))
                .collect(),
            project_folder: display_path(&context.project_folder),
            shell: default_shell(),
            os_version: std::env::consts::OS.to_string(),
            sandbox_enabled: false,
            terminals_folder: String::new(),
            agent_shared_notes_folder: String::new(),
            agent_conversation_notes_folder: String::new(),
            time_zone: String::new(),
            agent_transcripts_folder: String::new(),
        }),
        tools: tool_definitions.to_vec(),
        mcp_instructions: Vec::new(),
        ..Default::default()
    })
}

pub(super) fn describe_workspace_context(context: &CursorNativeWorkspaceContext) -> String {
    format!(
        "project={}, roots=[{}]",
        display_path(&context.project_folder),
        context
            .workspace_paths
            .iter()
            .map(|path| display_path(path))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

pub(super) fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Wrapper that delegates to [`super::interaction::cursor_mcp_tool_name`]
/// to avoid requiring `exec_bridge` to import `interaction` directly.
pub(super) fn cursor_mcp_tool_name_from_args(args: &pb::McpArgs) -> &str {
    if args.tool_name.is_empty() {
        &args.name
    } else {
        &args.tool_name
    }
}

#[cfg(unix)]
pub(super) fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
}

#[cfg(windows)]
pub(super) fn default_shell() -> String {
    // Cursor uses this request-context value to choose shell syntax before its
    // native shell call is bridged into ORGII's run_shell implementation.
    // Keep it aligned with the Windows PowerShell 5.1 execution contract.
    "powershell.exe".to_string()
}

#[cfg(all(test, windows))]
mod windows_shell_tests {
    #[test]
    fn windows_powershell_context_matches_run_shell_backend() {
        assert_eq!(super::default_shell(), "powershell.exe");
    }
}
