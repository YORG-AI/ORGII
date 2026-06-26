use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const CODE_ASSIST_THOUGHT_SIGNATURE_SKIP_VALIDATOR: &str = "skip_thought_signature_validator";

#[derive(Debug, Serialize)]
pub(super) struct CodeAssistEnvelope {
    model: String,
    project: String,
    user_prompt_id: String,
    request: GenerateContentRequest,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerateContentRequest {
    contents: Vec<GeminiContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system_instruction: Option<GeminiContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation_config: Option<GenerationConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<GeminiTool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_config: Option<GeminiToolConfig>,
    #[serde(rename = "session_id")]
    session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct GeminiContent {
    pub(super) role: String,
    pub(super) parts: Vec<GeminiPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GeminiPart {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) function_call: Option<GeminiFunctionCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) function_response: Option<GeminiFunctionResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) thought_signature: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GeminiFunctionCall {
    pub(super) name: String,
    pub(super) args: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct GeminiFunctionResponse {
    name: String,
    response: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerationConfig {
    max_output_tokens: u32,
    temperature: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeminiTool {
    function_declarations: Vec<GeminiFunctionDeclaration>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeminiToolConfig {
    function_calling_config: GeminiFunctionCallingConfig,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeminiFunctionCallingConfig {
    mode: &'static str,
}

#[derive(Debug, Serialize)]
struct GeminiFunctionDeclaration {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parameters: Option<Value>,
}

impl CodeAssistEnvelope {
    pub(super) fn telemetry(&self) -> CodeAssistRequestTelemetry {
        CodeAssistRequestTelemetry {
            model: self.model.clone(),
            session_id: self.request.session_id.clone(),
            contents_count: self.request.contents.len(),
            tool_declarations_count: self
                .request
                .tools
                .as_ref()
                .map(|tools| {
                    tools
                        .iter()
                        .map(|tool| tool.function_declarations.len())
                        .sum()
                })
                .unwrap_or(0),
            tool_names: self
                .request
                .tools
                .as_ref()
                .map(|tools| {
                    tools
                        .iter()
                        .flat_map(|tool| tool.function_declarations.iter())
                        .map(|declaration| declaration.name.clone())
                        .collect()
                })
                .unwrap_or_default(),
            system_bytes: self
                .request
                .system_instruction
                .as_ref()
                .and_then(|system| serde_json::to_vec(system).ok())
                .map(|body| body.len())
                .unwrap_or(0),
            contents_bytes: serde_json::to_vec(&self.request.contents)
                .map(|body| body.len())
                .unwrap_or(0),
            tools_bytes: self
                .request
                .tools
                .as_ref()
                .and_then(|tools| serde_json::to_vec(tools).ok())
                .map(|body| body.len())
                .unwrap_or(0),
            body_bytes: serde_json::to_vec(self).map(|body| body.len()).unwrap_or(0),
        }
    }
}

pub(super) struct CodeAssistRequestTelemetry {
    pub(super) model: String,
    pub(super) session_id: String,
    pub(super) contents_count: usize,
    pub(super) tool_declarations_count: usize,
    pub(super) tool_names: Vec<String>,
    pub(super) system_bytes: usize,
    pub(super) contents_bytes: usize,
    pub(super) tools_bytes: usize,
    pub(super) body_bytes: usize,
}

pub(super) fn code_assist_request_body(
    project_id: &str,
    session_id: &str,
    messages: &[Value],
    tools: Option<&[Value]>,
    model: &str,
    max_tokens: u32,
    temperature: f32,
) -> CodeAssistEnvelope {
    let (system_instruction, contents) = convert_messages(messages);
    let converted_tools = convert_tools(tools);
    let tool_config = converted_tools.as_ref().map(|_| GeminiToolConfig {
        function_calling_config: GeminiFunctionCallingConfig { mode: "AUTO" },
    });
    CodeAssistEnvelope {
        model: model.to_string(),
        project: project_id.to_string(),
        user_prompt_id: uuid::Uuid::new_v4().to_string(),
        request: GenerateContentRequest {
            contents,
            system_instruction,
            generation_config: Some(GenerationConfig {
                max_output_tokens: max_tokens,
                temperature,
            }),
            tools: converted_tools,
            tool_config,
            session_id: session_id.to_string(),
        },
    }
}

fn convert_messages(messages: &[Value]) -> (Option<GeminiContent>, Vec<GeminiContent>) {
    let mut system_texts = Vec::new();
    let mut contents = Vec::new();
    let mut tool_names_by_call_id: HashMap<String, String> = HashMap::new();
    let mut pending_tool_response_parts: Vec<GeminiPart> = Vec::new();

    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user");
        let text = message_text(message);
        let has_text = !text.trim().is_empty();
        if !has_text && role != "assistant" && role != "tool" {
            continue;
        }

        match role {
            "tool" => {
                let call_id = message.get("tool_call_id").and_then(Value::as_str);
                let name = message
                    .get("name")
                    .and_then(Value::as_str)
                    .or_else(|| {
                        call_id.and_then(|id| tool_names_by_call_id.get(id).map(String::as_str))
                    })
                    .unwrap_or("tool_result")
                    .to_string();
                pending_tool_response_parts.push(GeminiPart {
                    text: None,
                    function_call: None,
                    function_response: Some(GeminiFunctionResponse {
                        name,
                        response: json!({ "result": text }),
                    }),
                    thought_signature: None,
                });
            }
            _ => {
                flush_tool_response_parts(&mut contents, &mut pending_tool_response_parts);
                match role {
                    "system" => system_texts.push(text),
                    "assistant" => {
                        remember_tool_call_names(message, &mut tool_names_by_call_id);
                        let parts = assistant_parts(message, has_text.then_some(text));
                        if !parts.is_empty() {
                            contents.push(GeminiContent {
                                role: "model".to_string(),
                                parts,
                            });
                        }
                    }
                    _ => contents.push(GeminiContent {
                        role: "user".to_string(),
                        parts: vec![GeminiPart {
                            text: Some(text),
                            function_call: None,
                            function_response: None,
                            thought_signature: None,
                        }],
                    }),
                }
            }
        }
    }

    flush_tool_response_parts(&mut contents, &mut pending_tool_response_parts);

    let system_instruction = if system_texts.is_empty() {
        None
    } else {
        Some(GeminiContent {
            role: "user".to_string(),
            parts: vec![GeminiPart {
                text: Some(system_texts.join("\n\n")),
                function_call: None,
                function_response: None,
                thought_signature: None,
            }],
        })
    };

    (system_instruction, contents)
}

fn flush_tool_response_parts(
    contents: &mut Vec<GeminiContent>,
    pending_tool_response_parts: &mut Vec<GeminiPart>,
) {
    if pending_tool_response_parts.is_empty() {
        return;
    }
    contents.push(GeminiContent {
        role: "user".to_string(),
        parts: std::mem::take(pending_tool_response_parts),
    });
}

fn remember_tool_call_names(message: &Value, tool_names_by_call_id: &mut HashMap<String, String>) {
    let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) else {
        return;
    };
    for tool_call in tool_calls {
        let Some(call_id) = tool_call.get("id").and_then(Value::as_str) else {
            continue;
        };
        let function = tool_call.get("function").unwrap_or(tool_call);
        let Some(name) = function.get("name").and_then(Value::as_str) else {
            continue;
        };
        tool_names_by_call_id.insert(call_id.to_string(), name.to_string());
    }
}

fn assistant_parts(message: &Value, text: Option<String>) -> Vec<GeminiPart> {
    let mut parts = Vec::new();
    if let Some(text) = text {
        parts.push(GeminiPart {
            text: Some(text),
            function_call: None,
            function_response: None,
            thought_signature: None,
        });
    }

    if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
        for tool_call in tool_calls {
            let function = tool_call.get("function").unwrap_or(tool_call);
            let Some(name) = function.get("name").and_then(Value::as_str) else {
                continue;
            };
            let args = function
                .get("arguments")
                .and_then(|arguments| {
                    arguments
                        .as_str()
                        .and_then(|text| serde_json::from_str::<Value>(text).ok())
                        .or_else(|| Some(arguments.clone()))
                })
                .unwrap_or_else(|| json!({}));
            parts.push(GeminiPart {
                text: None,
                function_call: Some(GeminiFunctionCall {
                    name: name.to_string(),
                    args,
                }),
                function_response: None,
                thought_signature: Some(
                    google_thought_signature(tool_call)
                        .cloned()
                        .unwrap_or_else(|| json!(CODE_ASSIST_THOUGHT_SIGNATURE_SKIP_VALIDATOR)),
                ),
            });
        }
    }

    parts
}

fn google_thought_signature(tool_call: &Value) -> Option<&Value> {
    tool_call
        .get("extra_content")
        .and_then(|extra| extra.get("google"))
        .and_then(|google| google.get("thought_signature"))
}

fn message_text(message: &Value) -> String {
    let Some(content) = message.get("content") else {
        return String::new();
    };
    if content.is_null() {
        return String::new();
    }
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    if let Some(parts) = content.as_array() {
        return parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .or_else(|| part.get("content").and_then(Value::as_str))
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    content.to_string()
}

fn convert_tools(tools: Option<&[Value]>) -> Option<Vec<GeminiTool>> {
    let declarations: Vec<GeminiFunctionDeclaration> = tools?
        .iter()
        .filter_map(|tool| {
            let function = tool.get("function").unwrap_or(tool);
            let name = function.get("name")?.as_str()?.to_string();
            Some(GeminiFunctionDeclaration {
                name,
                description: function
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                parameters: function.get("parameters").map(sanitize_gemini_schema),
            })
        })
        .collect();
    if declarations.is_empty() {
        None
    } else {
        Some(vec![GeminiTool {
            function_declarations: declarations,
        }])
    }
}

fn sanitize_gemini_schema(schema: &Value) -> Value {
    let mut sanitized = schema.clone();
    strip_unsupported_schema_keywords(&mut sanitized);
    sanitized
}

fn strip_unsupported_schema_keywords(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for key in [
                "$schema",
                "$defs",
                "$ref",
                "definitions",
                "default",
                "examples",
                "nullable",
                "readOnly",
                "writeOnly",
                "deprecated",
            ] {
                object.remove(key);
            }
            if object
                .get("additionalProperties")
                .is_some_and(|value| value.is_boolean())
            {
                object.remove("additionalProperties");
            }
            normalize_schema_type(object);
            for child in object.values_mut() {
                strip_unsupported_schema_keywords(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                strip_unsupported_schema_keywords(item);
            }
        }
        _ => {}
    }
}

fn normalize_schema_type(object: &mut serde_json::Map<String, Value>) {
    let Some(type_value) = object.get_mut("type") else {
        return;
    };
    let Some(types) = type_value.as_array() else {
        return;
    };

    if let Some(concrete_type) = types
        .iter()
        .filter_map(Value::as_str)
        .find(|value| *value != "null")
        .map(str::to_string)
    {
        *type_value = Value::String(concrete_type);
    } else {
        object.remove("type");
    }
}

#[cfg(test)]
mod tests {
    use super::{code_assist_request_body, convert_messages, convert_tools};
    use serde_json::json;

    #[test]
    fn request_body_uses_code_assist_snake_case_envelope() {
        let body = code_assist_request_body(
            "project-from-load-code-assist",
            "stable-code-assist-session-id",
            &[
                json!({ "role": "system", "content": "Be concise." }),
                json!({ "role": "user", "content": "Hello" }),
            ],
            Some(&[json!({
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read a file",
                    "parameters": { "type": "object", "properties": { "path": { "type": "string" } } }
                }
            })]),
            "gemini-2.5-pro",
            1024,
            0.2,
        );
        let value = serde_json::to_value(body).expect("serialize request");

        assert_eq!(value["model"], "gemini-2.5-pro");
        assert_eq!(value["project"], "project-from-load-code-assist");
        assert!(value.get("user_prompt_id").is_some());
        assert!(value.get("userPromptId").is_none());
        assert_eq!(value["request"]["contents"][0]["role"], "user");
        assert_eq!(
            value["request"]["session_id"],
            "stable-code-assist-session-id"
        );
        assert_eq!(
            value["request"]["systemInstruction"]["parts"][0]["text"],
            "Be concise."
        );
        assert_eq!(
            value["request"]["tools"][0]["functionDeclarations"][0]["name"],
            "read_file"
        );
        assert_eq!(
            value["request"]["toolConfig"]["functionCallingConfig"]["mode"],
            "AUTO"
        );
    }

    #[test]
    fn tool_schema_strips_keywords_rejected_by_code_assist() {
        let tools = convert_tools(Some(&[json!({
            "type": "function",
            "function": {
                "name": "read_file",
                "parameters": {
                    "type": "object",
                    "$schema": "https://json-schema.org/draft/2020-12/schema",
                    "definitions": {
                        "PathInput": { "type": "string" }
                    },
                    "$defs": {
                        "Other": { "type": "string" }
                    },
                    "additionalProperties": false,
                    "properties": {
                        "path": { "$ref": "#/definitions/PathInput", "default": "README.md" },
                        "label": { "type": ["string", "null"], "nullable": true },
                        "items": {
                            "type": "array",
                            "items": { "$ref": "#/$defs/Other" }
                        }
                    }
                }
            }
        })]))
        .expect("convert tools");
        let schema = tools[0].function_declarations[0]
            .parameters
            .as_ref()
            .expect("parameters");

        assert!(schema.get("$schema").is_none());
        assert!(schema.get("definitions").is_none());
        assert!(schema.get("$defs").is_none());
        assert!(schema.get("additionalProperties").is_none());
        assert!(schema["properties"]["path"].get("$ref").is_none());
        assert!(schema["properties"]["path"].get("default").is_none());
        assert_eq!(schema["properties"]["label"]["type"], "string");
        assert!(schema["properties"]["label"].get("nullable").is_none());
        assert!(schema["properties"]["items"]["items"].get("$ref").is_none());
    }

    #[test]
    fn tool_result_uses_function_name_from_prior_assistant_tool_call() {
        let (_system, contents) = convert_messages(&[
            json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "gemini-call-1",
                    "type": "function",
                    "function": {
                        "name": "read_file",
                        "arguments": "{\"path\":\"src/main.rs\"}"
                    },
                    "extra_content": {
                        "google": { "thought_signature": "gemini-thought-sig" }
                    }
                }]
            }),
            json!({
                "role": "tool",
                "tool_call_id": "gemini-call-1",
                "content": "fn main() {}"
            }),
        ]);

        let function_call = contents[0].parts[0].function_call.as_ref().unwrap();
        assert_eq!(function_call.name, "read_file");
        assert_eq!(
            contents[0].parts[0].thought_signature,
            Some(json!("gemini-thought-sig"))
        );
        assert_eq!(
            contents[1].parts[0]
                .function_response
                .as_ref()
                .unwrap()
                .name,
            "read_file"
        );
    }

    #[test]
    fn consecutive_tool_results_share_one_function_response_turn() {
        let (_system, contents) = convert_messages(&[
            json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [
                    {
                        "id": "gemini-call-1",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": "{\"path\":\"src/main.rs\"}"
                        }
                    },
                    {
                        "id": "gemini-call-2",
                        "type": "function",
                        "function": {
                            "name": "list_dir",
                            "arguments": "{\"path\":\"src\"}"
                        }
                    }
                ]
            }),
            json!({
                "role": "tool",
                "tool_call_id": "gemini-call-1",
                "content": "fn main() {}"
            }),
            json!({
                "role": "tool",
                "tool_call_id": "gemini-call-2",
                "content": "main.rs"
            }),
            json!({
                "role": "user",
                "content": "continue"
            }),
        ]);

        assert_eq!(contents.len(), 3);
        assert_eq!(contents[0].role, "model");
        assert_eq!(contents[0].parts.len(), 2);
        assert_eq!(contents[1].role, "user");
        assert_eq!(contents[1].parts.len(), 2);
        assert_eq!(
            contents[1].parts[0]
                .function_response
                .as_ref()
                .unwrap()
                .name,
            "read_file"
        );
        assert_eq!(
            contents[1].parts[1]
                .function_response
                .as_ref()
                .unwrap()
                .name,
            "list_dir"
        );
        assert_eq!(contents[2].parts[0].text.as_deref(), Some("continue"));
    }

    #[test]
    fn assistant_tool_call_adds_code_assist_thought_signature_fallback() {
        let (_system, contents) = convert_messages(&[json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [{
                "id": "gemini-call-1",
                "type": "function",
                "function": {
                    "name": "read_file",
                    "arguments": "{\"path\":\"src/main.rs\"}"
                }
            }]
        })]);

        let function_call = contents[0].parts[0].function_call.as_ref().unwrap();
        assert_eq!(function_call.name, "read_file");
        assert_eq!(
            contents[0].parts[0].thought_signature,
            Some(json!("skip_thought_signature_validator"))
        );
    }
}
