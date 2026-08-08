//! Interaction side-channel handling.
//!
//! Translates `InteractionUpdate` server messages into ORGII `ToolCallRequest`
//! values and implements the KV blob reply protocol.

use std::collections::HashSet;

use tracing::info;

use super::super::client::{ClientError, RunStream};
use super::super::proto::agent_v1 as pb;
use super::super::request::BlobStore;
use super::super::tools::mcp_args_to_tool_call;
use super::exec_bridge::cursor_tool_call_id;
use super::tool_stream::InteractionToolStreamState;
use crate::definitions::builtin::{EXPLORE_AGENT_ID, GENERAL_AGENT_ID};
use crate::providers::traits::{finish_reason, StreamDelta, ToolCallDelta, ToolCallRequest};
use crate::tools::names as tool_names;

/// Dispatch a single `InteractionUpdate` into the accumulators + on_delta.
///
/// Returns `Some(ToolCallRequest)` when the server has completed an MCP or
/// task tool call that ORGII should now execute.
#[allow(clippy::too_many_arguments)]
// Keep the stream reducer's mutable accumulators explicit; a relay context
// would obscure which fields this update is allowed to mutate.
pub(super) fn handle_interaction_update(
    update: pb::InteractionUpdate,
    content: &mut String,
    reasoning: &mut String,
    output_tokens: &mut i64,
    saw_turn_end: &mut bool,
    completed_same_stream_tool_ids: &HashSet<String>,
    interaction_tool_streams: &mut InteractionToolStreamState,
    on_delta: &(dyn Fn(StreamDelta) + Send + Sync),
) -> Option<ToolCallRequest> {
    let inner = update.message?;
    match inner {
        pb::interaction_update::Message::TextDelta(d) => {
            if !d.text.is_empty() {
                content.push_str(&d.text);
                on_delta(StreamDelta {
                    content: Some(d.text),
                    reasoning: None,
                    tool_call_delta: None,
                    finish_reason: None,
                    usage: None,
                });
            }
        }
        pb::interaction_update::Message::ThinkingDelta(d) => {
            if !d.text.is_empty() {
                reasoning.push_str(&d.text);
                on_delta(StreamDelta {
                    content: None,
                    reasoning: Some(d.text),
                    tool_call_delta: None,
                    finish_reason: None,
                    usage: None,
                });
            }
        }
        pb::interaction_update::Message::TokenDelta(d) => {
            *output_tokens = output_tokens.saturating_add(d.tokens as i64);
        }
        pb::interaction_update::Message::TurnEnded(_) => {
            *saw_turn_end = true;
            on_delta(StreamDelta {
                content: None,
                reasoning: None,
                tool_call_delta: None,
                finish_reason: Some(finish_reason::STOP.to_string()),
                usage: None,
            });
        }
        pb::interaction_update::Message::ToolCallStarted(update) => {
            log_interaction_tool_call("started", &update.call_id, update.tool_call.as_ref());
            interaction_tool_streams.register(&update.call_id, update.tool_call.as_ref());
        }
        pb::interaction_update::Message::PartialToolCall(update) => {
            interaction_tool_streams.register(&update.call_id, update.tool_call.as_ref());
            if !update.args_text_delta.is_empty() {
                let entry = interaction_tool_streams.entry_for_cursor_call_id(&update.call_id);
                interaction_tool_streams.mark_partial(&entry.orgii_call_id);
                on_delta(StreamDelta {
                    content: None,
                    reasoning: None,
                    tool_call_delta: Some(ToolCallDelta {
                        index: entry.index,
                        id: Some(entry.orgii_call_id),
                        name: entry.tool_name,
                        arguments_delta: Some(update.args_text_delta),
                    }),
                    finish_reason: None,
                    usage: None,
                });
            }
        }
        pb::interaction_update::Message::ToolCallCompleted(update) => {
            interaction_tool_streams.register(&update.call_id, update.tool_call.as_ref());
            if completed_same_stream_tool_ids.contains(&update.call_id)
                || update
                    .tool_call
                    .as_ref()
                    .and_then(extract_mcp_args)
                    .is_some_and(|args| completed_same_stream_tool_ids.contains(&args.tool_call_id))
            {
                info!(
                    "[cursor] ignoring completed MCP tool-call echo after same-stream result call_id={}",
                    update.call_id
                );
                return None;
            }
            return interaction_tool_call_to_orgii_request(
                &update.call_id,
                update.tool_call.as_ref(),
            );
        }
        // Non-MCP native tools get their authoritative args from
        // `ExecServerMessage`. Delta lifecycle updates are not executable on
        // their own because args may be incomplete.
        _ => {}
    }
    None
}

/// Reply to a server KV request (blob get / set) on the open stream.
pub(super) fn reply_to_kv(
    stream: &RunStream,
    kv: pb::KvServerMessage,
    blobs: &mut BlobStore,
) -> Result<(), ClientError> {
    let id = kv.id;
    let Some(inner) = kv.message else {
        return Ok(());
    };
    let response = match inner {
        pb::kv_server_message::Message::GetBlobArgs(args) => {
            let blob_data = blobs.get(&args.blob_id).cloned();
            if blob_data.is_none() {
                tracing::warn!(
                    "[cursor] server requested unknown blob (id_bytes_len={})",
                    args.blob_id.len()
                );
            }
            pb::KvClientMessage {
                id,
                message: Some(pb::kv_client_message::Message::GetBlobResult(
                    pb::GetBlobResult { blob_data },
                )),
            }
        }
        pb::kv_server_message::Message::SetBlobArgs(args) => {
            blobs.insert(args.blob_id, args.blob_data);
            pb::KvClientMessage {
                id,
                message: Some(pb::kv_client_message::Message::SetBlobResult(
                    pb::SetBlobResult { error: None },
                )),
            }
        }
    };
    stream.send(&pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::KvClientMessage(response)),
    })
}

pub(super) fn cursor_mcp_tool_name(args: &pb::McpArgs) -> &str {
    if args.tool_name.is_empty() {
        &args.name
    } else {
        &args.tool_name
    }
}

pub(super) fn extract_mcp_args(tool_call: &pb::ToolCall) -> Option<&pb::McpArgs> {
    match tool_call.tool.as_ref()? {
        pb::tool_call::Tool::McpToolCall(mcp_tool_call) => mcp_tool_call.args.as_ref(),
        _ => None,
    }
}

pub(super) fn log_interaction_tool_call(
    stage: &str,
    call_id: &str,
    tool_call: Option<&pb::ToolCall>,
) {
    if let Some(args) = tool_call.and_then(extract_mcp_args) {
        let arg_keys = args.args.keys().cloned().collect::<Vec<_>>().join(",");
        info!(
            "[cursor] interaction {} MCP tool call: call_id={} tool_call_id={} name={} arg_keys=[{}]",
            stage,
            call_id,
            args.tool_call_id,
            cursor_mcp_tool_name(args),
            arg_keys
        );
    }
}

pub(super) fn interaction_tool_call_to_orgii_request(
    call_id: &str,
    tool_call: Option<&pb::ToolCall>,
) -> Option<ToolCallRequest> {
    let tool_call = tool_call?;
    match tool_call.tool.as_ref()? {
        pb::tool_call::Tool::McpToolCall(mcp_tool_call) => {
            let args = mcp_tool_call.args.as_ref()?;
            let arg_keys = args.args.keys().cloned().collect::<Vec<_>>().join(",");
            info!(
                "[cursor] interaction completed MCP tool call: id={} name={} arg_keys=[{}]",
                call_id,
                cursor_mcp_tool_name(args),
                arg_keys
            );
            if args.args.is_empty() {
                return None;
            }
            Some(mcp_args_to_tool_call(args))
        }
        pb::tool_call::Tool::TaskToolCall(task_tool_call) => task_tool_call
            .args
            .as_ref()
            .map(|args| cursor_task_to_agent_tool_call(call_id, args)),
        _ => None,
    }
}

pub(super) fn cursor_task_to_agent_tool_call(
    call_id: &str,
    args: &pb::TaskArgs,
) -> ToolCallRequest {
    let agent_id = cursor_subagent_type_to_agent_id(args.subagent_type.as_ref());
    let mut arguments = serde_json::json!({
        "command": "launch",
        "mode": "delegate",
        "agent_id": agent_id,
        "prompt": args.prompt,
        "description": args.description,
    });
    if let Some(model) = args.model.as_ref().filter(|model| !model.is_empty()) {
        arguments["model"] = serde_json::json!(model);
    }
    if let Some(resume) = args.resume.as_ref().filter(|resume| !resume.is_empty()) {
        arguments["resume_session_id"] = serde_json::json!(resume);
    }
    ToolCallRequest {
        id: cursor_tool_call_id(call_id),
        name: tool_names::AGENT.to_string(),
        arguments,
        thought_signature: None,
    }
}

pub(super) fn cursor_subagent_type_to_agent_id(
    subagent_type: Option<&pb::SubagentType>,
) -> &'static str {
    match subagent_type.and_then(|value| value.r#type.as_ref()) {
        Some(pb::subagent_type::Type::Explore(_)) => EXPLORE_AGENT_ID,
        _ => GENERAL_AGENT_ID,
    }
}
