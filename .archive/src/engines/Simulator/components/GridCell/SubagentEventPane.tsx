/**
 * SubagentEventPane
 *
 * Prop-driven event renderer for subagent grid cells.
 * Routes CODE_EDITOR events to CodePanel (mini-IDE); everything else
 * goes to CompactEventView → ActivityChatItem (same as main chat panel).
 *
 * Uses the same Rust-registry classification and empty-event skip logic
 * as the main simulator (shared via skipEmptyRunningEvent).
 */
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { SessionEvent } from "@src/engines/SessionCore";
import { getIDEEventType } from "@src/engines/SessionCore/rendering/registry/toolRegistryDomain";
import { CodePanel } from "@src/modules/WorkStation/CodeEditor/SessionReplay/CodePanel";
import { deriveIDEState } from "@src/modules/WorkStation/CodeEditor/SessionReplay/config";

import { AppType } from "../../types/appTypes";
import { getAppTypeForSessionEvent } from "../../utils/eventToDockMapping";
import { resolveNonEmptyEvent } from "../../utils/skipEmptyRunningEvent";
import { CompactEventView } from "../CompactEventView";

interface SubagentEventPaneProps {
  events: SessionEvent[];
  currentEvent: SessionEvent | null;
  autoScroll?: boolean;
  isPlaying?: boolean;
  playbackSpeed?: number;
}

const SubagentEventPaneComponent: React.FC<SubagentEventPaneProps> = ({
  events,
  currentEvent: rawCurrentEvent,
  autoScroll = false,
  isPlaying = false,
  playbackSpeed = 1,
}) => {
  const { t } = useTranslation("sessions");
  const currentEvent = useMemo(
    () => resolveNonEmptyEvent(rawCurrentEvent, events),
    [rawCurrentEvent, events]
  );

  const appType = useMemo(
    () => (currentEvent ? getAppTypeForSessionEvent(currentEvent) : null),
    [currentEvent]
  );

  const ideState = useMemo(() => {
    if (appType !== AppType.CODE_EDITOR) return null;
    // events are already merged by the caller (BannerCell or IndependentGridCell)
    return deriveIDEState(events, currentEvent?.id ?? null);
  }, [appType, events, currentEvent?.id]);

  if (!currentEvent) {
    return (
      <div className="flex h-full items-center justify-center text-text-4">
        <span className="text-xs">{t("simulator.awaitingActivity")}</span>
      </div>
    );
  }

  if (appType === AppType.CODE_EDITOR && ideState) {
    // Match SessionReplayIDE `codePanelMode`: explore/search events must use
    // mode "explore" so CodePanel reads `exploreOperation`, not `operation`.
    const currentIdeType = getIDEEventType(currentEvent.functionName);
    const isExploreEvent = currentIdeType === "explore";

    const codePanelMode =
      ideState.fileViewMode === "tool" && ideState.selectedToolOperation
        ? ("tool" as const)
        : ideState.fileViewMode === "terminal" &&
            ideState.selectedShellOperation
          ? ("terminal" as const)
          : isExploreEvent && ideState.selectedExploreOperation
            ? ("explore" as const)
            : ideState.selectedFileOperation
              ? ("file" as const)
              : null;

    // If we resolved a valid mode, render CodePanel; otherwise fall through to
    // CompactEventView so the cell never shows a blank pane.
    if (codePanelMode !== null) {
      return (
        <CodePanel
          operation={ideState.selectedFileOperation}
          exploreOperation={ideState.selectedExploreOperation}
          shellOperation={ideState.selectedShellOperation}
          toolOperation={ideState.selectedToolOperation}
          mode={codePanelMode}
        />
      );
    }
  }

  return (
    <CompactEventView
      event={currentEvent}
      autoScroll={autoScroll}
      isPlaying={isPlaying}
      playbackSpeed={playbackSpeed}
    />
  );
};

export const SubagentEventPane = memo(SubagentEventPaneComponent);
SubagentEventPane.displayName = "SubagentEventPane";
