import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  collectOwnedProcessSnapshot,
  collectProcessTable,
  redactProcessCommand,
  resolveRootProcess,
} from "./process-snapshot.mjs";
import { generateReports } from "./report.mjs";
import {
  appendJsonLine,
  claimActiveSession,
  createSessionId,
  readStopRequest,
  removeActiveStateIfOwned,
  resolveDiagnosticPaths,
  writeJsonAtomic,
} from "./session-store.mjs";

function formatMiB(bytes) {
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function createInterruptibleWait() {
  let wake;
  let timer;
  let watcher;
  return {
    observe(sessionDir) {
      watcher = watch(sessionDir, { encoding: "utf8" }, (_event, filename) => {
        if (filename === "stop-request.json") wake?.();
      });
      watcher.on("error", () => wake?.());
    },
    wait(milliseconds) {
      return new Promise((resolve) => {
        wake = () => {
          if (timer) clearTimeout(timer);
          timer = undefined;
          wake = undefined;
          resolve();
        };
        timer = setTimeout(wake, milliseconds);
      });
    },
    interrupt() {
      wake?.();
    },
    close() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      wake = undefined;
      watcher?.close();
      watcher = undefined;
    },
  };
}

export async function recordMemorySession(options) {
  const paths = resolveDiagnosticPaths(options.repoRoot, options);
  const initialRows = await collectProcessTable();
  const root = resolveRootProcess(initialRows, options.pid, options.repoRoot);
  const recorder = initialRows.find((row) => row.pid === process.pid);
  if (!recorder) throw new Error("无法读取诊断记录器自身的进程身份");

  const sessionId = createSessionId();
  const sessionDir = path.join(paths.outputRoot, sessionId);
  const rootIdentity = { pid: root.pid, startToken: root.startToken };
  const active = {
    schemaVersion: 1,
    sessionId,
    sessionDir,
    startedAt: new Date().toISOString(),
    recorder: { pid: recorder.pid, startToken: recorder.startToken },
    rootProcess: rootIdentity,
  };

  const session = {
    schemaVersion: 1,
    sessionId,
    state: "recording",
    platform: process.platform,
    startedAt: active.startedAt,
    rootProcess: {
      ...rootIdentity,
      parentPid: root.parentPid,
      command: redactProcessCommand(root.command),
    },
    recorder: active.recorder,
    config: {
      intervalSeconds: options.intervalSeconds,
      maxSamples: options.maxSamples,
      ...(options.durationSeconds
        ? { durationSeconds: options.durationSeconds }
        : {}),
      measurement: "resident_set_sum",
    },
  };
  const waiter = createInterruptibleWait();
  let requestedStopReason;
  const requestSignalStop = (signal) => {
    requestedStopReason ??= `signal_${signal.toLowerCase()}`;
    waiter.interrupt();
  };
  const signalHandlers = new Map(
    ["SIGINT", "SIGTERM"].map((signal) => [
      signal,
      () => requestSignalStop(signal),
    ])
  );
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);

  let stopReason = "unknown";
  let sequence = 0;
  let consecutiveErrors = 0;
  let claimed = false;
  let fatalError;
  let report;
  const startedAtMs = Date.now();
  const samplesPath = path.join(sessionDir, "samples.ndjson");

  try {
    await claimActiveSession(paths, active);
    claimed = true;
    await mkdir(sessionDir, { recursive: true });
    waiter.observe(sessionDir);
    await writeJsonAtomic(path.join(sessionDir, "session.json"), session);
    process.stdout.write(
      `录制已开始：${sessionId}\n根进程：PID ${root.pid}\n产物目录：${sessionDir}\n`
    );

    while (sequence < options.maxSamples) {
      const stopRequest = await readStopRequest(sessionDir, sessionId);
      if (stopRequest) {
        stopReason = "external_stop";
        break;
      }
      if (requestedStopReason) {
        stopReason = requestedStopReason;
        break;
      }
      if (
        options.durationSeconds &&
        Date.now() - startedAtMs >= options.durationSeconds * 1000 &&
        sequence > 0
      ) {
        stopReason = "duration_reached";
        break;
      }

      sequence += 1;
      try {
        const sample = await collectOwnedProcessSnapshot(rootIdentity);
        const record = { schemaVersion: 1, sequence, ...sample };
        await appendJsonLine(samplesPath, record);
        if (sample.status === "root_exited") {
          stopReason = "root_process_exited_or_replaced";
          break;
        }
        consecutiveErrors = 0;
        process.stdout.write(
          `样本 ${sequence}/${options.maxSamples}：${formatMiB(sample.totalRssBytes)}，${sample.processes.length} 个进程，归因 ${sample.attribution}\n`
        );
      } catch (error) {
        consecutiveErrors += 1;
        await appendJsonLine(samplesPath, {
          schemaVersion: 1,
          sequence,
          capturedAt: new Date().toISOString(),
          status: "sample_error",
          error: error.message,
          processes: [],
        });
        process.stderr.write(`样本 ${sequence} 失败：${error.message}\n`);
        if (consecutiveErrors >= 3) {
          stopReason = "three_consecutive_sample_errors";
          break;
        }
      }

      const stopRequestAfterSample = await readStopRequest(
        sessionDir,
        sessionId
      );
      if (stopRequestAfterSample) {
        stopReason = "external_stop";
        break;
      }
      if (requestedStopReason) {
        stopReason = requestedStopReason;
        break;
      }
      if (sequence >= options.maxSamples) {
        stopReason = "sample_limit_reached";
        break;
      }
      await waiter.wait(options.intervalSeconds * 1000);
    }
  } catch (error) {
    fatalError = error;
    if (claimed) stopReason = "recorder_error";
  } finally {
    waiter.close();
    for (const [signal, handler] of signalHandlers)
      process.off(signal, handler);
    if (claimed) {
      try {
        const stopRequest = await readStopRequest(sessionDir, sessionId);
        if (stopRequest && stopReason !== "recorder_error")
          stopReason = "external_stop";
        session.state = fatalError ? "failed" : "ready";
        session.endedAt = new Date().toISOString();
        session.stopReason = stopReason;
        session.sampleCount = sequence;
        if (fatalError) session.error = fatalError.message;
        await writeJsonAtomic(path.join(sessionDir, "session.json"), session);
        report = await generateReports(sessionDir);
      } catch (finalizeError) {
        fatalError ??= finalizeError;
      } finally {
        await removeActiveStateIfOwned(paths.activePath, sessionId);
      }
    }
  }

  if (fatalError) throw fatalError;
  if (!report) throw new Error("诊断录制未生成报告");
  process.stdout.write(
    `录制已结束：${stopReason}\n报告：${report.files.markdown}\n`
  );
  return report;
}
