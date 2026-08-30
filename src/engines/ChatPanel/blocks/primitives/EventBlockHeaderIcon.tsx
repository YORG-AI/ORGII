/**
 * EventBlockHeaderIcon - Reusable header icon that transforms on hover
 *
 * Shows the block's icon by default, transforms to chevron on hover
 * Chevron click toggles expand/collapse (separate from header click)
 *
 * When `revealChevronOnIconHoverOnly` is set (navigate-on-header-click blocks),
 * only hovering the icon slot shows the chevron so the rest of the header
 * reads as a single "go to event" target without swapping to chevron.
 *
 * Loading state: repeating stroke-draw animation (like home sidebar),
 * NOT spinning. Only Loader2 components should spin.
 */
import React, { ReactNode, useCallback } from "react";

import { useSafeHover } from "@src/hooks/ui/useSafeHover";
import { ChevronsDownUpIcon, HugeiconsIcon, UnfoldMoreIcon } from "@src/icons";

import {
  EVENT_BLOCK_ICON_HOVER_AREA_CLASSES,
  EVENT_BLOCK_ICON_WRAPPER_CLASSES,
} from "./config";
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
  /** Callback when chevron is clicked (for expand/collapse) */
  onToggle?: () => void;
  /** Whether there is content to expand (shows chevron only if true) */
  hasContent?: boolean;
  /**
   * If true, chevron appears only when hovering this icon area, not the full header.
   * Use with headers where click navigates/locates and icon toggles collapse.
   */
  revealChevronOnIconHoverOnly?: boolean;
  /** When true, plays a repeating stroke-draw animation in text-1 */
  isLoading?: boolean;
  /** When true, icon renders in muted text-3 to signal attempted/failed */
  isFailed?: boolean;
}

/**
 * Header icon that transforms to chevron on hover
 * Clicking chevron calls onToggle (expand/collapse)
 */
export const EventBlockHeaderIcon: React.FC<EventBlockHeaderIconProps> = ({
  icon,
  isCollapsed = false,
  isHeaderHovered = false,
  iconSize = 14,
  className = "",
  onToggle,
  hasContent = true,
  revealChevronOnIconHoverOnly = false,
  isLoading = false,
  isFailed = false,
}) => {
  const [hoverAreaRef, isIconHovered] = useSafeHover<HTMLDivElement>({
    disabled: !revealChevronOnIconHoverOnly,
  });
  const iconRefCb = useStrokeDraw(isLoading);

  const handleChevronClick = useCallback(
    (e: React.MouseEvent) => {
      if (onToggle) {
        e.stopPropagation();
        onToggle();
      }
    },
    [onToggle]
  );

  const showChevron =
    (revealChevronOnIconHoverOnly ? isIconHovered : isHeaderHovered) &&
    hasContent;

  const wrapperClass = isLoading
    ? `${EVENT_BLOCK_ICON_WRAPPER_CLASSES} [&_svg]:text-text-1 ${className}`
    : isFailed
      ? `${EVENT_BLOCK_ICON_WRAPPER_CLASSES} [&_svg]:text-text-3 ${className}`
      : `${EVENT_BLOCK_ICON_WRAPPER_CLASSES} ${className}`;

  const iconContent = (
    <div ref={iconRefCb} className={wrapperClass}>
      {showChevron ? (
        <span
          onClick={handleChevronClick}
          className="cursor-pointer transition-colors hover:text-text-1"
        >
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

  if (revealChevronOnIconHoverOnly) {
    return (
      <div ref={hoverAreaRef} className={EVENT_BLOCK_ICON_HOVER_AREA_CLASSES}>
        {iconContent}
      </div>
    );
  }

  return iconContent;
};

EventBlockHeaderIcon.displayName = "EventBlockHeaderIcon";

export default EventBlockHeaderIcon;
