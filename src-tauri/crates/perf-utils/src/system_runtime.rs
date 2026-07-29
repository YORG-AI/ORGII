//! Whole-machine runtime snapshot for member-runtime sharing.
//!
//! Serves the `system_runtime_snapshot` Tauri command: a short burst sample
//! (~1s) of machine-wide CPU utilization, system memory, and — when NVIDIA
//! tooling is present — GPU utilization. Pushed hourly to `org2_cloud` by the
//! member-runtime scheduler, so every probe here must be cheap:
//!
//! - CPU: sysinfo needs two spaced refreshes for a meaningful reading
//!   (`MINIMUM_CPU_UPDATE_INTERVAL`), so we take [`CPU_SAMPLE_COUNT`]
//!   refreshes [`CPU_SAMPLE_INTERVAL`] apart on a dedicated `System` and
//!   average `global_cpu_usage()`. A dedicated instance (not the
//!   [`super::process_metrics`] cache) keeps the burst's sleeps from holding
//!   the shared mutex and starving the perf overlay.
//! - Memory: the cached [`super::process_metrics::get_system_memory`] read.
//! - GPU: `nvidia-smi --query-gpu=utilization.gpu` only — short timeout, any
//!   failure ⇒ `None`, absence cached for the process lifetime. On macOS
//!   always `None`: there is no cheap sudo-free utilization probe, and
//!   `system_profiler` / `powermetrics` are far too slow for an hourly tick
//!   (GPU *identity* still ships via `detect_local_model_hardware`).

use serde::Serialize;
use std::time::{Duration, Instant};
use sysinfo::System;

/// Number of spaced CPU refreshes averaged into `cpu_percent` (after one
/// extra baseline refresh that only arms the measurement).
const CPU_SAMPLE_COUNT: usize = 3;
/// Spacing between CPU refreshes. Kept above sysinfo's
/// `MINIMUM_CPU_UPDATE_INTERVAL` (200ms), below which readings are unusable.
const CPU_SAMPLE_INTERVAL: Duration = Duration::from_millis(250);
/// Hard cap on the nvidia-smi utilization probe.
#[cfg(not(target_os = "macos"))]
const NVIDIA_SMI_TIMEOUT: Duration = Duration::from_millis(1500);
/// Poll interval while waiting for nvidia-smi to exit.
#[cfg(not(target_os = "macos"))]
const NVIDIA_SMI_POLL_INTERVAL: Duration = Duration::from_millis(25);
/// Cap on the human-readable machine label (see [`machine_label`]).
pub const MACHINE_LABEL_MAX_CHARS: usize = 64;

/// Wire shape of `system_runtime_snapshot` (camelCase per the member-runtime
/// contract in `features/Org2Cloud/memberRuntime/types.ts`; `sampledAtMs` is
/// stamped client-side).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemRuntimeSnapshot {
    /// Whole-machine CPU utilization, averaged over the burst, 0–100.
    pub cpu_percent: f32,
    pub mem_used_mb: f64,
    pub mem_total_mb: f64,
    /// GPU utilization 0–100; `None` when no cheap probe exists (macOS, no
    /// NVIDIA tooling, probe failure/timeout).
    pub gpu_percent: Option<f32>,
    /// Wall-clock duration of the sampling burst.
    pub sampled_over_ms: u64,
}

/// Burst-sample whole-machine CPU / memory / GPU utilization (~1s).
#[tauri::command]
pub async fn system_runtime_snapshot() -> Result<SystemRuntimeSnapshot, String> {
    tokio::task::spawn_blocking(sample_system_runtime_blocking)
        .await
        .map_err(|err| format!("System runtime snapshot task failed: {err}"))
}

fn sample_system_runtime_blocking() -> SystemRuntimeSnapshot {
    let started = Instant::now();

    // CPU burst on a dedicated System: the first refresh only establishes the
    // per-CPU baseline; each subsequent spaced refresh yields a usage reading.
    let interval = CPU_SAMPLE_INTERVAL.max(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
    let mut system = System::new();
    system.refresh_cpu_usage();
    let mut readings: Vec<f32> = Vec::with_capacity(CPU_SAMPLE_COUNT);
    for _ in 0..CPU_SAMPLE_COUNT {
        std::thread::sleep(interval);
        system.refresh_cpu_usage();
        readings.push(system.global_cpu_usage());
    }
    let cpu_percent =
        (readings.iter().sum::<f32>() / readings.len().max(1) as f32).clamp(0.0, 100.0);

    // Reuse the cached system-memory read (1s refresh gate is fine hourly).
    let memory = super::process_metrics::get_system_memory();

    let gpu_percent = nvidia_gpu_utilization_percent();

    SystemRuntimeSnapshot {
        cpu_percent,
        mem_used_mb: memory.used_mb,
        mem_total_mb: memory.total_mb,
        gpu_percent,
        sampled_over_ms: started.elapsed().as_millis() as u64,
    }
}

/// macOS: no cheap sudo-free GPU-utilization probe. NEVER shell out to
/// `system_profiler` or `powermetrics` here — this runs on the hourly push
/// path and both are multi-second calls.
#[cfg(target_os = "macos")]
fn nvidia_gpu_utilization_percent() -> Option<f32> {
    None
}

/// NVIDIA GPU utilization via `nvidia-smi`, reusing the discovery/invocation
/// from [`super::local_model_hardware`]. Bounded by [`NVIDIA_SMI_TIMEOUT`];
/// any failure (missing binary, non-zero exit, garbage output, timeout)
/// yields `None`. A `NotFound` spawn error is cached so machines without
/// NVIDIA tooling pay the probe cost at most once per process.
#[cfg(not(target_os = "macos"))]
fn nvidia_gpu_utilization_percent() -> Option<f32> {
    use std::io::Read;
    use std::process::Stdio;
    use std::sync::atomic::{AtomicBool, Ordering};

    static NVIDIA_SMI_ABSENT: AtomicBool = AtomicBool::new(false);
    if NVIDIA_SMI_ABSENT.load(Ordering::Relaxed) {
        return None;
    }

    let mut cmd = super::local_model_hardware::nvidia_smi_command("utilization.gpu");
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            if err.kind() == std::io::ErrorKind::NotFound {
                NVIDIA_SMI_ABSENT.store(true, Ordering::Relaxed);
            }
            return None;
        }
    };

    // Output is a handful of bytes per GPU (far below the pipe buffer), so
    // polling for exit before reading stdout cannot deadlock.
    let deadline = Instant::now() + NVIDIA_SMI_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return None,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(NVIDIA_SMI_POLL_INTERVAL);
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }

    let mut stdout = String::new();
    child.stdout.take()?.read_to_string(&mut stdout).ok()?;
    parse_nvidia_utilization(&stdout)
}

/// Parse `nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits`
/// output — one numeric line per GPU — into an averaged 0–100 reading.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn parse_nvidia_utilization(stdout: &str) -> Option<f32> {
    let values: Vec<f32> = stdout
        .lines()
        .filter_map(|line| line.trim().parse::<f32>().ok())
        .collect();
    if values.is_empty() {
        return None;
    }
    Some((values.iter().sum::<f32>() / values.len() as f32).clamp(0.0, 100.0))
}

/// Human-readable machine label for the `cloud_device_identity` command: the
/// host name when available, else a "<chip> <os>" fallback built from
/// [`super::process_metrics::get_system_info`]. Trimmed and capped at
/// [`MACHINE_LABEL_MAX_CHARS`] characters.
pub fn machine_label() -> String {
    let host_name = System::host_name().unwrap_or_default();
    let trimmed = host_name.trim();
    let label = if trimmed.is_empty() {
        fallback_machine_label()
    } else {
        trimmed.to_string()
    };
    truncate_label(label)
}

fn fallback_machine_label() -> String {
    let info = super::process_metrics::get_system_info();
    format!("{} {}", info.chip_type, info.os_name)
        .trim()
        .to_string()
}

fn truncate_label(label: String) -> String {
    if label.chars().count() <= MACHINE_LABEL_MAX_CHARS {
        label
    } else {
        label.chars().take(MACHINE_LABEL_MAX_CHARS).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// e2e-lite sanity of the real burst sampler. Range assertions only, so
    /// the test holds on loaded or idle hosts alike; on macOS it never shells
    /// out, elsewhere a missing nvidia-smi fast-fails once.
    #[test]
    fn snapshot_burst_produces_sane_shape() {
        let snapshot = sample_system_runtime_blocking();

        assert!(
            (0.0..=100.0).contains(&snapshot.cpu_percent),
            "cpu out of range: {}",
            snapshot.cpu_percent
        );
        assert!(snapshot.mem_total_mb > 0.0);
        assert!(snapshot.mem_used_mb > 0.0);
        assert!(snapshot.mem_used_mb <= snapshot.mem_total_mb);
        // Three ~250ms spaced refreshes: the burst must have taken real time.
        assert!(
            snapshot.sampled_over_ms >= 700,
            "burst too fast: {}ms",
            snapshot.sampled_over_ms
        );
        if let Some(gpu) = snapshot.gpu_percent {
            assert!((0.0..=100.0).contains(&gpu), "gpu out of range: {gpu}");
        }
    }

    #[test]
    fn snapshot_serializes_camel_case() {
        let snapshot = SystemRuntimeSnapshot {
            cpu_percent: 12.5,
            mem_used_mb: 1024.0,
            mem_total_mb: 2048.0,
            gpu_percent: None,
            sampled_over_ms: 750,
        };
        let json = serde_json::to_value(&snapshot).expect("serialize snapshot");
        assert_eq!(json["cpuPercent"], 12.5);
        assert_eq!(json["memUsedMb"], 1024.0);
        assert_eq!(json["memTotalMb"], 2048.0);
        assert!(json["gpuPercent"].is_null());
        assert_eq!(json["sampledOverMs"], 750);
    }

    #[test]
    fn parses_nvidia_utilization_output() {
        assert_eq!(parse_nvidia_utilization("37\n"), Some(37.0));
        // Multi-GPU: average, clamped into 0..=100.
        assert_eq!(parse_nvidia_utilization("20\n40\n"), Some(30.0));
        assert_eq!(parse_nvidia_utilization("150\n"), Some(100.0));
        assert_eq!(parse_nvidia_utilization(""), None);
        assert_eq!(parse_nvidia_utilization("N/A\n"), None);
    }

    #[test]
    fn machine_label_is_present_trimmed_and_capped() {
        let label = machine_label();
        assert!(!label.is_empty());
        assert_eq!(label, label.trim());
        assert!(label.chars().count() <= MACHINE_LABEL_MAX_CHARS);
    }

    #[test]
    fn fallback_label_and_truncation() {
        assert!(!fallback_machine_label().is_empty());
        assert_eq!(truncate_label("  ok".to_string()), "  ok");
        let long: String = "é".repeat(MACHINE_LABEL_MAX_CHARS + 10);
        let capped = truncate_label(long);
        assert_eq!(capped.chars().count(), MACHINE_LABEL_MAX_CHARS);
    }
}
