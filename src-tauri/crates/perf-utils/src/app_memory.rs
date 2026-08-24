//! Application memory snapshots with platform-native effective-memory metrics.
//!
//! The user-facing total deliberately excludes shell, agent CLI, and tool
//! helpers. Those processes are returned by a separate diagnostic command so
//! they can never be accidentally folded into `effective_total_bytes`.
//!
//! Schema v2 adds a resident / swapped split and a lifetime peak per process.
//! The headline `effective_memory_bytes` stays the metric the platform's own
//! task manager shows (macOS `phys_footprint`, Windows private working set,
//! Linux PSS); the split explains how much of that headline is physically
//! resident right now versus held by the memory compressor or swap.

mod diagnostics;
mod inventory;
#[cfg(target_os = "macos")]
mod macos_services;
mod ownership;
mod platform;
mod snapshot;
mod types;
#[cfg(windows)]
mod windows_impl;

use tauri::AppHandle;

pub use ownership::{begin_webview_ownership_observation, WebviewOwnershipObservation};
pub use types::{
    AppMemoryProcess, AppMemoryProcessRole, AppMemorySnapshot, AttributionStatus,
    EffectiveMeasurement, MemoryBreakdownKind, MemoryMetricKind, ToolProcessCategory,
    ToolProcessMemoryDiagnostic,
};

/// Return the single authoritative ORG2 application-memory snapshot.
#[tauri::command]
pub async fn get_app_memory_snapshot_v1(app: AppHandle) -> AppMemorySnapshot {
    match tokio::task::spawn_blocking(move || snapshot::collect_app_memory_snapshot(&app)).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            tracing::warn!(%error, "app-memory snapshot worker failed");
            AppMemorySnapshot::unavailable(inventory::now_ms(), AttributionStatus::Partial)
        }
    }
}

/// Return descendant tool-process RSS diagnostics without changing the app total.
#[tauri::command]
pub async fn get_tool_process_memory_diagnostics_v1(
    app: AppHandle,
) -> Vec<ToolProcessMemoryDiagnostic> {
    match tokio::task::spawn_blocking(move || {
        diagnostics::collect_tool_process_memory_diagnostics(&app)
    })
    .await
    {
        Ok(diagnostics) => diagnostics,
        Err(error) => {
            tracing::warn!(%error, "tool-process memory diagnostic worker failed");
            Vec::new()
        }
    }
}

#[cfg(test)]
use inventory::ProcessDescriptor;
#[cfg(target_os = "macos")]
#[cfg(test)]
use ownership::{is_trusted_macos_webkit_candidate, resolve_macos_service_ownership};
#[cfg(test)]
use platform::parse_smaps_rollup;
#[cfg(target_os = "macos")]
#[cfg(test)]
use platform::{macos_region_breakdown, macos_rusage};
#[cfg(test)]
use snapshot::aggregate_snapshot;
#[cfg(test)]
use std::collections::HashMap;

#[cfg(test)]
#[path = "app_memory/tests.rs"]
mod tests;
