/**
 * SessionReplayIDE Component
 *
 * IDE-style layout matching WorkStation CodeEditor:
 * - Left: Full-height FileSidebar (Read/Edit/Search/Terminal tabs)
 * - Right: Code viewer / terminal output (shows content for selected item)
 *
 * Uses WorkStationShell for consistent layout with the interactive CodeEditor.
 * Integrated with SimulatorApps framework for replay-aware state management.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { SIMULATOR_PRIMARY_SIDEBAR } from "@src/config/simulatorPrimarySidebar";
import EventWrapper from "@src/engines/ChatPanel/adapters/EventWrapper";
import { getIDEEventType } from "@src/engines/SessionCore/rendering/registry/toolRegistryDomain";
import {
  simulatorIdeTerminalRevealRequestAtom,
  simulatorPrimarySidebarCollapsedAtom,
  simulatorPrimarySidebarPositionAtom,
  simulatorPrimarySidebarWidthAtom,
  simulatorPrimarySidebarWidthPersistAtom,
} from "@src/store/ui/simulatorAtom";
import type { BackendEvent } from "@src/types/session/steps";

import {
  type ReplayTab,
  SimulatorReplayChrome,
  type TimestampedReplayTab,
  WorkStationShell,
  buildPrimarySidebarConfig,
  capNewestWithActive,
  mergeNewestFirstByTimestamp,
} from "../../shared";
import { CodePanel } from "./CodePanel";
import { FileSidebar } from "./FileSidebar";
import { isGenericIDEFallbackToolEvent } from "./config";
import { isExplorePanelTool } from "./converters/exploreTypeResolver";
import {
  CODE_PANEL_MODE,
  FILE_OPERATION_TYPE,
  FILE_PANEL_VIEW_MODE,
  IDE_EVENT_TYPE,
  type SimulatorIDEProps,
} from "./types";
import { useCodeEditorReplay } from "./useCodeEditorReplay";
import { getExploreDisplayName } from "./utils/exploreDisplayUtils";
import { sidebarToolIcon } from "./utils/fileOpUtils";

const SessionReplayIDEComponent: React.FC<SimulatorIDEProps> = ({
  currentEvent,
  currentEventType: currentEventTypeProp,
  currentFileData,
  currentShellData,
  mode = "simulation",
}) => {
  const eventId = (currentEvent as unknown as { id?: string })?.id || "";
  const sessionEvent = currentEvent as unknown as Parameters<
    typeof isGenericIDEFallbackToolEvent
  >[0];
  const functionName = sessionEvent?.functionName || "";
  const currentEventType = isExplorePanelTool(functionName)
    ? IDE_EVENT_TYPE.EXPLORE
    : currentEventTypeProp ||
      (isGenericIDEFallbackToolEvent(sessionEvent)
        ? IDE_EVENT_TYPE.TOOL
        : getIDEEventType(functionName));
  const terminalRevealRequest = useAtomValue(
    simulatorIdeTerminalRevealRequestAtom
  );
  const primarySidebarCollapsed = useAtomValue(
    simulatorPrimarySidebarCollapsedAtom
  );
  const primarySidebarPosition = useAtomValue(
    simulatorPrimarySidebarPositionAtom
  );
  const primarySidebarWidth = useAtomValue(simulatorPrimarySidebarWidthAtom);
  const setPrimarySidebarWidthPersist = useSetAtom(
    simulatorPrimarySidebarWidthPersistAtom
  );

  const handlePrimarySidebarWidthChange = useCallback(
    (width: number) => {
      setPrimarySidebarWidthPersist(width);
    },
    [setPrimarySidebarWidthPersist]
  );

  const {
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
  } = useCodeEditorReplay({
    currentEventId: eventId,
    currentEventType,
    currentEvent: sessionEvent,
    currentFileData,
    currentShellData,
  });

  // Track whether user explicitly chose file or search in the explore tab.
  // Updated only by user clicks; auto-navigation uses currentEventType directly.
  const [userExploreChoice, setUserExploreChoice] = useState<
    "file" | "search" | null
  >(null);

  // Track whether user explicitly selected a tool item (under terminal tab)
  const [userPickedTool, setUserPickedTool] = useState(false);
  const lastTerminalRevealRequestRef = useRef(0);

  useEffect(() => {
    if (
      terminalRevealRequest === 0 ||
      terminalRevealRequest === lastTerminalRevealRequestRef.current
    ) {
      return;
    }
    lastTerminalRevealRequestRef.current = terminalRevealRequest;
    const timer = window.setTimeout(() => {
      setFileViewMode(FILE_PANEL_VIEW_MODE.TERMINAL);
      setUserPickedTool(false);
      const targetShell = selectedShellOperation ?? allShellOperations[0];
      if (targetShell) selectShellOperation(targetShell.eventId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    terminalRevealRequest,
    setFileViewMode,
    selectedShellOperation,
    allShellOperations,
    selectShellOperation,
  ]);

  // File tab — sidebar click lives inside the explore tab's file list, so we
  // only need to flip the explore/file vs search switch here. The sidebar
  // itself sets fileViewMode elsewhere.
  const handleFileSelect = useCallback(
    (selectedEventId: string) => {
      setUserExploreChoice("file");
      selectFileOperation(selectedEventId);
    },
    [selectFileOperation]
  );

  const handleShellSelect = useCallback(
    (selectedEventId: string) => {
      setUserPickedTool(false);
      selectShellOperation(selectedEventId);
    },
    [selectShellOperation]
  );

  const handleSearchSelect = useCallback(
    (selectedEventId: string) => {
      setUserExploreChoice("search");
      selectExploreOperation(selectedEventId);
    },
    [selectExploreOperation]
  );

  const handleToolSelect = useCallback(
    (selectedEventId: string) => {
      setUserPickedTool(true);
      selectToolOperation(selectedEventId);
    },
    [selectToolOperation]
  );

  // Mixed-kind tab click: the unified replay tab strip renders entries of
  // every kind, so a click may mean "switch to terminal view then pick this
  // shell op" or "switch to explore/search then pick this search", etc. Each
  // branch forwards to the existing per-kind handler AFTER forcing fileViewMode
  // to the matching pane, so CodePanel re-resolves its mode on the next render.
  // File tabs split on op.type so writes land on the Edit sidebar section and
  // reads land on Explore — matches what the sidebar would do on a direct click.
  const handleReplayTabClick = useCallback(
    (kind: ReplayTab["kind"], selectedEventId: string) => {
      switch (kind) {
        case "file": {
          const op = allFileOperations.find(
            (candidate) =>
              candidate.eventId === selectedEventId ||
              candidate.relatedEventIds?.includes(selectedEventId)
          );
          setFileViewMode(
            op?.type === FILE_OPERATION_TYPE.WRITE
              ? FILE_PANEL_VIEW_MODE.WRITE
              : FILE_PANEL_VIEW_MODE.EXPLORE
          );
          handleFileSelect(selectedEventId);
          return;
        }
        case "explore":
          setFileViewMode(FILE_PANEL_VIEW_MODE.EXPLORE);
          handleSearchSelect(selectedEventId);
          return;
        case "terminal":
          setFileViewMode(FILE_PANEL_VIEW_MODE.TERMINAL);
          handleShellSelect(selectedEventId);
          return;
        case "tool":
          setFileViewMode(FILE_PANEL_VIEW_MODE.TOOL);
          handleToolSelect(selectedEventId);
          return;
      }
    },
    [
      allFileOperations,
      setFileViewMode,
      handleFileSelect,
      handleSearchSelect,
      handleShellSelect,
      handleToolSelect,
    ]
  );

  const exploreSelection =
    currentEventType === IDE_EVENT_TYPE.EXPLORE
      ? "search"
      : (userExploreChoice ?? "file");

  // When user explicitly clicks a tool in the terminal tab's "Other Tools" section,
  // override the code panel to show the tool. Auto-navigation to a non-tool event
  // clears this because currentEventType drives fileViewMode, resetting the tab.
  const showToolInTerminalTab =
    userPickedTool &&
    selectedToolOperation &&
    fileViewMode === FILE_PANEL_VIEW_MODE.TERMINAL;

  const codePanelMode =
    fileViewMode === FILE_PANEL_VIEW_MODE.TOOL || showToolInTerminalTab
      ? CODE_PANEL_MODE.TOOL
      : fileViewMode === FILE_PANEL_VIEW_MODE.TERMINAL
        ? CODE_PANEL_MODE.TERMINAL
        : fileViewMode === FILE_PANEL_VIEW_MODE.EXPLORE &&
            exploreSelection === "search" &&
            selectedExploreOperation
          ? CODE_PANEL_MODE.EXPLORE
          : CODE_PANEL_MODE.FILE;

  // Sidebar highlight single-source-of-truth: only the section whose selection
  // currently drives CodePanel renders the primary-1 row fill. Every other
  // section's `selectedId` is nulled out inside FileSidebar. The blue agent
  // dot is driven separately by agentSelectedIds and is unaffected.
  // NOTE: codePanelMode is already the exact 4-value kind FileSidebar expects
  // (file/explore/terminal/tool) — both sections of the "file" kind (read and
  // write) can share the same key because a given event is only ever one type.

  const primarySidebarConfig = useMemo(() => {
    // FileSidebar's "terminal" tab hosts both shell ops AND "other tools"
    // (tool ops). "tool" is not a standalone sidebar tab key, so map it to
    // "terminal" so the active tab highlights correctly.
    const sidebarFileViewMode =
      fileViewMode === FILE_PANEL_VIEW_MODE.TOOL
        ? FILE_PANEL_VIEW_MODE.TERMINAL
        : fileViewMode;
    return buildPrimarySidebarConfig({
      content: (
        <FileSidebar
          fileViewMode={sidebarFileViewMode}
          onFileViewModeChange={setFileViewMode}
          fileOperations={filteredFileOperations}
          exploreOperations={allExploreOperations}
          shellOperations={allShellOperations}
          toolOperations={allToolOperations}
          selectedFileEventId={selectedFileOperation?.eventId || null}
          selectedExploreEventId={selectedExploreOperation?.eventId || null}
          selectedShellEventId={selectedShellOperation?.eventId || null}
          selectedToolEventId={selectedToolOperation?.eventId || null}
          activeSelectionKind={codePanelMode}
          onSelectFileOperation={handleFileSelect}
          onSelectExploreOperation={handleSearchSelect}
          onSelectShellOperation={handleShellSelect}
          onSelectToolOperation={handleToolSelect}
          currentEventId={eventId}
        />
      ),
      collapsed: primarySidebarCollapsed,
      size: primarySidebarWidth,
      onSizeChange: handlePrimarySidebarWidthChange,
      minSize: SIMULATOR_PRIMARY_SIDEBAR.minWidth,
      maxSize: SIMULATOR_PRIMARY_SIDEBAR.maxWidth,
      resetSize: SIMULATOR_PRIMARY_SIDEBAR.defaultWidth,
    });
  }, [
    fileViewMode,
    setFileViewMode,
    filteredFileOperations,
    allExploreOperations,
    allShellOperations,
    allToolOperations,
    selectedFileOperation?.eventId,
    selectedExploreOperation?.eventId,
    selectedShellOperation?.eventId,
    selectedToolOperation?.eventId,
    codePanelMode,
    handleFileSelect,
    handleSearchSelect,
    handleShellSelect,
    handleToolSelect,
    eventId,
    primarySidebarCollapsed,
    primarySidebarWidth,
    handlePrimarySidebarWidthChange,
  ]);

  // Build a UNIFIED newest-first timeline across every op kind. Each kind
  // produces entries in its own shape (file / explore / terminal / tool),
  // they're sorted by the underlying SessionEvent.createdAt, and then capped
  // at MAX_REPLAY_TABS (always including the currently-active entry so the
  // selected tab stays visible even if it's older than the cap).
  const replayTabsOrdered = useMemo<ReplayTab[]>(() => {
    const fileTabs: TimestampedReplayTab[] = allFileOperations.map((op) => ({
      eventId: op.eventId,
      kind: "file",
      label: op.fileName,
      title: op.filePath,
      createdAt: op.event?.createdAt ?? "",
    }));
    const exploreTabs: TimestampedReplayTab[] = allExploreOperations.map(
      (op) => {
        const label = getExploreDisplayName(op) || op.query || "search";
        return {
          eventId: op.eventId,
          kind: "explore",
          label,
          title: op.query || label,
          createdAt: op.event?.createdAt ?? "",
          isLoading: op.isLoading,
        };
      }
    );
    const shellTabs: TimestampedReplayTab[] = allShellOperations.map((op) => {
      const label =
        op.description || op.commandKeywords || op.shortCommand || op.command;
      return {
        eventId: op.eventId,
        kind: "terminal",
        label,
        title: op.command || label,
        createdAt: op.event?.createdAt ?? "",
        isLoading: op.isLoading,
      };
    });
    const toolTabs: TimestampedReplayTab[] = allToolOperations.map((op) => ({
      eventId: op.eventId,
      kind: "tool",
      label: op.displayName,
      title: op.toolName,
      icon: sidebarToolIcon(op.event?.functionName),
      createdAt: op.event?.createdAt ?? "",
      isLoading: op.isLoading,
    }));

    return mergeNewestFirstByTimestamp([
      fileTabs,
      exploreTabs,
      shellTabs,
      toolTabs,
    ]);
  }, [
    allFileOperations,
    allExploreOperations,
    allShellOperations,
    allToolOperations,
  ]);

  // The active tab mirrors whichever selection drives the current CodePanel
  // mode — so the strip highlights the tab corresponding to what's on screen,
  // regardless of kind.
  const replayActiveEventId = useMemo<string | null>(() => {
    switch (codePanelMode) {
      case CODE_PANEL_MODE.FILE:
        return selectedFileOperation?.eventId ?? null;
      case CODE_PANEL_MODE.EXPLORE:
        return selectedExploreOperation?.eventId ?? null;
      case CODE_PANEL_MODE.TERMINAL:
        return selectedShellOperation?.eventId ?? null;
      case CODE_PANEL_MODE.TOOL:
        return selectedToolOperation?.eventId ?? null;
    }
    return null;
  }, [
    codePanelMode,
    selectedFileOperation?.eventId,
    selectedExploreOperation?.eventId,
    selectedShellOperation?.eventId,
    selectedToolOperation?.eventId,
  ]);

  const replayTabs = useMemo(
    () => capNewestWithActive(replayTabsOrdered, replayActiveEventId),
    [replayTabsOrdered, replayActiveEventId]
  );

  // Map eventId → kind so the click handler can dispatch to the right
  // select*Operation + fileViewMode transition. Built from the capped list
  // since that's the only set of tabs that's clickable.
  const tabKindByEventId = useMemo(() => {
    const map = new Map<string, ReplayTab["kind"]>();
    for (const tab of replayTabs) map.set(tab.eventId, tab.kind);
    return map;
  }, [replayTabs]);

  const onReplayTabClick = useCallback(
    (clickedEventId: string) => {
      const kind = tabKindByEventId.get(clickedEventId);
      if (!kind) return;
      handleReplayTabClick(kind, clickedEventId);
    },
    [tabKindByEventId, handleReplayTabClick]
  );

  const onReplayTabDoubleClick = useCallback(
    (clickedEventId: string) => {
      const op = allFileOperations.find(
        (candidate) =>
          candidate.eventId === clickedEventId ||
          candidate.relatedEventIds?.includes(clickedEventId)
      );
      if (!op?.filePath) return;

      document.dispatchEvent(
        new CustomEvent("file-pill-click", {
          detail: {
            filePath: op.filePath,
            fileName: op.fileName,
          },
        })
      );
    },
    [allFileOperations]
  );

  const isCurrentEventLoading = sessionEvent?.displayStatus === "running";

  const mainContent = (
    <div className="ide-code-panel allow-select-deep flex min-h-0 flex-1 flex-col overflow-hidden">
      <CodePanel
        operation={selectedFileOperation}
        exploreOperation={selectedExploreOperation}
        shellOperation={selectedShellOperation}
        toolOperation={selectedToolOperation}
        mode={codePanelMode}
        sessionReplayMode={mode}
        isLoading={isCurrentEventLoading}
      />
    </div>
  );

  return (
    <EventWrapper
      event={currentEvent as unknown as BackendEvent}
      mode={mode}
      expand={true}
      padding="p-0"
    >
      <SimulatorReplayChrome
        tabs={replayTabs}
        activeEventId={replayActiveEventId}
        onTabClick={onReplayTabClick}
        onTabDoubleClick={onReplayTabDoubleClick}
      >
        <div className="flex min-h-0 flex-1">
          <WorkStationShell
            primarySidebarConfig={primarySidebarConfig}
            content={mainContent}
            statusBar={null}
            layoutMode={primarySidebarPosition === "right" ? "right" : "left"}
            appClassName="session-replay-ide"
          />
        </div>
      </SimulatorReplayChrome>
    </EventWrapper>
  );
};

export const SessionReplayIDE = memo(SessionReplayIDEComponent);
SessionReplayIDE.displayName = "SessionReplayIDE";

export { SessionReplayIDE as SimulatorIDE };
export default SessionReplayIDE;
