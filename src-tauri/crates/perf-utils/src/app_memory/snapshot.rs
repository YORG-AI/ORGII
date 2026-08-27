//! Snapshot aggregation and authoritative app-memory collection.

use std::collections::HashMap;

use tauri::AppHandle;

use super::inventory::{collect_process_inventory, now_ms};
use super::ownership::owned_webview_processes;
use super::platform::{build_process, process_instance_key};
use super::types::{
    AppMemoryProcess, AppMemoryProcessRole, AppMemorySnapshot, AttributionStatus,
    EffectiveMeasurement, MemoryMetricKind, ProcessDescriptor, ProcessInstanceKey,
    SNAPSHOT_SCHEMA_VERSION,
};

pub(super) fn aggregate_snapshot(
    captured_at_ms: u64,
    mut processes: Vec<AppMemoryProcess>,
    attribution: AttributionStatus,
    mut skipped_ambiguous_pids: Vec<u32>,
) -> AppMemorySnapshot {
    processes.sort_by(|left, right| {
        right
            .effective_memory_bytes
            .cmp(&left.effective_memory_bytes)
            .then_with(|| left.pid.cmp(&right.pid))
    });
    processes.dedup_by_key(|process| process.pid);
    skipped_ambiguous_pids.sort_unstable();
    skipped_ambiguous_pids.dedup();

    if processes.is_empty() {
        let mut snapshot = AppMemorySnapshot::unavailable(captured_at_ms, attribution);
        snapshot.skipped_ambiguous_pids = skipped_ambiguous_pids;
        return snapshot;
    }

    let effective_total_bytes = processes.iter().fold(0_u64, |total, process| {
        total.saturating_add(process.effective_memory_bytes)
    });
    let rss_mapped_total_bytes = processes.iter().fold(0_u64, |total, process| {
        total.saturating_add(process.rss_bytes)
    });
    let resident_private_total_bytes = processes.iter().fold(0_u64, |total, process| {
        total.saturating_add(process.resident_private_bytes)
    });
    let resident_shared_total_bytes = processes.iter().fold(0_u64, |total, process| {
        total.saturating_add(process.resident_shared_bytes)
    });
    let swapped_total_bytes = processes.iter().fold(0_u64, |total, process| {
        total.saturating_add(process.swapped_bytes)
    });
    let all_rss = processes
        .iter()
        .all(|process| process.metric_kind == MemoryMetricKind::RssFallback);
    let all_compatibility = processes
        .iter()
        .all(|process| process.metric_kind == MemoryMetricKind::PrivateBytes);
    let all_native = processes.iter().all(|process| {
        matches!(
            process.metric_kind,
            MemoryMetricKind::PhysicalFootprint
                | MemoryMetricKind::PrivateWorkingSet
                | MemoryMetricKind::Pss
        )
    });
    let measurement = if all_native {
        EffectiveMeasurement::Native
    } else if all_compatibility {
        EffectiveMeasurement::Compatibility
    } else if all_rss {
        EffectiveMeasurement::RssFallback
    } else {
        EffectiveMeasurement::Mixed
    };

    AppMemorySnapshot {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        captured_at_ms,
        processes,
        effective_total_bytes,
        rss_mapped_total_bytes,
        resident_private_total_bytes,
        resident_shared_total_bytes,
        swapped_total_bytes,
        measurement,
        attribution,
        skipped_ambiguous_pids,
    }
}

pub(super) fn collect_app_memory_snapshot(app: &AppHandle) -> AppMemorySnapshot {
    #[cfg(not(windows))]
    let _ = app;

    let captured_at_ms = now_ms();
    let inventory = collect_process_inventory(true);
    if inventory.is_empty() {
        return AppMemorySnapshot::unavailable(captured_at_ms, AttributionStatus::Partial);
    }

    #[cfg(windows)]
    let (owned_helpers, mut skipped_ambiguous_pids, mut attribution) =
        owned_webview_processes(app, &inventory);
    #[cfg(not(windows))]
    let (owned_helpers, mut skipped_ambiguous_pids, mut attribution) =
        owned_webview_processes(&inventory);

    let descriptors_by_key: HashMap<ProcessInstanceKey, &ProcessDescriptor> = inventory
        .iter()
        .map(|descriptor| (process_instance_key(descriptor), descriptor))
        .collect();
    let mut processes = Vec::new();
    if let Some(backend) = inventory
        .iter()
        .find(|descriptor| descriptor.pid == std::process::id())
    {
        processes.push(build_process(backend, AppMemoryProcessRole::Backend));
    } else {
        attribution = AttributionStatus::Partial;
        skipped_ambiguous_pids.push(std::process::id());
    }
    for (key, role) in owned_helpers {
        if let Some(descriptor) = descriptors_by_key.get(&key) {
            let process = build_process(descriptor, role);
            if process.process_instance_id == key.wire_id() {
                processes.push(process);
            } else {
                // Never transfer ownership when a PID is reused between the
                // ownership scan and native memory query.
                attribution = AttributionStatus::Partial;
                skipped_ambiguous_pids.push(key.pid);
            }
        } else {
            attribution = AttributionStatus::Partial;
            skipped_ambiguous_pids.push(key.pid);
        }
    }

    aggregate_snapshot(
        captured_at_ms,
        processes,
        attribution,
        skipped_ambiguous_pids,
    )
}
