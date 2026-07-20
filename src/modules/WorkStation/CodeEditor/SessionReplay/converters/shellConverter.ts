/**
 * Shell Operation Converter
 *
 * Converts SessionEvents into ShellOperationEntry for the IDE simulator view.
 */
import { TOOL_NAMES } from "@src/api/tauri/agent/toolNames";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { extractShellData } from "@src/engines/SessionCore/rendering/props";
import { APP_SUBTOOL } from "@src/engines/SessionCore/rendering/registry";
import { getAppSubtool } from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import type { EventStatus } from "@src/engines/SessionCore/rendering/types/universalProps";
import { getEventStatus } from "@src/util/data/converters/eventStatus";

import type { ShellOperationEntry } from "../types";

function commandFromAction(event: SessionEvent): string {
  const action =
    typeof event.args?.action === "string" ? event.args.action : "";
  if (!action) return "";

  if (event.functionName === TOOL_NAMES.INSPECT_TERMINALS) {
    return `${TOOL_NAMES.INSPECT_TERMINALS} ${action}`;
  }

  return "";
}

function resolveEventStatus(event: SessionEvent): EventStatus {
  const status = getEventStatus(event) || event.displayStatus || "completed";
  return status as EventStatus;
}

/**
 * Convert a SessionEvent to a ShellOperationEntry.
 * Returns null if the event is not a shell operation.
 */
export function convertToShellOperation(
  event: SessionEvent,
  isCurrent: boolean
): ShellOperationEntry | null {
  const eventType = event.functionName;

  const subtool = getAppSubtool(eventType);

  if (subtool === APP_SUBTOOL.SHELL) {
    const statusString = resolveEventStatus(event);

    const propsForExtraction = {
      eventId: event.id,
      eventType: event.functionName,
      args: event.args,
      result: event.result,
      status: statusString,
      variant: "simulator" as const,
      context: "simulator" as const,
      rustExtracted: event.extracted,
      shellPid: event.shellPid,
      shellProcessStatus: event.shellProcessStatus,
      shellLogPath: event.shellLogPath,
    };

    const data = extractShellData(propsForExtraction);
    const command = data.command || commandFromAction(event);

    if (!command) return null;

    const isLoading = statusString === "running" || statusString === "pending";
    const rawStreamOutput = data.streamOutput;

    return {
      command,
      shortCommand: data.shortCommand || command,
      commandKeywords: data.commandKeywords || data.shortCommand || "",
      cwd: data.cwd,
      description: data.description,
      output: data.output,
      streamOutput: isLoading ? rawStreamOutput : undefined,
      replayRef: event.shellReplay?.ref,
      exitCode: data.exitCode,
      executionTime: data.executionTime,
      isLoading,
      isError: data.exitCode !== undefined && data.exitCode !== 0,
      isFailed: statusString === "failed",
      event,
      eventId: event.id,
      isCurrent,
    };
  }

  return null;
}
