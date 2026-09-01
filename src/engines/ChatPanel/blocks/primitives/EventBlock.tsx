/**
 * EventBlock - Reusable collapsible block component for session event items
 *
 * Provides consistent styling for terminal blocks, code blocks, file lists, etc.
 * All styling uses inline Tailwind for easy maintenance.
 *
 * **File / stack lists (glob, ls flat, manage_workspace, search_files):** use
 * `EventBlockExpandableStackList` — rounded fill-2 shell (`layout="full"`) or body-only inside a
 * parent shell (`layout="body"`), wrapping `ExpandableItemList` with shared section padding.
 */
import React, { ReactNode } from "react";

import type { ExpandableItemListProps } from "./ExpandableItemList";
import ExpandableItemList from "./ExpandableItemList";
import {
  EVENT_BLOCK_BORDER_CLASSES,
  EVENT_BLOCK_CONTENT_BG,
  EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES,
  getEventBlockContentClasses,
} from "./config";

// ============================================
// Shared Tailwind Classes (for consistency)
// ============================================

/**
 * Standard container classes for all chat blocks
 */
export const EVENT_BLOCK_CONTAINER_CLASSES = `w-full max-w-full overflow-hidden rounded-lg ${EVENT_BLOCK_BORDER_CLASSES} ${EVENT_BLOCK_CONTENT_BG} transition-all duration-200`;

/**
 * Standard header classes for all chat blocks
 * @param isCollapsed - Whether the block is collapsed
 * @returns className string
 */
/** Header row for the EventBlock shell (distinct from primitives/config `getEventBlockHeaderClasses`). */
export const getEventBlockShellHeaderClasses = (_isCollapsed: boolean) =>
  `flex cursor-pointer items-center justify-between ${EVENT_BLOCK_CONTENT_BG} p-2 transition-all duration-150`;

/**
 * Standard button classes for header action buttons (copy, expand, etc.)
 * @param isVisible - Whether the button is visible (usually on hover)
 * @returns className string
 */
export const getEventBlockHeaderButtonClasses = (isVisible: boolean) =>
  `flex h-6 w-6 cursor-pointer items-center justify-center rounded text-text-3 transition-all duration-150 hover:text-text-1 ${
    isVisible ? "opacity-100" : "opacity-0"
  }`;

/**
 * Standard expand/collapse button classes
 * Note: No background hover, only text color change from text-2 to text-1
 */
export const EVENT_BLOCK_EXPAND_BUTTON_CLASSES =
  "flex cursor-pointer select-none items-center justify-center gap-1.5 px-3 pb-1.5 text-[11px] text-text-2 transition-colors duration-150 hover:text-text-1";

// ============================================
// EventBlockExpandableStackList — file / tool stack lists
// ============================================

/** Padding shell around the list — not exported; only used by EventBlockExpandableStackList. */
function StackListSection({
  children,
  className = "",
  withAnimation = true,
}: {
  children: ReactNode;
  className?: string;
  withAnimation?: boolean;
}) {
  const classes = [
    withAnimation ? "animate-fade-in" : "",
    getEventBlockContentClasses({ padding: "px-0 pb-1" }),
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <div className={classes}>{children}</div>;
}

export type EventBlockExpandableStackListProps<T> =
  ExpandableItemListProps<T> & {
    /**
     * - `full` — fill-2 rounded shell + section + list (e.g. Glob under transparent header).
     * - `body` — section + list only; parent already provides shell (ToolCall, Explore flat inside shell).
     */
    layout: "full" | "body";
    /** When `layout` is `full`, add `animate-fade-in` on the shell. Default true. */
    shellWithAnimation?: boolean;
    /** Section fade-in; when omitted: full layout uses `!shellWithAnimation`; body defaults to false (Explore passes true). */
    sectionWithAnimation?: boolean;
  };

function EventBlockExpandableStackListInner<T>({
  layout,
  shellWithAnimation = true,
  sectionWithAnimation,
  ...expandableProps
}: EventBlockExpandableStackListProps<T>) {
  const resolvedSectionAnim =
    sectionWithAnimation ?? (layout === "full" ? !shellWithAnimation : false);

  const inner = (
    <StackListSection withAnimation={resolvedSectionAnim}>
      <ExpandableItemList {...expandableProps} withBorder={false} />
    </StackListSection>
  );

  if (layout === "body") {
    return inner;
  }

  const shellClasses = [
    EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES,
    shellWithAnimation ? "animate-fade-in" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return <div className={shellClasses}>{inner}</div>;
}

export const EventBlockExpandableStackList = React.memo(
  EventBlockExpandableStackListInner
) as <T>(
  props: EventBlockExpandableStackListProps<T>
) => React.ReactElement | null;

// ============================================
// EventBlock — generic collapsible wrapper
// ============================================

export interface EventBlockProps {
  /** Container className (additional classes to merge with defaults) */
  containerClassName?: string;
  /** Header className (additional classes to merge with defaults) */
  headerClassName?: string;
  /** Whether the block is collapsed */
  isCollapsed?: boolean;
  /** Callback when collapse state changes */
  onToggleCollapse?: () => void;
  /** Header left content (icon, title, etc.) */
  headerLeft: ReactNode;
  /** Header right content (action buttons) */
  headerRight?: ReactNode;
  /** Main content (shown when not collapsed) */
  children: ReactNode;
  /** Whether the header is currently hovered */
  isHeaderHovered?: boolean;
  /** Callback when header hover state changes */
  onHeaderHoverChange?: (hovered: boolean) => void;
}

/**
 * Reusable collapsible event block with consistent styling
 */
export const EventBlock: React.FC<EventBlockProps> = ({
  containerClassName = "",
  headerClassName = "",
  isCollapsed = false,
  onToggleCollapse,
  headerLeft,
  headerRight,
  children,
  onHeaderHoverChange,
}) => {
  const handleHeaderClick = () => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    onToggleCollapse?.();
  };

  return (
    <div className={`${EVENT_BLOCK_CONTAINER_CLASSES} ${containerClassName}`}>
      {/* Header */}
      <div
        className={`${getEventBlockShellHeaderClasses(isCollapsed)} ${headerClassName}`}
        onClick={onToggleCollapse ? handleHeaderClick : undefined}
        onMouseEnter={() => onHeaderHoverChange?.(true)}
        onMouseLeave={() => onHeaderHoverChange?.(false)}
      >
        {/* Left content */}
        <div className="flex min-w-0 flex-1 items-center gap-2 select-text">
          {headerLeft}
        </div>

        {/* Right content */}
        {headerRight && (
          <div className="flex shrink-0 items-center gap-0.5 select-none">
            {headerRight}
          </div>
        )}
      </div>

      {/* Content */}
      {!isCollapsed && children}
    </div>
  );
};

EventBlock.displayName = "EventBlock";

export default EventBlock;
