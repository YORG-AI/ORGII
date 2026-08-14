/**
 * Per-turn gantt over one session: where the wall-clock time actually went.
 *
 * Rows come from the session turn index (metadata only, no event bodies), so
 * a long session costs one read regardless of transcript size. Rendering is
 * virtualized — a session with thousands of turns paints a viewport's worth.
 */
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { VirtualizedListBase } from "@src/components/TreeRow";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { formatDuration } from "@src/util/time/formatDuration";

import {
  SESSION_DERIVED_SUMMARY_HEIGHT_PX,
  SessionDerivedViewShell,
} from "./SessionDerivedViewShell";
import type { TimelineRow } from "./sessionViewProjections";
import { projectSessionTimeline } from "./sessionViewProjections";
import type { SessionDerivedViewProps } from "./types";

const ROW_HEIGHT = 34;

/** Failed and interrupted turns are the ones a reader is scanning for. */
function barToneFor(row: TimelineRow): string {
  if (row.status === "failed") return "bg-danger-6";
  if (row.interrupted || row.status === "interrupted") return "bg-warning-6";
  if (row.status === "working" || row.status === "pending")
    return "bg-primary-4";
  return "bg-primary-6";
}

const TimelineRowView: React.FC<{ row: TimelineRow }> = memo(({ row }) => {
  const { t } = useTranslation("sessions");
  return (
    <div
      // Same 900px cap the transcript rows use, so switching views does not
      // change how wide the session reads.
      className={`flex h-[34px] items-center gap-2 px-3 text-xs ${DETAIL_PANEL_TOKENS.contentWidth}`}
      data-testid="session-timeline-row"
      data-turn-id={row.turnId}
    >
      <span className="w-8 shrink-0 tabular-nums text-text-3">
        #{row.ordinal}
      </span>
      <span className="w-40 shrink-0 truncate text-text-2" title={row.preview}>
        {row.preview}
      </span>
      <span className="relative h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-fill-2">
        <span
          className={`absolute inset-y-0 rounded-full ${barToneFor(row)}`}
          style={{
            left: `${row.offsetRatio * 100}%`,
            width: `${row.widthRatio * 100}%`,
          }}
        />
      </span>
      <span className="w-14 shrink-0 text-right tabular-nums text-text-3">
        {row.durationMs === null ? "—" : formatDuration(row.durationMs)}
      </span>
      <span className="w-16 shrink-0 text-right tabular-nums text-text-3">
        {row.fileCount > 0
          ? t("chat.sessionViews.fileCount", {
              count: row.fileCount,
              defaultValue: "{{count}} files",
            })
          : ""}
      </span>
    </div>
  );
});

TimelineRowView.displayName = "TimelineRowView";

const SessionTimelineView: React.FC<SessionDerivedViewProps> = memo(
  ({ turns, loading, error, topInset }) => {
    const { t } = useTranslation("sessions");
    const timeline = useMemo(() => projectSessionTimeline(turns), [turns]);

    return (
      <SessionDerivedViewShell
        testId="session-timeline-view"
        loading={loading}
        error={error}
        isEmpty={timeline.rows.length === 0}
        emptyLabel={t("chat.sessionViews.timelineEmpty", {
          defaultValue: "No turns to show yet.",
        })}
        topInset={topInset}
        summary={t("chat.sessionViews.timelineSummary", {
          count: timeline.rows.length,
          duration: formatDuration(timeline.totalMs),
          defaultValue: "{{count}} turns over {{duration}}",
        })}
      >
        <VirtualizedListBase<TimelineRow>
          items={timeline.rows}
          itemHeight={ROW_HEIGHT}
          paddingTop={
            topInset ? topInset + SESSION_DERIVED_SUMMARY_HEIGHT_PX : undefined
          }
          computeItemKey={(row) => row.turnId}
          getItemPath={(row) => row.turnId}
          renderItem={(row) => <TimelineRowView row={row} />}
        />
      </SessionDerivedViewShell>
    );
  }
);

SessionTimelineView.displayName = "SessionTimelineView";

export default SessionTimelineView;
