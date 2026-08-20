//! Turn-local usage telemetry for LLM spans and tool attribution.

use std::collections::HashMap;

use serde_json::Value;

use crate::providers::traits::{usage_key, ToolCallRequest};

use super::context_accounting::ContextUsageSnapshot;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttributionMethod {
    ProviderExact,
    SingleToolIteration,
    SplitBySerializedSize,
    SplitEvenly,
    EstimatedTokenizer,
    BytesOnly,
}

impl AttributionMethod {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ProviderExact => "provider_exact",
            Self::SingleToolIteration => "single_tool_iteration",
            Self::SplitBySerializedSize => "split_by_serialized_size",
            Self::SplitEvenly => "split_evenly",
            Self::EstimatedTokenizer => "estimated_tokenizer",
            Self::BytesOnly => "bytes_only",
        }
    }
}

#[derive(Debug, Clone)]
pub struct LlmUsageSpan {
    pub iteration_index: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub total_tokens: i64,
    pub context_tokens: i64,
    pub related_tool_call_ids: Vec<String>,
    pub context_usage_json: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ToolExecutionUsage {
    pub tool_call_id: String,
    pub tool_name: String,
    pub input_bytes: i64,
    pub output_bytes: i64,
}

#[derive(Debug, Clone)]
pub struct ToolUsageAttribution {
    pub event_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub iteration_index: i64,
    pub decision_completion_tokens: i64,
    pub result_context_tokens: i64,
    pub followup_completion_tokens: i64,
    pub input_bytes: i64,
    pub output_bytes: i64,
    pub attribution_method: AttributionMethod,
}

#[derive(Debug, Clone, Default)]
pub struct UsageTelemetry {
    pub llm_spans: Vec<LlmUsageSpan>,
    pub tool_attributions: Vec<ToolUsageAttribution>,
}

#[derive(Debug, Clone)]
struct PendingDecisionAttribution {
    decision_completion_tokens: i64,
    attribution_method: AttributionMethod,
}

#[derive(Debug, Default)]
pub(super) struct UsageTelemetryCollector {
    spans: Vec<LlmUsageSpan>,
    pending_decisions: HashMap<String, PendingDecisionAttribution>,
    tool_attributions: Vec<ToolUsageAttribution>,
}

impl UsageTelemetryCollector {
    pub fn record_llm_span(
        &mut self,
        iteration_index: i64,
        usage: &HashMap<String, i64>,
        context_tokens: i64,
        tool_calls: &[ToolCallRequest],
        context_usage_snapshot: Option<&ContextUsageSnapshot>,
    ) {
        let prompt_tokens = usage.get(usage_key::PROMPT_TOKENS).copied().unwrap_or(0);
        let completion_tokens = usage
            .get(usage_key::COMPLETION_TOKENS)
            .copied()
            .unwrap_or(0);
        let total_tokens = usage.get(usage_key::TOTAL_TOKENS).copied().unwrap_or(0);
        let cache_read_tokens = usage
            .get(usage_key::CACHE_READ_TOKENS)
            .copied()
            .unwrap_or(0);
        let cache_write_tokens = usage
            .get(usage_key::CACHE_WRITE_TOKENS)
            .copied()
            .unwrap_or(0);
        let related_tool_call_ids = tool_calls
            .iter()
            .map(|tool_call| tool_call.id.clone())
            .collect();
        let context_usage_json =
            context_usage_snapshot.and_then(|snapshot| serde_json::to_string(snapshot).ok());
        self.spans.push(LlmUsageSpan {
            iteration_index,
            prompt_tokens,
            completion_tokens,
            cache_read_tokens,
            cache_write_tokens,
            total_tokens,
            context_tokens,
            related_tool_call_ids,
            context_usage_json,
        });
        self.record_decision_completion(iteration_index, completion_tokens, tool_calls);
    }

    pub fn record_tool_results(
        &mut self,
        iteration_index: i64,
        tool_results: Vec<ToolExecutionUsage>,
    ) {
        for tool_result in tool_results {
            let decision = self.pending_decisions.remove(&tool_result.tool_call_id);
            let (decision_completion_tokens, attribution_method) = decision
                .map(|pending| {
                    (
                        pending.decision_completion_tokens,
                        pending.attribution_method,
                    )
                })
                .unwrap_or((0, AttributionMethod::BytesOnly));
            self.tool_attributions.push(ToolUsageAttribution {
                event_id: core_types::tool_names::tool_call_event_id(&tool_result.tool_call_id),
                tool_call_id: tool_result.tool_call_id,
                tool_name: tool_result.tool_name,
                iteration_index,
                decision_completion_tokens,
                result_context_tokens: estimate_tokens_from_bytes(tool_result.output_bytes),
                followup_completion_tokens: 0,
                input_bytes: tool_result.input_bytes,
                output_bytes: tool_result.output_bytes,
                attribution_method,
            });
        }
    }

    pub fn finish(self) -> UsageTelemetry {
        UsageTelemetry {
            llm_spans: self.spans,
            tool_attributions: self.tool_attributions,
        }
    }

    fn record_decision_completion(
        &mut self,
        _iteration_index: i64,
        completion_tokens: i64,
        tool_calls: &[ToolCallRequest],
    ) {
        if tool_calls.is_empty() || completion_tokens <= 0 {
            return;
        }

        if tool_calls.len() == 1 {
            self.pending_decisions.insert(
                tool_calls[0].id.clone(),
                PendingDecisionAttribution {
                    decision_completion_tokens: completion_tokens,
                    attribution_method: AttributionMethod::SingleToolIteration,
                },
            );
            return;
        }

        let serialized_sizes: Vec<i64> = tool_calls
            .iter()
            .map(|tool_call| serialized_tool_call_size(tool_call).max(1))
            .collect();
        let total_size: i64 = serialized_sizes.iter().sum();
        if total_size <= 0 {
            let split = completion_tokens / tool_calls.len() as i64;
            let remainder = completion_tokens % tool_calls.len() as i64;
            for (index, tool_call) in tool_calls.iter().enumerate() {
                self.pending_decisions.insert(
                    tool_call.id.clone(),
                    PendingDecisionAttribution {
                        decision_completion_tokens: split + i64::from(index == 0) * remainder,
                        attribution_method: AttributionMethod::SplitEvenly,
                    },
                );
            }
            return;
        }

        let mut allocated = 0;
        let last_index = tool_calls.len().saturating_sub(1);
        for (index, tool_call) in tool_calls.iter().enumerate() {
            let tokens = if index == last_index {
                completion_tokens - allocated
            } else {
                let proportional = completion_tokens * serialized_sizes[index] / total_size;
                allocated += proportional;
                proportional
            };
            self.pending_decisions.insert(
                tool_call.id.clone(),
                PendingDecisionAttribution {
                    decision_completion_tokens: tokens,
                    attribution_method: AttributionMethod::SplitBySerializedSize,
                },
            );
        }
    }
}

fn serialized_tool_call_size(tool_call: &ToolCallRequest) -> i64 {
    tool_call.id.len() as i64
        + tool_call.name.len() as i64
        + tool_call.arguments.to_string().len() as i64
}

pub fn estimate_tokens_from_bytes(bytes: i64) -> i64 {
    if bytes <= 0 {
        0
    } else {
        (bytes + 3) / 4
    }
}

pub fn serialized_value_bytes(value: &Value) -> i64 {
    value.to_string().len() as i64
}

pub fn string_bytes(value: &str) -> i64 {
    value.len() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(id: &str, name: &str, arguments: Value) -> ToolCallRequest {
        ToolCallRequest {
            id: id.to_string(),
            name: name.to_string(),
            arguments,
            thought_signature: None,
        }
    }

    #[test]
    fn single_tool_iteration_gets_all_decision_tokens() {
        let mut collector = UsageTelemetryCollector::default();
        let tool_calls = vec![call("call-1", "read_file", json!({"path":"a.md"}))];
        let mut usage = HashMap::new();
        usage.insert(usage_key::COMPLETION_TOKENS.to_string(), 42);
        collector.record_llm_span(1, &usage, 100, &tool_calls, None);
        collector.record_tool_results(
            1,
            vec![ToolExecutionUsage {
                tool_call_id: "call-1".to_string(),
                tool_name: "read_file".to_string(),
                input_bytes: 15,
                output_bytes: 400,
            }],
        );
        let telemetry = collector.finish();
        assert_eq!(telemetry.tool_attributions.len(), 1);
        assert_eq!(
            telemetry.tool_attributions[0].decision_completion_tokens,
            42
        );
        assert_eq!(
            telemetry.tool_attributions[0].attribution_method,
            AttributionMethod::SingleToolIteration
        );
        assert_eq!(telemetry.tool_attributions[0].result_context_tokens, 100);
    }

    #[test]
    fn multiple_tool_iterations_split_by_serialized_size() {
        let mut collector = UsageTelemetryCollector::default();
        let tool_calls = vec![
            call("call-1", "read_file", json!({"path":"a.md"})),
            call(
                "call-2",
                "read_file",
                json!({"path":"a-very-long-path-name.md"}),
            ),
        ];
        let mut usage = HashMap::new();
        usage.insert(usage_key::COMPLETION_TOKENS.to_string(), 100);
        collector.record_llm_span(1, &usage, 100, &tool_calls, None);
        collector.record_tool_results(
            1,
            vec![
                ToolExecutionUsage {
                    tool_call_id: "call-1".to_string(),
                    tool_name: "read_file".to_string(),
                    input_bytes: 10,
                    output_bytes: 100,
                },
                ToolExecutionUsage {
                    tool_call_id: "call-2".to_string(),
                    tool_name: "read_file".to_string(),
                    input_bytes: 20,
                    output_bytes: 200,
                },
            ],
        );
        let telemetry = collector.finish();
        assert_eq!(telemetry.tool_attributions.len(), 2);
        assert_eq!(
            telemetry.tool_attributions[0].attribution_method,
            AttributionMethod::SplitBySerializedSize
        );
        let allocated: i64 = telemetry
            .tool_attributions
            .iter()
            .map(|attribution| attribution.decision_completion_tokens)
            .sum();
        assert_eq!(allocated, 100);
    }

    #[test]
    fn missing_decision_uses_bytes_only() {
        let mut collector = UsageTelemetryCollector::default();
        collector.record_tool_results(
            2,
            vec![ToolExecutionUsage {
                tool_call_id: "call-late".to_string(),
                tool_name: "read_file".to_string(),
                input_bytes: 10,
                output_bytes: 8,
            }],
        );
        let telemetry = collector.finish();
        assert_eq!(telemetry.tool_attributions[0].decision_completion_tokens, 0);
        assert_eq!(telemetry.tool_attributions[0].result_context_tokens, 2);
        assert_eq!(
            telemetry.tool_attributions[0].attribution_method,
            AttributionMethod::BytesOnly
        );
    }
}
