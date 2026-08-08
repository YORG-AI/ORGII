//! `CursorNativeClient`: the [`LLMProvider`] adapter over Cursor's
//! `agent.v1.AgentService/Run` Connect RPC.
//!
//! Responsibilities:
//! - Hold a reusable `reqwest::Client` configured for HTTP/2 + rustls (see
//!   `factory.rs` for construction — we inherit the reqwest default plus
//!   whatever ALPN negotiates, which empirically picks HTTP/2 against
//!   `api2.cursor.sh`).
//! - Translate ORGII `chat_streaming` calls into an opening [`pb::AgentRunRequest`],
//!   hand it to [`client::start_run`], and drive the resulting bidirectional
//!   stream.
//! - Respond to mid-stream server side-channel requests (blob lookups,
//!   request-context asks) so the server doesn't stall waiting on us.
//! - Surface streamed text/thinking/usage as `StreamDelta`s and translate
//!   Connect / transport errors into [`ProviderError`].
//!
//! Native built-in tool invocations arrive through the exec side-channel. MCP
//! tools can also arrive as interaction-level tool lifecycle payloads, which
//! are translated into ORGII tool requests when no exec payload is needed.

#[path = "exec_bridge.rs"]
pub(super) mod exec_bridge;
#[path = "helpers.rs"]
pub(super) mod helpers;
#[path = "interaction.rs"]
pub(super) mod interaction;
#[path = "tool_stream.rs"]
pub(super) mod tool_stream;

#[cfg(test)]
#[path = "pipeline_tests.rs"]
mod pipeline_tests;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use reqwest::Client;
use serde_json::Value;
use tracing::{debug, info, warn};

use super::auth;
use super::client::{self, RunStream};
use super::proto::agent_v1 as pb;
use super::request::{build_run_request_with_context, BlobStore};
use super::tools::build_tool_definitions;

use crate::providers::traits::{
    finish_reason, usage_key, LLMProvider, LLMResponse, ProviderConfig, ProviderError,
    SideQueryExecution, StreamDelta, ToolCallDelta, ToolCallRequest,
};

use exec_bridge::{handle_exec_server_message, map_client_error, ExecToolPause, ToolResultKind};

#[cfg(test)]
use super::tools::CURSOR_MCP_PROVIDER_IDENTIFIER;
#[cfg(test)]
use exec_bridge::{
    cursor_exec_to_tool_call, mcp_native_fallback_result, MCP_NATIVE_FALLBACK_REJECTION,
};
use helpers::{
    build_request_context, continuation_policy_for_tool, current_user_request_from_messages,
    describe_workspace_context, find_tool_result, interaction_update_variant_name,
    send_tool_result_to_paused_run, server_message_variant_name,
    should_expose_as_cursor_native_mcp_tool, stable_conversation_id,
};
use interaction::{handle_interaction_update, reply_to_kv};
use tool_stream::{complete_tool_call_argument_deltas, InteractionToolStreamState};

/// Cursor's agent-mode auto-router model. Matches the `default` entry in
/// `agent.v1.AgentService/GetUsableModels`; the server picks an appropriate
/// composer-class model based on the user's subscription.
pub const DEFAULT_MODEL: &str = "default";

/// Provider name used in logs / telemetry and for [`LLMProvider::provider_name`].
pub const PROVIDER_NAME: &str = "cursor";

/// Total wall-clock cap on a single Run RPC. Cursor can legitimately stream
/// for minutes on long tool-using turns, but text-only replies finish in
/// seconds; for MVP we cap at 5 minutes so a hung stream eventually surfaces
/// a timeout error rather than blocking the agent loop forever.
const OVERALL_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Per-message idle cap while consuming the Cursor Run stream. Once the server
/// has accepted the Run, a completely silent stream for this long indicates a
/// protocol/tool-surface stall; returning a provider error lets callers persist
/// a failed turn instead of letting the HTTP debug endpoint time out and emit
/// an undecodable body.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(45);
const COMPLETE_TOOL_CALL_DRAFT_FLUSH_DELAY: Duration = Duration::from_millis(80);

/// Public constructor surface.
pub struct CursorNativeProvider {
    config: ProviderConfig,
    http: Client,
    default_model: String,
    conversation_id: Mutex<String>,
    workspace_context: Option<CursorNativeWorkspaceContext>,
    active_turn: Mutex<Option<ContinuationToken>>,
    pending_run: Mutex<Option<PendingCursorRun>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ContinuationToken {
    session_id: String,
    turn_id: String,
    kind: ContinuationKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ContinuationKind {
    SameStreamToolResult,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ToolContinuationPolicy {
    ContinueSameStream,
    EndLogicalTurn,
}

struct PendingCursorRun {
    token: Option<ContinuationToken>,
    stream: RunStream,
    blobs: BlobStore,
    tool_definitions: Vec<pb::McpToolDefinition>,
    exec_id: String,
    exec_message_id: u32,
    tool_call: ToolCallRequest,
    result_kind: ToolResultKind,
    current_user_request: Option<String>,
}

struct CursorRunOutcome {
    response: LLMResponse,
    paused_run: Option<PendingCursorRun>,
}

impl std::ops::Deref for CursorRunOutcome {
    type Target = LLMResponse;

    fn deref(&self) -> &Self::Target {
        &self.response
    }
}

impl std::fmt::Debug for CursorRunOutcome {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CursorRunOutcome")
            .field("response", &self.response)
            .field("paused_run", &self.paused_run.is_some())
            .finish()
    }
}

#[derive(Clone, Debug)]
pub struct CursorNativeWorkspaceContext {
    pub project_folder: PathBuf,
    pub workspace_paths: Vec<PathBuf>,
}

impl CursorNativeProvider {
    fn active_token(&self) -> Result<Option<ContinuationToken>, ProviderError> {
        self.active_turn
            .lock()
            .map(|guard| guard.clone())
            .map_err(|_| {
                ProviderError::RequestFailed("Cursor native active turn lock poisoned".to_string())
            })
    }

    fn take_pending_run(&self) -> Result<Option<PendingCursorRun>, ProviderError> {
        let active_token = self.active_token()?;
        let mut guard = self.pending_run.lock().map_err(|_| {
            ProviderError::RequestFailed("Cursor native pending run lock poisoned".to_string())
        })?;
        let Some(pending) = guard.take() else {
            return Ok(None);
        };
        if pending.token.is_none() || active_token == pending.token {
            Ok(Some(pending))
        } else {
            if let Some(token) = pending.token.as_ref() {
                info!(
                    "[cursor] dropping pending run at logical turn boundary (pending_session={} pending_turn={})",
                    token.session_id, token.turn_id
                );
            }
            Ok(None)
        }
    }

    fn store_paused_run(&self, paused_run: Option<PendingCursorRun>) -> Result<(), ProviderError> {
        *self.pending_run.lock().map_err(|_| {
            ProviderError::RequestFailed("Cursor native pending run lock poisoned".to_string())
        })? = paused_run;
        Ok(())
    }

    fn conversation_id(&self) -> Result<String, ProviderError> {
        self.conversation_id
            .lock()
            .map(|id| id.clone())
            .map_err(|_| {
                ProviderError::RequestFailed(
                    "Cursor native conversation id lock poisoned".to_string(),
                )
            })
    }

    fn set_stable_conversation_id(&self, session_id: &str) {
        let trimmed = session_id.trim();
        if trimmed.is_empty() {
            return;
        }
        let stable_id = stable_conversation_id(trimmed);
        match self.conversation_id.lock() {
            Ok(mut id) => {
                *id = stable_id;
            }
            Err(_) => {
                warn!("[cursor] failed to set stable conversation id: lock poisoned");
            }
        }
    }

    pub fn from_session_token(session_token: &str) -> Result<Self, ProviderError> {
        Self::from_session_token_with_workspace(session_token, None)
    }

    pub fn from_session_token_with_workspace(
        session_token: &str,
        workspace_context: Option<CursorNativeWorkspaceContext>,
    ) -> Result<Self, ProviderError> {
        let jwt = auth::extract_jwt(session_token);
        if jwt.trim().is_empty() {
            return Err(ProviderError::AuthError(
                "Cursor native provider requires a non-empty session token".to_string(),
            ));
        }
        if auth::is_web_session_token(session_token) {
            return Err(ProviderError::AuthError(
                "Cursor web login tokens cannot be used for native chat; please sign in again"
                    .to_string(),
            ));
        }
        Ok(Self::new_with_workspace(
            ProviderConfig {
                api_key: session_token.to_string(),
                api_base: Some(auth::CURSOR_API_BASE.to_string()),
                extra_headers: HashMap::new(),
                is_azure: false,
            },
            workspace_context,
        ))
    }

    /// Build a client from a resolved [`ProviderConfig`]. `config.api_key`
    /// must hold the session JWT (raw or URL-encoded `userId::jwt`). The
    /// caller — `factory.rs` — handles credential resolution.
    pub fn new(config: ProviderConfig) -> Self {
        Self::new_with_workspace(config, None)
    }

    pub fn new_with_workspace(
        config: ProviderConfig,
        workspace_context: Option<CursorNativeWorkspaceContext>,
    ) -> Self {
        let http = Client::builder()
            .user_agent(format!("cursor/{}", auth::cursor_client_version()))
            // Explicitly force rustls over the default TLS backend. reqwest
            // 0.11 only ships both backends as compile-time options; the
            // runtime default is native-tls, whose macOS SecureTransport
            // backend does not advertise `h2` in ALPN. api2.cursor.sh's
            // ALB routes `/agent.v1.AgentService/Run` to an HTTP/2-only
            // target group and returns HTTP 464 ("incompatible protocol
            // versions") when it sees an HTTP/1.1 request. Rustls's ALPN
            // config advertises both `h2` and `http/1.1`, so the server
            // picks HTTP/2 and the request is routed correctly.
            .use_rustls_tls()
            .build()
            // Fall back to the global default if custom-build fails — should
            // never happen in practice since we only set user-agent.
            .unwrap_or_else(|_| Client::new());
        Self {
            config,
            http,
            default_model: DEFAULT_MODEL.to_string(),
            conversation_id: Mutex::new(uuid::Uuid::new_v4().to_string()),
            workspace_context,
            active_turn: Mutex::new(None),
            pending_run: Mutex::new(None),
        }
    }
}

#[async_trait]
impl LLMProvider for CursorNativeProvider {
    /// Non-streaming variant: drive [`Self::chat_streaming`] with a no-op
    /// delta callback and return the aggregated response. Saves us from
    /// duplicating the Run loop for callers that don't want per-chunk
    /// events.
    async fn chat(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        model: &str,
        max_tokens: u32,
        temperature: f32,
    ) -> Result<LLMResponse, ProviderError> {
        let noop = |_: StreamDelta| {};
        self.chat_streaming(messages, tools, model, max_tokens, temperature, &noop, None)
            .await
    }

    async fn chat_streaming(
        &self,
        messages: &[Value],
        tools: Option<&[Value]>,
        model: &str,
        _max_tokens: u32,
        _temperature: f32,
        on_delta: &(dyn Fn(StreamDelta) + Send + Sync),
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<LLMResponse, ProviderError> {
        let jwt = auth::extract_jwt(&self.config.api_key);
        if jwt.is_empty() {
            return Err(ProviderError::AuthError(
                "Cursor account has no session token — sign into Cursor Desktop first".to_string(),
            ));
        }

        let effective_model = if model.is_empty() {
            self.default_model.as_str()
        } else {
            model
        };

        let should_manage_tool_continuation = tools.is_some();
        let tool_definitions = tools
            .map(build_tool_definitions)
            .unwrap_or_default()
            .into_iter()
            .filter(|definition| should_expose_as_cursor_native_mcp_tool(&definition.tool_name))
            .collect::<Vec<_>>();

        info!(
            "[cursor] chat_streaming: model={}, messages={}, tools={}, workspace={}",
            effective_model,
            messages.len(),
            tool_definitions.len(),
            self.workspace_context
                .as_ref()
                .map(describe_workspace_context)
                .unwrap_or_else(|| "<none>".to_string())
        );

        let current_user_request = current_user_request_from_messages(messages);
        let active_token = self.active_token()?;
        let pending_run = if should_manage_tool_continuation {
            self.take_pending_run()?
        } else {
            None
        };
        let outcome = if let Some(pending) = pending_run {
            let Some(tool_result) = find_tool_result(messages, &pending.tool_call.id) else {
                let available_tool_results: Vec<String> = messages
                    .iter()
                    .filter(|message| message.get("role").and_then(Value::as_str) == Some("tool"))
                    .filter_map(|message| {
                        let id = message.get("tool_call_id").and_then(Value::as_str)?;
                        let name = message
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("<unknown>");
                        Some(format!("{id}:{name}"))
                    })
                    .collect();
                return Err(ProviderError::RequestFailed(format!(
                    "Cursor native pending tool result missing for {} (pending_name={}, available_tool_results={:?}, message_count={})",
                    pending.tool_call.id,
                    pending.tool_call.name,
                    available_tool_results,
                    messages.len()
                )));
            };
            info!(
                "[cursor] continuing paused run with tool result id={} name={}",
                pending.tool_call.id, pending.tool_call.name
            );
            send_tool_result_to_paused_run(&pending, tool_result)?;
            if continuation_policy_for_tool(&pending.tool_call.name)
                == ToolContinuationPolicy::EndLogicalTurn
            {
                info!(
                    "[cursor] completed terminal tool result for {}; ending logical turn without resuming Cursor stream",
                    pending.tool_call.name
                );
                return Ok(LLMResponse {
                    content: None,
                    tool_calls: Vec::new(),
                    finish_reason: finish_reason::STOP.to_string(),
                    usage: HashMap::new(),
                    reasoning_content: None,
                    blocks: Vec::new(),
                    stream_error_kind: None,
                    retry_after_ms: None,
                });
            }
            let completed_same_stream_tool_ids = HashSet::from([pending.tool_call.id.clone()]);
            drive_run(
                pending.stream,
                pending.blobs,
                pending.tool_definitions,
                self.workspace_context.as_ref(),
                pending.current_user_request.clone(),
                &completed_same_stream_tool_ids,
                on_delta,
                cancel_flag,
                pending.token.clone(),
            )
            .await?
        } else {
            let request_context =
                build_request_context(&tool_definitions, self.workspace_context.as_ref());
            if !tool_definitions.is_empty() {
                let tool_names = tool_definitions
                    .iter()
                    .map(|definition| definition.tool_name.as_str())
                    .collect::<Vec<_>>()
                    .join(",");
                info!(
                    "[cursor] mcp tool definitions count={} names=[{}] request_context={}",
                    tool_definitions.len(),
                    tool_names,
                    request_context.is_some()
                );
            }
            let built = build_run_request_with_context(
                messages,
                effective_model,
                self.conversation_id()?,
                request_context,
            );
            let stream = match tokio::time::timeout(
                OVERALL_TIMEOUT,
                client::start_run(&self.http, &jwt, built.client_message),
            )
            .await
            {
                Ok(Ok(stream)) => stream,
                Ok(Err(err)) => return Err(map_client_error(err)),
                Err(_elapsed) => {
                    return Err(ProviderError::RequestFailed(
                        "Cursor Run RPC did not respond within 5 minutes".to_string(),
                    ));
                }
            };

            drive_run(
                stream,
                built.blobs,
                tool_definitions,
                self.workspace_context.as_ref(),
                current_user_request,
                &HashSet::new(),
                on_delta,
                cancel_flag,
                active_token.clone(),
            )
            .await?
        };
        if should_manage_tool_continuation {
            self.store_paused_run(outcome.paused_run)?;
        }
        Ok(outcome.response)
    }

    fn default_model(&self) -> &str {
        &self.default_model
    }

    fn provider_name(&self) -> &str {
        PROVIDER_NAME
    }

    fn set_session_context(&self, session_id: &str) {
        self.set_stable_conversation_id(session_id);
    }

    fn begin_logical_turn(&self, session_id: &str, turn_id: &str) {
        let token = ContinuationToken {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            kind: ContinuationKind::SameStreamToolResult,
        };
        match self.active_turn.lock() {
            Ok(mut active_turn) => {
                *active_turn = Some(token.clone());
            }
            Err(_) => {
                warn!("[cursor] active turn lock poisoned while beginning logical turn");
                return;
            }
        }
        if let Ok(mut pending_run) = self.pending_run.lock() {
            let should_drop = pending_run
                .as_ref()
                .and_then(|pending| pending.token.as_ref())
                .is_some_and(|pending_token| pending_token != &token);
            if should_drop {
                info!(
                    "[cursor] invalidating pending continuation for new logical turn (session={} turn={})",
                    session_id, turn_id
                );
                *pending_run = None;
            }
        }
    }

    fn side_query_execution(&self) -> SideQueryExecution {
        SideQueryExecution::IsolatedSession
    }
}

/// Consume the live Run stream: translate server messages into `StreamDelta`,
/// satisfy KV / exec side-channel requests, accumulate the final
/// `LLMResponse`.
///
/// `tool_definitions` are the `McpToolDefinition` list we hand back when the
/// server asks via `ExecServerMessage::RequestContextArgs`. Empty when the
/// caller didn't pass tools.
#[allow(clippy::too_many_arguments)]
// A run combines owned stream state with borrowed execution callbacks. A
// one-use relay struct would add indirection without creating a reusable domain.
async fn drive_run(
    mut stream: RunStream,
    mut blobs: BlobStore,
    tool_definitions: Vec<pb::McpToolDefinition>,
    workspace_context: Option<&CursorNativeWorkspaceContext>,
    current_user_request: Option<String>,
    completed_same_stream_tool_ids: &HashSet<String>,
    on_delta: &(dyn Fn(StreamDelta) + Send + Sync),
    cancel_flag: Option<&AtomicBool>,
    continuation_token: Option<ContinuationToken>,
) -> Result<CursorRunOutcome, ProviderError> {
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut total_output_tokens: i64 = 0;
    let mut saw_turn_end = false;
    let mut pending_tool_calls: Vec<ToolCallRequest> = Vec::new();
    let mut interaction_tool_streams = InteractionToolStreamState::default();
    let mut exec_tool_pause: Option<ExecToolPause> = None;

    loop {
        let result = match tokio::time::timeout(STREAM_IDLE_TIMEOUT, stream.responses.next()).await
        {
            Ok(Some(result)) => result,
            Ok(None) => break,
            Err(_elapsed) => {
                return Err(ProviderError::RequestFailed(format!(
                    "Cursor Run stream timed out: no server message received for {}s \
                     (content_len={}, reasoning_len={}, pending_tools={}, saw_turn_end={})",
                    STREAM_IDLE_TIMEOUT.as_secs(),
                    content.len(),
                    reasoning.len(),
                    pending_tool_calls.len(),
                    saw_turn_end
                )));
            }
        };

        if cancel_flag.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            debug!("[cursor] cancel requested; dropping run stream");
            return Err(ProviderError::Cancelled);
        }

        let message = match result {
            Ok(m) => m,
            Err(err) => return Err(map_client_error(err)),
        };

        let Some(inner) = message.message else {
            continue;
        };

        let variant_name = server_message_variant_name(&inner);
        debug!("[cursor] server message variant: {variant_name}");

        match inner {
            pb::agent_server_message::Message::InteractionUpdate(update) => {
                debug!(
                    "[cursor] interaction update variant: {}",
                    interaction_update_variant_name(&update)
                );
                if let Some(tool_call) = handle_interaction_update(
                    update,
                    &mut content,
                    &mut reasoning,
                    &mut total_output_tokens,
                    &mut saw_turn_end,
                    completed_same_stream_tool_ids,
                    &mut interaction_tool_streams,
                    on_delta,
                ) {
                    let index = interaction_tool_streams.index_for_orgii_call_id(&tool_call.id);
                    if !interaction_tool_streams.has_emitted_partial(&tool_call.id) {
                        let argument_deltas = complete_tool_call_argument_deltas(&tool_call);
                        let argument_delta_count = argument_deltas.len();
                        for (delta_offset, arguments_delta) in
                            argument_deltas.into_iter().enumerate()
                        {
                            on_delta(StreamDelta {
                                content: None,
                                reasoning: None,
                                tool_call_delta: Some(ToolCallDelta {
                                    index,
                                    id: Some(tool_call.id.clone()),
                                    name: Some(tool_call.name.clone()),
                                    arguments_delta: Some(arguments_delta),
                                }),
                                finish_reason: None,
                                usage: None,
                            });
                            if argument_delta_count > 1 && delta_offset + 1 < argument_delta_count {
                                tokio::time::sleep(COMPLETE_TOOL_CALL_DRAFT_FLUSH_DELAY).await;
                            }
                        }
                    }
                    info!(
                        "[cursor] interaction requested MCP tool call: id={} name={}",
                        tool_call.id, tool_call.name
                    );
                    pending_tool_calls.push(tool_call);
                    break;
                }
                if saw_turn_end {
                    break;
                }
            }
            pb::agent_server_message::Message::KvServerMessage(kv) => {
                if let Err(err) = reply_to_kv(&stream, kv, &mut blobs) {
                    return Err(map_client_error(err));
                }
            }
            pb::agent_server_message::Message::ExecServerMessage(exec) => {
                match handle_exec_server_message(
                    &stream,
                    exec,
                    &tool_definitions,
                    workspace_context,
                ) {
                    Ok(Some(pause)) => {
                        let index = pending_tool_calls.len();
                        let argument_deltas = complete_tool_call_argument_deltas(&pause.tool_call);
                        let argument_delta_count = argument_deltas.len();
                        for (delta_offset, arguments_delta) in
                            argument_deltas.into_iter().enumerate()
                        {
                            on_delta(StreamDelta {
                                content: None,
                                reasoning: None,
                                tool_call_delta: Some(ToolCallDelta {
                                    index,
                                    id: Some(pause.tool_call.id.clone()),
                                    name: Some(pause.tool_call.name.clone()),
                                    arguments_delta: Some(arguments_delta),
                                }),
                                finish_reason: None,
                                usage: None,
                            });
                            if argument_delta_count > 1 && delta_offset + 1 < argument_delta_count {
                                tokio::time::sleep(COMPLETE_TOOL_CALL_DRAFT_FLUSH_DELAY).await;
                            }
                        }
                        pending_tool_calls.push(pause.tool_call.clone());
                        exec_tool_pause = Some(pause);
                        break;
                    }
                    Ok(None) => {}
                    Err(err) => return Err(map_client_error(err)),
                }
            }
            pb::agent_server_message::Message::ConversationCheckpointUpdate(_) => {}
            // ExecServerControlMessage / InteractionQuery arrive on advanced
            // flows (plan mode, worker summaries). Ignoring them is safe for
            // the MVP request/reply pattern.
            other => {
                debug!("[cursor] unhandled server message variant: {:?}", other);
            }
        }
    }

    let has_tool_calls = !pending_tool_calls.is_empty();
    if !saw_turn_end && !has_tool_calls {
        // Unexpected but tolerable: server closed the stream without a
        // terminal update. Surface accumulated content rather than panicking.
        debug!(
            "[cursor] stream ended without TurnEndedUpdate and no tool calls (content_len={})",
            content.len()
        );
    }

    let mut usage = HashMap::new();
    if total_output_tokens > 0 {
        usage.insert(
            usage_key::COMPLETION_TOKENS.to_string(),
            total_output_tokens,
        );
        usage.insert(usage_key::TOTAL_TOKENS.to_string(), total_output_tokens);
    }

    // finish_reason reflects which terminal condition fired:
    // - tool_calls when the server asked us to invoke one or more tools
    //   (ORGII's agent loop will execute them and call us again).
    // - stop otherwise.
    let resolved_finish = if has_tool_calls {
        finish_reason::TOOL_CALLS.to_string()
    } else {
        finish_reason::STOP.to_string()
    };

    let response = LLMResponse {
        content: (!content.is_empty()).then_some(content),
        tool_calls: pending_tool_calls,
        finish_reason: resolved_finish,
        usage,
        reasoning_content: (!reasoning.is_empty()).then_some(reasoning),
        blocks: Vec::new(),
        stream_error_kind: None,
        retry_after_ms: None,
    };
    let paused_run = exec_tool_pause.and_then(|pause| {
        if !pause.requires_same_stream_result {
            return None;
        }
        if continuation_policy_for_tool(&pause.tool_call.name)
            == ToolContinuationPolicy::EndLogicalTurn
        {
            info!(
                "[cursor] dropping same-stream continuation for local end-turn tool {}",
                pause.tool_call.name
            );
            return None;
        }
        Some(PendingCursorRun {
            token: continuation_token,
            stream,
            blobs,
            tool_definitions,
            exec_id: pause.exec_id,
            exec_message_id: pause.exec_message_id,
            tool_call: pause.tool_call,
            result_kind: pause.result_kind,
            current_user_request,
        })
    });
    Ok(CursorRunOutcome {
        response,
        paused_run,
    })
}

#[cfg(test)]
mod tests {
    use super::client::ClientError;
    use super::*;
    use crate::tools::names as tool_names;

    #[test]
    fn map_error_unauthenticated_becomes_auth_error() {
        let err = ClientError::ConnectEnd {
            code: "unauthenticated".to_string(),
            message: "token expired".to_string(),
        };
        match map_client_error(err) {
            ProviderError::AuthError(msg) => {
                assert!(msg.contains("token expired"), "{}", msg);
                assert!(msg.contains("unauthenticated"), "code appended: {}", msg);
            }
            other => panic!("expected AuthError, got {:?}", other),
        }
    }

    #[test]
    fn map_error_resource_exhausted_becomes_rate_limited() {
        let err = ClientError::ConnectEnd {
            code: "resource_exhausted".to_string(),
            message: "quota".to_string(),
        };
        match map_client_error(err) {
            ProviderError::RateLimited { message, .. } => {
                assert!(message.contains("quota"), "{}", message);
                assert!(message.contains("resource_exhausted"), "code: {}", message);
            }
            other => panic!("expected RateLimited, got {:?}", other),
        }
    }

    /// Cursor's Connect trailers are often terse ("Error" with no
    /// structured detail). The mapper must surface the trailer *code*
    /// even when the message is useless, so operators can tell expired-
    /// JWT ("unauthenticated") apart from missing-subscription
    /// ("permission_denied") when reading logs.
    #[test]
    fn map_error_terse_server_message_still_includes_code() {
        let err = ClientError::ConnectEnd {
            code: "unauthenticated".to_string(),
            message: "Error".to_string(),
        };
        match map_client_error(err) {
            ProviderError::AuthError(msg) => {
                assert!(
                    msg.contains("unauthenticated"),
                    "trailer code in message: {}",
                    msg
                );
            }
            other => panic!("expected AuthError, got {:?}", other),
        }
    }

    /// `unavailable` is Cursor's overload signal — the retry layer uses a
    /// shorter budget for this class. Keep the mapping stable.
    #[test]
    fn map_error_unavailable_becomes_overloaded() {
        let err = ClientError::ConnectEnd {
            code: "unavailable".to_string(),
            message: "backend busy".to_string(),
        };
        assert!(matches!(
            map_client_error(err),
            ProviderError::Overloaded { .. }
        ));
    }

    #[test]
    fn map_error_not_found_becomes_model_not_found() {
        let err = ClientError::ConnectEnd {
            code: "not_found".to_string(),
            message: "model retired".to_string(),
        };
        assert!(matches!(
            map_client_error(err),
            ProviderError::ModelNotFound(_)
        ));
    }

    /// HTTP 401 before any stream data = JWT rejected at the HTTP layer
    /// (typically expired). Must produce `AuthError`, not `RequestFailed`.
    #[test]
    fn map_error_http_401_becomes_auth_error() {
        let err = ClientError::Status {
            status: 401,
            http_version: "HTTP/2.0".to_string(),
            body: "unauthorised".to_string(),
        };
        assert!(matches!(map_client_error(err), ProviderError::AuthError(_)));
    }

    /// HTTP 464 is AWS ALB's "incompatible protocol versions" signal —
    /// surfaced as a generic RequestFailed with the negotiated HTTP
    /// version embedded in the message so regressions are obvious.
    #[test]
    fn map_error_http_464_includes_protocol_version() {
        let err = ClientError::Status {
            status: 464,
            http_version: "HTTP/1.1".to_string(),
            body: String::new(),
        };
        match map_client_error(err) {
            ProviderError::RequestFailed(msg) => {
                assert!(msg.contains("464"), "status code preserved: {}", msg);
                assert!(
                    msg.contains("HTTP/1.1"),
                    "http version surfaced to caller: {}",
                    msg
                );
            }
            other => panic!("expected RequestFailed, got {:?}", other),
        }
    }

    #[test]
    fn map_error_cancelled_becomes_cancelled() {
        assert!(matches!(
            map_client_error(ClientError::Cancelled),
            ProviderError::Cancelled
        ));
    }

    #[test]
    fn request_context_advertises_mcp_tools_without_file_system_descriptors() {
        let definitions = build_tool_definitions(&[serde_json::json!({
            "type": "function",
            "function": {
                "name": tool_names::ORG_SEND_MESSAGE,
                "description": "Send a message",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "recipient_member_id": {
                            "type": "string",
                            "enum": ["coordinator"]
                        }
                    }
                }
            }
        })]);
        let context = build_request_context(&definitions, None).expect("request context");

        assert_eq!(context.tools.len(), 1);
        assert_eq!(context.tools[0].tool_name, tool_names::ORG_SEND_MESSAGE);
        assert!(context.mcp_file_system_options.is_none());
        assert!(context.mcp_instructions.is_empty());
    }

    #[test]
    fn map_error_permission_denied_becomes_auth_error() {
        let err = ClientError::ConnectEnd {
            code: "permission_denied".to_string(),
            message: "denied".to_string(),
        };
        assert!(matches!(map_client_error(err), ProviderError::AuthError(_)));
    }

    #[test]
    fn stable_conversation_id_is_session_scoped() {
        let first = stable_conversation_id("sdeagent-session-1");
        let same = stable_conversation_id("sdeagent-session-1");
        let different = stable_conversation_id("sdeagent-session-2");

        assert_eq!(first, same);
        assert_ne!(first, different);
        assert_eq!(first.len(), 36);
    }

    /// An unknown Connect trailer code shouldn't be lost — it needs to
    /// surface as a generic provider error with both code and message so
    /// the user can see what the server said.
    #[test]
    fn map_error_unknown_code_becomes_other_with_context() {
        let err = ClientError::ConnectEnd {
            code: "internal".to_string(),
            message: "boom".to_string(),
        };
        match map_client_error(err) {
            ProviderError::Other(msg) => {
                assert!(msg.contains("internal"), "code preserved: {}", msg);
                assert!(msg.contains("boom"), "message preserved: {}", msg);
            }
            other => panic!("expected Other, got {:?}", other),
        }
    }
}
