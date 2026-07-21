import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { buildFileOperationSequenceInfo } from "../fileOperationSequence";
import { FILE_OPERATION_TYPE, type FileOperationEntry } from "../types";

function operation(
  eventId: string,
  filePath: string,
  createdAt: string
): FileOperationEntry {
  const parts = filePath.split("/");
  const fileName = parts.pop() ?? filePath;
  return {
    eventId,
    filePath,
    fileName,
    directory: parts.join("/") || "/",
    type: FILE_OPERATION_TYPE.READ,
    isCurrent: false,
    event: {
      id: eventId,
      sessionId: "session-1",
      createdAt,
      functionName: "read_file",
      actionType: "tool_call",
      args: {},
      result: {},
      source: "assistant",
      displayText: "",
      displayStatus: "completed",
      displayVariant: "tool_call",
      activityStatus: "agent",
      chunk_id: null,
      uiCanonical: "",
    } satisfies SessionEvent,
  };
}

describe("buildFileOperationSequenceInfo", () => {
  it("numbers same-name files by event chronology and exposes their parent path", () => {
    const rootIgnore = operation(
      "root-ignore",
      "/repo/.gitignore",
      "2026-07-20T10:00:00.000Z"
    );
    const huskyIgnore = operation(
      "husky-ignore",
      "/repo/.husky/.gitignore",
      "2026-07-20T10:01:00.000Z"
    );

    const info = buildFileOperationSequenceInfo([huskyIgnore, rootIgnore]);

    expect(info.get("root-ignore")).toEqual({
      sequenceLabel: "#1",
      pathHint: "repo",
    });
    expect(info.get("husky-ignore")).toEqual({
      sequenceLabel: "#2",
      pathHint: ".husky",
    });
  });

  it("shows the chronological range for consolidated operations", () => {
    const first = operation(
      "edit-1",
      "/repo/index.tsx",
      "2026-07-20T10:00:00.000Z"
    );
    const second = operation(
      "edit-2",
      "/repo/index.tsx",
      "2026-07-20T10:02:00.000Z"
    );
    const other = operation(
      "other",
      "/repo/other.ts",
      "2026-07-20T10:01:00.000Z"
    );
    const consolidated = {
      ...second,
      relatedOperations: [first, second],
      editCount: 2,
    };

    const info = buildFileOperationSequenceInfo([consolidated, other]);

    expect(info.get("edit-2")?.sequenceLabel).toBe("#1–#3");
    expect(info.get("other")?.sequenceLabel).toBe("#2");
  });
});
