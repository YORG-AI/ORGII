//! Platform-native process metrics and stable process-instance identity.

mod linux;
#[cfg(target_os = "macos")]
mod macos;

use super::types::{AppMemoryProcess, AppMemoryProcessRole, ProcessDescriptor, ProcessInstanceKey};

#[cfg(windows)]
pub(super) fn process_instance_key(descriptor: &ProcessDescriptor) -> ProcessInstanceKey {
    super::windows_impl::process_instance_key(descriptor)
}
#[cfg(windows)]
fn collect_effective_memory(
    descriptor: &ProcessDescriptor,
) -> super::types::EffectiveProcessMemory {
    super::windows_impl::collect_effective_memory(descriptor)
}
#[cfg(target_os = "linux")]
fn collect_effective_memory(
    descriptor: &ProcessDescriptor,
) -> super::types::EffectiveProcessMemory {
    linux::collect_effective_memory(descriptor)
}
#[cfg(target_os = "macos")]
pub(super) fn process_instance_key(descriptor: &ProcessDescriptor) -> ProcessInstanceKey {
    macos::process_instance_key(descriptor)
}
#[cfg(target_os = "macos")]
fn collect_effective_memory(
    descriptor: &ProcessDescriptor,
) -> super::types::EffectiveProcessMemory {
    macos::collect_effective_memory(descriptor)
}

#[cfg(test)]
pub(super) fn parse_smaps_rollup(text: &str) -> Option<linux::SmapsRollup> {
    linux::parse_smaps_rollup(text)
}
#[cfg(all(test, target_os = "macos"))]
pub(super) fn macos_region_breakdown(pid: u32) -> super::types::MemoryBreakdown {
    macos::macos_region_breakdown(pid)
}
#[cfg(all(test, target_os = "macos"))]
pub(super) fn macos_rusage(pid: u32) -> Option<libc::rusage_info_v4> {
    macos::macos_rusage(pid)
}

#[cfg(not(any(target_os = "macos", windows)))]
pub(super) fn process_instance_key(descriptor: &ProcessDescriptor) -> ProcessInstanceKey {
    ProcessInstanceKey {
        pid: descriptor.pid,
        birth_token: descriptor.start_time_secs,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn collect_effective_memory(
    descriptor: &ProcessDescriptor,
) -> super::types::EffectiveProcessMemory {
    super::types::EffectiveProcessMemory::rss_fallback(descriptor, descriptor.start_time_secs)
}

pub(super) fn build_process(
    descriptor: &ProcessDescriptor,
    role: AppMemoryProcessRole,
) -> AppMemoryProcess {
    let effective = collect_effective_memory(descriptor);
    AppMemoryProcess {
        pid: descriptor.pid,
        parent_pid: descriptor.parent_pid,
        process_instance_id: ProcessInstanceKey {
            pid: descriptor.pid,
            birth_token: effective.birth_token,
        }
        .wire_id(),
        name: if role == AppMemoryProcessRole::Backend {
            "ORG2 backend".to_string()
        } else {
            display_app_process_name(&descriptor.name, role)
        },
        role,
        effective_memory_bytes: effective.bytes,
        metric_kind: effective.kind,
        rss_bytes: descriptor.rss_bytes,
        resident_private_bytes: effective.breakdown.resident_private_bytes,
        resident_shared_bytes: effective.breakdown.resident_shared_bytes,
        swapped_bytes: effective.breakdown.swapped_bytes,
        breakdown_kind: effective.breakdown.kind,
        peak_effective_memory_bytes: effective.peak_bytes,
    }
}

fn display_app_process_name(name: &str, role: AppMemoryProcessRole) -> String {
    match role {
        AppMemoryProcessRole::Backend => "ORG2 backend".to_string(),
        AppMemoryProcessRole::Renderer => "WebView renderer".to_string(),
        AppMemoryProcessRole::Gpu => "WebView GPU".to_string(),
        AppMemoryProcessRole::Network => "WebView networking".to_string(),
        AppMemoryProcessRole::Browser => "WebView browser".to_string(),
        AppMemoryProcessRole::Utility => {
            if name.is_empty() {
                "WebView utility".to_string()
            } else {
                name.to_string()
            }
        }
    }
}
