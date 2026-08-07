/**
 * Anchor Component
 *
 * A vertical navigation component for scrolling to sections within a container.
 * Displays a list of links that scroll to corresponding sections when clicked.
 *
 * @example
 * ```tsx
 * import Anchor from "@src/components/Anchor";
 *
 * const items = [
 *   { key: "section1", label: "Section 1", count: 5 },
 *   { key: "section2", label: "Section 2", count: 12 },
 * ];
 *
 * <div className="flex">
 *   <Anchor
 *     items={items}
 *     activeKey={activeKey}
 *     onSelect={(key) => scrollToSection(key)}
 *   />
 *   <div className="flex-1">
 *     <section id="section1">...</section>
 *     <section id="section2">...</section>
 *   </div>
 * </div>
 * ```
 */
import React, { memo, useCallback } from "react";

import { classNames } from "@src/util/ui/classNames";

// ============================================
// Types
// ============================================

export interface AnchorItem {
  /** Unique key for the anchor item */
  key: string;
  /** Display label */
  label: string;
  /** Optional count to display */
  count?: number;
}

export interface AnchorProps {
  /** List of anchor items */
  items: AnchorItem[];
  /** Currently active key */
  activeKey?: string | null;
  /** Callback when an anchor is clicked */
  onSelect?: (key: string) => void;
  /** Additional CSS classes for the container */
  className?: string;
}

interface AnchorListItemProps {
  itemKey: string;
  label: string;
  count?: number;
  isActive: boolean;
  onSelect?: (key: string) => void;
}

// ============================================
// Styling
// ============================================

const ANCHOR_NAV_CLASS = "flex flex-col gap-0.5";

const ANCHOR_ITEM_BUTTON_BASE_CLASS =
  "flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs transition-colors";

const ANCHOR_ITEM_BUTTON_STATE_CLASSES = {
  active: "bg-primary-1 font-medium text-primary-6",
  inactive: "text-text-2 hover:bg-fill-1 hover:text-text-1",
} as const;

const ANCHOR_ITEM_COUNT_BASE_CLASS = "ml-2 shrink-0 text-[10px] tabular-nums";

const ANCHOR_ITEM_COUNT_STATE_CLASSES = {
  active: "text-primary-5",
  inactive: "text-text-4",
} as const;

// ============================================
// Sub-components
// ============================================

const AnchorListItem: React.FC<AnchorListItemProps> = memo(
  ({ itemKey, label, count, isActive, onSelect }) => {
    const handleClick = useCallback(() => {
      onSelect?.(itemKey);
    }, [itemKey, onSelect]);

    return (
      <button
        type="button"
        aria-current={isActive ? "location" : undefined}
        onClick={handleClick}
        className={classNames(
          ANCHOR_ITEM_BUTTON_BASE_CLASS,
          isActive
            ? ANCHOR_ITEM_BUTTON_STATE_CLASSES.active
            : ANCHOR_ITEM_BUTTON_STATE_CLASSES.inactive
        )}
      >
        <span className="truncate capitalize">{label}</span>
        {count !== undefined && (
          <span
            className={classNames(
              ANCHOR_ITEM_COUNT_BASE_CLASS,
              isActive
                ? ANCHOR_ITEM_COUNT_STATE_CLASSES.active
                : ANCHOR_ITEM_COUNT_STATE_CLASSES.inactive
            )}
          >
            {count}
          </span>
        )}
      </button>
    );
  }
);

AnchorListItem.displayName = "AnchorListItem";

// ============================================
// Component
// ============================================

export const Anchor: React.FC<AnchorProps> = memo(
  ({ items, activeKey, onSelect, className }) => {
    return (
      <nav
        aria-label="Section navigation"
        className={classNames(ANCHOR_NAV_CLASS, className)}
      >
        {items.map((item) => (
          <AnchorListItem
            key={item.key}
            itemKey={item.key}
            label={item.label}
            count={item.count}
            isActive={item.key === activeKey}
            onSelect={onSelect}
          />
        ))}
      </nav>
    );
  }
);

Anchor.displayName = "Anchor";

export default Anchor;
