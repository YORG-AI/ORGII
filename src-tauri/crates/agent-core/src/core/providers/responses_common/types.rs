//! OpenAI Responses API types
//!
//! Shared type definitions for the Responses API format used by both:
//! - Public OpenAI API (`api.openai.com/v1/responses`)
//! - Codex native backend (`chatgpt.com/backend-api/codex/responses`)

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::warn;

use crate::providers::traits::ProviderError;

// ============================================
// Responses API Request Types
// ============================================

/// Request body for the OpenAI Responses API.
///
/// Fields supported vary by endpoint:
/// - Public API supports `max_output_tokens`, `temperature`
/// - Codex native backend rejects those parameters
///
/// **Distinct from** `crate::core::providers::codex_native::types::ResponsesRequest`,
/// which is intentionally narrower (`pub(super)` to its module) so the
/// Codex native code path cannot accidentally serialize public-API-
/// only fields. Both types must stay in sync when a public-API field is
/// added or renamed.
#[derive(Debug, Serialize)]
pub struct ResponsesRequest {
    pub model: String,
    pub input: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<Value>,
    /// Max output tokens (public API only, not supported by Codex native backend).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    /// Temperature (public API only, not supported by Codex native backend).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    /// Reasoning config `{effort: "low"|"medium"|"high"}` for GPT-5+/o-series
    /// (public API). Codex native backend never sets this.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<Value>,
    pub store: bool,
    pub stream: bool,
}

// ============================================
// Responses API Response Types
// ============================================

/// Top-level response from the Responses API.
#[derive(Debug, Deserialize)]
pub struct ResponsesResponse {
    #[serde(default)]
    pub output: Vec<ResponseItem>,
    pub usage: Option<ResponsesUsage>,
    pub error: Option<ResponsesError>,
}

/// An output item from the Responses API.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ResponseItem {
    #[serde(rename = "message")]
    Message(ResponseMessage),
    #[serde(rename = "function_call")]
    FunctionCall(ResponseFunctionCall),
    #[serde(rename = "reasoning")]
    Reasoning(ResponseReasoning),
    #[serde(other)]
    Unknown,
}

/// A message output item.
#[derive(Debug, Deserialize)]
pub struct ResponseMessage {
    #[serde(default)]
    pub content: Vec<ResponseContent>,
}

/// Content within a message.
#[derive(Debug, Deserialize)]
pub struct ResponseContent {
    #[serde(rename = "type")]
    pub content_type: Option<String>,
    pub text: Option<String>,
}

/// A function call output item.
#[derive(Debug, Deserialize)]
pub struct ResponseFunctionCall {
    pub call_id: String,
    pub name: String,
    pub arguments: String,
}

/// A reasoning output item (GPT-5+ models).
#[derive(Debug, Deserialize)]
pub struct ResponseReasoning {
    #[serde(default)]
    pub content: Vec<Value>,
    #[serde(default)]
    pub summary: Vec<Value>,
}

/// Usage statistics from the Responses API.
#[derive(Debug, Deserialize)]
pub struct ResponsesUsage {
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    /// `usage.input_tokens_details.cached_tokens` — prompt-cache hits.
    #[serde(default)]
    pub input_tokens_details: Option<ResponsesInputTokensDetails>,
}

/// `usage.input_tokens_details` from the Responses API.
#[derive(Debug, Deserialize)]
pub struct ResponsesInputTokensDetails {
    #[serde(default)]
    pub cached_tokens: i64,
}

/// Error from the Responses API.
#[derive(Clone, Debug, Deserialize)]
pub struct ResponsesError {
    pub message: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(rename = "type", default)]
    pub error_type: Option<String>,
    #[serde(default)]
    pub param: Option<String>,
}

impl ResponsesError {
    pub fn display_message(&self) -> String {
        let mut details = Vec::new();
        if let Some(code) = self.code.as_deref().filter(|code| !code.is_empty()) {
            details.push(format!("code={code}"));
        }
        if let Some(error_type) = self
            .error_type
            .as_deref()
            .filter(|error_type| !error_type.is_empty())
        {
            details.push(format!("type={error_type}"));
        }
        if let Some(param) = self.param.as_deref().filter(|param| !param.is_empty()) {
            details.push(format!("param={param}"));
        }

        if let Some(message) = self
            .message
            .as_deref()
            .filter(|message| !message.is_empty())
        {
            if details.is_empty() {
                message.to_string()
            } else {
                format!("{message} ({})", details.join(", "))
            }
        } else if details.is_empty() {
            "Responses API returned an error without details".to_string()
        } else {
            format!("Responses API error ({})", details.join(", "))
        }
    }

    /// Map an OpenAI Responses API error envelope to the runtime's typed
    /// provider errors. Machine-readable `code` and `type` fields take
    /// precedence; message matching is only a compatibility fallback for
    /// Responses-compatible gateways that omit structured fields.
    pub fn into_provider_error(self) -> ProviderError {
        let message = self.display_message();
        let code = self.code.as_deref().unwrap_or_default();
        let error_type = self.error_type.as_deref().unwrap_or_default();

        match (code, error_type) {
            ("usage_limit_reached", _) | (_, "usage_limit_reached") => {
                ProviderError::UsageLimitReached(message)
            }
            ("context_length_exceeded", _) | ("input_too_long", _) => {
                ProviderError::ContextTooLong(message)
            }
            ("rate_limit_exceeded", _) | (_, "rate_limit_error") => ProviderError::RateLimited {
                message,
                retry_after_secs: None,
            },
            ("model_not_found", _) => ProviderError::ModelNotFound(message),
            ("invalid_api_key", _) | ("authentication_error", _) | (_, "authentication_error") => {
                ProviderError::AuthError(message)
            }
            ("overloaded", _) | ("overloaded_error", _) | (_, "overloaded_error") => {
                ProviderError::Overloaded {
                    message,
                    retry_after_secs: None,
                }
            }
            _ => classify_responses_error_message(message),
        }
    }

    pub fn is_auth_error(&self) -> bool {
        matches!(
            (self.code.as_deref(), self.error_type.as_deref()),
            (Some("invalid_api_key" | "authentication_error"), _)
                | (_, Some("authentication_error"))
        ) || looks_like_auth_error(self.message.as_deref().unwrap_or_default())
    }
}

fn classify_responses_error_message(message: String) -> ProviderError {
    let lower = message.to_ascii_lowercase();
    if lower.contains("usage_limit_reached") || lower.contains("usage limit has been reached") {
        ProviderError::UsageLimitReached(message)
    } else if lower.contains("context_length_exceeded")
        || lower.contains("context window")
        || lower.contains("maximum context length")
        || lower.contains("prompt is too long")
        || lower.contains("input is too long")
    {
        ProviderError::ContextTooLong(message)
    } else if lower.contains("rate_limit") || lower.contains("rate limit") {
        ProviderError::RateLimited {
            message,
            retry_after_secs: None,
        }
    } else if lower.contains("overloaded") || lower.contains("capacity") {
        ProviderError::Overloaded {
            message,
            retry_after_secs: None,
        }
    } else if lower.contains("model_not_found") || lower.contains("model not found") {
        ProviderError::ModelNotFound(message)
    } else if looks_like_auth_error(&lower) {
        ProviderError::AuthError(message)
    } else {
        ProviderError::RequestFailed(message)
    }
}

fn looks_like_auth_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("unauthorized")
        || lower.contains("unauthorized_unknown")
        || lower.contains("could not parse your authentication token")
        || lower.contains("invalid authentication")
        || lower.contains("expired") && lower.contains("token")
}

// ============================================
// Streaming Event Types
// ============================================

/// SSE event from the OpenAI Responses API streaming.
///
/// **Naming note:** distinct from
/// [`crate::core::providers::anthropic_native::types::StreamEvent`]
/// (a `pub(super)` enum on a different wire shape) and from the now-retired
/// `infrastructure::transport::StreamEvent` wrapper. This struct stays
/// `pub` only because `codex_native` and `openai_responses` siblings both
/// deserialize the same SSE shape.
#[derive(Debug, Deserialize)]
pub struct StreamEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    /// Present on response.completed and response.failed.
    #[serde(default)]
    pub response: Option<ResponsesResponse>,
    /// Present on top-level `error` events in the official Responses SSE
    /// protocol. Some compatible backends instead wrap these fields in
    /// `error`, so both shapes are retained.
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub param: Option<String>,
    /// Present on top-level `error` events from some Responses-compatible
    /// backends instead of direct `code` / `message` / `param` fields.
    #[serde(default)]
    pub error: Option<ResponsesError>,
    /// Present on text delta events
    pub delta: Option<String>,
    pub call_id: Option<String>,
    /// Present on function-call argument delta/done events.
    pub item_id: Option<String>,
    /// Present on response.output_item.added
    pub item: Option<Value>,
}

// ============================================
// Schema Helpers
// ============================================

/// Recursively enforce strict schema rules on every object-type node:
/// 1. `"additionalProperties": false`
/// 2. `"required"` must be **exactly** the set of keys in `"properties"`
/// 3. Fields that were optional become nullable before being made required
/// 4. Object-type nodes must have an explicit `"properties"` field
///
/// All are mandatory for the Responses API when `strict: true`.
pub fn enforce_strict_schema(schema: &mut Value) {
    if let Some(obj) = schema.as_object_mut() {
        let is_object_type = obj
            .get("type")
            .and_then(|t| t.as_str())
            .is_some_and(|t| t == "object");

        if is_object_type {
            obj.insert("additionalProperties".to_string(), Value::Bool(false));

            if !obj.contains_key("properties") {
                obj.insert(
                    "properties".to_string(),
                    Value::Object(serde_json::Map::new()),
                );
            }

            let originally_required: std::collections::HashSet<String> = obj
                .get("required")
                .and_then(|required| required.as_array())
                .map(|required| {
                    required
                        .iter()
                        .filter_map(|name| name.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();

            let prop_names: Vec<String> = obj
                .get("properties")
                .and_then(|p| p.as_object())
                .map(|props| props.keys().cloned().collect())
                .unwrap_or_default();

            if let Some(properties) = obj.get_mut("properties").and_then(Value::as_object_mut) {
                for (name, prop_schema) in properties.iter_mut() {
                    if !originally_required.contains(name) {
                        make_schema_nullable(prop_schema);
                    }
                }
            }

            let prop_keys: Vec<Value> = prop_names.into_iter().map(Value::String).collect();

            if prop_keys.is_empty() {
                obj.remove("required");
            } else {
                obj.insert("required".to_string(), Value::Array(prop_keys));
            }

            if let Some(properties) = obj.get_mut("properties") {
                if let Some(props_map) = properties.as_object_mut() {
                    for (_key, prop_schema) in props_map.iter_mut() {
                        enforce_strict_schema(prop_schema);
                    }
                }
            }
        }

        for combiner in &["anyOf", "oneOf", "allOf"] {
            if let Some(variants) = obj.get_mut(*combiner) {
                if let Some(arr) = variants.as_array_mut() {
                    for variant in arr.iter_mut() {
                        enforce_strict_schema(variant);
                    }
                }
            }
        }

        if let Some(items) = obj.get_mut("items") {
            enforce_strict_schema(items);
        }
    }
}

/// Strict Responses schemas require every property to appear in the model's
/// output. Preserve the source schema's optional-field semantics by allowing
/// those properties to be `null`; consumers can then distinguish "omitted"
/// from meaningful empty values such as `""` or `[]`.
fn make_schema_nullable(schema: &mut Value) {
    let already_nullable = schema.get("type").is_some_and(|kind| match kind {
        Value::String(kind) => kind == "null",
        Value::Array(kinds) => kinds.iter().any(|kind| kind.as_str() == Some("null")),
        _ => false,
    }) || ["anyOf", "oneOf"].iter().any(|combiner| {
        schema
            .get(*combiner)
            .and_then(Value::as_array)
            .is_some_and(|variants| {
                variants
                    .iter()
                    .any(|variant| variant.get("type").and_then(Value::as_str) == Some("null"))
            })
    });

    if already_nullable {
        return;
    }

    let original = std::mem::take(schema);
    *schema = serde_json::json!({
        "anyOf": [original, { "type": "null" }]
    });
}

/// Extract `chatgpt_account_id` from a JWT id_token.
///
/// The id_token payload contains `https://api.openai.com/auth.chatgpt_account_id`.
/// We decode the JWT payload (base64url) without verifying the signature.
pub fn extract_account_id_from_id_token(id_token: &str) -> Option<String> {
    let parts: Vec<&str> = id_token.split('.').collect();
    if parts.len() < 2 {
        warn!("[codex-native] id_token has fewer than 2 parts");
        return None;
    }

    let payload = parts[1];

    use base64::Engine;
    let decoded = match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload) {
        Ok(bytes) => bytes,
        Err(err) => {
            warn!("[codex-native] Failed to decode id_token payload: {}", err);
            return None;
        }
    };

    let json: Value = match serde_json::from_slice(&decoded) {
        Ok(v) => v,
        Err(err) => {
            warn!("[codex-native] Failed to parse id_token JSON: {}", err);
            return None;
        }
    };

    let account_id = json
        .get("https://api.openai.com/auth")
        .and_then(|auth| auth.get("chatgpt_account_id"))
        .and_then(|id| id.as_str())
        .map(|s| s.to_string());

    if account_id.is_none() {
        warn!("[codex-native] No chatgpt_account_id in id_token");
    }

    account_id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_usage_limit_type_to_non_transient_provider_error() {
        let error = ResponsesError {
            message: Some("The usage limit has been reached".to_string()),
            code: None,
            error_type: Some("usage_limit_reached".to_string()),
            param: None,
        };

        assert!(matches!(
            error.into_provider_error(),
            ProviderError::UsageLimitReached(message)
                if message.contains("The usage limit has been reached")
                    && message.contains("type=usage_limit_reached")
        ));
    }

    #[test]
    fn maps_official_context_error_code_without_message_heuristics() {
        let error = ResponsesError {
            message: Some("Request rejected".to_string()),
            code: Some("context_length_exceeded".to_string()),
            error_type: Some("invalid_request_error".to_string()),
            param: Some("input".to_string()),
        };

        assert!(matches!(
            error.into_provider_error(),
            ProviderError::ContextTooLong(message)
                if message.contains("code=context_length_exceeded")
                    && message.contains("param=input")
        ));
    }

    #[test]
    fn maps_structured_rate_limit_auth_overload_and_model_codes() {
        let cases = [
            (
                ResponsesError {
                    message: None,
                    code: Some("rate_limit_exceeded".to_string()),
                    error_type: None,
                    param: None,
                },
                "rate_limit",
            ),
            (
                ResponsesError {
                    message: None,
                    code: Some("invalid_api_key".to_string()),
                    error_type: None,
                    param: None,
                },
                "auth",
            ),
            (
                ResponsesError {
                    message: None,
                    code: None,
                    error_type: Some("overloaded_error".to_string()),
                    param: None,
                },
                "overloaded",
            ),
            (
                ResponsesError {
                    message: None,
                    code: Some("model_not_found".to_string()),
                    error_type: None,
                    param: None,
                },
                "model",
            ),
        ];

        assert!(matches!(
            cases[0].0.clone().into_provider_error(),
            ProviderError::RateLimited { .. }
        ));
        assert!(matches!(
            cases[1].0.clone().into_provider_error(),
            ProviderError::AuthError(_)
        ));
        assert!(matches!(
            cases[2].0.clone().into_provider_error(),
            ProviderError::Overloaded { .. }
        ));
        assert!(matches!(
            cases[3].0.clone().into_provider_error(),
            ProviderError::ModelNotFound(_)
        ));
    }

    #[test]
    fn unknown_server_error_remains_retryable_request_failure() {
        let error = ResponsesError {
            message: Some("Internal server error".to_string()),
            code: Some("internal_error".to_string()),
            error_type: Some("server_error".to_string()),
            param: None,
        };

        assert!(matches!(
            error.into_provider_error(),
            ProviderError::RequestFailed(_)
        ));
    }

    #[test]
    fn test_enforce_strict_schema_adds_additional_properties() {
        let mut schema = serde_json::json!({
            "type": "object",
            "required": ["name"],
            "properties": {
                "name": {"type": "string"}
            }
        });

        enforce_strict_schema(&mut schema);

        assert_eq!(schema["additionalProperties"], Value::Bool(false));
        assert_eq!(schema["required"], serde_json::json!(["name"]));
    }

    #[test]
    fn test_enforce_strict_schema_nested_objects() {
        let mut schema = serde_json::json!({
            "type": "object",
            "required": ["user"],
            "properties": {
                "user": {
                    "type": "object",
                    "required": ["name"],
                    "properties": {
                        "name": {"type": "string"},
                        "age": {"type": "number"}
                    }
                }
            }
        });

        enforce_strict_schema(&mut schema);

        assert_eq!(schema["additionalProperties"], Value::Bool(false));
        assert_eq!(
            schema["properties"]["user"]["additionalProperties"],
            Value::Bool(false)
        );
        let nested_required = schema["properties"]["user"]["required"].as_array().unwrap();
        assert!(nested_required.contains(&Value::String("name".to_string())));
        assert!(nested_required.contains(&Value::String("age".to_string())));
        assert_eq!(
            schema["properties"]["user"]["properties"]["age"]["anyOf"][1]["type"],
            "null"
        );
    }

    #[test]
    fn test_enforce_strict_schema_empty_properties() {
        let mut schema = serde_json::json!({
            "type": "object"
        });

        enforce_strict_schema(&mut schema);

        assert_eq!(schema["additionalProperties"], Value::Bool(false));
        assert!(schema["properties"].is_object());
        assert!(schema.get("required").is_none());
    }

    #[test]
    fn test_enforce_strict_schema_array_items() {
        let mut schema = serde_json::json!({
            "type": "array",
            "items": {
                "type": "object",
                "required": ["id"],
                "properties": {
                    "id": {"type": "string"}
                }
            }
        });

        enforce_strict_schema(&mut schema);

        assert_eq!(schema["items"]["additionalProperties"], Value::Bool(false));
        assert_eq!(schema["items"]["required"], serde_json::json!(["id"]));
    }

    #[test]
    fn test_enforce_strict_schema_any_of() {
        let mut schema = serde_json::json!({
            "anyOf": [
                {
                    "type": "object",
                    "properties": {"a": {"type": "string"}}
                },
                {
                    "type": "object",
                    "properties": {"b": {"type": "number"}}
                }
            ]
        });

        enforce_strict_schema(&mut schema);

        assert_eq!(
            schema["anyOf"][0]["additionalProperties"],
            Value::Bool(false)
        );
        assert_eq!(
            schema["anyOf"][1]["additionalProperties"],
            Value::Bool(false)
        );
    }

    #[test]
    fn test_enforce_strict_schema_makes_optional_fields_nullable() {
        let mut schema = serde_json::json!({
            "type": "object",
            "required": ["action"],
            "properties": {
                "action": {"type": "string"},
                "content": {"type": "string"},
                "blockedBy": {
                    "type": "array",
                    "items": {"type": "integer"}
                }
            }
        });

        enforce_strict_schema(&mut schema);

        assert_eq!(
            schema["required"],
            serde_json::json!(["action", "blockedBy", "content"])
        );
        assert_eq!(schema["properties"]["action"]["type"], "string");
        assert_eq!(schema["properties"]["content"]["anyOf"][1]["type"], "null");
        assert_eq!(
            schema["properties"]["blockedBy"]["anyOf"][1]["type"],
            "null"
        );
    }
}
