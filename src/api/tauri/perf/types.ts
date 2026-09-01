/** Sample region definition (normalized 0.0-1.0) */
export interface SampleRegion {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Luminance result for a region */
interface LuminanceResult {
  name: string;
  luminance: number;
  is_light: boolean;
}

/** Full luminance analysis result */
export interface LuminanceAnalysis {
  regions: LuminanceResult[];
  processing_time_ms: number;
}

/** Binary check result */
export interface BinaryCheckResult {
  is_binary: boolean;
  reason: string;
  processing_time_us: number;
}

/** JSON parse result */
export interface JsonParseResult {
  value: unknown;
  processing_time_ms: number;
  input_size: number;
}

/** JSON stringify result */
export interface JsonStringifyResult {
  json: string;
  processing_time_ms: number;
  output_size: number;
}

/** JSON validation result */
export interface JsonValidationResult {
  valid: boolean;
  error: string | null;
  processing_time_ms: number;
}

/** Hash result */
export interface HashResult {
  hash: string;
  algorithm: string;
  input_size: number;
  processing_time_ms: number;
}

/** Process metrics snapshot */
export interface ProcessMetrics {
  memory_rss_mb: number;
  memory_virtual_mb: number;
  cpu_percent: number;
  start_time_secs: number;
  uptime_secs: number;
  pid: number;
  name: string;
}

/** Lightweight memory-only metrics */
export interface MemoryMetrics {
  rss_mb: number;
  virtual_mb: number;
}

/** System-wide memory information */
export interface SystemMemoryMetrics {
  total_mb: number;
  used_mb: number;
  available_mb: number;
  swap_total_mb: number;
  swap_used_mb: number;
}

/** Static OS/chip identity from `get_system_info` (snake_case wire). */
export interface SystemInfo {
  os_name: string;
  os_version: string;
  chip_type: string;
}

/**
 * Whole-machine burst sample from `system_runtime_snapshot` (member-runtime
 * sharing). The Rust side emits camelCase, so the invoke result IS the typed
 * shape. `gpuPercent` is null when the platform has no cheap sudo-free probe
 * (macOS) or the NVIDIA probe fails.
 */
export interface SystemRuntimeSnapshot {
  /** Whole-machine CPU utilization, 0–100 (averaged over the burst). */
  cpuPercent: number;
  memUsedMb: number;
  memTotalMb: number;
  gpuPercent: number | null;
  /** Duration of the sampling burst, ms. */
  sampledOverMs: number;
}

const GPU_DETECTION_STATUS = {
  DETECTED: "detected",
  NOT_AVAILABLE: "not_available",
  PROBE_FAILED: "probe_failed",
  UNSUPPORTED: "unsupported",
} as const;

type GpuDetectionStatus =
  (typeof GPU_DETECTION_STATUS)[keyof typeof GPU_DETECTION_STATUS];

const GPU_PROBE_SOURCE = {
  NONE: "none",
  NVIDIA_SMI: "nvidia-smi",
  SYSTEM_PROFILER: "system_profiler",
} as const;

type GpuProbeSource = (typeof GPU_PROBE_SOURCE)[keyof typeof GPU_PROBE_SOURCE];

/** Hardware summary used for local model recommendations */
export interface LocalModelHardwareSummary {
  os_name: string;
  os_version: string;
  chip_type: string;
  cpu_name: string;
  cpu_cores: number;
  total_ram_gb: number;
  available_ram_gb: number;
  backend: string;
  has_gpu: boolean;
  gpu_name: string | null;
  gpu_vram_gb: number | null;
  gpu_count: number;
  unified_memory: boolean;
  gpu_detection_status: GpuDetectionStatus;
  gpu_probe_source: GpuProbeSource;
  gpu_detection_message: string | null;
}
