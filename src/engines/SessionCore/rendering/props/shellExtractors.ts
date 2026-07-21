/**
 * Shell / command execution data extractor.
 */
import type {
  ExtractedShellData,
  UniversalEventProps,
} from "../types/universalProps";
import {
  extractFailureData,
  extractSuccessData,
  safeText,
} from "./extractorShared";

/**
 * Resolve the action name for a tool event.
 * Most tools use an explicit `args.action` field. Some (like run_shell)
 * use structural dispatch — inferred from which fields are present.
 */
function resolveAction(
  uiCanonical: string,
  args: Record<string, unknown>
): string | undefined {
  if (typeof args.action === "string") return args.action;
  if (uiCanonical === "run_shell") {
    if (args.kill_handle) return "kill";
    if (args.command !== undefined) return "run";
  }
  return undefined;
}

function getShellCommandDisplay(command: string): {
  shortCommand?: string;
  commandKeywords?: string;
} {
  if (!command) return {};
  const parts = command.split(/(?:&&|\|\||;|\|)/);
  const commands = parts
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
  return {
    shortCommand: command.trim().split(/\s+/)[0] || command,
    commandKeywords: [...new Set(commands)].join(", "),
  };
}

export function extractShellData(
  props: UniversalEventProps
): ExtractedShellData {
  if (props.rustExtracted?.kind === "shell") {
    const s = props.rustExtracted;
    const display = getShellCommandDisplay(s.command);
    return {
      command: s.command,
      shortCommand: display.shortCommand,
      commandKeywords: display.commandKeywords,
      action: s.action,
      killHandle: s.killHandle,
      description: s.description,
      output: s.output,
      streamOutput: s.streamOutput,
      exitCode: props.shellExitCode ?? s.exitCode,
      cwd: s.cwd,
      executionTime: s.executionTime,
      isFailure: s.isFailure,
      shellPid: props.shellPid ?? s.shellPid,
      shellProcessStatus: props.shellProcessStatus ?? s.shellProcessStatus,
      shellLogPath: props.shellLogPath ?? s.shellLogPath,
    };
  }

  const { args, result } = props;

  const successData = extractSuccessData(result);
  const failureData = extractFailureData(result);

  const commandData =
    Object.keys(successData).length > 0 ? successData : failureData;
  const isFailure =
    Object.keys(failureData).length > 0 &&
    Object.keys(successData).length === 0;

  const command =
    (commandData?.command as string) ||
    (args?.command as string) ||
    (result?.command as string) ||
    "";

  const description = (args?.description as string) || undefined;
  const action = resolveAction("run_shell", args || {});
  const killHandle = (args?.kill_handle as string) || undefined;

  const stdout = safeText(commandData?.stdout) || safeText(result?.stdout);
  const stderr = safeText(commandData?.stderr) || safeText(result?.stderr);
  const interleavedOutput =
    safeText(commandData?.interleavedOutput) ||
    safeText(commandData?.interleaved_output);

  const streamOutput = safeText(args?.streamOutput);

  const shellOutput =
    interleavedOutput ||
    stdout ||
    stderr ||
    streamOutput ||
    safeText(result?.output as string) ||
    safeText(result?.observation) ||
    undefined;

  const exitCode =
    (commandData?.exitCode as number) ??
    (commandData?.exit_code as number) ??
    (args?.shellExitCode as number) ??
    (args?.shell_exit_code as number) ??
    (result?.exit_code as number) ??
    undefined;

  const executionTime =
    (commandData?.executionTime as number) ??
    (commandData?.execution_time as number) ??
    (result?.execution_time as number) ??
    undefined;

  const cwd = (args?.cwd as string) || undefined;
  const display = getShellCommandDisplay(command);

  const shellPid =
    props.shellPid ??
    (args?.shellPid as number) ??
    (args?.shell_pid as number) ??
    undefined;
  const shellProcessStatus =
    props.shellProcessStatus ??
    (args?.shellProcessStatus as ExtractedShellData["shellProcessStatus"]) ??
    (args?.shell_process_status as ExtractedShellData["shellProcessStatus"]) ??
    undefined;
  const shellLogPath =
    props.shellLogPath ??
    (args?.shellLogPath as string) ??
    (args?.shell_log_path as string) ??
    undefined;

  return {
    command,
    shortCommand: display.shortCommand,
    commandKeywords: display.commandKeywords,
    action,
    killHandle,
    description,
    output: shellOutput,
    streamOutput: streamOutput || undefined,
    exitCode,
    cwd,
    executionTime,
    isFailure,
    shellPid,
    shellProcessStatus,
    shellLogPath,
  };
}
