import cn from "classnames";
import React from "react";

import Switch from "@src/components/Switch";
import Tooltip from "@src/components/Tooltip";
import { Add01Icon, HugeiconsIcon } from "@src/icons";

/** Shared 44px header row for left/right split panes (kept in sync with right-pane variant header). */
export const INLINE_SPLIT_HEADER_ROW_CLASS =
  "flex h-11 min-h-11 items-center justify-between gap-3 rounded-md text-xs";
const HEADER_ROW_PADDED_CLASS = `${INLINE_SPLIT_HEADER_ROW_CLASS} px-3`;

/** Header row used at the top of a left/right pane (with horizontal padding). */
interface InlineSplitHeaderRowProps {
  label: React.ReactNode;
  trailing?: React.ReactNode;
  /** Omit padding when the row should align flush-left with non-padded content below it (right pane). */
  padded?: boolean;
  /** Draw a bottom border to visually separate the header from the list below. */
  withSeparator?: boolean;
}

export function InlineSplitHeaderRow({
  label,
  trailing,
  padded = true,
  withSeparator = false,
}: InlineSplitHeaderRowProps) {
  return (
    <div
      className={cn(
        padded ? HEADER_ROW_PADDED_CLASS : INLINE_SPLIT_HEADER_ROW_CLASS,
        withSeparator && "mb-1 rounded-none border-0 border-b border-border-2"
      )}
    >
      <span className="min-w-0 flex-1 truncate font-medium leading-none text-text-1">
        {label}
      </span>
      {trailing ? (
        <div className="flex shrink-0 items-center gap-2">{trailing}</div>
      ) : null}
    </div>
  );
}

/** Selectable left-pane list row (label + switch).
 *
 * The switch uses any-enabled semantics: it is ON as long as at least one
 * variant in the row is enabled, OFF only when nothing is enabled. The
 * per-variant breakdown lives in the right pane, so this row deliberately
 * does not surface a mixed/indeterminate state. */
interface InlineSplitSelectableRowProps {
  selected: boolean;
  onSelect: () => void;
  label: React.ReactNode;
  switchChecked: boolean;
  /** Optional tooltip shown when hovering the switch. */
  switchTooltip?: React.ReactNode;
  onToggle: (checked: boolean) => void;
}

export function InlineSplitSelectableRow({
  selected,
  onSelect,
  label,
  switchChecked,
  switchTooltip,
  onToggle,
}: InlineSplitSelectableRowProps) {
  const switchElement = (
    <Switch size="small" checked={switchChecked} onCheckedChange={onToggle} />
  );
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        "flex h-9 min-h-9 cursor-pointer items-center justify-between gap-3 rounded-md px-3 text-xs hover:bg-fill-1",
        selected && "bg-fill-1"
      )}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">{label}</div>
      <div
        className="flex shrink-0 items-center gap-2"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {switchTooltip ? (
          <Tooltip content={switchTooltip} position="top">
            <span className="inline-flex">{switchElement}</span>
          </Tooltip>
        ) : (
          switchElement
        )}
      </div>
    </div>
  );
}

/** Left-pane "+ Add new key" action row. Matches the height of the
 * surrounding key rows (`h-9`, `px-3`) and renders the plus icon in a
 * 14px slot so the leading column lines up pixel-for-pixel with the
 * `ModelIcon size="small"` (14px) used by the key rows above. */
interface InlineSplitAddKeyRowProps {
  label: React.ReactNode;
  onClick: () => void;
}

export function InlineSplitAddKeyRow({
  label,
  onClick,
}: InlineSplitAddKeyRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-9 min-h-9 w-full cursor-pointer items-center gap-1.5 rounded-md px-3 text-xs text-text-2 hover:bg-fill-1"
    >
      <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center text-text-3">
        <HugeiconsIcon icon={Add01Icon} data-icon="plus" size={14} />
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}

/** Right-pane header when a key/group has a single model with no variant picker. */
interface InlineSplitDefaultVersionHeaderRowProps {
  label: React.ReactNode;
  pillLabel: React.ReactNode;
}

export function InlineSplitDefaultVersionHeaderRow({
  label,
  pillLabel,
}: InlineSplitDefaultVersionHeaderRowProps) {
  return (
    <div
      className={cn(
        INLINE_SPLIT_HEADER_ROW_CLASS,
        "mb-1 min-w-0 rounded-none border-0 border-b border-border-2"
      )}
    >
      <span className="min-w-0 flex-1 truncate font-medium leading-none text-text-1">
        {label}
      </span>
      <span
        aria-disabled="true"
        className="inline-flex h-[28px] shrink-0 cursor-default items-center rounded-full border border-border-2 bg-fill-1 px-2.5 text-[12px] font-semibold text-text-3 opacity-60"
      >
        {pillLabel}
      </span>
    </div>
  );
}
