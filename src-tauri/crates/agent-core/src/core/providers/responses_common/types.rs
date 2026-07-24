//! OpenAI Responses API types
//!
//! Shared type definitions for the Responses API format used by both:
//! - Public OpenAI API (`api.openai.com/v1/responses`)
//! - Codex native backend (`chatgpt.com/backend-api/codex/responses`)

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::warn;

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
#[derive(Debug, Deserialize, Serialize)]
pub struct ResponsesError {
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub code: Option<Value>,
    #[serde(default, rename = "type")]
    pub error_type: Option<String>,
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub body: Option<Value>,
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
    /// Present on response.completed
    #[serde(default)]
    pub response: Option<ResponsesResponse>,
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
/// 3. Object-type nodes must have an explicit `"properties"` field
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

            let prop_keys: Vec<Value> = obj
                .get("properties")
                .and_then(|p| p.as_object())
                .map(|props| props.keys().map(|k| Value::String(k.clone())).collect())
                .unwrap_or_default();

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
    fn test_enforce_strict_schema_adds_additional_properties() {
        let mut schema = serde_json::json!({
            "type": "object",
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
            "properties": {
                "user": {
                    "type": "object",
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
}
