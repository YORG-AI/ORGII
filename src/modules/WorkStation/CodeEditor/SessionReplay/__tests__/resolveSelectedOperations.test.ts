import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  resolveSelectedFileOperation,
  resolveSelectedShellOperation,
} from "../resolveSelectedOperations";
import {
  FILE_OPERATION_TYPE,
  type FileOperationEntry,
  type ShellOperationEntry,
} from "../types";

function minimalSessionEvent(
  overrides: Partial<SessionEvent> = {}
): SessionEvent {
  return {
    chunk_id: null,
    id: "evt-1",
    sessionId: "sess-1",
    createdAt: "2026-03-29T12:00:00.000Z",
    functionName: "read_file",
    uiCanonical: "",
    actionType: "tool_call",
    args: {},
    result: {},
    source: "assistant",
    displayText: "",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "agent",
    ...overrides,
  };
}

function fileOperation(
  overrides: Partial<FileOperationEntry> = {}
): FileOperationEntry {
  const event = minimalSessionEvent({ id: overrides.eventId ?? "read-1" });
  return {
    filePath: "/repo/a.ts",
    fileName: "a.ts",
    directory: "/repo",
    type: FILE_OPERATION_TYPE.READ,
    event,
    eventId: event.id,
    isCurrent: false,
    ...overrides,
  };
}

function shellOperation(
  overrides: Partial<ShellOperationEntry> = {}
): ShellOperationEntry {
  const event = minimalSessionEvent({
    id: overrides.eventId ?? "shell-1",
    functionName: "run_shell",
  });
  return {
    command: "pwd",
    shortCommand: "pwd",
    commandKeywords: "pwd",
    event,
    eventId: event.id,
    isCurrent: false,
    ...overrides,
  };
}

describe("resolveSelectedFileOperation", () => {
  it("prioritizes a running read over a stale manual selection", () => {
    const manualSelection = fileOperation({
      eventId: "read-old",
      filePath: "/repo/old.ts",
      fileName: "old.ts",
      content: "old content",
    });
    const runningRead = fileOperation({
      eventId: "read-running",
      filePath: "/repo/live.ts",
      fileName: "live.ts",
      isCurrent: true,
      isLoading: true,
      content: undefined,
    });

    const selected = resolveSelectedFileOperation(
      [manualSelection, runningRead],
      [manualSelection, runningRead],
      null,
      "read-old",
      "read-running"
    );

    expect(selected?.eventId).toBe("read-running");
    expect(selected?.filePath).toBe("/repo/live.ts");
    expect(selected?.isLoading).toBe(true);
  });
});

describe("resolveSelectedShellOperation", () => {
  it("keeps following the running command until the user selects one", () => {
    const completed = shellOperation({ eventId: "shell-completed" });
    const running = shellOperation({
      eventId: "shell-running",
      isCurrent: true,
      isLoading: true,
      streamOutput: "still running",
    });

    expect(
      resolveSelectedShellOperation([completed, running], null, null)?.eventId
    ).toBe("shell-running");
  });

  it("honors a manual command selection while another command is running", () => {
    const completed = shellOperation({
      eventId: "shell-completed",
      output: "finished output",
    });
    const running = shellOperation({
      eventId: "shell-running",
      isCurrent: true,
      isLoading: true,
      streamOutput: "still running",
    });

    const selected = resolveSelectedShellOperation(
      [completed, running],
      running,
      "shell-completed"
    );

    expect(selected?.eventId).toBe("shell-completed");
    expect(selected?.output).toBe("finished output");
  });
});
