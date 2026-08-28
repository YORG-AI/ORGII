/**
 * EventNavigateIcon
 *
 * Token-button styled icon for navigating to an event in the simulator.
 *
 * Variants:
 * - "header" (default): hidden until `group/chat-block-header` is hovered.
 *   Uses `fill-3` hover because it sits inside a `fill-2` container.
 * - "footer": always visible, same token-button styling.
 */
import React, { memo } from "react";

import AnyIcon from "@src/components/AnyIcon";
import { CircleArrowOutUpRightIcon, SquareArrowUpRightIcon } from "@src/icons";

const BASE_CLASSES =
  "flex h-5 cursor-pointer select-none items-center justify-center rounded-md border-none bg-transparent text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1";
const CIRCLE_CLASSES =
  "flex h-6 w-6 cursor-pointer select-none items-center justify-center rounded-full border-none bg-fill-2/90 text-text-3 shadow-sm backdrop-blur-sm transition-colors hover:bg-fill-3 hover:text-text-1";

const HEADER_VISIBILITY =
  "w-0 overflow-hidden opacity-0 transition-[width,opacity,background-color,color] group-hover/chat-block-header:w-5 group-hover/chat-block-header:opacity-100";
const FOOTER_VISIBILITY = "w-5";
const FOOTER_HOVER_VISIBILITY =
  "opacity-0 transition-opacity group-hover/agent-message:opacity-100";

export interface EventNavigateIconProps {
  onClick: () => void;
  /** "header" hides until header hover; "footer" is always visible; "footer-hover" hides until agent-message hover. */
  variant?: "header" | "footer" | "footer-hover";
  ariaLabel?: string;
}

const EventNavigateIcon: React.FC<EventNavigateIconProps> = memo(
  ({ onClick, variant = "header", ariaLabel }) => {
    const handleClick = (event: React.MouseEvent) => {
      event.stopPropagation();
      onClick();
    };

    const visibilityClass =
      variant === "header"
        ? HEADER_VISIBILITY
        : variant === "footer-hover"
          ? FOOTER_HOVER_VISIBILITY
          : FOOTER_VISIBILITY;
    const className = `${variant === "footer-hover" ? CIRCLE_CLASSES : BASE_CLASSES} ${visibilityClass}`;
    const Icon =
      variant === "footer-hover"
        ? CircleArrowOutUpRightIcon
        : SquareArrowUpRightIcon;

    return (
      <button
        type="button"
        data-testid="event-navigate"
        aria-label={ariaLabel}
        className={className}
        onClick={handleClick}
        tabIndex={-1}
      >
        <AnyIcon icon={Icon} size={variant === "footer-hover" ? 16 : 14} />
      </button>
    );
  }
);

EventNavigateIcon.displayName = "EventNavigateIcon";

export default EventNavigateIcon;
