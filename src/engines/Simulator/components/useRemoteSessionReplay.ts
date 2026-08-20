import { useCallback, useMemo, useState } from "react";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { getIDEEventType } from "@src/engines/SessionCore/rendering/registry/toolRegistryDomain";
import {
  deriveIDEState,
  isGenericIDEFallbackToolEvent,
  matchesIDEEventRecord,
} from "@src/modules/WorkStation/CodeEditor/SessionReplay/config";
import { isExplorePanelTool } from "@src/modules/WorkStation/CodeEditor/SessionReplay/converters/exploreTypeResolver";
import { isShellSearchEvent } from "@src/modules/WorkStation/CodeEditor/SessionReplay/converters/shellSearchConverter";
import {
  resolveSelectedExploreOperation,
  resolveSelectedFileOperation,
  resolveSelectedShellOperation,
  resolveSelectedToolOperation,
} from "@src/modules/WorkStation/CodeEditor/SessionReplay/resolveSelectedOperations";
import {
  CODE_PANEL_MODE,
  type CodePanelMode,
  FILE_OPERATION_TYPE,
  FILE_PANEL_VIEW_MODE,
  type FilePanelViewMode,
  type IDEEventType,
  IDE_EVENT_TYPE,
} from "@src/modules/WorkStation/CodeEditor/SessionReplay/types";

export interface UseRemoteSessionReplayOptions {
  events: SessionEvent[];
  currentEventId?: string | null;
  /** Inclusive replay cursor on the full event list. */
  replayEndIndex?: number;
}

function resolveCurrentEventType(event: SessionEvent | null): IDEEventType {
  if (!event) return IDE_EVENT_TYPE.READ;
  const functionName = event.functionName || "";
  if (isExplorePanelTool(functionName) || isShellSearchEvent(event)) {
    return IDE_EVENT_TYPE.EXPLORE;
  }
  if (isGenericIDEFallbackToolEvent(event)) return IDE_EVENT_TYPE.TOOL;
  return getIDEEventType(functionName);
}

export function useRemoteSessionReplay({
  events,
  currentEventId = null,
  replayEndIndex,
}: UseRemoteSessionReplayOptions) {
  const resolvedEndIndex = useMemo(() => {
    if (events.length === 0) return -1;
    if (replayEndIndex === undefined) return events.length - 1;
    return Math.min(Math.max(replayEndIndex, 0), events.length - 1);
  }, [events, replayEndIndex]);

  const currentEvent = useMemo(() => {
    if (currentEventId) {
      return events.find((event) => event.id === currentEventId) ?? null;
    }
    return resolvedEndIndex >= 0 ? (events[resolvedEndIndex] ?? null) : null;
  }, [currentEventId, events, resolvedEndIndex]);
  const currentEventType = useMemo(
    () => resolveCurrentEventType(currentEvent),
    [currentEvent]
  );

  const appEvents = useMemo(() => {
    if (events.length === 0) return [];
    const endIndex = currentEventId
      ? events.findIndex((event) => event.id === currentEventId)
      : resolvedEndIndex;
    const boundedEndIndex =
      endIndex >= 0 ? endIndex : Math.max(resolvedEndIndex, 0);
    return events
      .slice(0, boundedEndIndex + 1)
      .filter((event) => matchesIDEEventRecord(event));
  }, [currentEventId, events, resolvedEndIndex]);

  const derivedState = useMemo(
    () => deriveIDEState(appEvents, currentEventId),
    [appEvents, currentEventId]
  );

  const {
    fileOperations: allFileOperations,
    shellOperations: allShellOperations,
    exploreOperations: allExploreOperations,
    toolOperations: allToolOperations,
  } = derivedState;

  const defaultViewMode = useMemo((): FilePanelViewMode => {
    if (currentEventType === IDE_EVENT_TYPE.WRITE) {
      return FILE_PANEL_VIEW_MODE.WRITE;
    }
    if (currentEventType === IDE_EVENT_TYPE.EXPLORE) {
      return FILE_PANEL_VIEW_MODE.EXPLORE;
    }
    if (currentEventType === IDE_EVENT_TYPE.SHELL) {
      return FILE_PANEL_VIEW_MODE.TERMINAL;
    }
    if (currentEventType === IDE_EVENT_TYPE.TOOL) {
      return FILE_PANEL_VIEW_MODE.TOOL;
    }
    if (allFileOperations.length > 0) {
      const lastFileOp = allFileOperations[allFileOperations.length - 1];
      return lastFileOp.type === FILE_OPERATION_TYPE.WRITE ||
        lastFileOp.type === FILE_OPERATION_TYPE.DELETE
        ? FILE_PANEL_VIEW_MODE.WRITE
        : FILE_PANEL_VIEW_MODE.EXPLORE;
    }
    return FILE_PANEL_VIEW_MODE.EXPLORE;
  }, [allFileOperations, currentEventType]);

  const [userViewModeOverride, setUserViewModeOverride] =
    useState<FilePanelViewMode | null>(null);
  const [prevEventId, setPrevEventId] = useState(currentEventId);
  const [userSelectedFileEventId, setUserSelectedFileEventId] = useState<
    string | null
  >(null);
  const [userSelectedShellEventId, setUserSelectedShellEventId] = useState<
    string | null
  >(null);
  const [userSelectedExploreEventId, setUserSelectedExploreEventId] = useState<
    string | null
  >(null);
  const [userSelectedToolEventId, setUserSelectedToolEventId] = useState<
    string | null
  >(null);

  if (prevEventId !== currentEventId) {
    setPrevEventId(currentEventId);
    if (userViewModeOverride !== null) setUserViewModeOverride(null);
    if (userSelectedFileEventId !== null) setUserSelectedFileEventId(null);
    if (userSelectedShellEventId !== null) setUserSelectedShellEventId(null);
    if (userSelectedExploreEventId !== null)
      setUserSelectedExploreEventId(null);
    if (userSelectedToolEventId !== null) setUserSelectedToolEventId(null);
  }

  const fileViewMode = useMemo((): FilePanelViewMode => {
    if (userViewModeOverride !== null) return userViewModeOverride;
    if (currentEventType === IDE_EVENT_TYPE.WRITE) {
      return FILE_PANEL_VIEW_MODE.WRITE;
    }
    if (currentEventType === IDE_EVENT_TYPE.EXPLORE) {
      return FILE_PANEL_VIEW_MODE.EXPLORE;
    }
    if (currentEventType === IDE_EVENT_TYPE.READ) {
      return FILE_PANEL_VIEW_MODE.EXPLORE;
    }
    if (currentEventType === IDE_EVENT_TYPE.SHELL) {
      return FILE_PANEL_VIEW_MODE.TERMINAL;
    }
    if (currentEventType === IDE_EVENT_TYPE.TOOL) {
      return FILE_PANEL_VIEW_MODE.TOOL;
    }
    return defaultViewMode;
  }, [currentEventType, defaultViewMode, userViewModeOverride]);

  const setFileViewMode = useCallback((mode: FilePanelViewMode) => {
    setUserViewModeOverride(mode);
  }, []);

  const filteredFileOperations = useMemo(() => {
    const typeFilter =
      fileViewMode === FILE_PANEL_VIEW_MODE.EXPLORE
        ? FILE_OPERATION_TYPE.READ
        : fileViewMode;
    return allFileOperations.filter(
      (operation) => operation.type === typeFilter
    );
  }, [allFileOperations, fileViewMode]);

  const selectedFileOperation = useMemo(
    () =>
      resolveSelectedFileOperation(
        allFileOperations,
        filteredFileOperations,
        null,
        userSelectedFileEventId,
        currentEventId ?? undefined
      ),
    [
      allFileOperations,
      filteredFileOperations,
      currentEventId,
      userSelectedFileEventId,
    ]
  );

  const selectedShellOperation = useMemo(
    () =>
      resolveSelectedShellOperation(
        allShellOperations,
        null,
        userSelectedShellEventId
      ),
    [allShellOperations, userSelectedShellEventId]
  );

  const selectedExploreOperation = useMemo(
    () =>
      resolveSelectedExploreOperation(
        allExploreOperations,
        userSelectedExploreEventId
      ),
    [allExploreOperations, userSelectedExploreEventId]
  );

  const selectedToolOperation = useMemo(
    () =>
      resolveSelectedToolOperation(allToolOperations, userSelectedToolEventId),
    [allToolOperations, userSelectedToolEventId]
  );

  const codePanelMode = useMemo((): CodePanelMode => {
    if (fileViewMode === FILE_PANEL_VIEW_MODE.TOOL) {
      return CODE_PANEL_MODE.TOOL;
    }
    if (fileViewMode === FILE_PANEL_VIEW_MODE.TERMINAL) {
      return CODE_PANEL_MODE.TERMINAL;
    }
    if (
      fileViewMode === FILE_PANEL_VIEW_MODE.EXPLORE &&
      selectedExploreOperation
    ) {
      return CODE_PANEL_MODE.EXPLORE;
    }
    return CODE_PANEL_MODE.FILE;
  }, [fileViewMode, selectedExploreOperation]);

  const selectFileOperation = useCallback((eventId: string) => {
    setUserSelectedFileEventId(eventId);
  }, []);

  const selectShellOperation = useCallback((eventId: string) => {
    setUserSelectedShellEventId(eventId);
  }, []);

  const selectExploreOperation = useCallback((eventId: string) => {
    setUserSelectedExploreEventId(eventId);
  }, []);

  const selectToolOperation = useCallback((eventId: string) => {
    setUserSelectedToolEventId(eventId);
  }, []);

  const hasAnyOperations =
    allFileOperations.length > 0 ||
    allExploreOperations.length > 0 ||
    allShellOperations.length > 0 ||
    allToolOperations.length > 0;

  return {
    currentEvent,
    currentEventType,
    fileViewMode,
    setFileViewMode,
    filteredFileOperations,
    allFileOperations,
    allShellOperations,
    allExploreOperations,
    allToolOperations,
    selectedFileOperation,
    selectedShellOperation,
    selectedExploreOperation,
    selectedToolOperation,
    codePanelMode,
    selectFileOperation,
    selectShellOperation,
    selectExploreOperation,
    selectToolOperation,
    hasAnyOperations,
  };
}
