/**
 * EventBlockHeaderIcon - Reusable header icon that transforms on hover
 *
 * Shows the block's icon by default, transforms to chevron on hover
 * The parent header owns the expand/collapse click target.
 *
 * Loading state: repeating stroke-draw animation (like home sidebar),
 * NOT spinning. Only Loader2 components should spin.
 */
import React, { ReactNode } from "react";

import { ChevronsDownUpIcon, HugeiconsIcon, UnfoldMoreIcon } from "@src/icons";

import { EVENT_BLOCK_ICON_WRAPPER_CLASSES } from "./config";
import { useStrokeDraw } from "./useStrokeDraw";

export interface EventBlockHeaderIconProps {
  /** The icon to show when not hovered */
  icon: ReactNode;
  /** Whether the block is collapsed (default: false) */
  isCollapsed?: boolean;
  /** Whether the header is currently hovered (default: false) */
  isHeaderHovered?: boolean;
  /** Icon size (default: 14) */
  iconSize?: number;
  /** Additional className for wrapper */
  className?: string;
  /** Whether there is content to expand (shows chevron only if true) */
  hasContent?: boolean;
  /** When true, plays a repeating stroke-draw animation in text-1 */
  isLoading?: boolean;
  /** When true, icon renders in muted text-3 to signal attempted/failed */
  isFailed?: boolean;
}

/**
 * Header icon that transforms to a collapse-state chevron on row hover.
 */
export const EventBlockHeaderIcon: React.FC<EventBlockHeaderIconProps> = ({
  icon,
  isCollapsed = false,
  isHeaderHovered = false,
  iconSize = 14,
  className = "",
  hasContent = true,
  isLoading = false,
  isFailed = false,
}) => {
  const iconRefCb = useStrokeDraw(isLoading);

  const showChevron = isHeaderHovered && hasContent;

  const wrapperClass = isLoading
    ? `${EVENT_BLOCK_ICON_WRAPPER_CLASSES} [&_svg]:text-text-1 ${className}`
    : isFailed
      ? `${EVENT_BLOCK_ICON_WRAPPER_CLASSES} [&_svg]:text-text-3 ${className}`
      : `${EVENT_BLOCK_ICON_WRAPPER_CLASSES} ${className}`;

  return (
    <div ref={iconRefCb} className={wrapperClass}>
      {showChevron ? (
        <span className="transition-colors group-hover/chat-block-header:text-text-1">
          {isCollapsed ? (
            <HugeiconsIcon
              icon={UnfoldMoreIcon}
              data-icon="chevrons-up-down"
              size={iconSize}
            />
          ) : (
            <HugeiconsIcon
              icon={ChevronsDownUpIcon}
              data-icon="chevrons-down-up"
              size={iconSize}
            />
          )}
        </span>
      ) : (
        icon
      )}
    </div>
  );
};

EventBlockHeaderIcon.displayName = "EventBlockHeaderIcon";

export default EventBlockHeaderIcon;
