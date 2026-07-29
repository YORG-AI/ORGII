/**
 * Process Metrics API — memory, CPU, and system information.
 * Uses cached system data when called within 1 second of last call.
 */
import { invoke } from "@tauri-apps/api/core";

import type {
  LocalModelHardwareSummary,
  MemoryMetrics,
  ProcessMetrics,
  SystemInfo,
  SystemMemoryMetrics,
  SystemRuntimeSnapshot,
} from "./types";

export async function getProcessMetrics(): Promise<ProcessMetrics> {
  return invoke<ProcessMetrics>("get_process_metrics");
}

export async function getMemoryUsage(): Promise<MemoryMetrics> {
  return invoke<MemoryMetrics>("get_memory_usage");
}

export async function getSystemMemory(): Promise<SystemMemoryMetrics> {
  return invoke<SystemMemoryMetrics>("get_system_memory");
}

export async function detectLocalModelHardware(): Promise<LocalModelHardwareSummary> {
  return invoke<LocalModelHardwareSummary>("detect_local_model_hardware");
}

export async function getSystemInfo(): Promise<SystemInfo> {
  return invoke<SystemInfo>("get_system_info");
}

/** ~1–2s whole-machine CPU/mem/GPU burst sample (member-runtime sharing). */
export async function systemRuntimeSnapshot(): Promise<SystemRuntimeSnapshot> {
  return invoke<SystemRuntimeSnapshot>("system_runtime_snapshot");
}
