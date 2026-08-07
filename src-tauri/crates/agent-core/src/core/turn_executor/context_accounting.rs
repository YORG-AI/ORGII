use serde::Serialize;
use serde_json::Value;

use crate::core::session::prompt::cache::{RenderedSystemBlockScope, ORGII_SYSTEM_CACHE_SCOPE_KEY};
use crate::core::turn_executor::helpers::{STRUCTURED_CONTENT_BLOCKS_KEY, STRUCTURED_SIDECAR_KEY};

const APPROX_CHARS_PER_TOKEN: i64 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextUsageCategory {
    StablePrompt,
    DynamicPrompt,
    Rules,
    Skills,
    Memory,
    Conversation,
    ToolResults,
    Attachments,
    Other,
    Unattributed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsageItem {
    pub category: ContextUsageCategory,
    pub label: String,
    pub source: String,
    pub estimated_tokens: i64,
    pub included: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsageSection {
    pub category: ContextUsageCategory,
    pub label: String,
    pub estimated_tokens: i64,
    pub percent: i64,
    pub items: Vec<ContextUsageItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsageSnapshot {
    pub used_tokens: i64,
    pub max_tokens: Option<i64>,
    pub percent_used: Option<f64>,
    pub updated_at: String,
    pub sections: Vec<ContextUsageSection>,
    pub warnings: Vec<String>,
    /// Provider-reported cache-read tokens (Anthropic prompt caching).
    /// These tokens were NOT fetched over the wire — the model reused
    /// previously cached KV blocks.  The frontend should NOT count cache
    /// reads as "used" because they don't consume context-window budget.
    #[serde(skip_serializing_if = "is_zero_i64")]
    pub cache_read_tokens: i64,
    /// Provider-reported cache-write tokens (new KV blocks written this
    /// turn for future reuse).
    #[serde(skip_serializing_if = "is_zero_i64")]
    pub cache_write_tokens: i64,
}

fn is_zero_i64(v: &i64) -> bool {
    *v == 0
}

impl ContextUsageSnapshot {
    /// Three-tier low-context signal derived from `percent_used`:
    /// `warning` (≥75%), `error` (≥90%), `blocking` (≥98%). `None` while
    /// comfortably within budget or when the window size is unknown.
    /// Rides the `agent:context_usage` broadcast so the frontend can color
    /// the gauge, and drives the one-shot model-side budget nudge in the
    /// turn loop.
    pub fn warning_level(&self) -> Option<&'static str> {
        let percent = self.percent_used?;
        if percent >= 98.0 {
            Some("blocking")
        } else if percent >= 90.0 {
            Some("error")
        } else if percent >= 75.0 {
            Some("warning")
        } else {
            None
        }
    }

    pub fn from_payload(
        messages: &[Value],
        tools: &[Value],
        used_tokens: i64,
        cache_read_tokens: i64,
        cache_write_tokens: i64,
        max_tokens: Option<i64>,
    ) -> Self {
        let mut items = Vec::new();

        if !tools.is_empty() {
            items.push(ContextUsageItem {
                category: ContextUsageCategory::DynamicPrompt,
                label: "Tool definitions".to_string(),
                source: "request.tools".to_string(),
                estimated_tokens: estimate_tokens_for_json_array(tools),
                included: true,
                cache_status: None,
                details: Some(format!("{} tools", tools.len())),
            });
        }

        for (index, message) in messages.iter().enumerate() {
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("other");
            match role {
                "system" => push_system_item(&mut items, message, index),
                "tool" => push_tool_result_item(&mut items, message, index),
                "user" | "assistant" => push_conversation_item(&mut items, message, index, role),
                _ => push_other_item(&mut items, message, index, role),
            }
        }

        let items = normalize_items_to_used_tokens(items, used_tokens);
        let mut sections = build_sections(items, used_tokens);
        let attributed = sections
            .iter()
            .filter(|section| section.category != ContextUsageCategory::Unattributed)
            .map(|section| section.estimated_tokens)
            .sum::<i64>();

        if used_tokens > 0 && attributed < used_tokens {
            let delta = used_tokens - attributed;
            sections.push(ContextUsageSection {
                category: ContextUsageCategory::Unattributed,
                label: label_for_category(ContextUsageCategory::Unattributed).to_string(),
                estimated_tokens: delta,
                percent: percent(delta, used_tokens),
                items: vec![ContextUsageItem {
                    category: ContextUsageCategory::Unattributed,
                    label: "Provider usage difference".to_string(),
                    source: "provider.usage".to_string(),
                    estimated_tokens: delta,
                    included: true,
                    cache_status: None,
                    details: Some(
                        "Difference between provider total and local section estimate".to_string(),
                    ),
                }],
            });
        }

        let percent_used = match max_tokens {
            Some(max) if max > 0 => Some((used_tokens as f64 / max as f64) * 100.0),
            _ => None,
        };

        Self {
            used_tokens,
            max_tokens,
            percent_used,
            updated_at: chrono::Utc::now().to_rfc3339(),
            sections,
            cache_read_tokens,
            cache_write_tokens,
            warnings: vec![
                "Section token counts are estimated from the final request payload.".to_string(),
            ],
        }
    }
}

fn push_system_item(items: &mut Vec<ContextUsageItem>, message: &Value, index: usize) {
    let text = text_content(message);
    let scope = system_scope(message);
    let category = match scope.as_deref() {
        Some(scope) if scope == RenderedSystemBlockScope::Session.as_str() => {
            ContextUsageCategory::StablePrompt
        }
        Some(scope) if scope == RenderedSystemBlockScope::Volatile.as_str() => {
            categorize_dynamic_system_text(&text)
        }
        _ => ContextUsageCategory::Other,
    };

    items.push(ContextUsageItem {
        category,
        label: match category {
            ContextUsageCategory::StablePrompt => "Stable system prompt".to_string(),
            ContextUsageCategory::DynamicPrompt => "Dynamic system context".to_string(),
            ContextUsageCategory::Rules => "Activated rules".to_string(),
            ContextUsageCategory::Skills => "Activated skills".to_string(),
            ContextUsageCategory::Memory => "Loaded memory".to_string(),
            _ => "System message".to_string(),
        },
        source: format!("messages[{index}].system"),
        estimated_tokens: estimate_tokens(&text),
        included: true,
        cache_status: scope,
        details: None,
    });
}

fn push_conversation_item(
    items: &mut Vec<ContextUsageItem>,
    message: &Value,
    index: usize,
    role: &str,
) {
    let attachments_tokens = attachment_tokens(message);
    let message_tokens = (estimate_tokens_for_json(message) - attachments_tokens).max(0);
    if message_tokens > 0 {
        items.push(ContextUsageItem {
            category: ContextUsageCategory::Conversation,
            label: format!("{} message", capitalize(role)),
            source: format!("messages[{index}]"),
            estimated_tokens: message_tokens,
            included: true,
            cache_status: None,
            details: None,
        });
    }
    if attachments_tokens > 0 {
        items.push(ContextUsageItem {
            category: ContextUsageCategory::Attachments,
            label: "Message attachments".to_string(),
            source: format!("messages[{index}].content"),
            estimated_tokens: attachments_tokens,
            included: true,
            cache_status: None,
            details: None,
        });
    }
}

fn push_tool_result_item(items: &mut Vec<ContextUsageItem>, message: &Value, index: usize) {
    let attachments_tokens = attachment_tokens(message);
    let message_tokens = (estimate_tokens_for_json(message) - attachments_tokens).max(0);
    if message_tokens > 0 {
        items.push(ContextUsageItem {
            category: ContextUsageCategory::ToolResults,
            label: message
                .get("name")
                .and_then(Value::as_str)
                .map(|name| format!("{name} result"))
                .unwrap_or_else(|| "Tool result".to_string()),
            source: format!("messages[{index}]"),
            estimated_tokens: message_tokens,
            included: true,
            cache_status: None,
            details: None,
        });
    }
    if attachments_tokens > 0 {
        items.push(ContextUsageItem {
            category: ContextUsageCategory::Attachments,
            label: "Tool result attachments".to_string(),
            source: format!("messages[{index}]._orgii_structured"),
            estimated_tokens: attachments_tokens,
            included: true,
            cache_status: None,
            details: None,
        });
    }
}

fn push_other_item(items: &mut Vec<ContextUsageItem>, message: &Value, index: usize, role: &str) {
    items.push(ContextUsageItem {
        category: ContextUsageCategory::Other,
        label: format!("{role} message"),
        source: format!("messages[{index}]"),
        estimated_tokens: estimate_tokens_for_json(message),
        included: true,
        cache_status: None,
        details: None,
    });
}

fn build_sections(items: Vec<ContextUsageItem>, used_tokens: i64) -> Vec<ContextUsageSection> {
    let order = [
        ContextUsageCategory::StablePrompt,
        ContextUsageCategory::DynamicPrompt,
        ContextUsageCategory::Rules,
        ContextUsageCategory::Skills,
        ContextUsageCategory::Memory,
        ContextUsageCategory::Conversation,
        ContextUsageCategory::ToolResults,
        ContextUsageCategory::Attachments,
        ContextUsageCategory::Other,
    ];

    order
        .into_iter()
        .filter_map(|category| {
            let section_items = items
                .iter()
                .filter(|item| item.category == category && item.estimated_tokens > 0)
                .cloned()
                .collect::<Vec<_>>();
            if section_items.is_empty() {
                return None;
            }
            let tokens = section_items
                .iter()
                .map(|item| item.estimated_tokens)
                .sum::<i64>();
            Some(ContextUsageSection {
                category,
                label: label_for_category(category).to_string(),
                estimated_tokens: tokens,
                percent: percent(tokens, used_tokens),
                items: section_items,
            })
        })
        .collect()
}

fn normalize_items_to_used_tokens(
    mut items: Vec<ContextUsageItem>,
    used_tokens: i64,
) -> Vec<ContextUsageItem> {
    if used_tokens <= 0 {
        return items;
    }

    let total = items
        .iter()
        .map(|item| item.estimated_tokens.max(0))
        .sum::<i64>();
    if total <= used_tokens || total <= 0 {
        return items;
    }

    let mut scaled = items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let tokens = item.estimated_tokens.max(0) as i128;
            let product = tokens * used_tokens as i128;
            let scaled_tokens = (product / total as i128) as i64;
            let remainder = product % total as i128;
            (index, scaled_tokens, remainder)
        })
        .collect::<Vec<_>>();

    let assigned = scaled
        .iter()
        .map(|(_, scaled_tokens, _)| *scaled_tokens)
        .sum::<i64>();
    let mut remaining = used_tokens.saturating_sub(assigned);

    scaled.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
    for (_, scaled_tokens, _) in &mut scaled {
        if remaining <= 0 {
            break;
        }
        *scaled_tokens += 1;
        remaining -= 1;
    }

    scaled.sort_by_key(|(index, _, _)| *index);
    for (index, scaled_tokens, _) in scaled {
        if let Some(item) = items.get_mut(index) {
            item.estimated_tokens = scaled_tokens;
        }
    }

    items
        .into_iter()
        .filter(|item| item.estimated_tokens > 0)
        .collect()
}

fn categorize_dynamic_system_text(text: &str) -> ContextUsageCategory {
    let lower = text.to_lowercase();
    if lower.contains("skill") {
        ContextUsageCategory::Skills
    } else if lower.contains("memory")
        || lower.contains("learnings")
        || lower.contains("workspace-memory")
    {
        ContextUsageCategory::Memory
    } else if lower.contains("rule")
        || lower.contains("policy")
        || lower.contains("context rules activated")
    {
        ContextUsageCategory::Rules
    } else {
        ContextUsageCategory::DynamicPrompt
    }
}

fn system_scope(message: &Value) -> Option<String> {
    message
        .get("content")
        .and_then(Value::as_array)
        .and_then(|blocks| blocks.first())
        .and_then(|block| block.get(ORGII_SYSTEM_CACHE_SCOPE_KEY))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn text_content(value: &Value) -> String {
    match value.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| {
                block
                    .get("text")
                    .or_else(|| block.get("content"))
                    .and_then(Value::as_str)
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn attachment_tokens(message: &Value) -> i64 {
    let content_attachment_tokens = message
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| {
                    block
                        .get("type")
                        .and_then(Value::as_str)
                        .is_some_and(|kind| kind != "text")
                })
                .map(estimate_tokens_for_json)
                .sum::<i64>()
        })
        .unwrap_or(0);

    let structured_attachment_tokens = message
        .get(STRUCTURED_SIDECAR_KEY)
        .and_then(|sidecar| sidecar.get(STRUCTURED_CONTENT_BLOCKS_KEY))
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| {
                    block
                        .get("type")
                        .and_then(Value::as_str)
                        .is_some_and(|kind| kind != "text")
                })
                .map(estimate_tokens_for_json)
                .sum::<i64>()
        })
        .unwrap_or(0);

    content_attachment_tokens + structured_attachment_tokens
}

fn estimate_tokens_for_json_array(values: &[Value]) -> i64 {
    estimate_tokens(&serde_json::to_string(values).unwrap_or_default())
}

fn estimate_tokens_for_json(value: &Value) -> i64 {
    estimate_tokens(&value.to_string())
}

fn estimate_tokens(text: &str) -> i64 {
    ((text.chars().count() as i64 + APPROX_CHARS_PER_TOKEN - 1) / APPROX_CHARS_PER_TOKEN).max(0)
}

fn percent(tokens: i64, total: i64) -> i64 {
    if total <= 0 {
        0
    } else {
        ((tokens as f64 / total as f64) * 100.0).round() as i64
    }
}

fn label_for_category(category: ContextUsageCategory) -> &'static str {
    match category {
        ContextUsageCategory::StablePrompt => "Stable prompt",
        ContextUsageCategory::DynamicPrompt => "Dynamic prompt",
        ContextUsageCategory::Rules => "Rules",
        ContextUsageCategory::Skills => "Skills",
        ContextUsageCategory::Memory => "Memory",
        ContextUsageCategory::Conversation => "Conversation",
        ContextUsageCategory::ToolResults => "Tool history",
        ContextUsageCategory::Attachments => "Attachments",
        ContextUsageCategory::Other => "Other",
        ContextUsageCategory::Unattributed => "Unattributed",
    }
}

fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn adds_unattributed_difference() {
        let messages = vec![json!({"role":"user","content":"hello"})];
        let snapshot = ContextUsageSnapshot::from_payload(&messages, &[], 100, 0, 0, None);
        assert!(snapshot
            .sections
            .iter()
            .any(|section| section.category == ContextUsageCategory::Unattributed));
        assert_eq!(
            snapshot
                .sections
                .iter()
                .map(|section| section.estimated_tokens)
                .sum::<i64>(),
            100
        );
    }

    #[test]
    fn scales_estimated_sections_down_to_provider_total() {
        let items = vec![
            ContextUsageItem {
                category: ContextUsageCategory::Conversation,
                label: "Conversation".to_string(),
                source: "messages[0]".to_string(),
                estimated_tokens: 80,
                included: true,
                cache_status: None,
                details: None,
            },
            ContextUsageItem {
                category: ContextUsageCategory::ToolResults,
                label: "Tool history".to_string(),
                source: "messages[1]".to_string(),
                estimated_tokens: 40,
                included: true,
                cache_status: None,
                details: None,
            },
        ];

        let normalized = normalize_items_to_used_tokens(items, 60);
        assert_eq!(
            normalized
                .iter()
                .map(|item| item.estimated_tokens)
                .sum::<i64>(),
            60
        );

        let sections = build_sections(normalized, 60);
        assert_eq!(
            sections
                .iter()
                .map(|section| section.estimated_tokens)
                .sum::<i64>(),
            60
        );
    }

    #[test]
    fn separates_cache_scoped_system_prompts() {
        let messages = vec![
            json!({
                "role":"system",
                "content":[{"type":"text","text":"stable", ORGII_SYSTEM_CACHE_SCOPE_KEY: "session"}]
            }),
            json!({
                "role":"system",
                "content":[{"type":"text","text":"# Scratchpad Directory", ORGII_SYSTEM_CACHE_SCOPE_KEY: "volatile"}]
            }),
        ];
        let snapshot = ContextUsageSnapshot::from_payload(&messages, &[], 0, 0, 0, None);
        assert!(snapshot
            .sections
            .iter()
            .any(|section| section.category == ContextUsageCategory::StablePrompt));
        assert!(snapshot
            .sections
            .iter()
            .any(|section| section.category == ContextUsageCategory::DynamicPrompt));
    }

    #[test]
    fn tool_messages_are_not_conversation() {
        let messages = vec![json!({"role":"tool","name":"read_file","content":"file body"})];
        let snapshot = ContextUsageSnapshot::from_payload(&messages, &[], 0, 0, 0, None);
        assert!(snapshot
            .sections
            .iter()
            .any(|section| section.category == ContextUsageCategory::ToolResults));
        assert!(!snapshot
            .sections
            .iter()
            .any(|section| section.category == ContextUsageCategory::Conversation));
    }

    #[test]
    fn cache_tokens_are_not_added_to_active_context() {
        let messages = vec![json!({"role":"user","content":"hello"})];
        let snapshot = ContextUsageSnapshot::from_payload(&messages, &[], 0, 0, 0, None);
        assert_eq!(
            snapshot
                .sections
                .iter()
                .map(|section| section.estimated_tokens)
                .sum::<i64>(),
            snapshot.sections[0].estimated_tokens
        );
    }

    #[test]
    fn fills_percent_used_from_max_tokens() {
        let messages = vec![json!({"role":"user","content":"hello"})];
        let snapshot =
            ContextUsageSnapshot::from_payload(&messages, &[], 100_000, 0, 0, Some(1_000_000));
        assert_eq!(snapshot.max_tokens, Some(1_000_000));
        assert_eq!(snapshot.percent_used, Some(10.0));
    }
}
