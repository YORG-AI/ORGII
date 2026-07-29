/**
 * Payload collectors for the member-runtime push: the static `machine`
 * identity (cached for the whole app run — hardware never re-probed per
 * tick) and the per-tick burst `sample`, plus the installed-agent probe
 * mapping. Network-free; everything here talks to local Tauri commands.
 */
import { getVersion } from "@tauri-apps/api/app";

import { cloudDeviceIdentity } from "@src/api/tauri/cloudDevice";
import type { ExternalCliSourceProbe } from "@src/api/tauri/externalHistory/detection";
import {
  detectLocalModelHardware,
  getSystemInfo,
  systemRuntimeSnapshot,
} from "@src/api/tauri/perf/metrics";
import type {
  LocalModelHardwareSummary,
  SystemInfo,
} from "@src/api/tauri/perf/types";

import type {
  MemberInstalledAgent,
  MemberRuntimeMachine,
  MemberRuntimeSample,
} from "./types";

async function composeMemberRuntimeMachine(): Promise<MemberRuntimeMachine> {
  // Device identity and app version are essential (deviceId keys the row);
  // let their failure reject so the tick backs off and retries.
  const [identity, appVersion] = await Promise.all([
    cloudDeviceIdentity(),
    getVersion(),
  ]);
  // Hardware detection is enrichment: degrade to the cheap `get_system_info`
  // triple, then to "unknown", rather than blocking the heartbeat.
  let hardware: LocalModelHardwareSummary | null = null;
  try {
    hardware = await detectLocalModelHardware();
  } catch {
    hardware = null;
  }
  let systemInfo: SystemInfo | null = null;
  if (!hardware) {
    try {
      systemInfo = await getSystemInfo();
    } catch {
      systemInfo = null;
    }
  }
  return {
    deviceId: identity.deviceId,
    machineLabel: identity.machineLabel,
    osName: hardware?.os_name ?? systemInfo?.os_name ?? "unknown",
    osVersion: hardware?.os_version ?? systemInfo?.os_version ?? "unknown",
    chipType: hardware?.chip_type ?? systemInfo?.chip_type ?? "unknown",
    ...(hardware?.cpu_name ? { cpuName: hardware.cpu_name } : {}),
    ...(hardware && hardware.cpu_cores > 0
      ? { cpuCores: hardware.cpu_cores }
      : {}),
    ...(hardware && hardware.total_ram_gb > 0
      ? { totalRamGb: hardware.total_ram_gb }
      : {}),
    ...(hardware?.gpu_name ? { gpuName: hardware.gpu_name } : {}),
    ...(hardware?.gpu_vram_gb != null
      ? { gpuVramGb: hardware.gpu_vram_gb }
      : {}),
    ...(hardware ? { unifiedMemory: hardware.unified_memory } : {}),
    appVersion,
  };
}

let cachedMachine: Promise<MemberRuntimeMachine> | null = null;

/** Cached per app run; a failed composition evicts itself so the next tick
 * retries instead of pinning the failure. */
export function getMemberRuntimeMachineCached(): Promise<MemberRuntimeMachine> {
  if (!cachedMachine) {
    const pending = composeMemberRuntimeMachine();
    cachedMachine = pending;
    pending.catch(() => {
      if (cachedMachine === pending) cachedMachine = null;
    });
  }
  return cachedMachine;
}

export function __resetMemberRuntimeMachineCacheForTests(): void {
  cachedMachine = null;
}

/** One burst sample, stamped with the client clock at collection. */
export async function collectMemberRuntimeSample(
  nowMs: number
): Promise<MemberRuntimeSample> {
  const snapshot = await systemRuntimeSnapshot();
  return {
    cpuPercent: snapshot.cpuPercent,
    memUsedMb: snapshot.memUsedMb,
    memTotalMb: snapshot.memTotalMb,
    gpuPercent: snapshot.gpuPercent,
    sampledOverMs: snapshot.sampledOverMs,
    sampledAtMs: nowMs,
  };
}

/** Detection probes → wire inventory (ids are stable across machines;
 * labels/icons resolve client-side on the viewer). */
export function mapProbesToInstalledAgents(
  probes: readonly ExternalCliSourceProbe[]
): MemberInstalledAgent[] {
  return probes.map((probe) => ({ id: probe.sourceId, status: probe.status }));
}
