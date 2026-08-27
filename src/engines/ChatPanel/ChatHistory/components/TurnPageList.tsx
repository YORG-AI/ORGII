/**
 * TurnPageList
 *
 * Absolute-overlay list of all turn pages shown when the round selector
 * dropdown is open. Each row is `#N` + preview text + start/end clock range.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { ClockArrowDown, ClockArrowUp, X } from "lucide-react";
import React, { memo, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import { TabBarTrailingIconButton } from "@src/components/TabPill/TabBarTrailingIconButton";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";

import { stripExpandedPillContent } from "../../InputArea/utils/pillContentParser";
import type { ChatGroupMeta, UseChatGroupsReturn } from "../hooks";
import type { UseChatTurnPaginationReturn } from "../hooks/useChatTurnPagination";
import {
  formatCursorIdeTurnPageTimeLabel,
  formatTurnPageTimeLabel,
  getRoundPreviewText,
} from "../utils/turnPageFormatting";

interface TurnPageListProps {
  surfaceBgClass: string;
  /** Reserved space for the overlapping composer at the bottom of the pane. */
  bottomInset: number;
  pages: UseChatTurnPaginationReturn["pages"];
  groupHeaders: UseChatGroupsReturn["groupHeaders"];
  groupMeta: ChatGroupMeta[];
  currentPageIndex: number;
  turnPageSortAscending: boolean;
  onSelectTurnPage: (pageIndex: number) => void;
  /** Non-pagination history overlays supply their own list controls. */
  onToggleSort?: () => void;
  onClose?: () => void;
}

interface TurnPageItem {
  pageIndex: number;
  text: string;
  time: string;
}

// memo: parallels `TurnPaginationControls` (its sibling toolbar) so
// the dropdown overlay doesn't re-mount on every chat-history tick
// while it is open. All props are primitives or stable references
// from `useChatTurnPagination` / `useTurnPageNavigation`.
const TurnPageList: React.FC<TurnPageListProps> = memo(
  ({
    surfaceBgClass,
    bottomInset,
    pages,
    groupHeaders,
    groupMeta,
    currentPageIndex,
    turnPageSortAscending,
    onSelectTurnPage,
    onToggleSort,
    onClose,
  }) => {
    const { t } = useTranslation();

    const turnPageItems = useMemo<TurnPageItem[]>(() => {
      const items: TurnPageItem[] = pages.map((page, pageIndex) => {
        const header = groupHeaders[page.startGroupIndex];
        const meta = groupMeta[page.startGroupIndex];
        const rawPreviewText =
          page.cursorIdeSummary?.userPreview ??
          (header?.event?.displayText
            ? stripExpandedPillContent(String(header.event.displayText))
            : undefined) ??
          meta?.previewText;
        const text = getRoundPreviewText(rawPreviewText);
        return {
          pageIndex,
          text:
            text ||
            t("common:pagination.round", {
              current: pageIndex + 1,
            }),
          time: page.cursorIdeSummary
            ? formatCursorIdeTurnPageTimeLabel(page.cursorIdeSummary)
            : formatTurnPageTimeLabel(
                groupMeta.slice(page.startGroupIndex, page.endGroupIndex + 1)
              ),
        };
      });
      return turnPageSortAscending ? items : [...items].reverse();
    }, [groupHeaders, groupMeta, pages, t, turnPageSortAscending]);

    const scrollParentRef = useRef<HTMLDivElement>(null);
    // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual exposes stable imperative helpers that are intentionally used by this virtualized overlay.
    const rowVirtualizer = useVirtualizer({
      count: turnPageItems.length,
      getScrollElement: () => scrollParentRef.current,
      estimateSize: () => 36,
      overscan: 12,
    });

    return (
      <div
        className={`absolute inset-x-0 top-0 z-30 ${surfaceBgClass}`}
        style={bottomInset > 0 ? { bottom: bottomInset } : { bottom: 0 }}
      >
        <div
          className={`mx-auto h-full w-full px-2 ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
        >
          <div
            className={`${DROPDOWN_CLASSES.panel} flex h-full flex-col !overflow-hidden p-1`}
          >
            {onClose && (
              <div className="flex h-7 shrink-0 justify-end gap-px">
                {onToggleSort && (
                  <TabBarTrailingIconButton
                    title={t("common:actions.sort")}
                    tooltipPosition="bottom-end"
                    onClick={onToggleSort}
                  >
                    {turnPageSortAscending ? (
                      <ClockArrowDown size={14} strokeWidth={1.75} />
                    ) : (
                      <ClockArrowUp size={14} strokeWidth={1.75} />
                    )}
                  </TabBarTrailingIconButton>
                )}
                <TabBarTrailingIconButton
                  title={t("common:actions.close")}
                  tooltipPosition="bottom-end"
                  onClick={onClose}
                >
                  <X size={14} strokeWidth={1.75} />
                </TabBarTrailingIconButton>
              </div>
            )}
            <div
              ref={scrollParentRef}
              data-testid="turn-page-list"
              className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide"
            >
              <div
                className="relative w-full"
                style={{ height: rowVirtualizer.getTotalSize() }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualItem) => {
                  const item = turnPageItems[virtualItem.index];
                  if (!item) return null;
                  const { pageIndex, text, time } = item;
                  const isCurrent = pageIndex === currentPageIndex;
                  return (
                    <div
                      key={virtualItem.key}
                      ref={rowVirtualizer.measureElement}
                      data-index={virtualItem.index}
                      className="absolute left-0 top-0 w-full"
                      style={{
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                    >
                      <button
                        type="button"
                        data-testid="turn-page-list-item"
                        data-page-index={pageIndex}
                        className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left ${
                          isCurrent
                            ? DROPDOWN_CLASSES.itemSelected
                            : "text-text-2"
                        }`}
                        onClick={() => onSelectTurnPage(pageIndex)}
                      >
                        <span className="shrink-0 font-semibold tabular-nums">
                          #{pageIndex + 1}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{text}</span>
                        {time && (
                          <span className="shrink-0 text-xs tabular-nums text-text-3">
                            {time}
                          </span>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
);

TurnPageList.displayName = "TurnPageList";

export default TurnPageList;
