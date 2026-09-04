#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { CliUsageError, parseCliArgs, usage } from "./lib/args.mjs";
import { auditProcesses } from "./lib/process-snapshot.mjs";
import { recordMemorySession } from "./lib/recorder.mjs";
import { generateReports } from "./lib/report.mjs";
import {
  ActiveSessionError,
  addMarker,
  inspectActiveState,
  requestStop,
  resolveDiagnosticPaths,
  resolveReportSessionDir,
} from "./lib/session-store.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unavailable";
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function printProcessAudit(audit) {
  process.stdout.write(`Process audit: ${audit.capturedAt}\n`);
  if (audit.root) {
    process.stdout.write(`ORG2 root process: PID ${audit.root.pid}\n`);
    process.stdout.write(
      `Related processes: ${audit.relatedProcesses.length}\n`
    );
  } else {
    process.stdout.write(`ORG2 root process: not found (${audit.warning})\n`);
    for (const candidate of audit.candidates ?? []) {
      process.stdout.write(
        `- Candidate PID ${candidate.pid}: ${candidate.command}\n`
      );
    }
  }
  if (audit.findings.length === 0) {
    process.stdout.write(
      "No zombie or adopted processes found for this workspace or ORG2 process tree.\n"
    );
    return;
  }
  process.stdout.write(`Found ${audit.findings.length} findings to review:\n`);
  for (const finding of audit.findings) {
    process.stdout.write(
      `- [${finding.kind}] PID ${finding.pid}, PPID ${finding.parentPid}: ${finding.reason}\n  ${finding.command}\n`
    );
  }
}

async function runMemoryCommand(parsed) {
  const paths = resolveDiagnosticPaths(repoRoot, parsed);
  if (parsed.subcommand === "record") {
    return recordMemorySession({ ...parsed, repoRoot });
  }
  if (parsed.subcommand === "mark") {
    const { active, marker } = await addMarker(paths.activePath, parsed.label);
    process.stdout.write(
      `Marked session ${active.sessionId}: ${marker.label}\n`
    );
    return;
  }
  if (parsed.subcommand === "stop") {
    const { active } = await requestStop(paths.activePath);
    process.stdout.write(
      `Stop requested for session ${active.sessionId}; the recorder will finalize the report.\n`
    );
    return;
  }
  if (parsed.subcommand === "status") {
    const inspection = await inspectActiveState(paths.activePath);
    if (inspection.state === "idle") {
      process.stdout.write("No diagnostic recording session is active.\n");
      return;
    }
    process.stdout.write(
      `${inspection.state === "recording" ? "Recording" : "Interrupted session found"}: ${inspection.active.sessionId}\n` +
        `Recorder PID: ${inspection.active.recorder.pid}\n` +
        `Root process PID: ${inspection.active.rootProcess.pid} (${inspection.rootLive ? "running" : "exited or replaced"})\n` +
        `Output directory: ${inspection.active.sessionDir}\n`
    );
    return;
  }
  const sessionDir = await resolveReportSessionDir(paths, parsed.sessionPath);
  const report = await generateReports(sessionDir);
  process.stdout.write(
    `Report generated: ${report.files.markdown}\n` +
      `Usable samples: ${report.summary.usableSampleCount}\n` +
      `RSS change: ${formatBytes(report.summary.deltaRssBytes)}\n` +
      `Verdict: ${report.summary.verdict}\n`
  );
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (parsed.command === "process") {
    const audit = await auditProcesses({
      requestedPid: parsed.pid,
      workspaceRoot: repoRoot,
    });
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
    } else {
      printProcessAudit(audit);
    }
    return;
  }
  await runMemoryCommand(parsed);
}

main().catch((error) => {
  const prefix =
    error instanceof CliUsageError ? "Usage error" : "Diagnostics failed";
  process.stderr.write(`${prefix}: ${error.message}\n`);
  if (error instanceof CliUsageError) process.stderr.write(`\n${usage()}\n`);
  if (error instanceof ActiveSessionError) {
    process.stderr.write(
      "No actions that could affect other processes were performed.\n"
    );
  }
  process.exitCode = 1;
});
