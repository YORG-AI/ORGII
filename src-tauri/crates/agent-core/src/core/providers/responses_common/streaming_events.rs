use std::collections::HashMap;

use serde_json::Value;

use crate::providers::traits::ToolCallRequest;

use super::types::{ResponsesResponse, StreamEvent};

#[derive(Debug)]
pub enum ResponsesStreamOutput {
    BlockBoundary,
    TextDelta(String),
    ReasoningDelta(String),
    ToolCallStarted {
        index: usize,
        call_id: String,
        name: String,
        arguments_delta: Option<String>,
    },
    ToolArgumentsDelta {
        index: usize,
        arguments_delta: String,
    },
    ToolCallDone(ToolCallRequest),
    ResponseCompleted(ResponsesResponse),
    Error(String),
    UnknownFrame {
        event_type: String,
        sample: String,
    },
}

pub struct ResponsesStreamNormalizer {
    pending_calls: HashMap<String, PendingToolCall>,
    item_id_to_call_id: HashMap<String, String>,
    call_id_to_index: HashMap<String, usize>,
    unknown_frame_count: usize,
}

struct PendingToolCall {
    index: usize,
    name: String,
    arguments_json: String,
}

impl ResponsesStreamNormalizer {
    pub fn new() -> Self {
        Self {
            pending_calls: HashMap::new(),
            item_id_to_call_id: HashMap::new(),
            call_id_to_index: HashMap::new(),
            unknown_frame_count: 0,
        }
    }

    pub fn unknown_frame_count(&self) -> usize {
        self.unknown_frame_count
    }

    pub fn has_pending_tool_calls(&self) -> bool {
        !self.pending_calls.is_empty()
    }

    pub fn ingest_json_str(
        &mut self,
        event_json: &str,
    ) -> Result<Vec<ResponsesStreamOutput>, serde_json::Error> {
        let event: StreamEvent = serde_json::from_str(event_json)?;
        Ok(self.ingest(event))
    }

    fn ingest(&mut self, event: StreamEvent) -> Vec<ResponsesStreamOutput> {
        let mut outputs = Vec::new();

        match ResponseStreamEventKind::from_wire(event.event_type.as_str()) {
            ResponseStreamEventKind::TextDelta => {
                if let Some(delta) = event.delta {
                    outputs.push(ResponsesStreamOutput::TextDelta(delta));
                }
            }
            ResponseStreamEventKind::ReasoningDelta => {
                if let Some(delta) = event.delta {
                    outputs.push(ResponsesStreamOutput::ReasoningDelta(delta));
                }
            }
            ResponseStreamEventKind::FunctionCallArgumentsDelta => {
                if let Some(call_id) = self.resolve_call_id(&event) {
                    let index = self.index_for_call_id(&call_id);
                    let entry = self
                        .pending_calls
                        .entry(call_id)
                        .or_insert(PendingToolCall {
                            index,
                            name: String::new(),
                            arguments_json: String::new(),
                        });
                    if let Some(delta) = event.delta {
                        entry.arguments_json.push_str(&delta);
                        outputs.push(ResponsesStreamOutput::ToolArgumentsDelta {
                            index,
                            arguments_delta: delta,
                        });
                    }
                }
            }
            ResponseStreamEventKind::OutputItemAdded => {
                outputs.push(ResponsesStreamOutput::BlockBoundary);
                if let Some(item) = event.item {
                    self.ingest_output_item(item, &mut outputs);
                }
            }
            ResponseStreamEventKind::FunctionCallArgumentsDone => {
                if let Some(call_id) = self.resolve_call_id(&event) {
                    if let Some(tool_call) = self.take_tool_call(&call_id) {
                        outputs.push(ResponsesStreamOutput::ToolCallDone(tool_call));
                    }
                }
            }
            ResponseStreamEventKind::Completed => {
                if let Some(response) = event.response {
                    outputs.push(ResponsesStreamOutput::ResponseCompleted(response));
                }
            }
            ResponseStreamEventKind::Error => {
                let message = event
                    .response
                    .as_ref()
                    .and_then(|response| response.error.as_ref())
                    .map(|error| {
                        let explicit = error
                            .message
                            .as_deref()
                            .map(str::trim)
                            .filter(|s| !s.is_empty());
                        if let Some(message) = explicit {
                            message.to_string()
                        } else {
                            let details = serde_json::to_string(&error)
                                .unwrap_or_else(|_| "unserializable error payload".to_string());
                            format!("Streaming error (provider payload: {details})")
                        }
                    })
                    .unwrap_or_else(|| {
                        format!(
                            "Streaming error (event payload: {})",
                            bounded_event_sample(&event)
                        )
                    });
                outputs.push(ResponsesStreamOutput::Error(message));
            }
            ResponseStreamEventKind::Unknown(event_type) => {
                self.unknown_frame_count += 1;
                outputs.push(ResponsesStreamOutput::UnknownFrame {
                    sample: bounded_event_sample(&event),
                    event_type,
                });
            }
            ResponseStreamEventKind::Ignored => {}
        }

        outputs
    }

    pub fn take_pending_tool_calls(&mut self) -> Vec<ToolCallRequest> {
        let mut pending: Vec<(usize, String)> = self
            .pending_calls
            .iter()
            .map(|(call_id, pending)| (pending.index, call_id.clone()))
            .collect();
        pending.sort_by_key(|(index, _)| *index);
        pending
            .into_iter()
            .filter_map(|(_, call_id)| self.take_tool_call(&call_id))
            .collect()
    }

    fn ingest_output_item(&mut self, item: Value, outputs: &mut Vec<ResponsesStreamOutput>) {
        match item.get("type").and_then(Value::as_str) {
            Some("reasoning") => {
                let summary_values: Vec<Value> = item
                    .get("summary")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let summary_text =
                    super::parser::response_reasoning_summary_text_from_values(&summary_values);
                if !summary_text.is_empty() {
                    outputs.push(ResponsesStreamOutput::ReasoningDelta(
                        summary_text.join("\n"),
                    ));
                }
            }
            Some("function_call") => {
                let call_id = item
                    .get("call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if call_id.is_empty() {
                    return;
                }

                let name = item
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let arguments_json = item
                    .get("arguments")
                    .map(arguments_value_to_json_string)
                    .unwrap_or_default();
                let index = self.index_for_call_id(&call_id);

                if let Some(item_id) = item.get("id").and_then(Value::as_str) {
                    self.item_id_to_call_id
                        .insert(item_id.to_string(), call_id.clone());
                }

                self.pending_calls.insert(
                    call_id.clone(),
                    PendingToolCall {
                        index,
                        name: name.clone(),
                        arguments_json: arguments_json.clone(),
                    },
                );

                outputs.push(ResponsesStreamOutput::ToolCallStarted {
                    index,
                    call_id,
                    name,
                    arguments_delta: (!arguments_json.is_empty()).then_some(arguments_json),
                });
            }
            _ => {}
        }
    }

    fn resolve_call_id(&self, event: &StreamEvent) -> Option<String> {
        event.call_id.clone().or_else(|| {
            event
                .item_id
                .as_ref()
                .and_then(|item_id| self.item_id_to_call_id.get(item_id).cloned())
        })
    }

    fn index_for_call_id(&mut self, call_id: &str) -> usize {
        let next_index = self.call_id_to_index.len();
        *self
            .call_id_to_index
            .entry(call_id.to_string())
            .or_insert(next_index)
    }

    fn take_tool_call(&mut self, call_id: &str) -> Option<ToolCallRequest> {
        let pending = self.pending_calls.remove(call_id)?;
        if call_id.is_empty() || pending.name.is_empty() {
            return None;
        }

        let arguments: Value = serde_json::from_str(&pending.arguments_json)
            .unwrap_or(Value::Object(serde_json::Map::new()));
        Some(ToolCallRequest {
            id: call_id.to_string(),
            name: pending.name,
            arguments,
            thought_signature: None,
        })
    }
}

enum ResponseStreamEventKind {
    TextDelta,
    ReasoningDelta,
    FunctionCallArgumentsDelta,
    OutputItemAdded,
    FunctionCallArgumentsDone,
    Completed,
    Error,
    Unknown(String),
    Ignored,
}

impl ResponseStreamEventKind {
    fn from_wire(event_type: &str) -> Self {
        match event_type {
            "response.output_text.delta" => Self::TextDelta,
            "response.reasoning.delta"
            | "response.reasoning_summary.delta"
            | "response.reasoning_summary_text.delta"
            | "response.reasoning_summary_part.delta" => Self::ReasoningDelta,
            "response.function_call_arguments.delta" => Self::FunctionCallArgumentsDelta,
            "response.output_item.added" => Self::OutputItemAdded,
            "response.function_call_arguments.done" => Self::FunctionCallArgumentsDone,
            "response.completed" => Self::Completed,
            "error" => Self::Error,
            "response.created"
            | "response.in_progress"
            | "response.output_item.done"
            | "response.content_part.added"
            | "response.content_part.done"
            | "response.output_text.done"
            | "response.reasoning_summary_part.added"
            | "response.reasoning_summary_part.done"
            | "response.reasoning_summary_text.done" => Self::Ignored,
            other => Self::Unknown(other.to_string()),
        }
    }
}

fn bounded_event_sample(event: &StreamEvent) -> String {
    let sample = serde_json::json!({
        "type": &event.event_type,
        "delta": event.delta.as_deref(),
        "call_id": event.call_id.as_deref(),
        "item_id": event.item_id.as_deref(),
        "item_type": event.item.as_ref().and_then(|item| item.get("type")).and_then(Value::as_str),
    })
    .to_string();
    crate::utils::safe_truncate_chars_to_string(&sample, 500)
}

fn arguments_value_to_json_string(arguments_value: &Value) -> String {
    arguments_value
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| arguments_value.to_string())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{ResponsesStreamNormalizer, ResponsesStreamOutput};
    use crate::providers::responses_common::types::StreamEvent;

    fn event(value: serde_json::Value) -> StreamEvent {
        serde_json::from_value(value).expect("test stream event should deserialize")
    }

    #[test]
    fn normalizes_text_and_reasoning_deltas() {
        let mut normalizer = ResponsesStreamNormalizer::new();

        let text_outputs = normalizer.ingest(event(json!({
            "type": "response.output_text.delta",
            "delta": "hello"
        })));
        let reasoning_outputs = normalizer.ingest(event(json!({
            "type": "response.reasoning_summary_text.delta",
            "delta": "thinking"
        })));

        assert!(matches!(
            text_outputs.as_slice(),
            [ResponsesStreamOutput::TextDelta(text)] if text == "hello"
        ));
        assert!(matches!(
            reasoning_outputs.as_slice(),
            [ResponsesStreamOutput::ReasoningDelta(reasoning)] if reasoning == "thinking"
        ));
    }

    #[test]
    fn normalizes_reasoning_output_items_as_reasoning_deltas() {
        let mut normalizer = ResponsesStreamNormalizer::new();

        let outputs = normalizer.ingest(event(json!({
            "type": "response.output_item.added",
            "item": {
                "id": "rs_1",
                "type": "reasoning",
                "summary": [{ "type": "summary_text", "text": "reasoning item" }]
            }
        })));

        assert!(matches!(
            outputs.as_slice(),
            [ResponsesStreamOutput::BlockBoundary, ResponsesStreamOutput::ReasoningDelta(reasoning)] if reasoning == "reasoning item"
        ));
    }

    #[test]
    fn preserves_structured_stream_error_when_message_is_empty() {
        let mut normalizer = ResponsesStreamNormalizer::new();
        let outputs = normalizer.ingest(event(json!({
            "type": "error",
            "response": {"output": [], "usage": null, "error": {
                "message": "", "status": 400, "code": "context_length_exceeded",
                "type": "invalid_request_error", "body": {"detail": "maximum context length"}
            }}
        })));
        assert!(
            matches!(outputs.as_slice(), [ResponsesStreamOutput::Error(message)]
            if message.contains("400")
                && message.contains("context_length_exceeded")
                && message.contains("invalid_request_error")
                && message.contains("maximum context length")
                && !message.contains("Unknown streaming error"))
        );
    }

    #[test]
    fn normalizes_streamed_tool_call_lifecycle() {
        let mut normalizer = ResponsesStreamNormalizer::new();

        let started = normalizer.ingest(event(json!({
            "type": "response.output_item.added",
            "item": {
                "id": "fc_1",
                "type": "function_call",
                "call_id": "call_1",
                "name": "create_plan",
                "arguments": "{\"title\":"
            }
        })));
        let delta = normalizer.ingest(event(json!({
            "type": "response.function_call_arguments.delta",
            "item_id": "fc_1",
            "delta": "\"Plan\"}"
        })));
        let done = normalizer.ingest(event(json!({
            "type": "response.function_call_arguments.done",
            "item_id": "fc_1"
        })));

        assert!(matches!(
            started.as_slice(),
            [
                ResponsesStreamOutput::BlockBoundary,
                ResponsesStreamOutput::ToolCallStarted {
                    index: 0,
                    call_id,
                    name,
                    arguments_delta: Some(arguments_delta),
                }
            ] if call_id == "call_1" && name == "create_plan" && arguments_delta == "{\"title\":"
        ));
        assert!(matches!(
            delta.as_slice(),
            [ResponsesStreamOutput::ToolArgumentsDelta { index: 0, arguments_delta }]
                if arguments_delta == "\"Plan\"}"
        ));
        assert!(matches!(
            done.as_slice(),
            [ResponsesStreamOutput::ToolCallDone(tool_call)]
                if tool_call.id == "call_1"
                    && tool_call.name == "create_plan"
                    && tool_call.arguments.get("title").and_then(serde_json::Value::as_str) == Some("Plan")
        ));
        assert!(!normalizer.has_pending_tool_calls());
    }

    #[test]
    fn surfaces_unknown_frames_without_blocking_later_completion() {
        let mut normalizer = ResponsesStreamNormalizer::new();

        let unknown = normalizer.ingest(event(json!({
            "type": "response.future_unhandled.delta",
            "delta": "opaque"
        })));
        let completion = normalizer.ingest(event(json!({
            "type": "response.completed",
            "response": {
                "output": [],
                "usage": null
            }
        })));

        assert_eq!(normalizer.unknown_frame_count(), 1);
        assert!(matches!(
            unknown.as_slice(),
            [ResponsesStreamOutput::UnknownFrame { event_type, sample }]
                if event_type == "response.future_unhandled.delta" && sample.contains("opaque")
        ));
        assert!(matches!(
            completion.as_slice(),
            [ResponsesStreamOutput::ResponseCompleted(_)]
        ));
    }

    #[test]
    fn flushes_pending_tool_calls_in_stream_order() {
        let mut normalizer = ResponsesStreamNormalizer::new();

        normalizer.ingest(event(json!({
            "type": "response.output_item.added",
            "item": {
                "id": "fc_1",
                "type": "function_call",
                "call_id": "call_1",
                "name": "first",
                "arguments": "{}"
            }
        })));
        normalizer.ingest(event(json!({
            "type": "response.output_item.added",
            "item": {
                "id": "fc_2",
                "type": "function_call",
                "call_id": "call_2",
                "name": "second",
                "arguments": "{}"
            }
        })));

        let pending = normalizer.take_pending_tool_calls();

        assert_eq!(pending.len(), 2);
        assert_eq!(pending[0].id, "call_1");
        assert_eq!(pending[1].id, "call_2");
        assert!(!normalizer.has_pending_tool_calls());
    }
}
