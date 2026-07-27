import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { APP_SUBTOOL } from "@src/engines/SessionCore/rendering/registry";
import {
  getAppSubtool,
  getAppTypeForTool,
} from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import { resolveToolName } from "@src/engines/SessionCore/rendering/registry/toolAliases";
import { getEventStatus } from "@src/util/data/converters/eventStatus";
import { getToolDisplayLabelFromRegistry } from "@src/util/ui/rendering/registryToolLabel";

import {
  convertShellSearchOperation,
  convertToExploreOperation,
  convertToFileOperation,
  convertToShellOperation,
} from "./converters";
import { isExplorePanelTool } from "./converters/exploreTypeResolver";
import type {
  FileOperationEntry,
  SimulatorIDEState,
  ToolOperationEntry,
} from "./types";

function replaceOrPrependByEventId<T extends { eventId: string }>(
  operations: T[],
  liveOperation: T
): T[] {
  const next = [...operations];
  const existingIndex = next.findIndex(
    (operation) => operation.eventId === liveOperation.eventId
  );

  if (existingIndex >= 0) {
    next[existingIndex] = liveOperation;
    return next;
  }

  return [liveOperation, ...next];
}

function overlayFileOperation(
  operations: FileOperationEntry[],
  liveOperation: FileOperationEntry
): FileOperationEntry[] {
  const next = [...operations];
  const existingIndex = next.findIndex(
    (operation) =>
      operation.eventId === liveOperation.eventId ||
      operation.relatedEventIds?.includes(liveOperation.eventId)
  );

  if (existingIndex >= 0) {
    const existing = next[existingIndex];
    // A still-running live event has no result payload yet — its converted
    // entry carries `content: undefined` and an event without `result`.
    // Spreading it over the existing entry would clobber the completed
    // payload (and the rehydration source `event`), blanking the viewer
    // until the user navigates away. Keep the richer payload of the two.
    const liveHasPayload =
      liveOperation.content !== undefined ||
      liveOperation.oldContent !== undefined ||
      liveOperation.newContent !== undefined ||
      liveOperation.diff !== undefined;
    next[existingIndex] = {
      ...existing,
      ...liveOperation,
      ...(liveHasPayload
        ? {}
        : {
            content: existing.content,
            contentStartLine: existing.contentStartLine,
            oldContent: existing.oldContent,
            newContent: existing.newContent,
            diff: existing.diff,
            event: existing.event ?? liveOperation.event,
          }),
      relatedEventIds: existing.relatedEventIds,
      relatedOperations: existing.relatedOperations,
      editCount: existing.editCount,
    };
    return next;
  }

  return [...next, liveOperation];
}

function convertToToolOperation(
  event: SessionEvent,
  isCurrent: boolean
): ToolOperationEntry {
  const status = getEventStatus(event) || event.displayStatus;

  return {
    toolName: event.functionName,
    displayName: getToolDisplayLabelFromRegistry(
      resolveToolName(event.functionName)
    ),
    event,
    eventId: event.id,
    isCurrent,
    isLoading: status === "running" || status === "pending",
    isFailed: status === "failed",
  };
}

export function applyLiveOperationOverlay(
  derivedState: Pick<
    SimulatorIDEState,
    | "fileOperations"
    | "shellOperations"
    | "exploreOperations"
    | "toolOperations"
  >,
  currentEvent: SessionEvent | null | undefined
): Pick<
  SimulatorIDEState,
  "fileOperations" | "shellOperations" | "exploreOperations" | "toolOperations"
> {
  if (!currentEvent) {
    return {
      fileOperations: derivedState.fileOperations,
      shellOperations: derivedState.shellOperations,
      exploreOperations: derivedState.exploreOperations,
      toolOperations: derivedState.toolOperations,
    };
  }

  if (isExplorePanelTool(currentEvent.functionName)) {
    const liveExploreOperation = convertToExploreOperation(currentEvent, true);
    return {
      fileOperations: derivedState.fileOperations,
      shellOperations: derivedState.shellOperations,
      exploreOperations: liveExploreOperation
        ? replaceOrPrependByEventId(
            derivedState.exploreOperations,
            liveExploreOperation
          )
        : derivedState.exploreOperations,
      toolOperations: derivedState.toolOperations,
    };
  }

  const subtool =
    getAppSubtool(currentEvent.functionName) ?? APP_SUBTOOL.OTHER_TOOL;

  if (subtool === APP_SUBTOOL.FILE_READ || subtool === APP_SUBTOOL.FILE_WRITE) {
    const liveFileOperation = convertToFileOperation(currentEvent, true);
    return {
      fileOperations: liveFileOperation
        ? overlayFileOperation(derivedState.fileOperations, liveFileOperation)
        : derivedState.fileOperations,
      shellOperations: derivedState.shellOperations,
      exploreOperations: derivedState.exploreOperations,
      toolOperations: derivedState.toolOperations,
    };
  }

  if (subtool === APP_SUBTOOL.SHELL) {
    const liveShellOperation = convertToShellOperation(currentEvent, true);
    // Grep/rg pipelines run through the shell overlay onto the explore list,
    // mirroring deriveIDEState's routing.
    const liveSearchOperation = liveShellOperation
      ? convertShellSearchOperation(liveShellOperation)
      : null;
    if (liveSearchOperation) {
      return {
        fileOperations: derivedState.fileOperations,
        shellOperations: derivedState.shellOperations,
        exploreOperations: replaceOrPrependByEventId(
          derivedState.exploreOperations,
          liveSearchOperation
        ),
        toolOperations: derivedState.toolOperations,
      };
    }
    return {
      fileOperations: derivedState.fileOperations,
      shellOperations: liveShellOperation
        ? replaceOrPrependByEventId(
            derivedState.shellOperations,
            liveShellOperation
          )
        : derivedState.shellOperations,
      exploreOperations: derivedState.exploreOperations,
      toolOperations: derivedState.toolOperations,
    };
  }

  if (
    getAppTypeForTool(currentEvent.functionName) !== null ||
    currentEvent.displayVariant !== "tool_call" ||
    currentEvent.source === "user"
  ) {
    return {
      fileOperations: derivedState.fileOperations,
      shellOperations: derivedState.shellOperations,
      exploreOperations: derivedState.exploreOperations,
      toolOperations: derivedState.toolOperations,
    };
  }

  const liveToolOperation = convertToToolOperation(currentEvent, true);
  return {
    fileOperations: derivedState.fileOperations,
    shellOperations: derivedState.shellOperations,
    exploreOperations: derivedState.exploreOperations,
    toolOperations: replaceOrPrependByEventId(
      derivedState.toolOperations,
      liveToolOperation
    ),
  };
}
