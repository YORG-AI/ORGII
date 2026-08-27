/**
 * WorkstationItemRow — one actionable rail row (open tab, terminal session,
 * Review, PR link, …) with its optional diff stats, CI status and close button.
 */
import { ArrowUpRight, X } from "lucide-react";

import DiffStatsBadge from "@src/components/DiffStatsBadge";
import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import FileTypeIcon from "@src/components/FileTypeIcon";
import { IconButton } from "@src/components/IconButton";
import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import Tooltip from "@src/components/Tooltip";
import { WORKSTATION_TRAIL_CONTENT } from "@src/config/workstation/tokens";

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
  const Icon = item.icon;
  const runAction = () => {
    onRequestClose?.();
    item.onClick?.();
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
    >
      <span className="flex shrink-0 items-center text-text-1">
        {item.fileName ? (
          <FileTypeIcon fileName={item.fileName} size="small" />
        ) : (
          <Icon size={14} strokeWidth={1.75} />
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
        <ArrowUpRight
          aria-hidden
          className="shrink-0 text-text-3"
          size={13}
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
      {item.onClose && (
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
          <X size={12} />
        </IconButton>
      )}
    </div>
  );
}
