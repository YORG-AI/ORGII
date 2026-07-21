//! Application memory snapshots with platform-native effective-memory metrics.
//!
//! The user-facing total deliberately excludes shell, agent CLI, and tool
//! helpers. Those processes are returned by a separate diagnostic command so
//! they can never be accidentally folded into `effective_total_bytes`.

#[cfg(target_os = "macos")]
mod macos_services;

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[cfg(target_os = "macos")]
use sysinfo::UpdateKind;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::AppHandle;
#[cfg(windows)]
use tauri::Manager;

const SNAPSHOT_SCHEMA_VERSION: u16 = 1;
const INVENTORY_CACHE_TTL: Duration = Duration::from_millis(750);

#[cfg(target_os = "macos")]
const MACOS_OBSERVATION_WINDOW: Duration = Duration::from_secs(3);
#[cfg(target_os = "macos")]
const MACOS_EAGER_OBSERVATION_SCANS: usize = 8;
#[cfg(target_os = "macos")]
const MACOS_EAGER_OBSERVATION_INTERVAL: Duration = Duration::from_millis(250);

/// The metric used as the effective-memory value for one process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryMetricKind {
    PhysicalFootprint,
    PrivateWorkingSet,
    PrivateBytes,
    RssFallback,
}

/// Summary of how the effective total was measured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectiveMeasurement {
    Native,
    Compatibility,
    Mixed,
    RssFallback,
    Unavailable,
}

/// Whether every relevant WebView helper could be safely attributed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttributionStatus {
    Complete,
    Partial,
}

/// Product role of a process included in the top-level app total.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppMemoryProcessRole {
    Backend,
    Renderer,
    Gpu,
    Network,
    Browser,
    Utility,
}

/// One process included in the ORG2 application-memory boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppMemoryProcess {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    /// Opaque, platform-native process birth token used with PID to prevent
    /// stale ownership from surviving PID reuse.
    pub process_instance_id: String,
    pub name: String,
    pub role: AppMemoryProcessRole,
    pub effective_memory_bytes: u64,
    pub metric_kind: MemoryMetricKind,
    pub rss_bytes: u64,
}

/// Atomic application-memory snapshot consumed by every frontend surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppMemorySnapshot {
    pub schema_version: u16,
    pub captured_at_ms: u64,
    pub processes: Vec<AppMemoryProcess>,
    pub effective_total_bytes: u64,
    pub rss_mapped_total_bytes: u64,
    pub measurement: EffectiveMeasurement,
    pub attribution: AttributionStatus,
    pub skipped_ambiguous_pids: Vec<u32>,
}

impl AppMemorySnapshot {
    fn unavailable(captured_at_ms: u64, attribution: AttributionStatus) -> Self {
        Self {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            captured_at_ms,
            processes: Vec::new(),
            effective_total_bytes: 0,
            rss_mapped_total_bytes: 0,
            measurement: EffectiveMeasurement::Unavailable,
            attribution,
            skipped_ambiguous_pids: Vec::new(),
        }
    }
}

/// Classification for a descendant shown only in Settings diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolProcessCategory {
    Terminal,
    AgentCli,
    McpOrTool,
}

/// RSS-only diagnostic for an owned tool process. This type is intentionally
/// separate from `AppMemoryProcess` so it cannot enter the app-memory total.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolProcessMemoryDiagnostic {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub process_instance_id: String,
    pub name: String,
    pub category: ToolProcessCategory,
    pub rss_bytes: u64,
    pub virtual_memory_bytes: u64,
    pub depth: u32,
}

#[derive(Debug, Clone)]
struct ProcessDescriptor {
    pid: u32,
    parent_pid: Option<u32>,
    start_time_secs: u64,
    name: String,
    #[cfg(target_os = "macos")]
    executable: Option<String>,
    rss_bytes: u64,
    virtual_memory_bytes: u64,
    #[cfg(target_os = "macos")]
    belongs_to_current_user: bool,
}

#[derive(Debug)]
struct ProcessInventoryCache {
    system: System,
    captured_at: Option<Instant>,
    descriptors: Vec<ProcessDescriptor>,
}

impl ProcessInventoryCache {
    fn new() -> Self {
        Self {
            system: System::new(),
            captured_at: None,
            descriptors: Vec::new(),
        }
    }

    fn snapshot(&mut self, force: bool) -> Vec<ProcessDescriptor> {
        if !force
            && self
                .captured_at
                .is_some_and(|captured_at| captured_at.elapsed() < INVENTORY_CACHE_TTL)
        {
            return self.descriptors.clone();
        }

        let refresh_kind = ProcessRefreshKind::nothing().with_memory();
        #[cfg(target_os = "macos")]
        let refresh_kind = refresh_kind
            .with_exe(UpdateKind::OnlyIfNotSet)
            .with_user(UpdateKind::OnlyIfNotSet);
        self.system
            .refresh_processes_specifics(ProcessesToUpdate::All, true, refresh_kind);

        #[cfg(target_os = "macos")]
        let current_uid = sysinfo::Uid::try_from(unsafe { libc::getuid() } as usize).ok();

        self.descriptors = self
            .system
            .processes()
            .values()
            .map(|process| ProcessDescriptor {
                pid: process.pid().as_u32(),
                parent_pid: process.parent().map(Pid::as_u32),
                start_time_secs: process.start_time(),
                name: process.name().to_string_lossy().to_string(),
                #[cfg(target_os = "macos")]
                executable: process.exe().map(|path| path.to_string_lossy().to_string()),
                rss_bytes: process.memory(),
                virtual_memory_bytes: process.virtual_memory(),
                #[cfg(target_os = "macos")]
                belongs_to_current_user: current_uid
                    .as_ref()
                    .is_some_and(|uid| process.user_id() == Some(uid)),
            })
            .collect();
        self.captured_at = Some(Instant::now());
        self.descriptors.clone()
    }
}

static PROCESS_INVENTORY: OnceLock<Mutex<ProcessInventoryCache>> = OnceLock::new();

fn collect_process_inventory(force: bool) -> Vec<ProcessDescriptor> {
    let cache = PROCESS_INVENTORY.get_or_init(|| Mutex::new(ProcessInventoryCache::new()));
    match cache.lock() {
        Ok(mut guard) => guard.snapshot(force),
        Err(error) => {
            tracing::warn!(%error, "app-memory process inventory mutex poisoned");
            Vec::new()
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct ProcessInstanceKey {
    pid: u32,
    birth_token: u64,
}

impl ProcessInstanceKey {
    fn wire_id(self) -> String {
        format!("{}:{}", self.pid, self.birth_token)
    }
}

#[derive(Debug, Clone, Copy)]
struct EffectiveProcessMemory {
    bytes: u64,
    kind: MemoryMetricKind,
    birth_token: u64,
}

#[cfg(target_os = "macos")]
fn macos_rusage(pid: u32) -> Option<libc::rusage_info_v2> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
    let result = unsafe {
        libc::proc_pid_rusage(
            pid as libc::c_int,
            libc::RUSAGE_INFO_V2,
            usage.as_mut_ptr().cast(),
        )
    };
    (result == 0).then(|| unsafe { usage.assume_init() })
}

#[cfg(target_os = "macos")]
fn process_instance_key(descriptor: &ProcessDescriptor) -> ProcessInstanceKey {
    let birth_token = macos_rusage(descriptor.pid)
        .map(|usage| usage.ri_proc_start_abstime)
        .unwrap_or(descriptor.start_time_secs);
    ProcessInstanceKey {
        pid: descriptor.pid,
        birth_token,
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn process_instance_key(descriptor: &ProcessDescriptor) -> ProcessInstanceKey {
    ProcessInstanceKey {
        pid: descriptor.pid,
        birth_token: descriptor.start_time_secs,
    }
}

#[cfg(target_os = "macos")]
fn collect_effective_memory(descriptor: &ProcessDescriptor) -> EffectiveProcessMemory {
    if let Some(usage) = macos_rusage(descriptor.pid) {
        EffectiveProcessMemory {
            bytes: usage.ri_phys_footprint,
            kind: MemoryMetricKind::PhysicalFootprint,
            birth_token: usage.ri_proc_start_abstime,
        }
    } else {
        EffectiveProcessMemory {
            bytes: descriptor.rss_bytes,
            kind: MemoryMetricKind::RssFallback,
            birth_token: descriptor.start_time_secs,
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn collect_effective_memory(descriptor: &ProcessDescriptor) -> EffectiveProcessMemory {
    EffectiveProcessMemory {
        bytes: descriptor.rss_bytes,
        kind: MemoryMetricKind::RssFallback,
        birth_token: descriptor.start_time_secs,
    }
}

fn build_process(descriptor: &ProcessDescriptor, role: AppMemoryProcessRole) -> AppMemoryProcess {
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

fn aggregate_snapshot(
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
    let all_rss = processes
        .iter()
        .all(|process| process.metric_kind == MemoryMetricKind::RssFallback);
    let all_compatibility = processes
        .iter()
        .all(|process| process.metric_kind == MemoryMetricKind::PrivateBytes);
    let all_native = processes.iter().all(|process| {
        matches!(
            process.metric_kind,
            MemoryMetricKind::PhysicalFootprint | MemoryMetricKind::PrivateWorkingSet
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
        measurement,
        attribution,
        skipped_ambiguous_pids,
    }
}

#[cfg(target_os = "macos")]
fn macos_webkit_role(descriptor: &ProcessDescriptor) -> Option<AppMemoryProcessRole> {
    let name = descriptor.name.to_ascii_lowercase();
    if name.contains("com.apple.webkit.webcontent") {
        Some(AppMemoryProcessRole::Renderer)
    } else if name.contains("com.apple.webkit.gpu") {
        Some(AppMemoryProcessRole::Gpu)
    } else if name.contains("com.apple.webkit.networking") {
        Some(AppMemoryProcessRole::Network)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn is_trusted_macos_webkit_candidate(descriptor: &ProcessDescriptor) -> bool {
    descriptor.belongs_to_current_user
        && macos_webkit_role(descriptor).is_some()
        && descriptor.executable.as_ref().is_some_and(|path| {
            let lower = path.to_ascii_lowercase();
            lower.contains("/system/library/frameworks/webkit.framework/")
                && lower.contains("/xpcservices/com.apple.webkit.")
        })
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone)]
struct MacosOwnershipObservation {
    id: u64,
    baseline: HashSet<ProcessInstanceKey>,
    baseline_has_unowned_helpers: bool,
    committed_at: Option<Instant>,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Default)]
struct MacosOwnershipRegistry {
    next_id: u64,
    observations: Vec<MacosOwnershipObservation>,
    owned: HashMap<ProcessInstanceKey, AppMemoryProcessRole>,
}

#[cfg(target_os = "macos")]
static MACOS_OWNERSHIP: OnceLock<Mutex<MacosOwnershipRegistry>> = OnceLock::new();

/// Transaction token used around every ORG2 WebView creation path.
#[derive(Debug)]
pub struct WebviewOwnershipObservation {
    #[cfg(target_os = "macos")]
    id: Option<u64>,
}

impl WebviewOwnershipObservation {
    /// Mark the WebView creation as successful and begin a short, bounded
    /// observation period for late-spawned WebKit helpers.
    pub fn commit(mut self) {
        #[cfg(target_os = "macos")]
        if let Some(id) = self.id.take() {
            commit_macos_observation(id);
        }
    }
}

impl Drop for WebviewOwnershipObservation {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        if let Some(id) = self.id.take() {
            cancel_macos_observation(id);
        }
    }
}

/// Capture a pre-creation baseline. Failed WebView builds simply drop the
/// token, so their process candidates are never attributed to ORG2.
pub fn begin_webview_ownership_observation(
    _label: impl Into<String>,
) -> WebviewOwnershipObservation {
    #[cfg(target_os = "macos")]
    {
        let inventory = collect_process_inventory(true);
        let baseline: HashSet<ProcessInstanceKey> = inventory
            .iter()
            .filter(|descriptor| is_trusted_macos_webkit_candidate(descriptor))
            .map(process_instance_key)
            .collect();
        let registry =
            MACOS_OWNERSHIP.get_or_init(|| Mutex::new(MacosOwnershipRegistry::default()));
        let id = match registry.lock() {
            Ok(mut guard) => {
                // Existing helpers that were not already attributed to ORG2
                // may belong to Safari or another app. In that state the
                // observation is deliberately ineligible to claim any newly
                // appearing helper.
                guard.owned.retain(|key, _| baseline.contains(key));
                let baseline_has_unowned_helpers =
                    baseline.iter().any(|key| !guard.owned.contains_key(key));
                guard.next_id = guard.next_id.saturating_add(1);
                let id = guard.next_id;
                guard.observations.push(MacosOwnershipObservation {
                    id,
                    baseline,
                    baseline_has_unowned_helpers,
                    committed_at: None,
                });
                Some(id)
            }
            Err(error) => {
                tracing::warn!(%error, "macOS WebKit ownership registry mutex poisoned");
                None
            }
        };
        WebviewOwnershipObservation { id }
    }

    #[cfg(not(target_os = "macos"))]
    {
        WebviewOwnershipObservation {}
    }
}

#[cfg(target_os = "macos")]
fn cancel_macos_observation(id: u64) {
    if let Some(registry) = MACOS_OWNERSHIP.get() {
        if let Ok(mut guard) = registry.lock() {
            guard
                .observations
                .retain(|observation| observation.id != id);
        }
    }
}

#[cfg(target_os = "macos")]
fn commit_macos_observation(id: u64) {
    let Some(registry) = MACOS_OWNERSHIP.get() else {
        return;
    };
    if let Ok(mut guard) = registry.lock() {
        if let Some(observation) = guard
            .observations
            .iter_mut()
            .find(|observation| observation.id == id)
        {
            observation.committed_at = Some(Instant::now());
        }
    }
    refresh_macos_ownership();
    tauri::async_runtime::spawn(async move {
        for _ in 0..MACOS_EAGER_OBSERVATION_SCANS {
            tokio::time::sleep(MACOS_EAGER_OBSERVATION_INTERVAL).await;
            refresh_macos_ownership();
        }
    });
}

#[cfg(target_os = "macos")]
fn refresh_macos_ownership() {
    let inventory = collect_process_inventory(true);
    refresh_macos_ownership_with_inventory(&inventory);
}

#[cfg(target_os = "macos")]
fn refresh_macos_ownership_with_inventory(inventory: &[ProcessDescriptor]) {
    let current: HashMap<ProcessInstanceKey, &ProcessDescriptor> = inventory
        .iter()
        .filter(|descriptor| is_trusted_macos_webkit_candidate(descriptor))
        .map(|descriptor| (process_instance_key(descriptor), descriptor))
        .collect();
    let Some(registry) = MACOS_OWNERSHIP.get() else {
        return;
    };
    let Ok(mut guard) = registry.lock() else {
        return;
    };

    guard.owned.retain(|key, _| current.contains_key(key));
    let now = Instant::now();
    let active_observations: Vec<MacosOwnershipObservation> = guard
        .observations
        .iter()
        .filter_map(|observation| {
            observation.committed_at.and_then(|committed_at| {
                (!observation.baseline_has_unowned_helpers
                    && now.duration_since(committed_at) <= MACOS_OBSERVATION_WINDOW)
                    .then(|| observation.clone())
            })
        })
        .collect();
    for (key, descriptor) in &current {
        if guard.owned.contains_key(key) {
            continue;
        }
        let matching_observations = active_observations
            .iter()
            .filter(|observation| !observation.baseline.contains(key))
            .count();
        if matching_observations == 1 {
            if let Some(role) = macos_webkit_role(descriptor) {
                guard.owned.insert(*key, role);
            }
        }
    }
    guard.observations.retain(|observation| {
        observation
            .committed_at
            .is_none_or(|committed_at| now.duration_since(committed_at) <= MACOS_OBSERVATION_WINDOW)
    });
}

#[cfg(target_os = "macos")]
fn owned_webview_processes(
    inventory: &[ProcessDescriptor],
) -> (
    HashMap<ProcessInstanceKey, AppMemoryProcessRole>,
    Vec<u32>,
    AttributionStatus,
) {
    if let Ok(service_snapshot) = macos_services::owned_webkit_services(std::process::id()) {
        return resolve_macos_service_ownership(inventory, service_snapshot.roles_by_pid);
    }

    refresh_macos_ownership_with_inventory(inventory);
    let candidates: HashMap<ProcessInstanceKey, &ProcessDescriptor> = inventory
        .iter()
        .filter(|descriptor| is_trusted_macos_webkit_candidate(descriptor))
        .map(|descriptor| (process_instance_key(descriptor), descriptor))
        .collect();
    let (owned, ownership_observation_in_flight) = MACOS_OWNERSHIP
        .get()
        .and_then(|registry| registry.lock().ok())
        .map(|guard| (guard.owned.clone(), !guard.observations.is_empty()))
        .unwrap_or_else(|| (HashMap::new(), true));
    let skipped: Vec<u32> = candidates
        .iter()
        .filter_map(|(key, descriptor)| (!owned.contains_key(key)).then_some(descriptor.pid))
        .collect();
    let attribution = if skipped.is_empty() && !ownership_observation_in_flight {
        AttributionStatus::Complete
    } else {
        AttributionStatus::Partial
    };
    (owned, skipped, attribution)
}

#[cfg(target_os = "macos")]
fn resolve_macos_service_ownership(
    inventory: &[ProcessDescriptor],
    service_roles_by_pid: HashMap<u32, AppMemoryProcessRole>,
) -> (
    HashMap<ProcessInstanceKey, AppMemoryProcessRole>,
    Vec<u32>,
    AttributionStatus,
) {
    let descriptors_by_pid: HashMap<u32, &ProcessDescriptor> = inventory
        .iter()
        .map(|descriptor| (descriptor.pid, descriptor))
        .collect();
    let mut owned = HashMap::new();
    let mut skipped = Vec::new();
    for (pid, service_role) in service_roles_by_pid {
        let Some(descriptor) = descriptors_by_pid.get(&pid) else {
            skipped.push(pid);
            continue;
        };
        if !is_trusted_macos_webkit_candidate(descriptor)
            || macos_webkit_role(descriptor) != Some(service_role)
        {
            skipped.push(pid);
            continue;
        }
        owned.insert(process_instance_key(descriptor), service_role);
    }
    let attribution = if skipped.is_empty() {
        AttributionStatus::Complete
    } else {
        AttributionStatus::Partial
    };
    (owned, skipped, attribution)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn owned_webview_processes(
    inventory: &[ProcessDescriptor],
) -> (
    HashMap<ProcessInstanceKey, AppMemoryProcessRole>,
    Vec<u32>,
    AttributionStatus,
) {
    let root_pid = std::process::id();
    let mut owned = HashMap::new();
    for descriptor in inventory {
        let lower = descriptor.name.to_ascii_lowercase();
        if descendant_depth(descriptor.pid, root_pid, inventory).is_some()
            && (lower.contains("webprocess") || lower.contains("webkit"))
        {
            owned.insert(
                process_instance_key(descriptor),
                AppMemoryProcessRole::Renderer,
            );
        }
    }
    (owned, Vec::new(), AttributionStatus::Complete)
}

#[cfg(windows)]
mod windows_impl;

#[cfg(windows)]
use windows_impl::{collect_effective_memory, owned_webview_processes, process_instance_key};

/// Return the single authoritative ORG2 application-memory snapshot.
#[tauri::command]
pub async fn get_app_memory_snapshot_v1(app: AppHandle) -> AppMemorySnapshot {
    match tokio::task::spawn_blocking(move || collect_app_memory_snapshot(&app)).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            tracing::warn!(%error, "app-memory snapshot worker failed");
            AppMemorySnapshot::unavailable(now_ms(), AttributionStatus::Partial)
        }
    }
}

fn collect_app_memory_snapshot(app: &AppHandle) -> AppMemorySnapshot {
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
                // The PID was reused between ownership enumeration and the
                // native measurement query. Never transfer ownership to the
                // new process instance.
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

fn descendant_depth(pid: u32, root_pid: u32, inventory: &[ProcessDescriptor]) -> Option<u32> {
    if pid == root_pid {
        return None;
    }
    let by_pid: HashMap<u32, &ProcessDescriptor> = inventory
        .iter()
        .map(|descriptor| (descriptor.pid, descriptor))
        .collect();
    let mut current = pid;
    let mut seen = HashSet::new();
    let mut depth = 0_u32;
    while seen.insert(current) {
        let descriptor = by_pid.get(&current)?;
        let parent = descriptor.parent_pid?;
        depth = depth.saturating_add(1);
        if parent == root_pid {
            return Some(depth);
        }
        current = parent;
    }
    None
}

fn tool_process_category(name: &str) -> ToolProcessCategory {
    let lower = name.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "zsh" | "bash" | "fish" | "sh" | "pwsh" | "powershell"
    ) || lower.contains("terminal")
    {
        ToolProcessCategory::Terminal
    } else if [
        "claude", "codex", "cursor", "qoder", "opencode", "gemini", "kiro", "trae",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        ToolProcessCategory::AgentCli
    } else {
        ToolProcessCategory::McpOrTool
    }
}

/// Return descendant tool-process RSS diagnostics without changing the app total.
#[tauri::command]
pub async fn get_tool_process_memory_diagnostics_v1(
    app: AppHandle,
) -> Vec<ToolProcessMemoryDiagnostic> {
    match tokio::task::spawn_blocking(move || collect_tool_process_memory_diagnostics(&app)).await {
        Ok(diagnostics) => diagnostics,
        Err(error) => {
            tracing::warn!(%error, "tool-process memory diagnostic worker failed");
            Vec::new()
        }
    }
}

fn collect_tool_process_memory_diagnostics(app: &AppHandle) -> Vec<ToolProcessMemoryDiagnostic> {
    let inventory = collect_process_inventory(false);
    #[cfg(windows)]
    let (owned_helpers, _, _) = owned_webview_processes(app, &inventory);
    #[cfg(not(windows))]
    let (owned_helpers, _, _) = owned_webview_processes(&inventory);
    #[cfg(not(windows))]
    let _ = app;

    let root_pid = std::process::id();
    let owned_pids: HashSet<u32> = owned_helpers.keys().map(|key| key.pid).collect();
    let mut diagnostics: Vec<ToolProcessMemoryDiagnostic> = inventory
        .iter()
        .filter_map(|descriptor| {
            let depth = descendant_depth(descriptor.pid, root_pid, &inventory)?;
            if owned_pids.contains(&descriptor.pid) {
                return None;
            }
            Some(ToolProcessMemoryDiagnostic {
                pid: descriptor.pid,
                parent_pid: descriptor.parent_pid,
                process_instance_id: process_instance_key(descriptor).wire_id(),
                name: descriptor.name.clone(),
                category: tool_process_category(&descriptor.name),
                rss_bytes: descriptor.rss_bytes,
                virtual_memory_bytes: descriptor.virtual_memory_bytes,
                depth,
            })
        })
        .collect();
    diagnostics.sort_by(|left, right| {
        right
            .rss_bytes
            .cmp(&left.rss_bytes)
            .then_with(|| left.pid.cmp(&right.pid))
    });
    diagnostics
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(pid: u32, bytes: u64, kind: MemoryMetricKind) -> AppMemoryProcess {
        AppMemoryProcess {
            pid,
            parent_pid: Some(1),
            process_instance_id: format!("{pid}:{pid}"),
            name: format!("process-{pid}"),
            role: if pid == 1 {
                AppMemoryProcessRole::Backend
            } else {
                AppMemoryProcessRole::Renderer
            },
            effective_memory_bytes: bytes,
            metric_kind: kind,
            rss_bytes: bytes.saturating_add(10),
        }
    }

    #[test]
    fn aggregate_native_snapshot() {
        let snapshot = aggregate_snapshot(
            10,
            vec![
                process(1, 100, MemoryMetricKind::PhysicalFootprint),
                process(2, 50, MemoryMetricKind::PhysicalFootprint),
            ],
            AttributionStatus::Complete,
            Vec::new(),
        );
        assert_eq!(snapshot.measurement, EffectiveMeasurement::Native);
        assert_eq!(snapshot.effective_total_bytes, 150);
        assert_eq!(snapshot.rss_mapped_total_bytes, 170);
    }

    #[test]
    fn aggregate_compatibility_snapshot() {
        let snapshot = aggregate_snapshot(
            10,
            vec![process(1, 100, MemoryMetricKind::PrivateBytes)],
            AttributionStatus::Complete,
            Vec::new(),
        );
        assert_eq!(snapshot.measurement, EffectiveMeasurement::Compatibility);
    }

    #[test]
    fn aggregate_mixed_snapshot() {
        let snapshot = aggregate_snapshot(
            10,
            vec![
                process(1, 100, MemoryMetricKind::PhysicalFootprint),
                process(2, 50, MemoryMetricKind::RssFallback),
            ],
            AttributionStatus::Partial,
            vec![9, 9, 8],
        );
        assert_eq!(snapshot.measurement, EffectiveMeasurement::Mixed);
        assert_eq!(snapshot.attribution, AttributionStatus::Partial);
        assert_eq!(snapshot.skipped_ambiguous_pids, vec![8, 9]);
    }

    #[test]
    fn aggregate_rss_fallback_snapshot() {
        let snapshot = aggregate_snapshot(
            10,
            vec![
                process(1, 100, MemoryMetricKind::RssFallback),
                process(2, 50, MemoryMetricKind::RssFallback),
            ],
            AttributionStatus::Complete,
            Vec::new(),
        );
        assert_eq!(snapshot.measurement, EffectiveMeasurement::RssFallback);
    }

    #[test]
    fn aggregate_empty_snapshot_is_unavailable() {
        let snapshot = aggregate_snapshot(10, Vec::new(), AttributionStatus::Partial, vec![7]);
        assert_eq!(snapshot.measurement, EffectiveMeasurement::Unavailable);
        assert_eq!(snapshot.skipped_ambiguous_pids, vec![7]);
    }

    #[test]
    fn aggregate_deduplicates_pid_and_saturates_totals() {
        let snapshot = aggregate_snapshot(
            10,
            vec![
                process(1, u64::MAX, MemoryMetricKind::RssFallback),
                process(1, 99, MemoryMetricKind::RssFallback),
                process(2, 1, MemoryMetricKind::RssFallback),
            ],
            AttributionStatus::Complete,
            Vec::new(),
        );
        assert_eq!(snapshot.processes.len(), 2);
        assert_eq!(snapshot.effective_total_bytes, u64::MAX);
    }

    #[test]
    fn wire_contract_uses_explicit_snake_case_fields() {
        let snapshot = aggregate_snapshot(
            42,
            vec![process(1, 100, MemoryMetricKind::PhysicalFootprint)],
            AttributionStatus::Partial,
            vec![22],
        );
        let value = serde_json::to_value(snapshot).expect("snapshot serializes");
        assert_eq!(value["schema_version"], 1);
        assert_eq!(value["measurement"], "native");
        assert_eq!(value["attribution"], "partial");
        assert_eq!(value["processes"][0]["metric_kind"], "physical_footprint");
        assert!(value["processes"][0].get("memory_mb").is_none());
    }

    #[cfg(target_os = "macos")]
    fn macos_webkit_descriptor(pid: u32, name: &str) -> ProcessDescriptor {
        ProcessDescriptor {
            pid,
            parent_pid: Some(1),
            start_time_secs: u64::from(pid),
            name: name.to_string(),
            executable: Some(format!(
                "/System/Library/Frameworks/WebKit.framework/XPCServices/{name}.xpc/Contents/MacOS/{name}"
            )),
            rss_bytes: 1,
            virtual_memory_bytes: 1,
            belongs_to_current_user: true,
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_webkit_candidate_requires_current_user_and_system_xpc_path() {
        let trusted = macos_webkit_descriptor(4_000_001, "com.apple.WebKit.WebContent");
        assert!(is_trusted_macos_webkit_candidate(&trusted));

        let mut wrong_executable = trusted.clone();
        wrong_executable.executable = Some("/Applications/Safari.app/WebContent".to_string());
        assert!(!is_trusted_macos_webkit_candidate(&wrong_executable));

        let mut wrong_user = trusted;
        wrong_user.belongs_to_current_user = false;
        assert!(!is_trusted_macos_webkit_candidate(&wrong_user));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_service_ownership_excludes_unlisted_webkit_processes() {
        let owned_renderer = macos_webkit_descriptor(4_000_001, "com.apple.WebKit.WebContent");
        let other_app_renderer = macos_webkit_descriptor(4_000_002, "com.apple.WebKit.WebContent");
        let inventory = vec![owned_renderer, other_app_renderer];
        let service_roles = HashMap::from([(4_000_001, AppMemoryProcessRole::Renderer)]);

        let (owned, skipped, attribution) =
            resolve_macos_service_ownership(&inventory, service_roles);

        assert_eq!(owned.len(), 1);
        assert!(owned.keys().any(|key| key.pid == 4_000_001));
        assert!(!owned.keys().any(|key| key.pid == 4_000_002));
        assert!(skipped.is_empty());
        assert_eq!(attribution, AttributionStatus::Complete);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_service_ownership_rejects_role_mismatch() {
        let inventory = vec![macos_webkit_descriptor(
            4_000_001,
            "com.apple.WebKit.WebContent",
        )];
        let service_roles = HashMap::from([(4_000_001, AppMemoryProcessRole::Gpu)]);

        let (owned, skipped, attribution) =
            resolve_macos_service_ownership(&inventory, service_roles);

        assert!(owned.is_empty());
        assert_eq!(skipped, vec![4_000_001]);
        assert_eq!(attribution, AttributionStatus::Partial);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_current_process_has_physical_footprint() {
        let usage = macos_rusage(std::process::id()).expect("current process rusage");
        assert!(usage.ri_phys_footprint > 0);
        assert!(usage.ri_proc_start_abstime > 0);
    }
}
