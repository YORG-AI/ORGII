//! WebView helper ownership and macOS creation-observation lifecycle.

use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::collections::HashSet;
#[cfg(target_os = "macos")]
use std::sync::{Mutex, OnceLock};
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
use super::inventory::collect_process_inventory;
#[cfg(not(any(target_os = "macos", windows)))]
use super::inventory::descendant_depth;
use super::platform::process_instance_key;
use super::types::{
    AppMemoryProcessRole, AttributionStatus, ProcessDescriptor, ProcessInstanceKey,
};

#[cfg(windows)]
pub(super) fn owned_webview_processes(
    app: &tauri::AppHandle,
    inventory: &[ProcessDescriptor],
) -> (
    HashMap<ProcessInstanceKey, AppMemoryProcessRole>,
    Vec<u32>,
    AttributionStatus,
) {
    super::windows_impl::owned_webview_processes(app, inventory)
}

#[cfg(target_os = "macos")]
const MACOS_OBSERVATION_WINDOW: Duration = Duration::from_secs(3);
#[cfg(target_os = "macos")]
const MACOS_EAGER_OBSERVATION_SCANS: usize = 8;
#[cfg(target_os = "macos")]
const MACOS_EAGER_OBSERVATION_INTERVAL: Duration = Duration::from_millis(250);

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
pub(super) fn is_trusted_macos_webkit_candidate(descriptor: &ProcessDescriptor) -> bool {
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
    pub fn commit(self) {
        #[cfg(target_os = "macos")]
        {
            let mut observation = self;
            if let Some(id) = observation.id.take() {
                commit_macos_observation(id);
            }
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
pub(super) fn owned_webview_processes(
    inventory: &[ProcessDescriptor],
) -> (
    HashMap<ProcessInstanceKey, AppMemoryProcessRole>,
    Vec<u32>,
    AttributionStatus,
) {
    if let Ok(service_snapshot) = super::macos_services::owned_webkit_services(std::process::id()) {
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
pub(super) fn resolve_macos_service_ownership(
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
fn webkitgtk_role(name: &str) -> Option<AppMemoryProcessRole> {
    let lower = name.to_ascii_lowercase();
    if lower.starts_with("webkitwebproc") {
        Some(AppMemoryProcessRole::Renderer)
    } else if lower.starts_with("webkitnetworkp") {
        Some(AppMemoryProcessRole::Network)
    } else if lower.starts_with("webkitgpuproc") {
        Some(AppMemoryProcessRole::Gpu)
    } else if lower.contains("webprocess") || lower.contains("webkit") {
        Some(AppMemoryProcessRole::Utility)
    } else {
        None
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
pub(super) fn owned_webview_processes(
    inventory: &[ProcessDescriptor],
) -> (
    HashMap<ProcessInstanceKey, AppMemoryProcessRole>,
    Vec<u32>,
    AttributionStatus,
) {
    let root_pid = std::process::id();
    let mut owned = HashMap::new();
    for descriptor in inventory {
        #[cfg(unix)]
        if !descriptor.belongs_to_current_user {
            continue;
        }
        if descendant_depth(descriptor.pid, root_pid, inventory).is_none() {
            continue;
        }
        if let Some(role) = webkitgtk_role(&descriptor.name) {
            owned.insert(process_instance_key(descriptor), role);
        }
    }
    (owned, Vec::new(), AttributionStatus::Complete)
}
