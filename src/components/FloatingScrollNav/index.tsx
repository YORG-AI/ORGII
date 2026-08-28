/**
 * FloatingScrollNav
 *
 * Reusable floating navigation buttons for scrollable feeds.
 * Positioned at the bottom-center of a `position: relative` parent.
 *
 * Supports:
 * - Mark all as read (optional pill, e.g. inbox — left of catch-up)
 * - Catch-up / go-to-unread (pill with icon + label)
 * - Scroll to bottom (icon-only circle)
 *
 * Used by ChatHistory and Inbox feed panels.
 */
import React from "react";

import Button from "@src/components/Button";
import { PILL_CONTROL_IDLE_SURFACE_CLASS } from "@src/components/CompoundPill/config";
import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import Tooltip from "@src/components/Tooltip";
import { INPUT_AREA_BUTTONS } from "@src/config/inputAreaTokens";
import {
  ArrowDown02Icon,
  ArrowUp02Icon,
  CrosshairIcon,
  HugeiconsIcon,
  TickDouble01Icon,
} from "@src/icons";

const ICON_BUTTON_CLASS = `flex ${INPUT_AREA_BUTTONS.iconButtonSizeClass} cursor-pointer items-center justify-center rounded-full border border-solid border-border-2 transition-all ${PILL_CONTROL_IDLE_SURFACE_CLASS}`;

interface FloatingScrollNavProps {
  showScrollToBottom: boolean;
  onScrollToBottom: () => void;
  markAllAsRead?: {
    label: string;
    onClick: () => void;
  };
  catchUp?: {
    label: string;
    onClick: () => void;
  };
  followAgent?: {
    label: string;
    tooltipLabel?: string;
    shortcut?: string;
    onClick: () => void;
  };
}

const FloatingScrollNav: React.FC<FloatingScrollNavProps> = ({
  showScrollToBottom,
  onScrollToBottom,
  markAllAsRead,
  catchUp,
  followAgent,
}) => {
  if (!showScrollToBottom && !catchUp && !markAllAsRead && !followAgent)
    return null;

  const markAllAsReadPillClassName = `flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-solid border-border-2 pl-2 pr-3 transition-all ${PILL_CONTROL_IDLE_SURFACE_CLASS}`;

  return (
    <div className="absolute bottom-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2">
      {markAllAsRead && (
        <button
          type="button"
          aria-label={markAllAsRead.label}
          onClick={markAllAsRead.onClick}
          className={markAllAsReadPillClassName}
        >
          <HugeiconsIcon
            icon={TickDouble01Icon}
            data-icon="check-check"
            size={14}
            className="text-success-6"
            strokeWidth={2}
          />
          <span className="text-[12px] font-medium text-success-6">
            {markAllAsRead.label}
          </span>
        </button>
      )}
      {catchUp && (
        <Button
          variant="secondary"
          shape="round"
          size="small"
          icon={
            <HugeiconsIcon
              icon={ArrowUp02Icon}
              data-icon="arrow-up"
              size={13}
              strokeWidth={2}
            />
          }
          onClick={catchUp.onClick}
          aria-label={catchUp.label}
          className={PILL_CONTROL_IDLE_SURFACE_CLASS}
        >
          {catchUp.label}
        </Button>
      )}
      {followAgent && (
        <Tooltip
          content={
            <KeyboardShortcutTooltipContent
              label={followAgent.tooltipLabel ?? followAgent.label}
              shortcut={followAgent.shortcut || undefined}
            />
          }
          position="top"
          mouseEnterDelay={250}
          framedPanel
        >
          <span className="inline-flex">
            <Button
              variant="secondary"
              shape="round"
              size="small"
              icon={
                <HugeiconsIcon
                  icon={CrosshairIcon}
                  data-icon="crosshair"
                  size={13}
                  strokeWidth={2}
                />
              }
              onClick={followAgent.onClick}
              aria-label={followAgent.tooltipLabel ?? followAgent.label}
              className={PILL_CONTROL_IDLE_SURFACE_CLASS}
            >
              {followAgent.label}
            </Button>
          </span>
        </Tooltip>
      )}
      {showScrollToBottom && (
        <button
          type="button"
          onClick={onScrollToBottom}
          className={ICON_BUTTON_CLASS}
        >
          <HugeiconsIcon
            icon={ArrowDown02Icon}
            data-icon="arrow-down"
            size={INPUT_AREA_BUTTONS.iconSize}
            className="text-text-2"
            strokeWidth={1.75}
          />
        </button>
      )}
    </div>
  );
};

FloatingScrollNav.displayName = "FloatingScrollNav";

export default React.memo(FloatingScrollNav);
