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
import { CHAT_PANEL_WIDTH_TOKENS } from "@src/config/detailPanelTokens";
import { formatDuration } from "@src/util/time/formatDuration";

import { SessionDerivedViewShell } from "./SessionDerivedViewShell";
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

interface TimelineRowViewProps {
  row: TimelineRow;
  timeFormatter: Intl.DateTimeFormat;
}

const TimelineRowView: React.FC<TimelineRowViewProps> = memo(
  ({ row, timeFormatter }) => {
    const { t } = useTranslation("sessions");
    const startLabel = timeFormatter.format(new Date(row.startedAtMs));
    const endLabel =
      row.endedAtMs === null
        ? "—"
        : timeFormatter.format(new Date(row.endedAtMs));
    const rangeLabel = `${startLabel} ~ ${endLabel}`;
    const durationLabel =
      row.durationMs === null ? "—" : formatDuration(row.durationMs);
    const inferredTimingLabel = row.endInferred
      ? t("chat.sessionViews.inferredTiming", {
          defaultValue: "End inferred from the next turn",
        })
      : undefined;

    return (
      <div
        // Same 800px cap the transcript rows use, so switching views does not
        // change how wide the session reads.
        className={`flex h-[34px] items-center gap-2 px-3 text-xs ${CHAT_PANEL_WIDTH_TOKENS.contentWidth}`}
        data-testid="session-timeline-row"
        data-turn-id={row.turnId}
      >
        <span className="w-8 shrink-0 text-text-3 tabular-nums">
          #{row.ordinal}
        </span>
        <span
          className="w-40 shrink-0 truncate text-text-2"
          title={row.preview}
        >
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
        <span className="w-14 shrink-0 text-right text-text-3 tabular-nums">
          {durationLabel}
        </span>
        <span
          className="w-48 shrink-0 text-right text-text-3 tabular-nums"
          data-testid="session-timeline-range"
          data-start-ms={row.startedAtMs}
          data-end-ms={row.endedAtMs ?? undefined}
          title={inferredTimingLabel}
        >
          {rangeLabel}
        </span>
      </div>
    );
  }
);

TimelineRowView.displayName = "TimelineRowView";

const SessionTimelineView: React.FC<SessionDerivedViewProps> = memo(
  ({ turns, loading, error, topInset }) => {
    const { t, i18n } = useTranslation("sessions");
    const timeline = useMemo(() => projectSessionTimeline(turns), [turns]);
    const timeFormatter = useMemo(
      () =>
        new Intl.DateTimeFormat(i18n.resolvedLanguage, {
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        }),
      [i18n.resolvedLanguage]
    );

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
          computeItemKey={(row) => row.turnId}
          getItemPath={(row) => row.turnId}
          renderItem={(row) => (
            <TimelineRowView row={row} timeFormatter={timeFormatter} />
          )}
        />
      </SessionDerivedViewShell>
    );
  }
);

SessionTimelineView.displayName = "SessionTimelineView";

export default SessionTimelineView;
