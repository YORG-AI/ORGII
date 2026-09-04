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
    throw new CliUsageError(`${option} requires a value`);
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
    throw new CliUsageError(
      `${option} must be a positive ${integer ? "integer" : "number"}`
    );
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
      throw new CliUsageError(`Unsupported option: ${token}`);
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
        throw new CliUsageError(`Unimplemented option: ${token}`);
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
        `process does not accept positional arguments: ${positionals.join(" ")}`
      );
    }
    return {
      command,
      pid: options.pid ?? "auto",
      json: options.json ?? false,
    };
  }

  if (command !== "memory") {
    throw new CliUsageError(`Unknown command: ${command}`);
  }

  const [subcommand, ...subcommandArgs] = rest;
  if (!MEMORY_SUBCOMMANDS.has(subcommand)) {
    throw new CliUsageError(
      `Unknown memory subcommand: ${subcommand ?? "(missing)"}`
    );
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
        `memory record does not accept positional arguments: ${positionals.join(" ")}`
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
    if (!label) throw new CliUsageError("memory mark requires a marker label");
    if (label.length > 200)
      throw new CliUsageError("Marker labels must not exceed 200 characters");
    return { command, subcommand, label, stateRoot: options.stateRoot };
  }

  const { options, positionals } = parseOptions(
    subcommandArgs,
    new Set(["--state-root"])
  );
  if (subcommand !== "report" && positionals.length > 0) {
    throw new CliUsageError(
      `memory ${subcommand} does not accept positional arguments: ${positionals.join(" ")}`
    );
  }
  if (subcommand === "report" && positionals.length > 1) {
    throw new CliUsageError(
      "memory report accepts at most one session directory"
    );
  }
  return {
    command,
    subcommand,
    sessionPath: positionals[0],
    stateRoot: options.stateRoot,
  };
}

export function usage() {
  return `ORG2 standalone diagnostics

Usage:
  pnpm diag:process [--pid auto|PID] [--json]
  pnpm diag:memory record [--pid auto|PID] [--interval SECONDS] [--max-samples COUNT]
                          [--duration SECONDS] [--output DIR] [--state-root DIR]
  pnpm diag:memory mark "Describe the workflow stage" [--state-root DIR]
  pnpm diag:memory stop [--state-root DIR]
  pnpm diag:memory status [--state-root DIR]
  pnpm diag:memory report [SESSION_DIR] [--state-root DIR]

record runs in the foreground; use another terminal for mark or stop.
The default storage path remains .orgii/diagnostics/ for compatibility with
existing recordings. This tool does not modify the app's UI, IPC, or production
runtime.`;
}
