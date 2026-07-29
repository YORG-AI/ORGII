use serde::Serialize;
use std::process::Command;
use sysinfo::{CpuRefreshKind, System};

const BACKEND_CPU: &str = "cpu";
const BACKEND_CUDA: &str = "cuda";
#[cfg(target_os = "macos")]
const BACKEND_METAL: &str = "metal";
const GPU_DETECTION_STATUS_DETECTED: &str = "detected";
const GPU_DETECTION_STATUS_NOT_AVAILABLE: &str = "not_available";
const GPU_DETECTION_STATUS_PROBE_FAILED: &str = "probe_failed";
#[cfg(not(target_os = "macos"))]
const GPU_DETECTION_STATUS_UNSUPPORTED: &str = "unsupported";
#[cfg(not(target_os = "macos"))]
const GPU_PROBE_SOURCE_NONE: &str = "none";
const GPU_PROBE_SOURCE_NVIDIA_SMI: &str = "nvidia-smi";
#[cfg(target_os = "macos")]
const GPU_PROBE_SOURCE_SYSTEM_PROFILER: &str = "system_profiler";
#[cfg(target_os = "macos")]
const MACOS_APPLE_GPU_NAME_PREFIX: &str = "Apple ";

#[derive(Debug, Clone, Serialize)]
pub struct LocalModelHardwareSummary {
    pub os_name: String,
    pub os_version: String,
    pub chip_type: String,
    pub cpu_name: String,
    pub cpu_cores: usize,
    pub total_ram_gb: f64,
    pub available_ram_gb: f64,
    pub backend: String,
    pub has_gpu: bool,
    pub gpu_name: Option<String>,
    pub gpu_vram_gb: Option<f64>,
    pub gpu_count: usize,
    pub unified_memory: bool,
    pub gpu_detection_status: String,
    pub gpu_probe_source: String,
    pub gpu_detection_message: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct GpuProbe {
    name: String,
    vram_gb: Option<f64>,
    count: usize,
    backend: &'static str,
    unified_memory: bool,
    source: &'static str,
}

#[derive(Debug, Clone, PartialEq)]
struct GpuAbsence {
    status: &'static str,
    source: &'static str,
    message: String,
}

type GpuDetection = Result<GpuProbe, GpuAbsence>;

#[tauri::command]
pub async fn detect_local_model_hardware() -> Result<LocalModelHardwareSummary, String> {
    tokio::task::spawn_blocking(detect_local_model_hardware_blocking)
        .await
        .map_err(|err| format!("Local model hardware detection task failed: {err}"))
}

fn detect_local_model_hardware_blocking() -> LocalModelHardwareSummary {
    let mut system = System::new();
    system.refresh_memory();
    system.refresh_cpu_list(CpuRefreshKind::everything());

    let (os_name, os_version) = super::process_metrics::get_os_name_version();
    let arch = System::cpu_arch();
    let chip_type = super::process_metrics::format_chip_type(&arch);
    let cpu_name = detect_cpu_name(&system, &chip_type);
    let cpu_cores = detect_cpu_cores(&system);
    let total_ram_gb = bytes_to_gb(system.total_memory());
    let available_ram_gb = bytes_to_gb(system.available_memory());
    let gpu_detection = detect_gpu(&chip_type, total_ram_gb);

    match gpu_detection {
        Ok(gpu_probe) => LocalModelHardwareSummary {
            os_name,
            os_version,
            chip_type,
            cpu_name,
            cpu_cores,
            total_ram_gb,
            available_ram_gb,
            backend: gpu_probe.backend.to_string(),
            has_gpu: true,
            gpu_name: Some(gpu_probe.name),
            gpu_vram_gb: gpu_probe.vram_gb,
            gpu_count: gpu_probe.count,
            unified_memory: gpu_probe.unified_memory,
            gpu_detection_status: GPU_DETECTION_STATUS_DETECTED.to_string(),
            gpu_probe_source: gpu_probe.source.to_string(),
            gpu_detection_message: None,
        },
        Err(absence) => LocalModelHardwareSummary {
            os_name,
            os_version,
            chip_type,
            cpu_name,
            cpu_cores,
            total_ram_gb,
            available_ram_gb,
            backend: BACKEND_CPU.to_string(),
            has_gpu: false,
            gpu_name: None,
            gpu_vram_gb: None,
            gpu_count: 0,
            unified_memory: false,
            gpu_detection_status: absence.status.to_string(),
            gpu_probe_source: absence.source.to_string(),
            gpu_detection_message: Some(absence.message),
        },
    }
}

fn detect_cpu_name(system: &System, chip_type: &str) -> String {
    system
        .cpus()
        .iter()
        .map(|cpu| cpu.brand().trim())
        .find(|brand| !brand.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| chip_type.to_string())
}

fn detect_cpu_cores(system: &System) -> usize {
    System::physical_core_count()
        .or_else(|| {
            let cpu_count = system.cpus().len();
            if cpu_count > 0 {
                Some(cpu_count)
            } else {
                None
            }
        })
        .unwrap_or(1)
}

fn bytes_to_gb(bytes: u64) -> f64 {
    bytes as f64 / 1024.0 / 1024.0 / 1024.0
}

fn detect_gpu(chip_type: &str, total_ram_gb: f64) -> GpuDetection {
    match detect_nvidia_gpu() {
        Ok(nvidia_gpu) => return Ok(nvidia_gpu),
        Err(nvidia_absence)
            if nvidia_absence.status == GPU_DETECTION_STATUS_PROBE_FAILED
                && cfg!(not(target_os = "macos")) =>
        {
            return Err(nvidia_absence);
        }
        Err(_) => {}
    }

    detect_platform_gpu(chip_type, total_ram_gb)
}

/// Build an `nvidia-smi` invocation for one `--query-gpu=` field list, with
/// the console window suppressed on Windows. Shared by the hardware-identity
/// probe below and the runtime snapshot's utilization probe
/// ([`super::system_runtime`]), so both discover the binary identically
/// (plain `PATH` lookup — spawn failure means "no NVIDIA tooling").
pub(crate) fn nvidia_smi_command(query_gpu_fields: &str) -> Command {
    let mut cmd = Command::new("nvidia-smi");
    cmd.arg(format!("--query-gpu={query_gpu_fields}"));
    cmd.arg("--format=csv,noheader,nounits");
    // Suppress console window on Windows.
    app_platform::hide_console(&mut cmd);
    cmd
}

fn detect_nvidia_gpu() -> GpuDetection {
    let mut cmd = nvidia_smi_command("name,memory.total");
    let output = cmd.output().map_err(|err| GpuAbsence {
        status: GPU_DETECTION_STATUS_NOT_AVAILABLE,
        source: GPU_PROBE_SOURCE_NVIDIA_SMI,
        message: format!("nvidia-smi is not available: {err}"),
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(GpuAbsence {
            status: GPU_DETECTION_STATUS_PROBE_FAILED,
            source: GPU_PROBE_SOURCE_NVIDIA_SMI,
            message: if stderr.is_empty() {
                format!("nvidia-smi exited with status {}", output.status)
            } else {
                format!("nvidia-smi failed: {stderr}")
            },
        });
    }

    let stdout = String::from_utf8(output.stdout).map_err(|err| GpuAbsence {
        status: GPU_DETECTION_STATUS_PROBE_FAILED,
        source: GPU_PROBE_SOURCE_NVIDIA_SMI,
        message: format!("nvidia-smi output was not UTF-8: {err}"),
    })?;

    parse_nvidia_smi_output(&stdout).ok_or_else(|| GpuAbsence {
        status: GPU_DETECTION_STATUS_NOT_AVAILABLE,
        source: GPU_PROBE_SOURCE_NVIDIA_SMI,
        message: "nvidia-smi did not report any GPUs".to_string(),
    })
}

fn parse_nvidia_smi_output(stdout: &str) -> Option<GpuProbe> {
    let mut parsed_gpus = stdout.lines().filter_map(parse_nvidia_smi_line);
    let first_gpu = parsed_gpus.next()?;
    let count = 1 + parsed_gpus.count();

    Some(GpuProbe { count, ..first_gpu })
}

fn parse_nvidia_smi_line(line: &str) -> Option<GpuProbe> {
    let (name_part, memory_part) = line.split_once(',')?;
    let name = name_part.trim();
    if name.is_empty() {
        return None;
    }

    let memory_mib = memory_part.trim().parse::<f64>().ok();
    let vram_gb = memory_mib.map(|value| value / 1024.0);

    Some(GpuProbe {
        name: name.to_string(),
        vram_gb,
        count: 1,
        backend: BACKEND_CUDA,
        unified_memory: false,
        source: GPU_PROBE_SOURCE_NVIDIA_SMI,
    })
}

#[cfg(target_os = "macos")]
fn detect_platform_gpu(chip_type: &str, total_ram_gb: f64) -> GpuDetection {
    match detect_macos_gpu(total_ram_gb) {
        Ok(profiler_gpu) => Ok(profiler_gpu),
        Err(profiler_absence) => {
            if chip_type == "Apple Silicon" {
                Ok(GpuProbe {
                    name: "Apple Silicon GPU".to_string(),
                    vram_gb: Some(total_ram_gb),
                    count: 1,
                    backend: BACKEND_METAL,
                    unified_memory: true,
                    source: GPU_PROBE_SOURCE_SYSTEM_PROFILER,
                })
            } else {
                Err(profiler_absence)
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn detect_macos_gpu(total_ram_gb: f64) -> GpuDetection {
    let output = Command::new("system_profiler")
        .args(["SPDisplaysDataType", "-detailLevel", "mini"])
        .output()
        .map_err(|err| GpuAbsence {
            status: GPU_DETECTION_STATUS_PROBE_FAILED,
            source: GPU_PROBE_SOURCE_SYSTEM_PROFILER,
            message: format!("system_profiler SPDisplaysDataType failed to start: {err}"),
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(GpuAbsence {
            status: GPU_DETECTION_STATUS_PROBE_FAILED,
            source: GPU_PROBE_SOURCE_SYSTEM_PROFILER,
            message: if stderr.is_empty() {
                format!("system_profiler exited with status {}", output.status)
            } else {
                format!("system_profiler failed: {stderr}")
            },
        });
    }

    let stdout = String::from_utf8(output.stdout).map_err(|err| GpuAbsence {
        status: GPU_DETECTION_STATUS_PROBE_FAILED,
        source: GPU_PROBE_SOURCE_SYSTEM_PROFILER,
        message: format!("system_profiler output was not UTF-8: {err}"),
    })?;

    parse_macos_displays_output(&stdout, total_ram_gb).ok_or_else(|| GpuAbsence {
        status: GPU_DETECTION_STATUS_NOT_AVAILABLE,
        source: GPU_PROBE_SOURCE_SYSTEM_PROFILER,
        message: "system_profiler did not report GPU details".to_string(),
    })
}

#[cfg(target_os = "macos")]
fn parse_macos_displays_output(stdout: &str, total_ram_gb: f64) -> Option<GpuProbe> {
    let mut gpu_names = Vec::new();
    let mut first_vram_gb = None;
    let mut unified_memory = false;

    for line in stdout.lines() {
        let trimmed = line.trim();
        if let Some(name) = trimmed.strip_prefix("Chipset Model:") {
            push_macos_gpu_name(&mut gpu_names, name);
        }

        if let Some(name) = trimmed.strip_prefix("sppci_model:") {
            push_macos_gpu_name(&mut gpu_names, name);
        }

        if let Some(name) = parse_macos_gpu_section_header(trimmed) {
            push_macos_gpu_name(&mut gpu_names, name);
        }

        if let Some(vram) = trimmed.strip_prefix("VRAM") {
            if first_vram_gb.is_none() {
                first_vram_gb = parse_macos_vram_gb(vram);
            }
        }

        if trimmed.contains("Unified Memory") || is_apple_gpu_name(trimmed) {
            unified_memory = true;
        }
    }

    let first_name = gpu_names.first()?.clone();
    Some(GpuProbe {
        name: first_name,
        vram_gb: if unified_memory && first_vram_gb.is_none() {
            Some(total_ram_gb)
        } else {
            first_vram_gb
        },
        count: gpu_names.len(),
        backend: BACKEND_METAL,
        unified_memory,
        source: GPU_PROBE_SOURCE_SYSTEM_PROFILER,
    })
}

#[cfg(target_os = "macos")]
fn parse_macos_gpu_section_header(trimmed: &str) -> Option<&str> {
    let candidate = trimmed.strip_suffix(':')?.trim();
    if is_apple_gpu_name(candidate) {
        Some(candidate)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn push_macos_gpu_name(gpu_names: &mut Vec<String>, raw_name: &str) {
    let gpu_name = raw_name.trim().trim_matches('"');
    if gpu_name.is_empty() || !is_probable_gpu_name(gpu_name) {
        return;
    }

    if !gpu_names
        .iter()
        .any(|existing_name| existing_name == gpu_name)
    {
        gpu_names.push(gpu_name.to_string());
    }
}

#[cfg(target_os = "macos")]
fn is_probable_gpu_name(name: &str) -> bool {
    is_apple_gpu_name(name)
        || name.contains("NVIDIA")
        || name.contains("AMD")
        || name.contains("Radeon")
        || name.contains("Intel")
}

#[cfg(target_os = "macos")]
fn is_apple_gpu_name(name: &str) -> bool {
    name.starts_with(MACOS_APPLE_GPU_NAME_PREFIX)
}

#[cfg(target_os = "macos")]
fn parse_macos_vram_gb(value: &str) -> Option<f64> {
    let (_, amount) = value.split_once(':')?;
    let mut parts = amount.split_whitespace();
    let numeric_value = parts.next()?.replace(',', ".").parse::<f64>().ok()?;
    let unit = parts.next()?.to_ascii_uppercase();

    if unit.starts_with("GB") {
        Some(numeric_value)
    } else if unit.starts_with("MB") {
        Some(numeric_value / 1024.0)
    } else {
        None
    }
}

#[cfg(not(target_os = "macos"))]
fn detect_platform_gpu(_chip_type: &str, _total_ram_gb: f64) -> GpuDetection {
    Err(GpuAbsence {
        status: GPU_DETECTION_STATUS_UNSUPPORTED,
        source: GPU_PROBE_SOURCE_NONE,
        message: "No non-NVIDIA GPU probe is available on this platform".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nvidia_smi_output() {
        let output = "NVIDIA GeForce RTX 4090, 24564\nNVIDIA RTX A4000, 16376\n";
        let gpu = parse_nvidia_smi_output(output).expect("expected GPU data");

        assert_eq!(gpu.name, "NVIDIA GeForce RTX 4090");
        assert_eq!(gpu.count, 2);
        assert_eq!(gpu.backend, BACKEND_CUDA);
        assert_eq!(gpu.vram_gb, Some(24564.0 / 1024.0));
        assert!(!gpu.unified_memory);
    }

    #[test]
    fn ignores_invalid_nvidia_smi_output() {
        assert!(parse_nvidia_smi_output("not enough fields").is_none());
        assert!(parse_nvidia_smi_output(", 24564").is_none());
    }

    #[test]
    fn bytes_to_gb_uses_binary_units() {
        assert_eq!(bytes_to_gb(1024 * 1024 * 1024), 1.0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_macos_displays_output() {
        let output = "Graphics/Displays:\n\n    Apple M3 Max:\n\n      Chipset Model: Apple M3 Max\n      Type: GPU\n      Bus: Built-In\n      Total Number of Cores: 40\n      Vendor: Apple (0x106b)\n      Metal Support: Metal 3\n      Displays:\n";
        let gpu = parse_macos_displays_output(output, 64.0).expect("expected macOS GPU data");

        assert_eq!(gpu.name, "Apple M3 Max");
        assert_eq!(gpu.count, 1);
        assert_eq!(gpu.backend, BACKEND_METAL);
        assert_eq!(gpu.vram_gb, Some(64.0));
        assert!(gpu.unified_memory);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_macos_section_header_without_chipset_model() {
        let output = "Graphics/Displays:\n\n    Apple M1 Pro:\n\n      Type: GPU\n      Bus: Built-In\n      Total Number of Cores: 16\n      Vendor: Apple (0x106b)\n      Metal Support: Metal 4\n";
        let gpu = parse_macos_displays_output(output, 32.0).expect("expected macOS GPU data");

        assert_eq!(gpu.name, "Apple M1 Pro");
        assert_eq!(gpu.count, 1);
        assert_eq!(gpu.vram_gb, Some(32.0));
        assert!(gpu.unified_memory);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_macos_vram_units() {
        assert_eq!(parse_macos_vram_gb(": 8 GB"), Some(8.0));
        assert_eq!(parse_macos_vram_gb(" (Total): 512 MB"), Some(0.5));
    }
}
