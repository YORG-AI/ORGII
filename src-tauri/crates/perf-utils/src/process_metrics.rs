//! Process Metrics Collection
//!
//! Provides Rust-accelerated process metrics for performance monitoring.
//! Based on Cursor IDE's performance tracking patterns.
//!
//! Tracks:
//! - Memory usage (RSS, virtual memory)
//! - CPU usage percentage
//! - Process uptime
//! - Thread count (when available)

use serde::Serialize;
use std::sync::Mutex;
use std::time::Instant;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

/// Cached system state with thread-safe access
struct SystemCache {
    system: System,
    last_process_update: Option<Instant>,
    last_memory_update: Option<Instant>,
}

impl SystemCache {
    fn new() -> Self {
        Self {
            system: System::new(),
            last_process_update: None,
            last_memory_update: None,
        }
    }

    fn should_refresh_process(&self) -> bool {
        match &self.last_process_update {
            Some(last) => last.elapsed().as_millis() >= REFRESH_INTERVAL_MS,
            None => true,
        }
    }

    fn should_refresh_memory(&self) -> bool {
        match &self.last_memory_update {
            Some(last) => last.elapsed().as_millis() >= REFRESH_INTERVAL_MS,
            None => true,
        }
    }

    fn update_process_timestamp(&mut self) {
        self.last_process_update = Some(Instant::now());
    }

    fn update_memory_timestamp(&mut self) {
        self.last_memory_update = Some(Instant::now());
    }
}

/// Thread-safe cached system instance
static SYSTEM_CACHE: std::sync::OnceLock<Mutex<SystemCache>> = std::sync::OnceLock::new();

/// Minimum interval between system refreshes (avoid excessive syscalls)
const REFRESH_INTERVAL_MS: u128 = 1000;

/// Get or initialize the system cache
fn get_cache() -> &'static Mutex<SystemCache> {
    SYSTEM_CACHE.get_or_init(|| Mutex::new(SystemCache::new()))
}

/// Process metrics snapshot
#[derive(Debug, Clone, Serialize)]
pub struct ProcessMetrics {
    /// Resident Set Size in megabytes (physical memory used)
    pub memory_rss_mb: f64,
    /// Virtual memory size in megabytes
    pub memory_virtual_mb: f64,
    /// CPU usage percentage (0-100 per core, so can exceed 100 on multi-core)
    pub cpu_percent: f32,
    /// Process start time as Unix timestamp (seconds since epoch)
    pub start_time_secs: u64,
    /// Process uptime in seconds
    pub uptime_secs: u64,
    /// Process ID
    pub pid: u32,
    /// Process name
    pub name: String,
}

impl Default for ProcessMetrics {
    fn default() -> Self {
        Self {
            memory_rss_mb: 0.0,
            memory_virtual_mb: 0.0,
            cpu_percent: 0.0,
            start_time_secs: 0,
            uptime_secs: 0,
            pid: std::process::id(),
            name: String::from("app"),
        }
    }
}

/// Get current process metrics.
///
/// Uses cached system data if called within 1 second of last call
/// to avoid excessive system calls.
///
/// # Returns
///
/// `ProcessMetrics` containing memory, CPU, and process information.
///
/// # Example
///
/// ```typescript
/// // From frontend
/// const metrics = await invoke<ProcessMetrics>("get_process_metrics");
/// console.log(`Memory: ${metrics.memory_rss_mb.toFixed(1)} MB`);
/// console.log(`CPU: ${metrics.cpu_percent.toFixed(1)}%`);
/// ```
#[tauri::command]
pub fn get_process_metrics() -> ProcessMetrics {
    let pid = Pid::from_u32(std::process::id());
    let cache = get_cache();

    // Poisoned cache mutex would silently render "0 memory, 0 cpu"
    // in the perf overlay — making the user think the app is idle
    // while it might be the very crash that poisoned the lock.
    // Warn so the cache poisoning surfaces.
    let mut guard = match cache.lock() {
        Ok(g) => g,
        Err(err) => {
            tracing::warn!(
                error = %err,
                "perf::get_process_metrics: cache mutex poisoned; metrics will be all-zero until process restart"
            );
            return ProcessMetrics::default();
        }
    };

    // Refresh process data if needed
    if guard.should_refresh_process() {
        guard.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::everything(),
        );
        guard.update_process_timestamp();
    }

    if let Some(process) = guard.system.process(pid) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let start_time = process.start_time();
        let uptime = if start_time > 0 && now > start_time {
            now - start_time
        } else {
            0
        };

        ProcessMetrics {
            memory_rss_mb: process.memory() as f64 / 1024.0 / 1024.0,
            memory_virtual_mb: process.virtual_memory() as f64 / 1024.0 / 1024.0,
            cpu_percent: process.cpu_usage(),
            start_time_secs: start_time,
            uptime_secs: uptime,
            pid: std::process::id(),
            name: process.name().to_string_lossy().to_string(),
        }
    } else {
        ProcessMetrics::default()
    }
}

/// Get memory usage only (lighter weight than full metrics).
///
/// Useful for frequent polling without CPU overhead.
#[tauri::command]
pub fn get_memory_usage() -> MemoryMetrics {
    let pid = Pid::from_u32(std::process::id());
    let cache = get_cache();

    // Poisoned mutex → all-zero memory metrics, masking a crash.
    let mut guard = match cache.lock() {
        Ok(g) => g,
        Err(err) => {
            tracing::warn!(
                error = %err,
                "perf::get_memory_usage: cache mutex poisoned; memory metrics will be all-zero until process restart"
            );
            return MemoryMetrics::default();
        }
    };

    if guard.should_refresh_process() {
        guard.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing().with_memory(),
        );
        guard.update_process_timestamp();
    }

    if let Some(process) = guard.system.process(pid) {
        MemoryMetrics {
            rss_mb: process.memory() as f64 / 1024.0 / 1024.0,
            virtual_mb: process.virtual_memory() as f64 / 1024.0 / 1024.0,
        }
    } else {
        MemoryMetrics::default()
    }
}

/// Lightweight memory-only metrics
#[derive(Debug, Clone, Serialize, Default)]
pub struct MemoryMetrics {
    /// RSS in megabytes
    pub rss_mb: f64,
    /// Virtual memory in megabytes
    pub virtual_mb: f64,
}

/// Get system-wide memory information
#[tauri::command]
pub fn get_system_memory() -> SystemMemoryMetrics {
    let cache = get_cache();

    let mut guard = match cache.lock() {
        Ok(g) => g,
        Err(err) => {
            tracing::warn!(
                error = %err,
                "perf::get_system_memory: cache mutex poisoned; system memory metrics will be all-zero until process restart"
            );
            return SystemMemoryMetrics {
                total_mb: 0.0,
                used_mb: 0.0,
                available_mb: 0.0,
                swap_total_mb: 0.0,
                swap_used_mb: 0.0,
            };
        }
    };

    if guard.should_refresh_memory() {
        guard.system.refresh_memory();
        guard.update_memory_timestamp();
    }

    SystemMemoryMetrics {
        total_mb: guard.system.total_memory() as f64 / 1024.0 / 1024.0,
        used_mb: guard.system.used_memory() as f64 / 1024.0 / 1024.0,
        available_mb: guard.system.available_memory() as f64 / 1024.0 / 1024.0,
        swap_total_mb: guard.system.total_swap() as f64 / 1024.0 / 1024.0,
        swap_used_mb: guard.system.used_swap() as f64 / 1024.0 / 1024.0,
    }
}

/// System-wide memory information
#[derive(Debug, Clone, Serialize)]
pub struct SystemMemoryMetrics {
    /// Total system RAM in megabytes
    pub total_mb: f64,
    /// Used RAM in megabytes
    pub used_mb: f64,
    /// Available RAM in megabytes
    pub available_mb: f64,
    /// Total swap in megabytes
    pub swap_total_mb: f64,
    /// Used swap in megabytes
    pub swap_used_mb: f64,
}

/// Memory breakdown by backend subsystem.
#[derive(Debug, Clone, Serialize, Default)]
pub struct MemoryBreakdown {
    /// Total backend RSS in MB.
    pub backend_rss_mb: f64,
    /// Estimated memory tracked by backend subsystems in MB.
    pub tracked_backend_mb: f64,
    /// File cache memory in MB.
    pub file_cache_mb: f64,
}

/// Global memory tracker for subsystem allocations
pub static MEMORY_TRACKER: std::sync::OnceLock<Mutex<MemoryTracker>> = std::sync::OnceLock::new();

/// Tracks memory usage from various subsystems
#[derive(Debug, Default)]
pub struct MemoryTracker {
    pub file_cache_bytes: u64,
}

impl MemoryTracker {
    /// Update file cache memory usage
    pub fn set_file_cache(&mut self, bytes: u64) {
        self.file_cache_bytes = bytes;
    }
}

/// Get the global memory tracker
pub fn get_memory_tracker() -> &'static Mutex<MemoryTracker> {
    MEMORY_TRACKER.get_or_init(|| Mutex::new(MemoryTracker::default()))
}

/// Get memory breakdown by subsystem.
///
/// Returns estimated memory usage for major app components.
/// Components must register their memory usage via the global MemoryTracker.
#[tauri::command]
pub fn get_memory_breakdown() -> MemoryBreakdown {
    let backend_rss_mb = get_process_metrics().memory_rss_mb;

    let tracker = get_memory_tracker();
    let file_cache_mb = match tracker.lock() {
        Ok(guard) => guard.file_cache_bytes as f64 / 1024.0 / 1024.0,
        Err(err) => {
            tracing::warn!(
                error = %err,
                "perf::get_memory_breakdown: tracker mutex poisoned; subsystem breakdown will all be zero until process restart"
            );
            0.0
        }
    };

    let tracked_backend_mb = file_cache_mb;

    MemoryBreakdown {
        backend_rss_mb,
        tracked_backend_mb,
        file_cache_mb,
    }
}

/// System information (OS, version, architecture)
#[derive(Debug, Clone, Serialize)]
pub struct SystemInfo {
    /// OS name (e.g. "macOS", "Windows", "Linux")
    pub os_name: String,
    /// OS version (e.g. "15.3.1")
    pub os_version: String,
    /// CPU architecture label (e.g. "Apple Silicon", "Intel x86_64")
    pub chip_type: String,
}

/// Get system information: OS name, version, and CPU architecture.
///
/// On macOS, uses `sw_vers` for the marketing version (e.g. "macOS 15.3.1")
/// instead of sysinfo which returns kernel info ("Darwin 26.3").
#[tauri::command]
pub fn get_system_info() -> SystemInfo {
    let (os_name, os_version) = get_os_name_version();
    let arch = System::cpu_arch();

    let chip_type = format_chip_type(&arch);

    SystemInfo {
        os_name,
        os_version,
        chip_type,
    }
}

pub(crate) fn format_chip_type(arch: &str) -> String {
    match arch {
        "aarch64" | "arm64" => {
            if cfg!(target_os = "macos") {
                "Apple Silicon".into()
            } else {
                "ARM64".into()
            }
        }
        "x86_64" => "x86_64".into(),
        "x86" => "x86".into(),
        other => other.to_string(),
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn get_os_name_version() -> (String, String) {
    let version = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|ver| ver.trim().to_string())
        .unwrap_or_else(|| "Unknown".into());

    ("macOS".into(), version)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn get_os_name_version() -> (String, String) {
    let os_name = System::name().unwrap_or_else(|| "Unknown".into());
    let os_version = System::os_version().unwrap_or_else(|| "Unknown".into());
    (os_name, os_version)
}
