use serde_json::{Map, Value};

use super::types::{
    DiagnosticsLevel, DiagnosticsRuntimeSummary, DiagnosticsUsageSnapshot,
    DIAGNOSTICS_SCHEMA_VERSION,
};

const UNKNOWN_BUCKET: &str = "unknown";
const MAX_RUNTIME_OPERATIONS: usize = 100;
const MAX_LIST_ENTRIES: usize = 25;

pub fn bucket_duration_ms(duration_ms: f64) -> &'static str {
    if !duration_ms.is_finite() || duration_ms < 0.0 {
        return UNKNOWN_BUCKET;
    }
    let minute = 60_000.0;
    let hour = 60.0 * minute;
    if duration_ms < minute {
        "lt_1m"
    } else if duration_ms < 10.0 * minute {
        "1m_10m"
    } else if duration_ms < 30.0 * minute {
        "10m_30m"
    } else if duration_ms < hour {
        "30m_1h"
    } else if duration_ms < 2.0 * hour {
        "1h_2h"
    } else if duration_ms < 6.0 * hour {
        "2h_6h"
    } else {
        "6h_plus"
    }
}

pub fn sanitize_snapshot(
    snapshot: DiagnosticsUsageSnapshot,
    configured_level: DiagnosticsLevel,
) -> DiagnosticsUsageSnapshot {
    let effective_level = configured_level;

    let mut sanitized = DiagnosticsUsageSnapshot {
        schema_version: DIAGNOSTICS_SCHEMA_VERSION,
        diagnostics_level: effective_level,
        captured_at: snapshot.captured_at,
        app_version: snapshot.app_version.and_then(sanitize_app_version),
        app_launch_count: snapshot.app_launch_count.min(10_000),
        app_usage_duration_bucket: snapshot
            .app_usage_duration_bucket
            .and_then(|bucket| sanitize_optional_bucket(bucket.as_str())),
        system_profile: None,
        app_resource_usage: None,
        sessions: None,
        workspaces: None,
        model_usage: None,
        top_models_by_run_count: None,
        rust_agent_top_sessions_by_duration: None,
        external_tools: None,
        top_languages: None,
        rpc: None,
        http: None,
    };

    if effective_level == DiagnosticsLevel::PerformanceOnly
        || effective_level == DiagnosticsLevel::Default
    {
        sanitized.system_profile = snapshot.system_profile.map(sanitize_system_profile);
        sanitized.app_resource_usage = snapshot.app_resource_usage.map(sanitize_app_resource_usage);
        sanitized.rpc = snapshot.rpc.map(sanitize_runtime_summary);
        sanitized.http = snapshot.http.map(sanitize_runtime_summary);
    }

    if effective_level == DiagnosticsLevel::Off || effective_level == DiagnosticsLevel::Default {
        sanitized.sessions = snapshot.sessions.map(sanitize_sessions);
        sanitized.workspaces = snapshot.workspaces.map(sanitize_workspaces);
        sanitized.external_tools = snapshot.external_tools.map(sanitize_external_tools);
    }

    if effective_level == DiagnosticsLevel::Default {
        sanitized.model_usage = snapshot.model_usage.map(sanitize_model_usage);
        sanitized.top_models_by_run_count = snapshot
            .top_models_by_run_count
            .map(sanitize_top_models_by_run_count);
        sanitized.rust_agent_top_sessions_by_duration = snapshot
            .rust_agent_top_sessions_by_duration
            .map(sanitize_rust_agent_top_sessions_by_duration);
        sanitized.top_languages = snapshot.top_languages.map(sanitize_top_languages);
    }

    sanitized
}

fn sanitize_runtime_summary(summary: DiagnosticsRuntimeSummary) -> DiagnosticsRuntimeSummary {
    let mut by_operation = Map::new();
    for (operation, value) in summary
        .by_operation
        .into_iter()
        .take(MAX_RUNTIME_OPERATIONS)
    {
        let mut item = Map::new();
        let total = number_field(&value, "total").unwrap_or(0.0).max(0.0) as u64;
        let failure = number_field(&value, "failure").unwrap_or(0.0).max(0.0) as u64;
        let success = number_field(&value, "success")
            .unwrap_or((total.saturating_sub(failure)) as f64)
            .max(0.0) as u64;
        item.insert("total".into(), Value::from(total));
        item.insert("success".into(), Value::from(success));
        item.insert("failure".into(), Value::from(failure));
        item.insert(
            "durationBucket".into(),
            Value::from(bucket_string_field(&value, "durationBucket")),
        );
        by_operation.insert(sanitize_operation_name(&operation), Value::Object(item));
    }

    DiagnosticsRuntimeSummary {
        total: summary.total.min(1_000_000),
        success: summary.success.min(1_000_000),
        failure: summary.failure.min(1_000_000),
        by_operation,
    }
}

fn sanitize_system_profile(value: Value) -> Value {
    let mut out = Map::new();
    out.insert(
        "osFamily".into(),
        Value::from(enum_string_field(
            &value,
            "osFamily",
            &["darwin", "windows", "linux", "unknown"],
        )),
    );
    out.insert(
        "osVersionBucket".into(),
        Value::from(short_bucket_field(&value, "osVersionBucket")),
    );
    out.insert(
        "arch".into(),
        Value::from(enum_string_field(
            &value,
            "arch",
            &["arm64", "x64", "x86", "unknown"],
        )),
    );
    if let Some(bucket) = optional_short_bucket_field(&value, "cpuCoreBucket") {
        out.insert("cpuCoreBucket".into(), Value::from(bucket));
    }
    if let Some(bucket) = optional_short_bucket_field(&value, "totalRamBucket") {
        out.insert("totalRamBucket".into(), Value::from(bucket));
    }
    Value::Object(out)
}

fn sanitize_app_resource_usage(value: Value) -> Value {
    let mut out = Map::new();
    for key in [
        "appAvgRamBucket",
        "appPeakRamBucket",
        "appAvgCpuBucket",
        "uptimeBucket",
    ] {
        if let Some(bucket) = optional_short_bucket_field(&value, key) {
            out.insert(key.into(), Value::from(bucket));
        }
    }
    Value::Object(out)
}

fn sanitize_sessions(value: Value) -> Value {
    let mut out = Map::new();
    out.insert(
        "total".into(),
        Value::from(number_field(&value, "total").unwrap_or(0.0).max(0.0) as u64),
    );
    out.insert(
        "completed".into(),
        Value::from(number_field(&value, "completed").unwrap_or(0.0).max(0.0) as u64),
    );
    out.insert(
        "failed".into(),
        Value::from(number_field(&value, "failed").unwrap_or(0.0).max(0.0) as u64),
    );
    let mut by_category = Map::new();
    if let Some(object) = value.get("byDispatchCategory").and_then(Value::as_object) {
        for key in ["cli_agent", "rust_agent", "cursor_ide", "external_history"] {
            if let Some(count) = object.get(key).and_then(Value::as_u64) {
                by_category.insert(key.into(), Value::from(count));
            }
        }
    }
    out.insert("byDispatchCategory".into(), Value::Object(by_category));
    Value::Object(out)
}

fn sanitize_workspaces(value: Value) -> Value {
    let mut out = Map::new();
    out.insert(
        "distinctUsedInPeriod".into(),
        Value::from(
            number_field(&value, "distinctUsedInPeriod")
                .unwrap_or(0.0)
                .max(0.0) as u64,
        ),
    );
    out.insert(
        "totalKnown".into(),
        Value::from(number_field(&value, "totalKnown").unwrap_or(0.0).max(0.0) as u64),
    );
    Value::Object(out)
}

fn sanitize_model_usage(value: Value) -> Value {
    let entries = value.as_array().cloned().unwrap_or_default();
    Value::Array(
        entries
            .into_iter()
            .take(MAX_LIST_ENTRIES)
            .map(|entry| {
                let mut out = Map::new();
                if let Some(key_source) =
                    optional_enum_string_field(&entry, "keySource", &["own_key", "hosted_key"])
                {
                    out.insert("keySource".into(), Value::from(key_source));
                }
                if let Some(model_type) = optional_identifier_field(&entry, "modelType") {
                    out.insert("modelType".into(), Value::from(model_type));
                }
                out.insert(
                    "model".into(),
                    Value::from(short_bucket_field(&entry, "model")),
                );
                for key in ["sessionCount", "runCount", "successCount", "failureCount"] {
                    out.insert(
                        key.into(),
                        Value::from(number_field(&entry, key).unwrap_or(0.0).max(0.0) as u64),
                    );
                }
                Value::Object(out)
            })
            .collect(),
    )
}

fn sanitize_top_models_by_run_count(value: Value) -> Value {
    let entries = value.as_array().cloned().unwrap_or_default();
    Value::Array(
        entries
            .into_iter()
            .take(MAX_LIST_ENTRIES)
            .map(|entry| {
                let mut out = Map::new();
                out.insert("rank".into(), Value::from(number_field(&entry, "rank").unwrap_or(0.0).max(0.0) as u64));
                if let Some(model_type) = optional_identifier_field(&entry, "modelType") {
                    out.insert("modelType".into(), Value::from(model_type));
                }
                out.insert("model".into(), Value::from(short_bucket_field(&entry, "model")));
                out.insert("runCount".into(), Value::from(number_field(&entry, "runCount").unwrap_or(0.0).max(0.0) as u64));
                out.insert("sessionCount".into(), Value::from(number_field(&entry, "sessionCount").unwrap_or(0.0).max(0.0) as u64));
                Value::Object(out)
            })
            .collect(),
    )
}

fn sanitize_rust_agent_top_sessions_by_duration(value: Value) -> Value {
    let entries = value.as_array().cloned().unwrap_or_default();
    Value::Array(
        entries
            .into_iter()
            .take(MAX_LIST_ENTRIES)
            .map(|entry| {
                let mut out = Map::new();
                out.insert(
                    "localDate".into(),
                    Value::from(short_bucket_field(&entry, "localDate")),
                );
                out.insert(
                    "rank".into(),
                    Value::from(number_field(&entry, "rank").unwrap_or(0.0).max(0.0) as u64),
                );
                out.insert(
                    "rustAgentType".into(),
                    Value::from(short_bucket_field(&entry, "rustAgentType")),
                );
                if let Some(mode) = optional_short_bucket_field(&entry, "agentExecMode") {
                    out.insert("agentExecMode".into(), Value::from(mode));
                }
                let duration_ms = number_field(&entry, "durationMs").unwrap_or(0.0);
                out.insert(
                    "durationBucket".into(),
                    Value::from(bucket_duration_ms(duration_ms)),
                );
                out.insert(
                    "status".into(),
                    Value::from(short_bucket_field(&entry, "status")),
                );
                Value::Object(out)
            })
            .collect(),
    )
}

fn sanitize_external_tools(value: Value) -> Value {
    let entries = value.as_array().cloned().unwrap_or_default();
    Value::Array(
        entries
            .into_iter()
            .take(MAX_LIST_ENTRIES)
            .map(|entry| {
                let mut out = Map::new();
                out.insert("sourceId".into(), Value::from(short_bucket_field(&entry, "sourceId")));
                out.insert("sessionCount".into(), Value::from(number_field(&entry, "sessionCount").unwrap_or(0.0).max(0.0) as u64));
                out.insert("durationBucket".into(), Value::from(bucket_string_field(&entry, "durationBucket")));
                Value::Object(out)
            })
            .collect(),
    )
}

fn sanitize_top_languages(value: Value) -> Value {
    let entries = value.as_array().cloned().unwrap_or_default();
    Value::Array(
        entries
            .into_iter()
            .take(MAX_LIST_ENTRIES)
            .map(|entry| {
                let mut out = Map::new();
                out.insert(
                    "rank".into(),
                    Value::from(number_field(&entry, "rank").unwrap_or(0.0).max(0.0) as u64),
                );
                out.insert(
                    "language".into(),
                    Value::from(short_bucket_field(&entry, "language")),
                );
                out.insert(
                    "workspaceCount".into(),
                    Value::from(
                        number_field(&entry, "workspaceCount")
                            .unwrap_or(0.0)
                            .max(0.0) as u64,
                    ),
                );
                out.insert(
                    "activityBucket".into(),
                    Value::from(bucket_string_field(&entry, "activityBucket")),
                );
                Value::Object(out)
            })
            .collect(),
    )
}

fn sanitize_operation_name(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | '/')
        })
        .take(120)
        .collect::<String>()
}

fn sanitize_app_version(value: String) -> Option<String> {
    let sanitized = value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | '+')
        })
        .take(80)
        .collect::<String>();
    (!sanitized.is_empty()).then_some(sanitized)
}

fn number_field(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn bucket_string_field(value: &Value, key: &str) -> String {
    optional_short_bucket_field(value, key).unwrap_or_else(|| UNKNOWN_BUCKET.to_string())
}

fn sanitize_optional_bucket(value: &str) -> Option<String> {
    let sanitized = value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
        .take(80)
        .collect::<String>();
    (!sanitized.is_empty()).then_some(sanitized)
}

fn short_bucket_field(value: &Value, key: &str) -> String {
    optional_short_bucket_field(value, key).unwrap_or_else(|| UNKNOWN_BUCKET.to_string())
}

fn optional_short_bucket_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(|raw| {
            raw.chars()
                .filter(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
                })
                .take(80)
                .collect::<String>()
        })
        .filter(|sanitized| !sanitized.is_empty())
}

fn enum_string_field(value: &Value, key: &str, allowed: &[&str]) -> String {
    optional_enum_string_field(value, key, allowed).unwrap_or_else(|| UNKNOWN_BUCKET.to_string())
}

fn optional_enum_string_field(value: &Value, key: &str, allowed: &[&str]) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|raw| allowed.contains(raw))
        .map(ToOwned::to_owned)
}

fn optional_identifier_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(|raw| {
            raw.chars()
                .filter(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
                })
                .take(80)
                .collect::<String>()
        })
        .filter(|sanitized| !sanitized.is_empty())
}
