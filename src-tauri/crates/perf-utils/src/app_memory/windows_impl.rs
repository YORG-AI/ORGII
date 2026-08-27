use super::inventory::descendant_depth;
use super::types::{
    AppMemoryProcessRole, AttributionStatus, EffectiveProcessMemory, MemoryBreakdown,
    MemoryBreakdownKind, MemoryMetricKind, ProcessDescriptor, ProcessInstanceKey,
};
use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment8, COREWEBVIEW2_PROCESS_KIND, COREWEBVIEW2_PROCESS_KIND_BROWSER,
    COREWEBVIEW2_PROCESS_KIND_GPU, COREWEBVIEW2_PROCESS_KIND_RENDERER,
    COREWEBVIEW2_PROCESS_KIND_UTILITY,
};
use windows::core::Interface;
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
use windows::Win32::System::ProcessStatus::{
    GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    PROCESS_MEMORY_COUNTERS_EX2,
};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

#[derive(Debug, Clone, Copy)]
enum WindowsMemoryCapability {
    PrivateWorkingSet,
    PrivateBytes,
}

static WINDOWS_MEMORY_CAPABILITY: OnceLock<WindowsMemoryCapability> = OnceLock::new();

struct ProcessHandle(HANDLE);

impl ProcessHandle {
    fn open(pid: u32) -> Option<Self> {
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
            .ok()
            .map(Self)
    }
}

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

fn filetime_value(value: FILETIME) -> u64 {
    (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)
}

fn process_birth_token(handle: HANDLE) -> Option<u64> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) }
        .ok()
        .map(|()| filetime_value(creation))
}

fn query_counters_ex2(handle: HANDLE) -> Option<PROCESS_MEMORY_COUNTERS_EX2> {
    let mut counters = PROCESS_MEMORY_COUNTERS_EX2 {
        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32,
        ..Default::default()
    };
    unsafe {
        GetProcessMemoryInfo(
            handle,
            (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX2).cast::<PROCESS_MEMORY_COUNTERS>(),
            counters.cb,
        )
    }
    .ok()
    .map(|()| counters)
}

fn query_counters_ex(handle: HANDLE) -> Option<PROCESS_MEMORY_COUNTERS_EX> {
    let mut counters = PROCESS_MEMORY_COUNTERS_EX {
        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
        ..Default::default()
    };
    unsafe {
        GetProcessMemoryInfo(
            handle,
            (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX).cast::<PROCESS_MEMORY_COUNTERS>(),
            counters.cb,
        )
    }
    .ok()
    .map(|()| counters)
}

/// Task Manager parity: headline = private working set; resident shared =
/// the rest of the working set; "swapped" = private commit that is not
/// currently resident (an upper bound on pages in the pagefile).
fn private_working_set_memory(
    counters: &PROCESS_MEMORY_COUNTERS_EX2,
    birth_token: u64,
) -> EffectiveProcessMemory {
    let private_working_set = counters.PrivateWorkingSetSize as u64;
    let working_set = counters.WorkingSetSize as u64;
    let private_commit = counters.PrivateUsage as u64;
    EffectiveProcessMemory {
        bytes: private_working_set,
        kind: MemoryMetricKind::PrivateWorkingSet,
        birth_token,
        breakdown: MemoryBreakdown {
            resident_private_bytes: private_working_set,
            resident_shared_bytes: working_set.saturating_sub(private_working_set),
            swapped_bytes: private_commit.saturating_sub(private_working_set),
            kind: MemoryBreakdownKind::WorkingSetCommit,
        },
        // The OS tracks peak working set and peak commit, but no peak of the
        // private working set, so no matching peak is reported.
        peak_bytes: None,
    }
}

/// Compatibility path when EX2 counters are unavailable: headline = private
/// commit. The working set is not split into private / shared here, so the
/// resident figure is capped at the commit it explains.
fn private_bytes_memory(
    counters: &PROCESS_MEMORY_COUNTERS_EX,
    birth_token: u64,
) -> EffectiveProcessMemory {
    let private_commit = counters.PrivateUsage as u64;
    let working_set = counters.WorkingSetSize as u64;
    let resident_private = working_set.min(private_commit);
    EffectiveProcessMemory {
        bytes: private_commit,
        kind: MemoryMetricKind::PrivateBytes,
        birth_token,
        breakdown: MemoryBreakdown {
            resident_private_bytes: resident_private,
            resident_shared_bytes: working_set.saturating_sub(resident_private),
            swapped_bytes: private_commit.saturating_sub(resident_private),
            kind: MemoryBreakdownKind::WorkingSetCommit,
        },
        peak_bytes: Some(counters.PeakPagefileUsage as u64),
    }
}

fn detect_capability() -> WindowsMemoryCapability {
    ProcessHandle::open(std::process::id())
        .and_then(|handle| query_counters_ex2(handle.0))
        .map(|_| WindowsMemoryCapability::PrivateWorkingSet)
        .unwrap_or(WindowsMemoryCapability::PrivateBytes)
}

pub(super) fn process_instance_key(descriptor: &ProcessDescriptor) -> ProcessInstanceKey {
    let birth_token = ProcessHandle::open(descriptor.pid)
        .and_then(|handle| process_birth_token(handle.0))
        .unwrap_or(descriptor.start_time_secs);
    ProcessInstanceKey {
        pid: descriptor.pid,
        birth_token,
    }
}

pub(super) fn collect_effective_memory(descriptor: &ProcessDescriptor) -> EffectiveProcessMemory {
    let Some(handle) = ProcessHandle::open(descriptor.pid) else {
        return EffectiveProcessMemory::rss_fallback(descriptor, descriptor.start_time_secs);
    };
    let birth_token = process_birth_token(handle.0).unwrap_or(descriptor.start_time_secs);
    match *WINDOWS_MEMORY_CAPABILITY.get_or_init(detect_capability) {
        WindowsMemoryCapability::PrivateWorkingSet => query_counters_ex2(handle.0)
            .map(|counters| private_working_set_memory(&counters, birth_token))
            .unwrap_or_else(|| EffectiveProcessMemory::rss_fallback(descriptor, birth_token)),
        WindowsMemoryCapability::PrivateBytes => query_counters_ex(handle.0)
            .map(|counters| private_bytes_memory(&counters, birth_token))
            .unwrap_or_else(|| EffectiveProcessMemory::rss_fallback(descriptor, birth_token)),
    }
}

fn role_for_kind(kind: COREWEBVIEW2_PROCESS_KIND) -> Option<AppMemoryProcessRole> {
    if kind == COREWEBVIEW2_PROCESS_KIND_BROWSER {
        Some(AppMemoryProcessRole::Browser)
    } else if kind == COREWEBVIEW2_PROCESS_KIND_RENDERER {
        Some(AppMemoryProcessRole::Renderer)
    } else if kind == COREWEBVIEW2_PROCESS_KIND_UTILITY {
        Some(AppMemoryProcessRole::Utility)
    } else if kind == COREWEBVIEW2_PROCESS_KIND_GPU {
        Some(AppMemoryProcessRole::Gpu)
    } else {
        // Sandbox helper and PPAPI processes are deliberately outside the
        // product boundary documented for the top-level App memory value.
        None
    }
}

fn query_environment_processes(
    environment: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment,
) -> windows::core::Result<Vec<(u32, AppMemoryProcessRole)>> {
    let environment8: ICoreWebView2Environment8 = environment.cast()?;
    let collection = unsafe { environment8.GetProcessInfos()? };
    let mut count = 0_u32;
    unsafe { collection.Count(&mut count)? };
    let mut result = Vec::new();
    for index in 0..count {
        let process = unsafe { collection.GetValueAtIndex(index)? };
        let mut pid = 0_i32;
        let mut kind = COREWEBVIEW2_PROCESS_KIND::default();
        unsafe {
            process.ProcessId(&mut pid)?;
            process.Kind(&mut kind)?;
        }
        if pid > 0 {
            if let Some(role) = role_for_kind(kind) {
                result.push((pid as u32, role));
            }
        }
    }
    Ok(result)
}

pub(super) fn owned_webview_processes(
    app: &AppHandle,
    inventory: &[ProcessDescriptor],
) -> (
    HashMap<ProcessInstanceKey, AppMemoryProcessRole>,
    Vec<u32>,
    AttributionStatus,
) {
    let mut rows = Vec::new();
    let mut query_failed = false;
    for webview in app.webviews().into_values() {
        let (sender, receiver) = mpsc::channel();
        if webview
            .with_webview(move |platform_webview| {
                let environment = platform_webview.environment();
                let _ = sender.send(query_environment_processes(&environment));
            })
            .is_err()
        {
            query_failed = true;
            continue;
        }
        match receiver.recv_timeout(Duration::from_secs(2)) {
            Ok(Ok(processes)) => {
                if processes.is_empty() {
                    query_failed = true;
                } else {
                    rows.extend(processes);
                }
            }
            Ok(Err(error)) => {
                query_failed = true;
                tracing::debug!(%error, "WebView2 environment process query unavailable");
            }
            Err(error) => {
                query_failed = true;
                tracing::debug!(%error, "WebView2 environment process query timed out");
            }
        }
    }

    let by_pid: HashMap<u32, &ProcessDescriptor> = inventory
        .iter()
        .map(|descriptor| (descriptor.pid, descriptor))
        .collect();
    let mut owned = HashMap::new();
    for (pid, role) in rows {
        if let Some(descriptor) = by_pid.get(&pid) {
            owned
                .entry(process_instance_key(descriptor))
                .or_insert(role);
        } else {
            // The WebView2 environment reported a live owned process that was
            // not present in the process inventory captured moments earlier.
            query_failed = true;
        }
    }

    let root_pid = std::process::id();
    let skipped: Vec<u32> = inventory
        .iter()
        .filter(|descriptor| {
            descriptor
                .name
                .to_ascii_lowercase()
                .contains("msedgewebview2")
                && descendant_depth(descriptor.pid, root_pid, inventory).is_some()
                && !owned.keys().any(|key| key.pid == descriptor.pid)
        })
        .map(|descriptor| descriptor.pid)
        .collect();
    let attribution = if query_failed || !skipped.is_empty() {
        AttributionStatus::Partial
    } else {
        AttributionStatus::Complete
    };
    (owned, skipped, attribution)
}
