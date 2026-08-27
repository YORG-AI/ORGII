export class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliUsageError";
  }
}

const MEMORY_SUBCOMMANDS = new Set([
  "record",
  "mark",
  "stop",
  "status",
  "report",
]);

function takeValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CliUsageError(`${option} 需要一个值`);
  }
  return value;
}

function parsePositiveNumber(raw, option, { integer = false } = {}) {
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    (integer && !Number.isInteger(value))
  ) {
    throw new CliUsageError(`${option} 必须是正${integer ? "整数" : "数"}`);
  }
  return value;
}

function parsePid(raw) {
  if (raw === "auto") return raw;
  return parsePositiveNumber(raw, "--pid", { integer: true });
}

function parseOptions(argv, allowed) {
  const options = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (!allowed.has(token)) {
      throw new CliUsageError(`不支持的参数：${token}`);
    }
    if (token === "--json") {
      options.json = true;
      continue;
    }

    const value = takeValue(argv, index, token);
    index += 1;
    switch (token) {
      case "--pid":
        options.pid = parsePid(value);
        break;
      case "--interval":
        options.intervalSeconds = parsePositiveNumber(value, token);
        break;
      case "--max-samples":
        options.maxSamples = parsePositiveNumber(value, token, {
          integer: true,
        });
        break;
      case "--duration":
        options.durationSeconds = parsePositiveNumber(value, token);
        break;
      case "--output":
        options.outputRoot = value;
        break;
      case "--state-root":
        options.stateRoot = value;
        break;
      default:
        throw new CliUsageError(`尚未实现的参数：${token}`);
    }
  }
  return { options, positionals };
}

export function parseCliArgs(argv) {
  const [command, ...rest] = argv;
  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    return { command: "help" };
  }

  if (command === "process") {
    const { options, positionals } = parseOptions(
      rest,
      new Set(["--pid", "--json"])
    );
    if (positionals.length > 0) {
      throw new CliUsageError(
        `process 不接受位置参数：${positionals.join(" ")}`
      );
    }
    return {
      command,
      pid: options.pid ?? "auto",
      json: options.json ?? false,
    };
  }

  if (command !== "memory") {
    throw new CliUsageError(`未知命令：${command}`);
  }

  const [subcommand, ...subcommandArgs] = rest;
  if (!MEMORY_SUBCOMMANDS.has(subcommand)) {
    throw new CliUsageError(`未知 memory 子命令：${subcommand ?? "（缺失）"}`);
  }

  if (subcommand === "record") {
    const { options, positionals } = parseOptions(
      subcommandArgs,
      new Set([
        "--pid",
        "--interval",
        "--max-samples",
        "--duration",
        "--output",
        "--state-root",
      ])
    );
    if (positionals.length > 0) {
      throw new CliUsageError(
        `memory record 不接受位置参数：${positionals.join(" ")}`
      );
    }
    return {
      command,
      subcommand,
      pid: options.pid ?? "auto",
      intervalSeconds: options.intervalSeconds ?? 15,
      maxSamples: options.maxSamples ?? 720,
      durationSeconds: options.durationSeconds,
      outputRoot: options.outputRoot,
      stateRoot: options.stateRoot,
    };
  }

  if (subcommand === "mark") {
    const { options, positionals } = parseOptions(
      subcommandArgs,
      new Set(["--state-root"])
    );
    const label = positionals.join(" ").trim();
    if (!label) throw new CliUsageError("memory mark 需要一段标记文字");
    if (label.length > 200)
      throw new CliUsageError("标记文字不能超过 200 个字符");
    return { command, subcommand, label, stateRoot: options.stateRoot };
  }

  const { options, positionals } = parseOptions(
    subcommandArgs,
    new Set(["--state-root"])
  );
  if (subcommand !== "report" && positionals.length > 0) {
    throw new CliUsageError(
      `memory ${subcommand} 不接受位置参数：${positionals.join(" ")}`
    );
  }
  if (subcommand === "report" && positionals.length > 1) {
    throw new CliUsageError("memory report 最多接受一个会话目录");
  }
  return {
    command,
    subcommand,
    sessionPath: positionals[0],
    stateRoot: options.stateRoot,
  };
}

export function usage() {
  return `ORGII 独立诊断工具

用法：
  pnpm diag:process [--pid auto|PID] [--json]
  pnpm diag:memory record [--pid auto|PID] [--interval 秒] [--max-samples 数量]
                          [--duration 秒] [--output 目录] [--state-root 目录]
  pnpm diag:memory mark "操作阶段说明" [--state-root 目录]
  pnpm diag:memory stop [--state-root 目录]
  pnpm diag:memory status [--state-root 目录]
  pnpm diag:memory report [会话目录] [--state-root 目录]

说明：record 是前台录制；可从另一个终端执行 mark / stop。默认产物位于
.orgii/diagnostics/，不会接入或修改 App 的 UI、IPC 与生产运行路径。`;
}
