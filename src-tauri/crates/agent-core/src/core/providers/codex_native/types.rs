//! Codex native-specific types and constants.
//!
//! The Codex native backend has stricter requirements than the public OpenAI API:
//! - Does NOT support `max_output_tokens` and `temperature` parameters
//! - Requires specific User-Agent header for Cloudflare bypass

use serde::Serialize;
use serde_json::Value;

pub use crate::providers::responses_common::types::extract_account_id_from_id_token;
pub use crate::providers::responses_common::{
    enforce_strict_schema, ResponseItem, ResponsesError, ResponsesResponse, ResponsesUsage,
    StreamEvent,
};

/// Codex native backend base URL for OAuth sessions.
pub(super) const CHATGPT_CODEX_BASE: &str = "https://chatgpt.com/backend-api/codex";

/// User-Agent that matches the Codex CLI (required for Cloudflare bypass).
pub(super) const CODEX_USER_AGENT: &str = "codex_cli_rs/0.46.0 (Mac OS 15.3.1; arm64) dumb";

/// `env_vars` key on a `ModelKey` that stores the raw OAuth `id_token` JWT.
/// Written by `key_vault::auto_detect::codex` when scanning the Codex CLI's
/// `auth.json`, read by `factory::extract_codex_account_id`.
///
/// Lives in `core_types` so `key_vault` can reference it without taking a
/// dependency on `agent_core`. Re-exported here for ergonomics.
pub use core_types::providers::CODEX_ID_TOKEN_ENV_KEY;

/// HTTP request header carrying the ChatGPT account ID extracted from the
/// `id_token` JWT. Required by `chatgpt.com/backend-api/codex` to scope the
/// request to the user's ChatGPT account.
pub const CODEX_ACCOUNT_ID_HEADER: &str = "chatgpt-account-id";

/// Request body for the Codex native backend Responses API.
///
/// Note: the Codex backend (`chatgpt.com/backend-api/codex`) rejects
/// parameters like `max_output_tokens` and `temperature` that the public
/// Responses API (`api.openai.com/v1/responses`) accepts. This struct
/// only includes fields that this backend supports.
///
/// **Distinct from** `crate::core::providers::responses_common::types::ResponsesRequest`.
/// That type carries the public-API superset and is shared across other
/// Responses-API providers; this type is intentionally narrower so a
/// caller can't accidentally smuggle `max_output_tokens` into the
/// Codex native backend at compile time. Keep both in sync if a new field is
/// added to the public Responses API.
#[derive(Debug, Serialize)]
pub(super) struct ResponsesRequest {
    pub model: String,
    pub input: Vec<Value>,
    pub instructions: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<Value>,
    /// Reasoning-effort control (`{ "effort": "low"|"medium"|"high" }`).
    /// Only set for reasoning models; omitted otherwise since the backend
    /// rejects `reasoning` on non-reasoning models with HTTP 400.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<Value>,
    pub store: bool,
    pub stream: bool,
}
