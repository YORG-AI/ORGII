/**
 * StackedBlock - Collapsible group container for consecutive same-category blocks
 *
 * Renders N consecutive items as a vertical list inside a border-l indent.
 * Group header is collapsible; individual items handle their own collapse.
 *
 * Generic — works for any block type (browser actions, tool calls, exploration, etc.).
 *
 * Usage:
 *   <StackedBlock
 *     items={activities}
 *     renderItem={(activity, idx) => <ToolCallBlock defaultCollapsed {...} />}
 *     icon={<Globe />}
 *     label="Web Activity"
 *     groupSummary="3 actions"
 *   />
 */
import React, { memo, useEffect, useRef } from "react";

import { useBlockHeader } from "../useBlockLocate";
import { EventBlockHeader } from "./EventBlockHeader";
import { EventBlockHeaderIcon } from "./EventBlockHeaderIcon";
import {
  EventBlockHeaderSubtitle,
  EventBlockHeaderTitle,
} from "./EventBlockHeaderTextSlots";

const STACKED_BLOCK_CONTENT_MAX_HEIGHT_PX = 250;

// ============================================
// Types
// ============================================

export interface StackedBlockProps<T> {
  /** Array of items to display in the group */
  items: T[];
  /** Render function for each item — should return a regular block component */
  renderItem: (item: T, index: number) => React.ReactNode;
  /** Header icon (shown left of label) */
  icon?: React.ReactNode;
  /** Label shown in the header (e.g. "Browser", "Explored") */
  label?: string;
  /** Summary text shown after the label (e.g. "3 actions", "4 files, 2 searches") */
  groupSummary?: React.ReactNode;
  /** Start collapsed (default: true) */
  defaultCollapsed?: boolean;
  /** Collapse when this value changes from false to true. */
  collapseWhen?: boolean;
  /** Optional event ID used by the group header navigate icon. */
  eventId?: string;
  /** Optional content shown on the right side of the group header. */
  rightContent?: React.ReactNode;
}

// ============================================
// StackedBlock Component
// ============================================

function StackedBlockInner<T>({
  items,
  renderItem,
  icon,
  label,
  groupSummary,
  defaultCollapsed = true,
  collapseWhen,
  eventId,
  rightContent,
}: StackedBlockProps<T>) {
  const {
    isCollapsed,
    isHeaderHovered,
    setIsCollapsed,
    handleHeaderClick,
    handleHeaderMouseEnter,
    handleHeaderMouseLeave,
    handleLocate,
  } = useBlockHeader({ defaultCollapsed, collapseAllValue: true, eventId });
  const previousCollapseWhenRef = useRef(collapseWhen);

  useEffect(() => {
    if (previousCollapseWhenRef.current === false && collapseWhen === true) {
      setIsCollapsed(true);
    }
    previousCollapseWhenRef.current = collapseWhen;
  }, [collapseWhen, setIsCollapsed]);

  if (items.length === 0) return null;

  return (
    <div className="w-full max-w-full">
      <EventBlockHeader
        isCollapsed={isCollapsed}
        withHover={false}
        onClick={handleHeaderClick}
        onNavigate={eventId ? handleLocate : undefined}
        onMouseEnter={handleHeaderMouseEnter}
        onMouseLeave={handleHeaderMouseLeave}
        rightContent={rightContent}
      >
        <EventBlockHeaderIcon
          icon={icon || <span />}
          isCollapsed={isCollapsed}
          isHeaderHovered={isHeaderHovered}
          onToggle={handleHeaderClick}
          hasContent={true}
        />
        {label && <EventBlockHeaderTitle>{label}</EventBlockHeaderTitle>}
        {groupSummary && (
          <EventBlockHeaderSubtitle
            title={typeof groupSummary === "string" ? groupSummary : undefined}
          >
            {groupSummary}
          </EventBlockHeaderSubtitle>
        )}
      </EventBlockHeader>

      {!isCollapsed && (
        <div
          className="ml-[14px] overflow-y-auto border-l border-border-1 py-0.5"
          style={{ maxHeight: STACKED_BLOCK_CONTENT_MAX_HEIGHT_PX }}
        >
          <div className="flex flex-col gap-0.5 pl-3">
            {items.map((item, idx) => (
              <React.Fragment key={idx}>{renderItem(item, idx)}</React.Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const StackedBlock = memo(StackedBlockInner) as typeof StackedBlockInner;

export default StackedBlock;
