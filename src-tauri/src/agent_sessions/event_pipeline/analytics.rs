//! Session Analytics Engine
//!
//! Computes per-session statistics from events entirely in Rust.
//! Replaces JS-side `.reduce()` calls in DevRecord views.
//!
//! ## Metrics computed
//!
//! - **Tool usage**: frequency, duration, and file impact per tool
//! - **Token estimates**: input/output tokens from event metadata
//! - **File changes**: unique files touched, by operation type
//! - **Timeline density**: events bucketed by time interval
//! - **Conversation stats**: user/assistant message counts, avg response time

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::agent_sessions::event_pipeline::types::{
    EventDisplayStatus, EventDisplayVariant, EventSource, SessionEvent,
};

// ============================================================================
// Output Types (serialized to frontend via Tauri)
// ============================================================================

/// Complete analytics for a single session's events.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAnalytics {
    /// Total number of events analyzed
    pub total_events: usize,
    /// Session duration in milliseconds (first event → last event)
    pub duration_ms: u64,
    /// Timestamp of first event (ISO string)
    pub started_at: String,
    /// Timestamp of last event (ISO string)
    pub ended_at: String,

    /// Per-tool usage breakdown
    pub tool_usage: Vec<ToolUsageEntry>,
    /// File change summary
    pub file_changes: FileChangeSummary,
    /// Conversation (user/assistant) statistics
    pub conversation_stats: ConversationStats,
    /// Token usage estimates
    pub token_stats: TokenStats,
    /// Events bucketed by time interval for sparkline/heatmap
    pub timeline_buckets: Vec<TimelineBucket>,
    /// Error/failure summary
    pub error_stats: ErrorStats,
}

/// Usage statistics for a single tool (function_name).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsageEntry {
    pub function_name: String,
    pub call_count: usize,
    pub completed_count: usize,
    pub failed_count: usize,
    /// Files uniquely touched by this tool
    pub files_touched: usize,
    /// Estimated total duration across all invocations (ms)
    pub total_duration_ms: u64,
}

/// Summary of file operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeSummary {
    /// Total unique files referenced
    pub total_files: usize,
    /// Files grouped by operation type
    pub by_operation: Vec<FileOperationEntry>,
    /// Top N most-touched files
    pub top_files: Vec<FileFrequencyEntry>,
}

/// Count of a specific file operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationEntry {
    pub operation: String,
    pub count: usize,
    pub files: usize,
}

/// A file and how many times it was referenced.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFrequencyEntry {
    pub file_path: String,
    pub touch_count: usize,
    pub operations: Vec<String>,
}

/// User/assistant conversation metrics.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationStats {
    pub user_message_count: usize,
    pub assistant_message_count: usize,
    pub thinking_event_count: usize,
    pub total_user_chars: usize,
    pub total_assistant_chars: usize,
    /// Average time between user message and first assistant response (ms)
    pub avg_response_time_ms: u64,
}

/// Token usage estimates extracted from event metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenStats {
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_tokens: u64,
    /// Per-model token breakdown
    pub by_model: Vec<ModelTokenEntry>,
}

/// Token usage for a specific model.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTokenEntry {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub call_count: usize,
}

/// Events bucketed into time intervals.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineBucket {
    /// Bucket start time (ISO string)
    pub timestamp: String,
    pub event_count: usize,
    pub tool_call_count: usize,
    pub message_count: usize,
    pub error_count: usize,
}

/// Error and failure statistics.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorStats {
    pub total_errors: usize,
    pub total_failures: usize,
    pub error_rate: f64,
    pub by_tool: Vec<ToolErrorEntry>,
}

/// Error count for a specific tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolErrorEntry {
    pub function_name: String,
    pub error_count: usize,
    pub failure_count: usize,
}

// ============================================================================
// Computation
// ============================================================================

/// Compute comprehensive analytics from a slice of session events.
///
/// Single-pass where possible, with targeted secondary passes for
/// metrics that require sorted data (timeline buckets, response times).
pub fn compute_session_analytics(events: &[SessionEvent]) -> SessionAnalytics {
    if events.is_empty() {
        return empty_analytics();
    }

    // --- Pass 1: Single linear scan collecting all raw accumulators ---
    let mut tool_map: HashMap<String, ToolAccum> = HashMap::new();
    let mut file_op_map: HashMap<String, HashMap<String, usize>> = HashMap::new();
    let mut file_freq: HashMap<String, usize> = HashMap::new();
    let mut file_ops_set: HashMap<String, Vec<String>> = HashMap::new();
    let mut model_map: HashMap<String, ModelAccum> = HashMap::new();

    let mut user_msg_count: usize = 0;
    let mut asst_msg_count: usize = 0;
    let mut thinking_count: usize = 0;
    let mut user_chars: usize = 0;
    let mut asst_chars: usize = 0;
    let mut total_input_tokens: u64 = 0;
    let mut total_output_tokens: u64 = 0;
    let mut total_errors: usize = 0;
    let mut total_failures: usize = 0;
    let mut tool_errors: HashMap<String, (usize, usize)> = HashMap::new();

    let mut min_time_ms: i64 = i64::MAX;
    let mut max_time_ms: i64 = i64::MIN;
    let mut min_time_str = String::new();
    let mut max_time_str = String::new();

    let mut user_message_times: Vec<i64> = Vec::new();
    let mut first_response_times: Vec<i64> = Vec::new();
    let mut last_user_msg_time: Option<i64> = None;

    for event in events {
        let event_ms = parse_iso_ms(&event.created_at);

        // Track time bounds
        if event_ms < min_time_ms {
            min_time_ms = event_ms;
            min_time_str = event.created_at.clone();
        }
        if event_ms > max_time_ms {
            max_time_ms = event_ms;
            max_time_str = event.created_at.clone();
        }

        // Tool usage
        if event.display_variant == EventDisplayVariant::ToolCall {
            let entry = tool_map
                .entry(event.function_name.clone())
                .or_insert_with(ToolAccum::new);
            entry.call_count += 1;
            if event.display_status == EventDisplayStatus::Completed {
                entry.completed_count += 1;
            }
            if event.display_status == EventDisplayStatus::Failed {
                entry.failed_count += 1;
            }
            if let Some(ref fp) = event.file_path {
                entry.files.insert(fp.clone());
            }
        }

        // File tracking
        if let Some(ref fp) = event.file_path {
            if !fp.is_empty() {
                *file_freq.entry(fp.clone()).or_insert(0) += 1;
                let op_name = categorize_file_operation(&event.function_name);
                file_op_map
                    .entry(op_name.clone())
                    .or_default()
                    .entry(fp.clone())
                    .and_modify(|c| *c += 1)
                    .or_insert(1);
                let ops = file_ops_set.entry(fp.clone()).or_default();
                if !ops.contains(&op_name) {
                    ops.push(op_name);
                }
            }
        }

        // Conversation stats
        match event.source {
            EventSource::User => {
                if event.display_variant == EventDisplayVariant::Message {
                    user_msg_count += 1;
                    user_chars += event.display_text.len();
                    user_message_times.push(event_ms);
                    last_user_msg_time = Some(event_ms);
                }
            }
            EventSource::Assistant => {
                if event.display_variant == EventDisplayVariant::Message {
                    asst_msg_count += 1;
                    asst_chars += event.display_text.len();
                    if let Some(user_time) = last_user_msg_time.take() {
                        first_response_times.push(event_ms - user_time);
                    }
                }
                if event.display_variant == EventDisplayVariant::Thinking {
                    thinking_count += 1;
                }
            }
            _ => {}
        }

        // Token extraction from event result/args
        let (input_tok, output_tok, model_name) = extract_token_info(event);
        total_input_tokens += input_tok;
        total_output_tokens += output_tok;
        if input_tok > 0 || output_tok > 0 {
            if let Some(ref model) = model_name {
                let m = model_map
                    .entry(model.clone())
                    .or_insert_with(|| ModelAccum {
                        input_tokens: 0,
                        output_tokens: 0,
                        call_count: 0,
                    });
                m.input_tokens += input_tok;
                m.output_tokens += output_tok;
                m.call_count += 1;
            }
        }

        // Error tracking
        if event.display_status == EventDisplayStatus::Failed {
            total_failures += 1;
            let entry = tool_errors
                .entry(event.function_name.clone())
                .or_insert((0, 0));
            entry.1 += 1;
        }
        if event.display_variant == EventDisplayVariant::Error {
            total_errors += 1;
            let entry = tool_errors
                .entry(event.function_name.clone())
                .or_insert((0, 0));
            entry.0 += 1;
        }
    }

    // --- Build output structs ---

    let duration_ms = if max_time_ms > min_time_ms {
        (max_time_ms - min_time_ms) as u64
    } else {
        0
    };

    // Tool usage
    let mut tool_usage: Vec<ToolUsageEntry> = tool_map
        .into_iter()
        .map(|(name, acc)| ToolUsageEntry {
            function_name: name,
            call_count: acc.call_count,
            completed_count: acc.completed_count,
            failed_count: acc.failed_count,
            files_touched: acc.files.len(),
            total_duration_ms: 0, // Duration requires paired start/end — not available in single events
        })
        .collect();
    tool_usage.sort_by_key(|tool| std::cmp::Reverse(tool.call_count));

    // File changes
    let mut by_operation: Vec<FileOperationEntry> = file_op_map
        .into_iter()
        .map(|(op, files)| FileOperationEntry {
            operation: op,
            count: files.values().sum(),
            files: files.len(),
        })
        .collect();
    by_operation.sort_by_key(|operation| std::cmp::Reverse(operation.count));

    let mut top_files: Vec<FileFrequencyEntry> = file_freq
        .into_iter()
        .map(|(path, count)| FileFrequencyEntry {
            operations: file_ops_set.remove(&path).unwrap_or_default(),
            file_path: path,
            touch_count: count,
        })
        .collect();
    top_files.sort_by_key(|file| std::cmp::Reverse(file.touch_count));
    let total_files = top_files.len();
    top_files.truncate(20);

    let file_changes = FileChangeSummary {
        total_files,
        by_operation,
        top_files,
    };

    // Conversation stats
    let avg_response_time_ms = if first_response_times.is_empty() {
        0
    } else {
        let sum: i64 = first_response_times.iter().sum();
        (sum / first_response_times.len() as i64).max(0) as u64
    };

    let conversation_stats = ConversationStats {
        user_message_count: user_msg_count,
        assistant_message_count: asst_msg_count,
        thinking_event_count: thinking_count,
        total_user_chars: user_chars,
        total_assistant_chars: asst_chars,
        avg_response_time_ms,
    };

    // Token stats
    let mut by_model: Vec<ModelTokenEntry> = model_map
        .into_iter()
        .map(|(model, acc)| ModelTokenEntry {
            model,
            input_tokens: acc.input_tokens,
            output_tokens: acc.output_tokens,
            call_count: acc.call_count,
        })
        .collect();
    by_model.sort_by(|a, b| {
        (b.input_tokens + b.output_tokens).cmp(&(a.input_tokens + a.output_tokens))
    });

    let token_stats = TokenStats {
        total_input_tokens,
        total_output_tokens,
        total_tokens: total_input_tokens + total_output_tokens,
        by_model,
    };

    // Timeline buckets (fixed 30 buckets)
    let timeline_buckets = compute_timeline_buckets(events, min_time_ms, max_time_ms, 30);

    // Error stats
    let total_tool_calls: usize = tool_usage.iter().map(|t| t.call_count).sum();
    let error_rate = if total_tool_calls > 0 {
        (total_errors + total_failures) as f64 / total_tool_calls as f64
    } else {
        0.0
    };

    let mut by_tool_errors: Vec<ToolErrorEntry> = tool_errors
        .into_iter()
        .filter(|(_, (errs, fails))| *errs > 0 || *fails > 0)
        .map(|(name, (errs, fails))| ToolErrorEntry {
            function_name: name,
            error_count: errs,
            failure_count: fails,
        })
        .collect();
    by_tool_errors.sort_by_key(|tool| std::cmp::Reverse(tool.error_count + tool.failure_count));

    let error_stats = ErrorStats {
        total_errors,
        total_failures,
        error_rate,
        by_tool: by_tool_errors,
    };

    SessionAnalytics {
        total_events: events.len(),
        duration_ms,
        started_at: min_time_str,
        ended_at: max_time_str,
        tool_usage,
        file_changes,
        conversation_stats,
        token_stats,
        timeline_buckets,
        error_stats,
    }
}

// ============================================================================
// Multi-Session Analytics
// ============================================================================

/// Summary for comparing multiple sessions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiSessionSummary {
    pub session_count: usize,
    /// Total events across all sessions
    pub total_events: usize,
    /// Total duration across all sessions (ms)
    pub total_duration_ms: u64,
    /// Average session duration (ms)
    pub avg_duration_ms: u64,
    /// Aggregated tool usage across sessions
    pub tool_usage: Vec<ToolUsageEntry>,
    /// Global token stats
    pub token_stats: TokenStats,
    /// Global error stats
    pub error_stats: ErrorStats,
    /// Per-session summary (lightweight)
    pub sessions: Vec<SessionSummaryEntry>,
}

/// Lightweight summary for a single session within multi-session view.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummaryEntry {
    pub session_id: String,
    pub event_count: usize,
    pub duration_ms: u64,
    pub tool_call_count: usize,
    pub message_count: usize,
    pub error_count: usize,
    pub total_tokens: u64,
    pub files_touched: usize,
    pub started_at: String,
    pub ended_at: String,
}

/// Compute aggregated analytics across multiple sessions.
///
/// Each entry in `session_events` is `(session_id, events)`.
pub fn compute_multi_session_analytics(
    session_events: &[(String, Vec<SessionEvent>)],
) -> MultiSessionSummary {
    if session_events.is_empty() {
        return MultiSessionSummary {
            session_count: 0,
            total_events: 0,
            total_duration_ms: 0,
            avg_duration_ms: 0,
            tool_usage: Vec::new(),
            token_stats: TokenStats {
                total_input_tokens: 0,
                total_output_tokens: 0,
                total_tokens: 0,
                by_model: Vec::new(),
            },
            error_stats: ErrorStats {
                total_errors: 0,
                total_failures: 0,
                error_rate: 0.0,
                by_tool: Vec::new(),
            },
            sessions: Vec::new(),
        };
    }

    let mut all_events: Vec<&SessionEvent> = Vec::new();
    let mut sessions: Vec<SessionSummaryEntry> = Vec::new();
    let mut total_duration_ms: u64 = 0;

    for (session_id, events) in session_events {
        let analytics = compute_session_analytics(events);

        let tool_call_count: usize = analytics.tool_usage.iter().map(|t| t.call_count).sum();
        let message_count = analytics.conversation_stats.user_message_count
            + analytics.conversation_stats.assistant_message_count;

        sessions.push(SessionSummaryEntry {
            session_id: session_id.clone(),
            event_count: analytics.total_events,
            duration_ms: analytics.duration_ms,
            tool_call_count,
            message_count,
            error_count: analytics.error_stats.total_errors + analytics.error_stats.total_failures,
            total_tokens: analytics.token_stats.total_tokens,
            files_touched: analytics.file_changes.total_files,
            started_at: analytics.started_at,
            ended_at: analytics.ended_at,
        });

        total_duration_ms += analytics.duration_ms;
        for event in events {
            all_events.push(event);
        }
    }

    // Compute aggregated analytics from all events
    let all_events_owned: Vec<SessionEvent> = all_events.into_iter().cloned().collect();
    let aggregated = compute_session_analytics(&all_events_owned);

    let avg_duration_ms = if sessions.is_empty() {
        0
    } else {
        total_duration_ms / sessions.len() as u64
    };

    sessions.sort_by(|a, b| b.started_at.cmp(&a.started_at));

    MultiSessionSummary {
        session_count: session_events.len(),
        total_events: aggregated.total_events,
        total_duration_ms,
        avg_duration_ms,
        tool_usage: aggregated.tool_usage,
        token_stats: aggregated.token_stats,
        error_stats: aggregated.error_stats,
        sessions,
    }
}

// ============================================================================
// Internal Accumulators
// ============================================================================

struct ToolAccum {
    call_count: usize,
    completed_count: usize,
    failed_count: usize,
    files: std::collections::HashSet<String>,
}

impl ToolAccum {
    fn new() -> Self {
        Self {
            call_count: 0,
            completed_count: 0,
            failed_count: 0,
            files: std::collections::HashSet::new(),
        }
    }
}

struct ModelAccum {
    input_tokens: u64,
    output_tokens: u64,
    call_count: usize,
}

// ============================================================================
// Helpers
// ============================================================================

fn empty_analytics() -> SessionAnalytics {
    SessionAnalytics {
        total_events: 0,
        duration_ms: 0,
        started_at: String::new(),
        ended_at: String::new(),
        tool_usage: Vec::new(),
        file_changes: FileChangeSummary {
            total_files: 0,
            by_operation: Vec::new(),
            top_files: Vec::new(),
        },
        conversation_stats: ConversationStats {
            user_message_count: 0,
            assistant_message_count: 0,
            thinking_event_count: 0,
            total_user_chars: 0,
            total_assistant_chars: 0,
            avg_response_time_ms: 0,
        },
        token_stats: TokenStats {
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_tokens: 0,
            by_model: Vec::new(),
        },
        timeline_buckets: Vec::new(),
        error_stats: ErrorStats {
            total_errors: 0,
            total_failures: 0,
            error_rate: 0.0,
            by_tool: Vec::new(),
        },
    }
}

/// Parse an ISO 8601 timestamp to epoch milliseconds.
/// Falls back to 0 on parse failure.
///
/// Handles both `2024-01-15T10:30:00.000Z` (24 chars) and
/// `2024-01-15T10:30:00Z` (20 chars, no millis).
fn parse_iso_ms(iso: &str) -> i64 {
    // Minimum valid ISO: "YYYY-MM-DDTHH:MM:SS" = 19 chars
    if iso.len() < 19 {
        return 0;
    }
    let bytes = iso.as_bytes();
    // Validate separators to avoid garbage input
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return 0;
    }
    let year = parse_digits(bytes, 0, 4) as i64;
    let month = parse_digits(bytes, 5, 7) as i64;
    let day = parse_digits(bytes, 8, 10) as i64;
    let hour = parse_digits(bytes, 11, 13) as i64;
    let minute = parse_digits(bytes, 14, 16) as i64;
    let second = parse_digits(bytes, 17, 19) as i64;
    let millis = if iso.len() >= 23 && bytes[19] == b'.' {
        parse_digits(bytes, 20, 23) as i64
    } else {
        0
    };

    let days = days_from_civil(year, month, day);
    days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000 + millis
}

/// Civil date to days since epoch (algorithm from Howard Hinnant).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let m = month as u64;
    let doy = if m > 2 {
        (153 * (m - 3) + 2) / 5 + day as u64 - 1
    } else {
        (153 * (m + 9) + 2) / 5 + day as u64 - 1
    };
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe as i64 - 719468
}

fn parse_digits(bytes: &[u8], start: usize, end: usize) -> u32 {
    let mut result: u32 = 0;
    for &b in &bytes[start..end.min(bytes.len())] {
        if b.is_ascii_digit() {
            result = result * 10 + (b - b'0') as u32;
        }
    }
    result
}

/// Categorize a function_name into a high-level file operation.
fn categorize_file_operation(function_name: &str) -> String {
    let lower = function_name.to_lowercase();
    if lower.contains("read") || lower.contains("view") || lower.contains("list") {
        "read".to_string()
    } else if lower.contains("write") || lower.contains("create") || lower.contains("new") {
        "create".to_string()
    } else if lower.contains("edit")
        || lower.contains("replace")
        || lower.contains("update")
        || lower.contains("patch")
    {
        "edit".to_string()
    } else if lower.contains("delete") || lower.contains("remove") {
        "delete".to_string()
    } else if lower.contains("search") || lower.contains("grep") || lower.contains("find") {
        "search".to_string()
    } else {
        "other".to_string()
    }
}

/// Extract token counts and model name from event metadata.
fn extract_token_info(event: &SessionEvent) -> (u64, u64, Option<String>) {
    let mut input_tokens: u64 = 0;
    let mut output_tokens: u64 = 0;
    let mut model: Option<String> = None;

    // Check result.usage (common pattern for LLM responses)
    if let Some(obj) = event.result.as_object() {
        if let Some(usage) = obj.get("usage").and_then(|v| v.as_object()) {
            input_tokens = usage
                .get("input_tokens")
                .or_else(|| usage.get("prompt_tokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            output_tokens = usage
                .get("output_tokens")
                .or_else(|| usage.get("completion_tokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
        }
        if let Some(m) = obj.get("model").and_then(|v| v.as_str()) {
            model = Some(m.to_string());
        }
    }

    // Check args.usage as fallback
    if input_tokens == 0 && output_tokens == 0 {
        if let Some(obj) = event.args.as_object() {
            if let Some(usage) = obj.get("usage").and_then(|v| v.as_object()) {
                input_tokens = usage
                    .get("input_tokens")
                    .or_else(|| usage.get("prompt_tokens"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                output_tokens = usage
                    .get("output_tokens")
                    .or_else(|| usage.get("completion_tokens"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
            }
            if model.is_none() {
                if let Some(m) = obj.get("model").and_then(|v| v.as_str()) {
                    model = Some(m.to_string());
                }
            }
        }
    }

    (input_tokens, output_tokens, model)
}

/// Bucket events into N time intervals for timeline visualization.
fn compute_timeline_buckets(
    events: &[SessionEvent],
    min_ms: i64,
    max_ms: i64,
    bucket_count: usize,
) -> Vec<TimelineBucket> {
    if events.is_empty() || max_ms <= min_ms || bucket_count == 0 {
        return Vec::new();
    }

    let range = (max_ms - min_ms) as f64;
    let bucket_width = range / bucket_count as f64;
    if bucket_width <= 0.0 {
        return Vec::new();
    }

    let mut buckets: Vec<(usize, usize, usize, usize)> = vec![(0, 0, 0, 0); bucket_count];

    for event in events {
        let event_ms = parse_iso_ms(&event.created_at);
        let idx = ((event_ms - min_ms) as f64 / bucket_width).floor() as usize;
        let idx = idx.min(bucket_count - 1);

        buckets[idx].0 += 1; // event_count
        if event.display_variant == EventDisplayVariant::ToolCall {
            buckets[idx].1 += 1;
        }
        if event.display_variant == EventDisplayVariant::Message {
            buckets[idx].2 += 1;
        }
        if event.display_status == EventDisplayStatus::Failed
            || event.display_variant == EventDisplayVariant::Error
        {
            buckets[idx].3 += 1;
        }
    }

    buckets
        .into_iter()
        .enumerate()
        .map(
            |(i, (event_count, tool_call_count, message_count, error_count))| {
                let bucket_start_ms = min_ms + (i as f64 * bucket_width) as i64;
                TimelineBucket {
                    timestamp: ms_to_iso(bucket_start_ms),
                    event_count,
                    tool_call_count,
                    message_count,
                    error_count,
                }
            },
        )
        .collect()
}

/// Convert epoch milliseconds to a simplified ISO 8601 string.
fn ms_to_iso(ms: i64) -> String {
    let total_seconds = ms / 1000;
    let millis = (ms % 1000).abs();
    let total_days = total_seconds / 86400;
    let day_seconds = (total_seconds % 86400).abs();

    let hour = day_seconds / 3600;
    let minute = (day_seconds % 3600) / 60;
    let second = day_seconds % 60;

    // Reverse civil date from days
    let (year, month, day) = civil_from_days(total_days);

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hour, minute, second, millis
    )
}

/// Days since epoch to civil date (Howard Hinnant algorithm, inverse).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

#[cfg(test)]
#[path = "tests/analytics_tests.rs"]
mod tests;
