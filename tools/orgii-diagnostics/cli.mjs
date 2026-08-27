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
  if (!Number.isFinite(bytes)) return "不可用";
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function printProcessAudit(audit) {
  process.stdout.write(`进程审计：${audit.capturedAt}\n`);
  if (audit.root) {
    process.stdout.write(`ORGII 主进程：PID ${audit.root.pid}\n`);
    process.stdout.write(`相关进程：${audit.relatedProcesses.length}\n`);
  } else {
    process.stdout.write(`ORGII 主进程：未找到（${audit.warning}）\n`);
    for (const candidate of audit.candidates ?? []) {
      process.stdout.write(
        `- 候选 PID ${candidate.pid}：${candidate.command}\n`
      );
    }
  }
  if (audit.findings.length === 0) {
    process.stdout.write(
      "未发现与当前工作区/ORGII 进程树相关的僵尸或被接管进程。\n"
    );
    return;
  }
  process.stdout.write(`发现 ${audit.findings.length} 项需要检查：\n`);
  for (const finding of audit.findings) {
    process.stdout.write(
      `- [${finding.kind}] PID ${finding.pid}，PPID ${finding.parentPid}：${finding.reason}\n  ${finding.command}\n`
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
    process.stdout.write(`已标记会话 ${active.sessionId}：${marker.label}\n`);
    return;
  }
  if (parsed.subcommand === "stop") {
    const { active } = await requestStop(paths.activePath);
    process.stdout.write(
      `已请求停止会话 ${active.sessionId}，正在生成报告。\n`
    );
    return;
  }
  if (parsed.subcommand === "status") {
    const inspection = await inspectActiveState(paths.activePath);
    if (inspection.state === "idle") {
      process.stdout.write("当前没有诊断录制会话。\n");
      return;
    }
    process.stdout.write(
      `${inspection.state === "recording" ? "正在录制" : "发现中断的旧会话"}：${inspection.active.sessionId}\n` +
        `记录器 PID：${inspection.active.recorder.pid}\n` +
        `根进程 PID：${inspection.active.rootProcess.pid}（${inspection.rootLive ? "仍在运行" : "已退出或被替换"}）\n` +
        `产物目录：${inspection.active.sessionDir}\n`
    );
    return;
  }
  const sessionDir = await resolveReportSessionDir(paths, parsed.sessionPath);
  const report = await generateReports(sessionDir);
  process.stdout.write(
    `报告已生成：${report.files.markdown}\n` +
      `有效样本：${report.summary.usableSampleCount}\n` +
      `RSS 变化：${formatBytes(report.summary.deltaRssBytes)}\n` +
      `判断：${report.summary.verdict}\n`
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
  const prefix = error instanceof CliUsageError ? "用法错误" : "诊断失败";
  process.stderr.write(`${prefix}：${error.message}\n`);
  if (error instanceof CliUsageError) process.stderr.write(`\n${usage()}\n`);
  if (error instanceof ActiveSessionError) {
    process.stderr.write("未执行任何可能影响其他进程的操作。\n");
  }
  process.exitCode = 1;
});
