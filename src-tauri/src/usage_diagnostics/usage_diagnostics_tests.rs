use serde_json::json;

use super::queue::{enqueue_snapshot, mark_records_sent, read_unsent_records, DiagnosticsPaths};
use super::sanitize::{bucket_duration_ms, sanitize_snapshot};
use super::service::DiagnosticsService;
use super::types::{
    DiagnosticsLevel, DiagnosticsRuntimeSummary, DiagnosticsServiceConfig, DiagnosticsUsageSnapshot,
};

fn snapshot(level: DiagnosticsLevel) -> DiagnosticsUsageSnapshot {
    DiagnosticsUsageSnapshot {
        schema_version: 999,
        diagnostics_level: level,
        captured_at: "2026-06-14T00:00:00Z".to_string(),
        app_version: Some("1.0.1+test".to_string()),
        app_launch_count: 1,
        app_usage_duration_bucket: Some("6h_plus".to_string()),
        system_profile: Some(json!({
            "osFamily": "darwin",
            "osVersionBucket": "25.3",
            "arch": "arm64",
            "cpuCoreBucket": "9_16",
            "totalRamBucket": "16_32gb"
        })),
        app_resource_usage: Some(json!({
            "appAvgRamBucket": "1_2gb",
            "appPeakRamBucket": "2_4gb",
            "appAvgCpuBucket": "5_15pct",
            "uptimeBucket": "1h_2h"
        })),
        sessions: Some(json!({
            "total": 2,
            "completed": 1,
            "failed": 1,
            "byDispatchCategory": {
                "cli_agent": 1,
                "rust_agent": 1,
                "raw_path_should_drop": 99
            }
        })),
        workspaces: Some(json!({
            "distinctUsedInPeriod": 1,
            "totalKnown": 3,
            "path": "/Users/example/private"
        })),
        model_usage: Some(json!([
            {
                "keySource": "own_key",
                "modelType": "anthropic",
                "model": "claude-opus-4-20250514",
                "sessionCount": 1,
                "runCount": 2,
                "successCount": 1,
                "failureCount": 1,
                "rawModelJson": { "secret": true }
            }
        ])),
        top_models_by_run_count: None,
        rust_agent_top_sessions_by_duration: Some(json!([
            {
                "localDate": "2026-06-14",
                "rank": 1,
                "rustAgentType": "os",
                "agentExecMode": "build",
                "durationMs": 3600000,
                "durationBucket": "30m_1h",
                "status": "completed",
                "repoPath": "/secret/repo"
            }
        ])),
        external_tools: Some(json!([
            {
                "sourceId": "cursor",
                "sessionCount": 2,
                "durationBucket": "1h_2h",
                "repoPath": "/secret/external/repo"
            }
        ])),
        top_languages: None,
        rpc: Some(DiagnosticsRuntimeSummary {
            total: 1,
            success: 1,
            failure: 0,
            by_operation: serde_json::Map::from_iter([(
                "agent_send_message".to_string(),
                json!({
                    "total": 1,
                    "success": 1,
                    "failure": 0,
                    "durationBucket": "lt_1m",
                    "payload": "drop"
                }),
            )]),
        }),
        http: None,
    }
}

#[test]
fn buckets_match_expected_edges() {
    assert_eq!(bucket_duration_ms(-1.0), "unknown");
    assert_eq!(bucket_duration_ms(59_999.0), "lt_1m");
    assert_eq!(bucket_duration_ms(60_000.0), "1m_10m");
}

#[test]
fn performance_only_strips_usage_aggregates() {
    let sanitized = sanitize_snapshot(
        snapshot(DiagnosticsLevel::Default),
        DiagnosticsLevel::PerformanceOnly,
    );
    assert_eq!(sanitized.schema_version, 1);
    assert_eq!(sanitized.app_version.as_deref(), Some("1.0.1+test"));
    assert!(sanitized.app_usage_duration_bucket.is_some());
    assert!(sanitized.system_profile.is_some());
    assert!(sanitized.app_resource_usage.is_some());
    assert!(sanitized.rpc.is_some());
    assert!(sanitized.sessions.is_none());
    assert!(sanitized.workspaces.is_none());
    assert!(sanitized.external_tools.is_none());
    assert!(sanitized.model_usage.is_none());
    assert!(sanitized.rust_agent_top_sessions_by_duration.is_none());
}

#[test]
fn off_keeps_minimal_existence_usage_only() {
    let sanitized = sanitize_snapshot(snapshot(DiagnosticsLevel::Default), DiagnosticsLevel::Off);
    assert_eq!(sanitized.schema_version, 1);
    assert_eq!(sanitized.diagnostics_level, DiagnosticsLevel::Off);
    assert_eq!(sanitized.app_version.as_deref(), Some("1.0.1+test"));
    assert!(sanitized.app_usage_duration_bucket.is_some());
    assert!(sanitized.sessions.is_some());
    assert!(sanitized.workspaces.is_some());
    assert!(sanitized.external_tools.is_some());
    assert!(sanitized.system_profile.is_none());
    assert!(sanitized.app_resource_usage.is_none());
    assert!(sanitized.rpc.is_none());
    assert!(sanitized.http.is_none());
    assert!(sanitized.model_usage.is_none());
    assert!(sanitized.top_models_by_run_count.is_none());
    assert!(sanitized.rust_agent_top_sessions_by_duration.is_none());
    assert!(sanitized.top_languages.is_none());
}

#[test]
fn default_sanitization_drops_raw_or_path_fields() {
    let sanitized = sanitize_snapshot(
        snapshot(DiagnosticsLevel::Default),
        DiagnosticsLevel::Default,
    );
    let serialized = serde_json::to_string(&sanitized).unwrap();
    assert!(!serialized.contains("/Users/example/private"));
    assert!(!serialized.contains("/secret/repo"));
    assert!(!serialized.contains("rawModelJson"));
    assert!(!serialized.contains("raw_path_should_drop"));
    assert!(!serialized.contains("payload"));
    assert!(serialized.contains("cli_agent"));
    assert!(serialized.contains("agent_send_message"));
}

#[test]
fn queue_reads_only_unsent_and_marks_sent() {
    let dir = tempfile::tempdir().unwrap();
    let paths = DiagnosticsPaths::new(dir.path().to_path_buf());
    let first = enqueue_snapshot(&paths, snapshot(DiagnosticsLevel::PerformanceOnly)).unwrap();
    let second = enqueue_snapshot(&paths, snapshot(DiagnosticsLevel::PerformanceOnly)).unwrap();

    let unsent = read_unsent_records(&paths.queue).unwrap();
    assert_eq!(unsent.len(), 2);

    mark_records_sent(&paths.queue, &[first.id], "2026-06-14T01:00:00Z").unwrap();
    let unsent = read_unsent_records(&paths.queue).unwrap();
    assert_eq!(unsent.len(), 1);
    assert_eq!(unsent[0].id, second.id);
}

#[tokio::test]
async fn submitted_snapshot_is_queued_and_flushes_in_the_same_pass() {
    let dir = tempfile::tempdir().unwrap();
    let paths = DiagnosticsPaths::new(dir.path().to_path_buf());
    let service = DiagnosticsService::new_for_test(paths.clone());
    service
        .initialize(DiagnosticsServiceConfig {
            diagnostics_level: DiagnosticsLevel::PerformanceOnly,
            offline_mode: true,
        })
        .await
        .unwrap();

    let status = service
        .submit_usage_snapshot(snapshot(DiagnosticsLevel::PerformanceOnly))
        .await
        .unwrap();

    assert!(!status.attempted);
    assert_eq!(status.uploaded, 0);
    assert_eq!(status.queued_unsent, 1);
    assert_eq!(read_unsent_records(&paths.queue).unwrap().len(), 1);
}
