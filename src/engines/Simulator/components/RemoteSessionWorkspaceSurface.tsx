import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { WORK_STATION_PRIMARY_SIDEBAR } from "@src/config/workStationPrimarySidebar";
import type {
  SessionEvent,
  SessionLoadStatus,
} from "@src/engines/SessionCore/core/types";
import { CodePanel } from "@src/modules/WorkStation/CodeEditor/SessionReplay/CodePanel";
import { FileSidebar } from "@src/modules/WorkStation/CodeEditor/SessionReplay/FileSidebar";
import { FILE_PANEL_VIEW_MODE } from "@src/modules/WorkStation/CodeEditor/SessionReplay/types";
import {
  WorkStationShell,
  buildPrimarySidebarConfig,
} from "@src/modules/WorkStation/shared";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import { useRemoteSessionReplay } from "./useRemoteSessionReplay";

export interface RemoteSessionWorkspaceSurfaceProps {
  events: SessionEvent[];
  loadStatus: SessionLoadStatus;
  loadError: string | null;
  /** Replay cursor event; file read/edit rows follow this during scrubbing. */
  currentEventId?: string | null;
  /** Inclusive replay cursor on the full event list. */
  replayEndIndex?: number;
}

export function RemoteSessionWorkspaceSurface({
  events,
  loadStatus,
  loadError,
  currentEventId = null,
  replayEndIndex,
}: RemoteSessionWorkspaceSurfaceProps) {
  const { t } = useTranslation("navigation");
  const replay = useRemoteSessionReplay({
    events,
    currentEventId,
    replayEndIndex,
  });
  const [sidebarWidth, setSidebarWidth] = useState<number>(
    WORK_STATION_PRIMARY_SIDEBAR.defaultWidth
  );

  const sidebarFileViewMode =
    replay.fileViewMode === FILE_PANEL_VIEW_MODE.TOOL
      ? FILE_PANEL_VIEW_MODE.TERMINAL
      : replay.fileViewMode;

  const sidebar = useMemo(
    () => (
      <FileSidebar
        fileViewMode={sidebarFileViewMode}
        onFileViewModeChange={replay.setFileViewMode}
        fileOperations={replay.filteredFileOperations}
        exploreOperations={replay.allExploreOperations}
        shellOperations={replay.allShellOperations}
        toolOperations={replay.allToolOperations}
        selectedFileEventId={replay.selectedFileOperation?.eventId ?? null}
        selectedExploreEventId={
          replay.selectedExploreOperation?.eventId ?? null
        }
        selectedShellEventId={replay.selectedShellOperation?.eventId ?? null}
        selectedToolEventId={replay.selectedToolOperation?.eventId ?? null}
        activeSelectionKind={replay.codePanelMode}
        onSelectFileOperation={replay.selectFileOperation}
        onSelectExploreOperation={replay.selectExploreOperation}
        onSelectShellOperation={replay.selectShellOperation}
        onSelectToolOperation={replay.selectToolOperation}
        currentEventId={currentEventId ?? ""}
      />
    ),
    [currentEventId, replay, sidebarFileViewMode]
  );

  if (!replay.hasAnyOperations) {
    const isLoading = loadStatus === "idle" || loadStatus === "loading";
    return (
      <Placeholder
        variant={
          isLoading ? "loading" : loadStatus === "error" ? "error" : "empty"
        }
        placement="detail-panel"
        fillParentHeight
        title={
          loadStatus === "error"
            ? loadError || t("web.sessionPage.workstationLoadErrorFallback")
            : isLoading
              ? t("web.sessionPage.workstationLoading")
              : t("web.sessionPage.workstationEmptyTitle")
        }
        subtitle={
          isLoading
            ? undefined
            : loadStatus === "error"
              ? t("web.sessionPage.workstationLoadErrorSubtitle")
              : t("web.sessionPage.workstationEmptySubtitle")
        }
      />
    );
  }

  const mainContent = (
    <div className="ide-code-panel allow-select-deep flex min-h-0 flex-1 flex-col overflow-hidden">
      <CodePanel
        operation={replay.selectedFileOperation}
        exploreOperation={replay.selectedExploreOperation}
        shellOperation={replay.selectedShellOperation}
        toolOperation={replay.selectedToolOperation}
        mode={replay.codePanelMode}
        sessionReplayMode="simulation"
        isLoading={replay.currentEvent?.displayStatus === "running"}
      />
    </div>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      {loadStatus === "error" ? (
        <div
          className="text-danger-7 shrink-0 border-b border-border-2 bg-danger-1 px-3 py-1.5 text-[11px]"
          role="status"
        >
          {t("web.sessionPage.workstationRefreshFailedBanner")}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <WorkStationShell
          primarySidebarConfig={buildPrimarySidebarConfig({
            content: sidebar,
            size: sidebarWidth,
            onSizeChange: setSidebarWidth,
          })}
          content={mainContent}
          statusBar={null}
          appClassName="remote-session-workspace session-replay-ide"
        />
      </div>
    </div>
  );
}
