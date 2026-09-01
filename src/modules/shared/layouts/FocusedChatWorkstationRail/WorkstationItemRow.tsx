/**
 * WorkstationItemRow — one actionable rail row (open tab, terminal session,
 * Review, PR link, …) with its optional diff stats, CI status and close button.
 */
import type React from "react";

import AnyIcon from "@src/components/AnyIcon";
import DiffStatsBadge from "@src/components/DiffStatsBadge";
import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import FileTypeIcon from "@src/components/FileTypeIcon";
import { IconButton } from "@src/components/IconButton";
import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import { ProcessStopButton } from "@src/components/ProcessStopButton";
import Tooltip from "@src/components/Tooltip";
import { WORKSTATION_TRAIL_CONTENT } from "@src/config/workstation/tokens";
import {
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  HugeiconsIcon,
} from "@src/icons";

import { RailItemStatus } from "./RailItemStatus";
import type { FocusedChatRailItem } from "./types";

export function WorkstationItemRow({
  compact = false,
  item,
  onRequestClose,
}: {
  compact?: boolean;
  item: FocusedChatRailItem;
  onRequestClose?: () => void;
}) {
  const runAction = (event: React.MouseEvent<HTMLButtonElement>) => {
    // A submenu trigger keeps its host menu open; the popup it anchors is
    // part of that menu, not a destination.
    if (!item.submenu) onRequestClose?.();
    item.onClick?.(event);
  };

  const action = (
    <button
      type="button"
      className={
        compact
          ? `${DROPDOWN_CLASSES.item} min-w-0 flex-1 !px-2 text-left ${
              item.onClick
                ? DROPDOWN_CLASSES.itemHover
                : `${DROPDOWN_CLASSES.itemDisabled} text-text-3`
            }`
          : `${WORKSTATION_TRAIL_CONTENT.rowContent} ${
              item.onClick ? "text-text-1" : "cursor-default text-text-3"
            }`
      }
      onClick={runAction}
      disabled={!item.onClick}
      role={compact ? "menuitem" : undefined}
      aria-haspopup={item.submenu ? "menu" : undefined}
    >
      <span className="flex shrink-0 items-center text-text-1">
        {item.fileName ? (
          <FileTypeIcon fileName={item.fileName} size="small" />
        ) : (
          <AnyIcon icon={item.icon} size={14} strokeWidth={1.75} />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {(item.additions ?? 0) > 0 || (item.deletions ?? 0) > 0 ? (
        <DiffStatsBadge
          additions={item.additions}
          deletions={item.deletions}
          variant="plain"
          size="sm"
          reserveValueWidth={false}
          valueClassName="font-normal"
          className="shrink-0"
        />
      ) : null}
      {item.status ? <RailItemStatus status={item.status} /> : null}
      {item.external ? (
        <HugeiconsIcon
          icon={ArrowUpRight01Icon}
          data-icon="arrow-up-right"
          aria-hidden
          className="shrink-0 text-text-2"
          size={14}
          strokeWidth={1.75}
        />
      ) : null}
      {item.submenu ? (
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          data-icon="chevron-right"
          aria-hidden
          className="shrink-0 text-text-2"
          size={14}
          strokeWidth={1.75}
        />
      ) : null}
    </button>
  );

  return (
    <div
      className={
        compact
          ? "group flex min-w-0 items-center"
          : `group ${WORKSTATION_TRAIL_CONTENT.row} transition-colors duration-150 ${
              item.onClick ? "focus-within:bg-fill-2 hover:bg-fill-2" : ""
            }`
      }
    >
      {item.shortcut ? (
        <Tooltip
          content={
            <KeyboardShortcutTooltipContent
              label={item.label}
              shortcut={item.shortcut}
            />
          }
          position="left"
          framedPanel
          mouseEnterDelay={200}
          smartPlacement
        >
          {action}
        </Tooltip>
      ) : (
        action
      )}
      {item.onStop ? (
        <ProcessStopButton
          size="sm"
          label={item.stopLabel ?? item.label}
          className={`opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 ${compact ? "ml-0.5" : "mr-1"}`}
          onClick={item.onStop}
          role={compact ? "menuitem" : undefined}
        />
      ) : item.onClose ? (
        <IconButton
          size="sm"
          variant="defaultTreeRow"
          className={`shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 ${
            compact ? "ml-0.5" : "mr-1"
          }`}
          onClick={(event) => {
            event.stopPropagation();
            item.onClose?.();
          }}
          aria-label={item.closeLabel}
          role={compact ? "menuitem" : undefined}
        >
          <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={12} />
        </IconButton>
      ) : null}
    </div>
  );
}
