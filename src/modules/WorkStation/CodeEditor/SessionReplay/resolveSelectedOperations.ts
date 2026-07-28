/**
 * resolveSelectedOperations
 *
 * Pure helpers to compute the "currently selected" operation for each panel
 * (file, shell, explore, tool) in the Simulator IDE replay hook.
 *
 * Extracted from useCodeEditorReplay.ts to keep that hook under 600 lines.
 */
import { resolveFileOperationPayload } from "./resolveFilePayload";
import { FILE_OPERATION_TYPE } from "./types";
import type {
  ExploreOperationEntry,
  FileOperationEntry,
  ShellOperationEntry,
  ToolOperationEntry,
} from "./types";

// ── File operation ────────────────────────────────────────────────────────────

function resolveConsolidatedFileEntry(
  found: FileOperationEntry,
  targetEventId: string
): FileOperationEntry {
  if (!found.relatedOperations || found.eventId === targetEventId) return found;

  const specificOp = found.relatedOperations.find(
    (op) => op.eventId === targetEventId
  );
  if (!specificOp) return found;

  const specificPayload = resolveFileOperationPayload(specificOp);
  if (
    !specificPayload ||
    (specificPayload.oldContent === undefined &&
      specificPayload.newContent === undefined &&
      specificPayload.content === undefined)
  ) {
    return found;
  }

  return {
    ...found,
    content: specificPayload.content,
    oldContent: specificPayload.oldContent,
    newContent: specificPayload.newContent,
    linesAdded: specificOp.linesAdded,
    linesRemoved: specificOp.linesRemoved,
    isCurrent: true,
  };
}

export function resolveSelectedFileOperation(
  allFileOperations: FileOperationEntry[],
  filteredFileOperations: FileOperationEntry[],
  currentFileOperation: FileOperationEntry | null,
  userSelectedFileEventId: string | null,
  currentEventId: string | undefined
): FileOperationEntry | null {
  const runningReadOperation = allFileOperations.find(
    (operation) =>
      operation.type === FILE_OPERATION_TYPE.READ && operation.isLoading
  );
  if (runningReadOperation) return runningReadOperation;

  if (userSelectedFileEventId) {
    const found = allFileOperations.find(
      (op) =>
        op.eventId === userSelectedFileEventId ||
        op.relatedEventIds?.includes(userSelectedFileEventId)
    );
    if (found)
      return resolveConsolidatedFileEntry(found, userSelectedFileEventId);
  }

  if (!userSelectedFileEventId && currentEventId) {
    const found = allFileOperations.find(
      (op) =>
        op.eventId === currentEventId ||
        op.relatedEventIds?.includes(currentEventId)
    );
    if (found) return resolveConsolidatedFileEntry(found, currentEventId);
  }

  if (currentFileOperation) return currentFileOperation;

  if (filteredFileOperations.length > 0) {
    return filteredFileOperations[filteredFileOperations.length - 1];
  }

  return null;
}

// ── Shell operation ───────────────────────────────────────────────────────────

export function resolveSelectedShellOperation(
  allShellOperations: ShellOperationEntry[],
  currentShellOperation: ShellOperationEntry | null,
  userSelectedShellEventId: string | null
): ShellOperationEntry | null {
  // An explicit click is local browsing and must win over the live command.
  // Otherwise every render snaps back to the running operation, making older
  // command rows appear unclickable. With no manual selection, keep following
  // the running command so streamOutput remains visible automatically.
  if (userSelectedShellEventId) {
    const found = allShellOperations.find(
      (op) => op.eventId === userSelectedShellEventId
    );
    if (found) return found;
  }

  const runningOp = allShellOperations.find((op) => op.isLoading);
  if (runningOp) return runningOp;

  if (currentShellOperation) return currentShellOperation;
  return allShellOperations[0] || null;
}

// ── Explore operation ─────────────────────────────────────────────────────────

export function resolveSelectedExploreOperation(
  allExploreOperations: ExploreOperationEntry[],
  userSelectedExploreEventId: string | null
): ExploreOperationEntry | null {
  if (userSelectedExploreEventId) {
    const found = allExploreOperations.find(
      (op) => op.eventId === userSelectedExploreEventId
    );
    if (found) return found;
  }

  const current = allExploreOperations.find((op) => op.isCurrent);
  if (current) return current;

  return allExploreOperations.length > 0
    ? allExploreOperations[allExploreOperations.length - 1]
    : null;
}

// ── Tool operation ────────────────────────────────────────────────────────────

export function resolveSelectedToolOperation(
  allToolOperations: ToolOperationEntry[],
  userSelectedToolEventId: string | null
): ToolOperationEntry | null {
  if (userSelectedToolEventId) {
    const found = allToolOperations.find(
      (op) => op.eventId === userSelectedToolEventId
    );
    if (found) return found;
  }

  const current = allToolOperations.find((op) => op.isCurrent);
  if (current) return current;

  return allToolOperations.length > 0
    ? allToolOperations[allToolOperations.length - 1]
    : null;
}
