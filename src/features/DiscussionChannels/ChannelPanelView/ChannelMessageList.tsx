/**
 * Virtualized channel transcript.
 *
 * Same construction as `HumanSessionView`: a `useVirtualizer` over a flat row
 * list, THRESHOLD-GATED so short transcripts render plainly (a virtualizer
 * over ten rows costs measurement passes and buys nothing, and plain rendering
 * keeps the DOM inspectable in tests), with `measureElement` handling the
 * dynamic heights markdown bodies produce. Rows are keyed by message id via
 * `getItemKey` so editing a body re-measures that row instead of shifting the
 * window.
 *
 * Date dividers are ordinary rows in the same index space (see
 * `channelFeedRows.ts`) — the virtualizer needs one flat list.
 *
 * Width comes from `CHAT_PANEL_WIDTH_TOKENS.contentMaxWidth` on an inner column
 * inside a `px-2` scroller — the exact shape `HumanSessionView` and
 * `ChatHistoryList` use — so a channel row lands on the same 800px centred
 * column as a session transcript row. Rows measure INSIDE that column, so
 * `measureElement` reports the constrained height, not the pane-wide one.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import React, { useEffect, useMemo, useRef } from "react";

import { CHAT_PANEL_WIDTH_TOKENS } from "@src/config/detailPanelTokens";

import ChannelMessageRow, { ChannelDateDivider } from "./ChannelMessageRow";
import {
  type ChannelFeedMessage,
  buildChannelFeedRows,
  resolveChannelDateDividerLabel,
} from "./channelFeedRows";

/** Below this row count the list renders plainly (no virtualizer). */
export const CHANNEL_VIRTUALIZATION_THRESHOLD = 30;
/** First-pass row height; `measureElement` corrects it per row. */
export const CHANNEL_ESTIMATED_ROW_HEIGHT = 64;

export interface ChannelMessageListProps {
  messages: readonly ChannelFeedMessage[];
  /** Author label for rows that carry none of their own (local plane). */
  authorLabel: string;
  /** Present for cloud feeds so legacy source-only pills can recover scope. */
  cloudOrgId?: string;
  onEdit:
    | ((messageId: string, body: string) => boolean | Promise<boolean>)
    | null;
  onDelete: ((messageId: string) => void) | null;
  /**
   * Rendered above the first row inside the transcript column — the cloud
   * plane's "load earlier messages" control lives here so paging stays inside
   * the scroller without the list owning the pagination policy.
   */
  header?: React.ReactNode;
}

const ChannelMessageList: React.FC<ChannelMessageListProps> = ({
  messages,
  authorLabel,
  cloudOrgId,
  onEdit,
  onDelete,
  header,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const rows = useMemo(() => buildChannelFeedRows(messages), [messages]);
  const rowCount = rows.length;
  const shouldVirtualize = rowCount > CHANNEL_VIRTUALIZATION_THRESHOLD;

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual exposes imperative helpers that cannot be memoized safely.
  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? rowCount : 0,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => CHANNEL_ESTIMATED_ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 8,
  });

  // Row count read at scroll time, so the effect below can key on the LAST
  // row's identity without going stale on the count.
  const rowCountRef = useRef(rowCount);
  useEffect(() => {
    rowCountRef.current = rowCount;
  }, [rowCount]);

  // Auto-scroll to the newest row, the transcript's resting position. Keyed on
  // the LAST row's id, not the row count: a new post lands in view, an edit
  // does not scroll, and PREPENDING an older page (cloud paging) leaves the
  // reader where they were instead of yanking them back to the bottom.
  const lastRowId = rows.length > 0 ? rows[rows.length - 1].id : null;
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const count = rowCountRef.current;
      if (shouldVirtualize && count > 0) {
        rowVirtualizer.scrollToIndex(count - 1, { align: "end" });
        return;
      }
      const container = scrollContainerRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [lastRowId, rowVirtualizer, shouldVirtualize]);

  const renderRow = (index: number): React.ReactNode => {
    const row = rows[index];
    if (!row) return null;
    if (row.kind === "divider") {
      return (
        <ChannelDateDivider
          label={resolveChannelDateDividerLabel(row.dateKey)}
        />
      );
    }
    return (
      <ChannelMessageRow
        message={row.message}
        grouped={row.grouped}
        authorLabel={authorLabel}
        cloudOrgId={cloudOrgId}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    );
  };

  return (
    <div
      ref={scrollContainerRef}
      className="scrollbar-overlay allow-select-deep min-h-0 flex-1 overflow-y-auto px-2"
      data-testid="channel-message-list"
    >
      <div
        className={`mx-auto min-h-full w-full px-2 pt-6 pb-36 ${CHAT_PANEL_WIDTH_TOKENS.contentMaxWidth}`}
      >
        {header}
        {shouldVirtualize ? (
          <div
            className="relative min-w-0"
            style={{ height: rowVirtualizer.getTotalSize() }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => (
              <div
                key={rows[virtualRow.index].id}
                ref={rowVirtualizer.measureElement}
                data-index={virtualRow.index}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {renderRow(virtualRow.index)}
              </div>
            ))}
          </div>
        ) : (
          rows.map((row, index) => (
            <React.Fragment key={row.id}>{renderRow(index)}</React.Fragment>
          ))
        )}
      </div>
    </div>
  );
};

export default ChannelMessageList;
