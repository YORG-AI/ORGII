/**
 * useSimulatorIDE Hook
 *
 * Manages combined state for file and shell operations in simulator IDE.
 * Now uses the SimulatorApps framework for consistent replay-aware state management.
 *
 * ARCHITECTURE: Uses SessionEvent from session store (SINGLE SOURCE OF TRUTH)
 *
 * Features:
 * - Shows ALL files read/edited up to current replay point
 * - Shows ALL shell commands up to current replay point
 * - Auto-selects current event when replay advances
 * - Jump-to-event functionality for navigation
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo, useState } from "react";

import { REPLAY_CONFIG } from "@src/config/workspace/replayConfig";
import {
  eventIndexAtom,
  navigateToEventAtom,
  replayBarValueAtom,
} from "@src/engines/SessionCore/core/atoms";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { simulatorEventsAtom } from "@src/engines/SessionCore/derived/simulatorEvents";

import { deriveIDEState, matchesIDEEventRecord } from "./config";
import { applyLiveOperationOverlay } from "./liveOperationOverlay";
import {
  resolveSelectedExploreOperation,
  resolveSelectedFileOperation,
  resolveSelectedShellOperation,
  resolveSelectedToolOperation,
} from "./resolveSelectedOperations";
import { bindShellOperationToCursor } from "./shellReplayState";
import type {
  ExploreOperationEntry,
  FileOperationEntry,
  FilePanelViewMode,
  ShellOperationEntry,
  SimulatorIDEState,
  ToolOperationEntry,
  UseSimulatorIDEOptions,
} from "./types";
import {
  FILE_OPERATION_TYPE,
  FILE_PANEL_VIEW_MODE,
  IDE_EVENT_TYPE,
} from "./types";

// ============================================
// Return Type
// ============================================

export interface UseCodeEditorReplayReturn {
  /** Current file panel view mode (read/write/search) */
  fileViewMode: FilePanelViewMode;
  /** Set file panel view mode */
  setFileViewMode: (mode: FilePanelViewMode) => void;
  /** Filtered file operations (by view mode and search query) */
  filteredFileOperations: FileOperationEntry[];
  /** All file operations (both read and write) */
  allFileOperations: FileOperationEntry[];
  /** All shell operations */
  allShellOperations: ShellOperationEntry[];
  /** All explore operations */
  allExploreOperations: ExploreOperationEntry[];
  /** All tool operations (other tools without specialized panels) */
  allToolOperations: ToolOperationEntry[];
  /** Currently selected file operation */
  selectedFileOperation: FileOperationEntry | null;
  /** Currently selected shell operation */
  selectedShellOperation: ShellOperationEntry | null;
  /** Currently selected explore operation */
  selectedExploreOperation: ExploreOperationEntry | null;
  /** Currently selected tool operation */
  selectedToolOperation: ToolOperationEntry | null;
  /** Select a file operation by event ID */
  selectFileOperation: (eventId: string) => void;
  /** Select a shell operation by event ID */
  selectShellOperation: (eventId: string) => void;
  /** Select an explore operation by event ID */
  selectExploreOperation: (eventId: string) => void;
  /** Select a tool operation by event ID */
  selectToolOperation: (eventId: string) => void;
  /** File filter query */
  fileFilterQuery: string;
  /** Set file filter query */
  setFileFilterQuery: (query: string) => void;
  /** Jump to a specific event in the replay */
  jumpToEvent: (eventId: string) => void;
  /** Whether currently in replay mode */
  isReplaying: boolean;
  /** The derived IDE state */
  state: SimulatorIDEState;
}

// ============================================
// Hook Implementation
// ============================================

export function useCodeEditorReplay(
  options: UseSimulatorIDEOptions
): UseCodeEditorReplayReturn {
  const {
    currentEventId,
    currentEventType,
    currentEvent,
    currentFileData,
    currentShellData,
  } = options;

  // ============================================
  // Session Store (Single Source of Truth)
  // ============================================

  const allSimulatorEvents = useAtomValue(simulatorEventsAtom);
  const eventIndex = useAtomValue(eventIndexAtom);
  const replayBarValue = useAtomValue(replayBarValueAtom);
  const navigateToEvent = useSetAtom(navigateToEventAtom);

  // ============================================
  // Replay State
  // ============================================

  const barValue = Array.isArray(replayBarValue)
    ? replayBarValue[0]
    : replayBarValue;
  const isReplaying = barValue > 0 && barValue < REPLAY_CONFIG.MAX_VALUE;

  // ============================================
  // Filter Events for IDE
  // ============================================

  // O(1) index map — rebuilt only when the simulator event list changes.
  const simulatorIdIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    allSimulatorEvents.forEach((event, idx) => map.set(event.id, idx));
    return map;
  }, [allSimulatorEvents]);

  // Find current event index using O(1) Map lookup.
  // Falls back to timestamp scan only for non-simulator events.
  const currentIndex = useMemo(() => {
    if (!currentEventId) return -1;

    const directIndex = simulatorIdIndexMap.get(currentEventId);
    if (directIndex !== undefined) return directIndex;

    const clickedEvent = eventIndex.get(currentEventId);
    if (!clickedEvent) return -1;

    const targetTime = clickedEvent.createdAt;
    for (let idx = allSimulatorEvents.length - 1; idx >= 0; idx--) {
      if (allSimulatorEvents[idx].createdAt <= targetTime) return idx;
    }
    return -1;
  }, [currentEventId, simulatorIdIndexMap, eventIndex, allSimulatorEvents]);

  // Find the index of the last IDE event at or before currentIndex.
  // When scrubbing through non-IDE events (chat, thinking) this stays
  // constant, keeping appEvents (and everything downstream) stable.
  const lastIdeEventIndex = useMemo(() => {
    for (let idx = currentIndex; idx >= 0; idx--) {
      const event = allSimulatorEvents[idx];
      if (event && matchesIDEEventRecord(event)) return idx;
    }
    return -1;
  }, [allSimulatorEvents, currentIndex]);

  const appEvents = useMemo(() => {
    if (lastIdeEventIndex === -1) return [];

    return allSimulatorEvents
      .slice(0, lastIdeEventIndex + 1)
      .filter((event) => matchesIDEEventRecord(event));
  }, [allSimulatorEvents, lastIdeEventIndex]);

  // ============================================
  // Derive IDE State
  // ============================================

  const derivedState = useMemo(
    () => deriveIDEState(appEvents, currentEventId),
    [appEvents, currentEventId]
  );

  // ============================================
  // Local UI State
  // ============================================

  // File view mode - derived from current event type or last file operation
  const defaultViewMode = useMemo((): FilePanelViewMode => {
    if (currentEventType === IDE_EVENT_TYPE.WRITE)
      return FILE_PANEL_VIEW_MODE.WRITE;
    if (currentEventType === IDE_EVENT_TYPE.EXPLORE)
      return FILE_PANEL_VIEW_MODE.EXPLORE;
    if (currentEventType === IDE_EVENT_TYPE.READ)
      return FILE_PANEL_VIEW_MODE.EXPLORE;
    if (currentEventType === IDE_EVENT_TYPE.SHELL)
      return FILE_PANEL_VIEW_MODE.TERMINAL;
    if (currentEventType === IDE_EVENT_TYPE.TOOL)
      return FILE_PANEL_VIEW_MODE.TOOL;

    // Use the last file operation's type
    if (derivedState.fileOperations.length > 0) {
      const lastFileOp =
        derivedState.fileOperations[derivedState.fileOperations.length - 1];
      return lastFileOp.type === FILE_OPERATION_TYPE.WRITE ||
        lastFileOp.type === FILE_OPERATION_TYPE.DELETE
        ? FILE_PANEL_VIEW_MODE.WRITE
        : FILE_PANEL_VIEW_MODE.EXPLORE;
    }

    return FILE_PANEL_VIEW_MODE.EXPLORE;
  }, [currentEventType, derivedState.fileOperations]);

  // Track user's explicit view mode override (null = follow event type)
  const [userViewModeOverride, setUserViewModeOverride] =
    useState<FilePanelViewMode | null>(null);

  // Track the last event ID to detect navigation
  // Using React's documented pattern for state updates during render
  const [prevEventId, setPrevEventId] = useState(currentEventId);

  // User-selected items (null means "use current event")
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

  // Clear user override + per-panel selections when navigating to a new event
  // (state update during render is safe). Without this, repeated jumps from
  // the chat panel to the same kind of op (e.g. multiple Listed-directory
  // cards) get stuck on the first one the user manually picked in a sidebar.
  if (prevEventId !== currentEventId) {
    setPrevEventId(currentEventId);
    if (userViewModeOverride !== null) {
      setUserViewModeOverride(null);
    }
    if (userSelectedFileEventId !== null) {
      setUserSelectedFileEventId(null);
    }
    if (userSelectedShellEventId !== null) {
      setUserSelectedShellEventId(null);
    }
    if (userSelectedExploreEventId !== null) {
      setUserSelectedExploreEventId(null);
    }
    if (userSelectedToolEventId !== null) {
      setUserSelectedToolEventId(null);
    }
  }

  // Compute the effective view mode based on event type or user override
  const fileViewMode = useMemo((): FilePanelViewMode => {
    if (userViewModeOverride !== null) {
      return userViewModeOverride;
    }

    if (currentEventType === IDE_EVENT_TYPE.WRITE)
      return FILE_PANEL_VIEW_MODE.WRITE;
    if (currentEventType === IDE_EVENT_TYPE.EXPLORE)
      return FILE_PANEL_VIEW_MODE.EXPLORE;
    if (currentEventType === IDE_EVENT_TYPE.READ)
      return FILE_PANEL_VIEW_MODE.EXPLORE;
    if (currentEventType === IDE_EVENT_TYPE.SHELL)
      return FILE_PANEL_VIEW_MODE.TERMINAL;
    if (currentEventType === IDE_EVENT_TYPE.TOOL)
      return FILE_PANEL_VIEW_MODE.TOOL;

    return defaultViewMode;
  }, [currentEventType, defaultViewMode, userViewModeOverride]);

  const setFileViewMode = useCallback((mode: FilePanelViewMode) => {
    setUserViewModeOverride(mode);
  }, []);

  // File filter
  const [fileFilterQuery, setFileFilterQuery] = useState("");

  // ============================================
  // Merge Current Event Data
  // ============================================

  // Create current file operation from pre-extracted data
  const currentFileOperation = useMemo<FileOperationEntry | null>(() => {
    if (!currentFileData?.filePath) return null;

    const parts = currentFileData.filePath.split("/");
    const fileName = parts.pop() || currentFileData.filePath;
    const directory = parts.join("/") || "/";

    const isWrite = currentEventType === IDE_EVENT_TYPE.WRITE;

    return {
      filePath: currentFileData.filePath,
      fileName: currentFileData.fileName || fileName,
      directory,
      type: isWrite ? FILE_OPERATION_TYPE.WRITE : FILE_OPERATION_TYPE.READ,
      event: {} as SessionEvent,
      eventId: currentEventId,
      isCurrent: true,
      content: currentFileData.content,
      oldContent: currentFileData.oldContent,
      newContent: currentFileData.newContent,
      diff: currentFileData.diff,
      oldStartLine: currentFileData.oldStartLine,
      newStartLine: currentFileData.newStartLine,
      writeHasBaselineContent: isWrite
        ? Boolean(
            currentFileData.oldContent &&
            String(currentFileData.oldContent).length > 0
          )
        : undefined,
      linesAdded: currentFileData.linesAdded,
      linesRemoved: currentFileData.linesRemoved,
      language: currentFileData.language,
    };
  }, [currentFileData, currentEventType, currentEventId]);

  // Create current shell operation from pre-extracted data
  const currentShellOperation = useMemo<ShellOperationEntry | null>(() => {
    if (!currentShellData?.command) return null;

    return {
      command: currentShellData.command,
      shortCommand: currentShellData.shortCommand || currentShellData.command,
      commandKeywords:
        currentShellData.commandKeywords || currentShellData.shortCommand || "",
      cwd: currentShellData.cwd,
      description: currentShellData.description,
      output: currentShellData.output,
      replayRef: currentEvent?.shellReplay?.ref,
      exitCode: currentShellData.exitCode,
      executionTime: currentShellData.executionTime,
      isLoading: currentShellData.isLoading,
      isError: currentShellData.isError,
      customOutputComponent: currentShellData.customOutputComponent,
      event: currentEvent ?? ({} as SessionEvent),
      eventId: currentEventId,
      isCurrent: true,
    };
  }, [currentShellData, currentEventId, currentEvent]);

  // ============================================
  // Merge Operations with Live Current Event
  // ============================================

  const {
    fileOperations: allFileOperations,
    shellOperations: allShellOperations,
    exploreOperations: allExploreOperations,
    toolOperations: allToolOperations,
  } = useMemo(
    () => applyLiveOperationOverlay(derivedState, currentEvent),
    [derivedState, currentEvent]
  );

  // ============================================
  // Filter File Operations
  // ============================================

  const filteredFileOperations = useMemo(() => {
    // Explore tab shows read operations; write tab shows write operations
    const typeFilter =
      fileViewMode === FILE_PANEL_VIEW_MODE.EXPLORE
        ? FILE_OPERATION_TYPE.READ
        : fileViewMode;
    let filtered = allFileOperations.filter((op) => op.type === typeFilter);

    if (fileFilterQuery.trim()) {
      const query = fileFilterQuery.toLowerCase();
      filtered = filtered.filter(
        (op) =>
          op.fileName.toLowerCase().includes(query) ||
          op.filePath.toLowerCase().includes(query)
      );
    }

    return filtered;
  }, [allFileOperations, fileViewMode, fileFilterQuery]);

  // ============================================
  // Selected Operations
  // Use user selection if set, otherwise default to current event
  // ============================================

  const selectedFileOperation = useMemo(
    () =>
      resolveSelectedFileOperation(
        allFileOperations,
        filteredFileOperations,
        currentFileOperation,
        userSelectedFileEventId,
        currentEventId
      ),
    [
      allFileOperations,
      filteredFileOperations,
      currentFileOperation,
      userSelectedFileEventId,
      currentEventId,
    ]
  );

  const selectedShellOperationBase = useMemo(
    () =>
      resolveSelectedShellOperation(
        allShellOperations,
        currentShellOperation,
        userSelectedShellEventId
      ),
    [allShellOperations, currentShellOperation, userSelectedShellEventId]
  );

  const atTimelineLiveEdge =
    currentIndex === allSimulatorEvents.length - 1 &&
    barValue === REPLAY_CONFIG.MAX_VALUE;

  const selectedShellOperation = useMemo(
    () =>
      bindShellOperationToCursor(
        selectedShellOperationBase,
        currentEvent,
        atTimelineLiveEdge
      ),
    [selectedShellOperationBase, currentEvent, atTimelineLiveEdge]
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

  // ============================================
  // Selection Callbacks
  //
  // Clicking a tab or sidebar entry within this app is local browsing: the
  // user is picking a past artifact to inspect without moving the replay
  // cursor or changing the global trajectory filter.
  // ============================================

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

  // ============================================
  // Jump to Event
  // ============================================

  const jumpToEvent = useCallback(
    (eventId: string) => {
      // Use session store navigation (handles bar value + current event)
      navigateToEvent(eventId);

      // Clear user selection so it follows the new current event
      setUserSelectedFileEventId(null);
      setUserSelectedShellEventId(null);
      setUserSelectedExploreEventId(null);
      setUserSelectedToolEventId(null);
    },
    [navigateToEvent]
  );

  // ============================================
  // Build Full State
  // ============================================

  const state: SimulatorIDEState = useMemo(
    () => ({
      currentEventId,
      appEvents,
      selectedItemId: selectedFileOperation?.eventId ?? null,
      isReplaying,
      fileOperations: allFileOperations,
      shellOperations: allShellOperations,
      exploreOperations: allExploreOperations,
      toolOperations: allToolOperations,
      selectedFileOperation,
      selectedShellOperation,
      selectedExploreOperation,
      selectedToolOperation,
      fileViewMode,
    }),
    [
      currentEventId,
      appEvents,
      selectedFileOperation,
      isReplaying,
      allFileOperations,
      allShellOperations,
      allExploreOperations,
      allToolOperations,
      selectedShellOperation,
      selectedExploreOperation,
      selectedToolOperation,
      fileViewMode,
    ]
  );

  // ============================================
  // Return
  // ============================================

  return {
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
    selectFileOperation,
    selectShellOperation,
    selectExploreOperation,
    selectToolOperation,
    fileFilterQuery,
    setFileFilterQuery,
    jumpToEvent,
    isReplaying,
    state,
  };
}

export { useCodeEditorReplay as useSimulatorIDE };
export default useCodeEditorReplay;
