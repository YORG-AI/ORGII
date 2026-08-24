import { Loader2 } from "lucide-react";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import ProgressBar from "@src/components/ProgressBar";
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
  loadProgress?: {
    loadedEvents: number;
    totalEvents: number | null;
  } | null;
  onRetry?: () => void;
  /** Replay cursor event; file read/edit rows follow this during scrubbing. */
  currentEventId?: string | null;
  /** Inclusive replay cursor on the full event list. */
  replayEndIndex?: number;
}

export function RemoteSessionWorkspaceSurface({
  events,
  loadStatus,
  loadError,
  loadProgress = null,
  onRetry,
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
  const totalEvents = loadProgress?.totalEvents ?? null;
  const hasKnownTotal = totalEvents !== null;
  const progressDetail =
    loadProgress && hasKnownTotal
      ? t("cloud.download.events", {
          loaded: loadProgress.loadedEvents,
          total: totalEvents,
        })
      : null;
  const progressPercent =
    loadProgress && hasKnownTotal && totalEvents > 0
      ? Math.min(
          100,
          Math.round((loadProgress.loadedEvents / totalEvents) * 100)
        )
      : hasKnownTotal
        ? 100
        : 0;

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
    if (isLoading) {
      return (
        <div
          className="flex h-full min-h-0 w-full items-center justify-center p-6"
          data-testid="remote-workspace-streaming-progress"
        >
          <div className="flex w-64 max-w-full flex-col items-center gap-3 text-center">
            <Loader2
              aria-hidden
              className="h-5 w-5 animate-spin text-text-3 motion-reduce:animate-none"
            />
            <div className="text-sm font-medium text-text-2">
              {t("web.sessionPage.workstationLoading")}
            </div>
            <ProgressBar
              percent={progressPercent}
              indeterminate={!hasKnownTotal}
              ariaLabel={t("web.sessionPage.workstationLoading")}
              ariaValuetext={progressDetail ?? undefined}
              width="w-full"
              height="h-1"
            />
            {progressDetail ? (
              <div
                className="text-xs tabular-nums text-text-3"
                aria-live="polite"
              >
                {progressDetail}
              </div>
            ) : null}
          </div>
        </div>
      );
    }
    return (
      <Placeholder
        variant={loadStatus === "error" ? "error" : "empty"}
        placement="detail-panel"
        fillParentHeight
        title={
          loadStatus === "error"
            ? loadError || t("web.sessionPage.workstationLoadErrorFallback")
            : t("web.sessionPage.workstationEmptyTitle")
        }
        subtitle={
          loadStatus === "error"
            ? t("web.sessionPage.workstationLoadErrorSubtitle")
            : t("web.sessionPage.workstationEmptySubtitle")
        }
        onRetry={loadStatus === "error" ? onRetry : undefined}
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
      {loadProgress ? (
        <div
          className="shrink-0 border-b border-border-2 bg-bg-2"
          data-testid="remote-workspace-streaming-banner"
        >
          <ProgressBar
            percent={progressPercent}
            indeterminate={!hasKnownTotal}
            ariaLabel={t("web.sessionPage.workstationLoading")}
            ariaValuetext={progressDetail ?? undefined}
            height="h-0.5"
            width="w-full"
            trackColor="bg-transparent"
            className="rounded-none"
          />
          <div
            className="px-3 py-1 text-[11px] tabular-nums text-text-3"
            aria-live="polite"
          >
            {progressDetail ?? t("web.sessionPage.workstationLoading")}
          </div>
        </div>
      ) : null}
      {loadStatus === "error" ? (
        <div
          className="text-danger-7 flex shrink-0 items-center justify-between gap-2 border-b border-border-2 bg-danger-1 px-3 py-1.5 text-[11px]"
          role="status"
        >
          <span>{t("web.sessionPage.workstationRefreshFailedBanner")}</span>
          {onRetry ? (
            <Button variant="tertiary" size="mini" onClick={onRetry}>
              {t("web.sessionsPage.retry")}
            </Button>
          ) : null}
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
