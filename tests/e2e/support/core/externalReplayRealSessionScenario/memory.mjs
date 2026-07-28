import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { MIB, invokeTauriCommand } from "../externalReplayUiDriver.mjs";

const execFileAsync = promisify(execFile);

export async function assertNativeMemoryMatchesVmmap(
  memorySnapshot,
  baselineBytes
) {
  if (process.platform !== "darwin") return;
  if (memorySnapshot.measurement !== "native") {
    throw new Error(
      `#435 regression: expected native macOS memory measurement, got ${memorySnapshot.measurement}`
    );
  }
  let vmmapBytes = 0;
  const vmmapBytesByPid = new Map();
  for (const processRow of memorySnapshot.processes ?? []) {
    if (processRow.metric_kind !== "physical_footprint") {
      throw new Error(
        `#435 regression: PID ${processRow.pid} used ${processRow.metric_kind}`
      );
    }
    const { stdout } = await execFileAsync(
      "/usr/bin/vmmap",
      ["-summary", String(processRow.pid)],
      { maxBuffer: 2 * MIB }
    );
    const match = stdout.match(
      /^Physical footprint:\s+([0-9.]+)\s*([KMGT]?)B?\s*$/im
    );
    if (!match) {
      throw new Error(
        `#435 regression: vmmap omitted Physical footprint for PID ${processRow.pid}`
      );
    }
    const units = { "": 1, K: 1024, M: MIB, G: 1024 * MIB, T: 1024 ** 4 };
    const processVmmapBytes = Number(match[1]) * units[match[2].toUpperCase()];
    vmmapBytes += processVmmapBytes;
    vmmapBytesByPid.set(processRow.pid, processVmmapBytes);
  }
  // vmmap samples each PID sequentially, so the aggregate represents a point
  // somewhere between the native snapshot taken before the loop and the one
  // taken immediately after it. Compare against the closer bracket endpoint
  // instead of treating the older endpoint as simultaneous.
  const memoryAfterVmmap = await invokeTauriCommand(
    "get_app_memory_snapshot_v1"
  );
  if (memoryAfterVmmap.measurement !== "native") {
    throw new Error(
      `#435 regression: follow-up memory measurement was ${memoryAfterVmmap.measurement}`
    );
  }
  const afterBytes = Number(memoryAfterVmmap.effective_total_bytes ?? 0);
  const beforeBytesByPid = new Map(
    (memorySnapshot.processes ?? []).map((row) => [
      row.pid,
      Number(row.effective_memory_bytes ?? 0),
    ])
  );
  const afterBytesByPid = new Map(
    (memoryAfterVmmap.processes ?? []).map((row) => [
      row.pid,
      Number(row.effective_memory_bytes ?? 0),
    ])
  );
  let difference = 0;
  for (const [pid, processVmmapBytes] of vmmapBytesByPid) {
    const beforeProcessBytes = beforeBytesByPid.get(pid);
    const afterProcessBytes = afterBytesByPid.get(pid);
    if (beforeProcessBytes === undefined || afterProcessBytes === undefined) {
      throw new Error(
        `#435 regression: PID ${pid} changed during bracketed vmmap sampling`
      );
    }
    const lower = Math.min(beforeProcessBytes, afterProcessBytes);
    const upper = Math.max(beforeProcessBytes, afterProcessBytes);
    if (processVmmapBytes < lower) {
      difference += lower - processVmmapBytes;
    } else if (processVmmapBytes > upper) {
      difference += processVmmapBytes - upper;
    }
  }
  const tolerance = Math.max(vmmapBytes * 0.1, 50 * MIB);
  if (difference > tolerance) {
    throw new Error(
      `#435 regression: per-PID bracketed native snapshots and vmmap differ by ${(difference / MIB).toFixed(1)} MiB (before=${(baselineBytes / MIB).toFixed(1)} MiB, after=${(afterBytes / MIB).toFixed(1)} MiB, vmmap=${(vmmapBytes / MIB).toFixed(1)} MiB)`
    );
  }
  console.log(
    `[issue-443-real-codex] #435 native-before=${(baselineBytes / MIB).toFixed(1)} MiB native-after=${(afterBytes / MIB).toFixed(1)} MiB vmmap=${(vmmapBytes / MIB).toFixed(1)} MiB out-of-bracket=${(difference / MIB).toFixed(1)} MiB`
  );
}

export function processMemoryRows(memorySnapshot) {
  return (memorySnapshot?.processes ?? []).map((processRow) => ({
    pid: processRow.pid,
    role: processRow.role,
    mib: Number(
      (Number(processRow.effective_memory_bytes ?? 0) / MIB).toFixed(1)
    ),
  }));
}

export async function waitForStableNativeMemorySnapshot() {
  const maxAttempts = 12;
  const stableDifferenceBytes = 32 * MIB;
  let previous = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = await invokeTauriCommand("get_app_memory_snapshot_v1");
    const currentBytes = Number(current?.effective_total_bytes ?? 0);
    if (current?.measurement !== "native" || !(currentBytes > 0)) {
      throw new Error(
        `native memory baseline is unavailable: ${JSON.stringify(current)}`
      );
    }
    if (previous) {
      const previousPids = (previous.processes ?? [])
        .map((row) => row.pid)
        .sort((left, right) => left - right)
        .join(",");
      const currentPids = (current.processes ?? [])
        .map((row) => row.pid)
        .sort((left, right) => left - right)
        .join(",");
      const difference = Math.abs(
        currentBytes - Number(previous.effective_total_bytes ?? 0)
      );
      if (previousPids === currentPids && difference <= stableDifferenceBytes) {
        console.log(
          `[issue-443-real-codex] native baseline stabilized after ${attempt + 1} samples (delta=${(difference / MIB).toFixed(1)} MiB)`
        );
        return current;
      }
    }
    previous = current;
    await browser.pause(500);
  }
  throw new Error(
    `native memory baseline did not stabilize within ${maxAttempts} samples`
  );
}
