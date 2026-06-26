import type { OrgtrackSessionFinalDiff } from "@src/api/tauri/lineage";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { FILE_OPERATION_TYPE, type FileOperationEntry } from "./types";

const ORGTRACK_FINAL_DIFF_EVENT_NAME = "orgtrack_final_diff";

function makeFinalDiffEvent(finalDiff: OrgtrackSessionFinalDiff): SessionEvent {
  const eventId = finalDiff.finalEventId ?? finalDiff.recordId;
  return {
    id: eventId,
    chunk_id: null,
    sessionId: finalDiff.sessionId,
    createdAt: finalDiff.computedAt,
    functionName: ORGTRACK_FINAL_DIFF_EVENT_NAME,
    uiCanonical: ORGTRACK_FINAL_DIFF_EVENT_NAME,
    actionType: "tool_call",
    args: { path: finalDiff.filePath },
    result: {
      oldContent: finalDiff.oldContent ?? undefined,
      newContent: finalDiff.newContent ?? undefined,
      diff: finalDiff.diff ?? undefined,
    },
    source: "assistant",
    displayText: finalDiff.filePath,
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "processed",
  };
}

export function finalDiffToFileOperation(
  finalDiff: OrgtrackSessionFinalDiff,
  isCurrent = false
): FileOperationEntry {
  const filePathParts = finalDiff.filePath.split("/");
  const fileName = filePathParts.at(-1) ?? finalDiff.filePath;
  return {
    filePath: finalDiff.filePath,
    fileName,
    directory: filePathParts.slice(0, -1).join("/") || "/",
    type: FILE_OPERATION_TYPE.WRITE,
    event: makeFinalDiffEvent(finalDiff),
    eventId: finalDiff.finalEventId ?? finalDiff.recordId,
    language: "text",
    oldContent: finalDiff.oldContent ?? undefined,
    newContent: finalDiff.newContent ?? undefined,
    diff: finalDiff.diff ?? undefined,
    linesAdded: finalDiff.linesAdded,
    linesRemoved: finalDiff.linesRemoved,
    isCurrent,
    relatedEventIds: [finalDiff.baselineEventId, finalDiff.finalEventId].filter(
      (eventId): eventId is string => Boolean(eventId)
    ),
    editCount: 1,
  };
}

export function finalDiffsToFileOperations(
  finalDiffs: OrgtrackSessionFinalDiff[]
): FileOperationEntry[] {
  return finalDiffs.map((finalDiff) => finalDiffToFileOperation(finalDiff));
}
