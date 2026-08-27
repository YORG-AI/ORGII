import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PS_PATH = "/bin/ps";
const LAUNCHCTL_PATH = "/bin/launchctl";
const PROCESS_COMMAND_TIMEOUT_MS = 5_000;
const PROCESS_COMMAND_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_REPORTED_PROCESSES = 256;
const MAX_AUDIT_FINDINGS = 200;
const MAX_REPORTED_COMMAND_LENGTH = 300;

export class ProcessResolutionError extends Error {
  constructor(message, candidates = []) {
    super(message);
    this.name = "ProcessResolutionError";
    this.candidates = candidates;
  }
}

function parseInteger(raw) {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : 0;
}

export function redactProcessCommand(command) {
  const redacted = command
    .replace(
      /(--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|authorization|auth)(?:=|\s+))(?:("[^"]*")|('[^']*')|\S+)/gi,
      "$1[REDACTED]"
    )
    .replace(/(https?:\/\/[^\s/:]+:)[^\s@]+@/gi, "$1[REDACTED]@");
  return redacted.length > MAX_REPORTED_COMMAND_LENGTH
    ? `${redacted.slice(0, MAX_REPORTED_COMMAND_LENGTH)}…`
    : redacted;
}

export function parsePsOutput(output) {
  const rows = [];
  const pattern =
    /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/;
  for (const line of output.split("\n")) {
    const match = line.match(pattern);
    if (!match) continue;
    rows.push({
      pid: parseInteger(match[1]),
      parentPid: parseInteger(match[2]),
      processGroupId: parseInteger(match[3]),
      userId: parseInteger(match[4]),
      state: match[5],
      startToken: match[6],
      rssBytes: parseInteger(match[7]) * 1024,
      virtualBytes: parseInteger(match[8]) * 1024,
      cpuPercent: Number.parseFloat(match[9]) || 0,
      command: match[10],
    });
  }
  return rows;
}

export async function collectProcessTable() {
  if (process.platform === "win32") {
    throw new Error("当前版本的独立诊断工具暂不支持 Windows 进程采样");
  }
  const { stdout } = await execFileAsync(
    PS_PATH,
    ["-axo", "pid=,ppid=,pgid=,uid=,stat=,lstart=,rss=,vsz=,%cpu=,command="],
    {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: PROCESS_COMMAND_MAX_BUFFER,
      timeout: PROCESS_COMMAND_TIMEOUT_MS,
    }
  );
  return parsePsOutput(stdout);
}

function executableBasename(command) {
  const executable = command.trim().split(/\s+/, 1)[0] ?? "";
  return path.basename(executable).toLowerCase();
}

export function isOrgiiRootCandidate(row, workspaceRoot) {
  const basename = executableBasename(row.command);
  const isRootName =
    basename === "org2" ||
    basename === "orgii" ||
    /(?:^|\/)(?:org2|orgii)(?:\s|$)/i.test(row.command);
  const isHelper = /\bhelper\b/i.test(row.command);
  if (!isRootName || isHelper) return false;
  if (!workspaceRoot) return true;
  const normalizedRoot = `${path.resolve(workspaceRoot)}${path.sep}`;
  return (
    row.command.includes(normalizedRoot) ||
    row.command.includes("/Contents/MacOS/")
  );
}

export function resolveRootProcess(rows, requestedPid, workspaceRoot) {
  if (requestedPid !== "auto") {
    const selected = rows.find((row) => row.pid === requestedPid);
    if (!selected) {
      throw new ProcessResolutionError(
        `找不到 PID ${requestedPid}；它可能已经退出`
      );
    }
    return selected;
  }

  const candidates = rows.filter((row) =>
    isOrgiiRootCandidate(row, workspaceRoot)
  );
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new ProcessResolutionError("没有找到正在运行的 ORGII 主进程");
  }
  throw new ProcessResolutionError(
    "找到多个 ORGII 主进程，请用 --pid 明确指定",
    candidates
  );
}

export function descendantDepth(pid, rootPid, rowsOrIndex) {
  if (pid === rootPid) return 0;
  const byPid =
    rowsOrIndex instanceof Map
      ? rowsOrIndex
      : new Map(rowsOrIndex.map((row) => [row.pid, row]));
  const seen = new Set();
  let currentPid = pid;
  let depth = 0;
  while (!seen.has(currentPid)) {
    seen.add(currentPid);
    const current = byPid.get(currentPid);
    if (!current) return undefined;
    depth += 1;
    if (current.parentPid === rootPid) return depth;
    if (current.parentPid <= 1) return undefined;
    currentPid = current.parentPid;
  }
  return undefined;
}

export function parseLaunchctlWebKitServices(output) {
  const rolesByPid = new Map();
  for (const line of output.split("\n")) {
    const match = line.match(
      /^\s*(\d+)\s+-\s+(com\.apple\.WebKit\.(?:WebContent|GPU|Networking)(?:\.[^\s]+)?)\s*$/
    );
    if (!match || match[1] === "0") continue;
    const service = match[2];
    const role = service.includes("WebContent")
      ? "renderer"
      : service.includes("GPU")
        ? "gpu"
        : "network";
    rolesByPid.set(parseInteger(match[1]), role);
  }
  return rolesByPid;
}

async function collectOwnedWebKitServices(rootPid) {
  if (process.platform !== "darwin") {
    return { rolesByPid: new Map(), attribution: "complete" };
  }
  try {
    const { stdout } = await execFileAsync(
      LAUNCHCTL_PATH,
      ["print", `pid/${rootPid}`],
      {
        encoding: "utf8",
        maxBuffer: PROCESS_COMMAND_MAX_BUFFER,
        timeout: PROCESS_COMMAND_TIMEOUT_MS,
      }
    );
    return {
      rolesByPid: parseLaunchctlWebKitServices(stdout),
      attribution: "complete",
    };
  } catch (error) {
    return {
      rolesByPid: new Map(),
      attribution: "partial",
      warning: `无法读取宿主 WebKit 服务：${error.message}`,
    };
  }
}

function isTrustedWebKitProcess(row, role, rootUserId) {
  const expectedName =
    role === "renderer"
      ? "com.apple.WebKit.WebContent"
      : role === "gpu"
        ? "com.apple.WebKit.GPU"
        : "com.apple.WebKit.Networking";
  return (
    row.userId === rootUserId &&
    row.command.includes("/System/Library/Frameworks/WebKit.framework/") &&
    row.command.includes(`/XPCServices/${expectedName}.xpc/`) &&
    row.command.includes(`/MacOS/${expectedName}`)
  );
}

function descendantRole(row) {
  const lower = row.command.toLowerCase();
  if (
    /\b(zsh|bash|fish|sh|pwsh|powershell)\b/.test(lower) ||
    lower.includes("terminal")
  ) {
    return "terminal";
  }
  if (
    [
      "claude",
      "codex",
      "cursor",
      "qoder",
      "opencode",
      "gemini",
      "kiro",
      "trae",
    ].some((name) => lower.includes(name))
  ) {
    return "agent_cli";
  }
  return "tool";
}

export async function collectOwnedProcessSnapshot(rootIdentity, { rows } = {}) {
  const processRows = rows ?? (await collectProcessTable());
  const root = processRows.find((row) => row.pid === rootIdentity.pid);
  if (!root || root.startToken !== rootIdentity.startToken) {
    return {
      status: "root_exited",
      capturedAt: new Date().toISOString(),
      measurement: "resident_set_sum",
      attribution: "partial",
      processes: [],
      totalRssBytes: 0,
      totalVirtualBytes: 0,
      skippedPids: [],
    };
  }

  const webKit = await collectOwnedWebKitServices(root.pid);
  const included = new Map();
  const rowsByPid = new Map(processRows.map((row) => [row.pid, row]));
  included.set(root.pid, {
    row: root,
    role: "backend",
    relation: "root",
    depth: 0,
  });
  for (const row of processRows) {
    const depth = descendantDepth(row.pid, root.pid, rowsByPid);
    if (depth && !included.has(row.pid)) {
      included.set(row.pid, {
        row,
        role: descendantRole(row),
        relation: "descendant",
        depth,
      });
    }
  }

  const skippedPids = [];
  for (const [pid, role] of webKit.rolesByPid) {
    const row = processRows.find((candidate) => candidate.pid === pid);
    if (!row || !isTrustedWebKitProcess(row, role, root.userId)) {
      skippedPids.push(pid);
      continue;
    }
    included.set(pid, {
      row,
      role,
      relation: "owned_webkit",
      depth: undefined,
    });
  }

  const allProcesses = [...included.values()]
    .map(({ row, role, relation, depth }) => ({
      pid: row.pid,
      parentPid: row.parentPid,
      processGroupId: row.processGroupId,
      processInstanceId: `${row.pid}:${row.startToken}`,
      startToken: row.startToken,
      state: row.state,
      role,
      relation,
      ...(depth === undefined ? {} : { depth }),
      rssBytes: row.rssBytes,
      virtualBytes: row.virtualBytes,
      cpuPercent: row.cpuPercent,
      command: redactProcessCommand(row.command),
    }))
    .sort((left, right) => {
      if (left.relation === "root") return -1;
      if (right.relation === "root") return 1;
      return right.rssBytes - left.rssBytes || left.pid - right.pid;
    });
  const processes = allProcesses.slice(0, MAX_REPORTED_PROCESSES);
  const roleRssBytes = {};
  for (const item of allProcesses) {
    roleRssBytes[item.role] = (roleRssBytes[item.role] ?? 0) + item.rssBytes;
  }

  return {
    status: "ok",
    capturedAt: new Date().toISOString(),
    measurement: "resident_set_sum",
    attribution:
      webKit.attribution === "complete" && skippedPids.length === 0
        ? "complete"
        : "partial",
    ...(webKit.warning ? { warning: webKit.warning } : {}),
    processes,
    omittedProcessCount: Math.max(0, allProcesses.length - processes.length),
    roleRssBytes,
    zombieProcessCount: allProcesses.filter((item) => item.state.includes("Z"))
      .length,
    totalRssBytes: allProcesses.reduce(
      (total, item) => total + item.rssBytes,
      0
    ),
    totalVirtualBytes: allProcesses.reduce(
      (total, item) => total + item.virtualBytes,
      0
    ),
    skippedPids,
  };
}

export function auditProcessTable(
  rows,
  root,
  workspaceRoot,
  ownedWebKitPids = new Set()
) {
  const rootPid = root?.pid;
  const normalizedRoot = workspaceRoot
    ? `${path.resolve(workspaceRoot)}${path.sep}`
    : undefined;
  const rowsByPid = new Map(rows.map((row) => [row.pid, row]));
  const related = root
    ? rows.filter(
        (row) =>
          row.pid === rootPid ||
          descendantDepth(row.pid, rootPid, rowsByPid) !== undefined
      )
    : [];
  const relatedPids = new Set(related.map((row) => row.pid));
  const findings = [];

  for (const row of rows) {
    const workspaceRelated =
      normalizedRoot && row.command.includes(normalizedRoot);
    const rootRelated = relatedPids.has(row.pid);
    if (row.state.includes("Z") && (rootRelated || workspaceRelated)) {
      findings.push({
        kind: "zombie",
        severity: "actionable",
        pid: row.pid,
        parentPid: row.parentPid,
        command: redactProcessCommand(row.command),
        reason: "进程已退出但父进程尚未回收退出状态",
      });
      continue;
    }
    if (
      row.parentPid === 1 &&
      workspaceRelated &&
      row.pid !== rootPid &&
      !ownedWebKitPids.has(row.pid)
    ) {
      findings.push({
        kind: "adopted_workspace_process",
        severity: "review",
        pid: row.pid,
        parentPid: row.parentPid,
        command: redactProcessCommand(row.command),
        reason: "工作区相关进程已被系统 init 进程接管，需核对是否仍有用途",
      });
    }
  }

  return {
    root: root
      ? {
          pid: root.pid,
          parentPid: root.parentPid,
          startToken: root.startToken,
          command: redactProcessCommand(root.command),
        }
      : null,
    relatedProcesses: related.slice(0, MAX_REPORTED_PROCESSES).map((row) => ({
      pid: row.pid,
      parentPid: row.parentPid,
      state: row.state,
      rssBytes: row.rssBytes,
      command: redactProcessCommand(row.command),
    })),
    omittedRelatedProcessCount: Math.max(
      0,
      related.length - MAX_REPORTED_PROCESSES
    ),
    findings: findings.slice(0, MAX_AUDIT_FINDINGS),
    omittedFindingCount: Math.max(0, findings.length - MAX_AUDIT_FINDINGS),
  };
}

export async function auditProcesses({ requestedPid, workspaceRoot }) {
  const rows = await collectProcessTable();
  let root;
  let resolutionWarning;
  let resolutionCandidates = [];
  try {
    root = resolveRootProcess(rows, requestedPid, workspaceRoot);
  } catch (error) {
    if (!(error instanceof ProcessResolutionError)) throw error;
    resolutionWarning = error.message;
    resolutionCandidates = error.candidates.map((candidate) => ({
      pid: candidate.pid,
      startToken: candidate.startToken,
      command: redactProcessCommand(candidate.command),
    }));
  }

  const webKit = root
    ? await collectOwnedWebKitServices(root.pid)
    : { rolesByPid: new Map(), attribution: "unavailable" };
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    status: root ? "ok" : "app_not_found",
    ...(resolutionWarning ? { warning: resolutionWarning } : {}),
    ...(resolutionCandidates.length > 0
      ? { candidates: resolutionCandidates }
      : {}),
    webKitAttribution: webKit.attribution,
    ...auditProcessTable(
      rows,
      root,
      workspaceRoot,
      new Set(webKit.rolesByPid.keys())
    ),
  };
}
