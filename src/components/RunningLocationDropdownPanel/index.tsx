/**
 * RunningLocationDropdownPanel
 *
 * Shared dropdown panel body for selecting a running location
 * (This Mac / New Worktree / Cloud).
 *
 * Used by both RunningLocationPill (active session) and
 * SessionInfoLine's location segment (session creator).
 *
 * Callers are responsible for positioning and portal-rendering this panel.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import DropdownSelectedCheck from "@src/components/Dropdown/DropdownSelectedCheck";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
import type {
  RunningLocation,
  RunningLocationEntry,
} from "@src/config/sessionCreatorConfig";
import { RUNNING_LOCATIONS } from "@src/config/sessionCreatorConfig";

/**
 * Per-row props provided by the parent's keyboard-navigation engine
 * (see `useDropdownEngine({ listNavigation })`). Spreading these on
 * each row wires highlight-on-hover, click-to-select, and
 * keyboard-driven selection.
 */
export interface RunningLocationItemProps {
  "data-dropdown-item-index": number;
  "data-dropdown-keyboard-highlight"?: "true";
  "aria-selected": boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}

export interface RunningLocationDropdownPanelProps {
  selected: RunningLocation;
  onSelect: (location: RunningLocation) => void;
  panelRef?:
    | React.RefCallback<HTMLDivElement>
    | React.RefObject<HTMLDivElement | null>
    | null;
  style?: React.CSSProperties;
  className?: string;
  /**
   * Optional keyboard-nav integration. When provided, the parent owns
   * the highlight state (via `useDropdownEngine`'s `listNavigation`)
   * and supplies the per-row prop getter. The currently highlighted
   * row is painted by the global SCSS rule on
   * `[data-dropdown-keyboard-highlight="true"]` — the panel does not
   * need an explicit index. When omitted, rows fall back to plain
   * hover/click without arrow navigation.
   */
  getItemProps?: (index: number) => RunningLocationItemProps;
}

const RunningLocationDropdownPanel: React.FC<
  RunningLocationDropdownPanelProps
> = ({ selected, onSelect, panelRef, style, className, getItemProps }) => {
  const { t } = useTranslation("sessions");

  return (
    <div
      ref={panelRef}
      className={`${DROPDOWN_CLASSES.panelAnimated} w-[180px] ${className ?? ""}`}
      style={style}
    >
      <div className={DROPDOWN_CLASSES.optionsContainer}>
        {RUNNING_LOCATIONS.map((entry, index) => (
          <LocationOption
            key={entry.id}
            entry={entry}
            isSelected={selected === entry.id}
            label={t(entry.i18nKey)}
            onSelect={onSelect}
            disabled={entry.disabled}
            itemProps={getItemProps?.(index)}
          />
        ))}
      </div>
    </div>
  );
};

// ── LocationOption ─────────────────────────────────────────────────────────

interface LocationOptionProps {
  entry: RunningLocationEntry;
  isSelected: boolean;
  label: string;
  onSelect: (id: RunningLocation) => void;
  disabled?: boolean;
  itemProps?: RunningLocationItemProps;
}

const LocationOption: React.FC<LocationOptionProps> = ({
  entry,
  isSelected,
  label,
  onSelect,
  disabled,
  itemProps,
}) => {
  const Icon = entry.icon;
  // When a keyboard-nav engine is wired in, hover + click are routed
  // through `itemProps`; otherwise we fall back to the local click
  // handler.
  const interactionProps =
    itemProps ?? ({ onClick: () => !disabled && onSelect(entry.id) } as const);
  // `itemSelected` (filled accent background) is reserved for the
  // actually-selected row. Hover and keyboard highlight use the
  // neutral `itemHover` token so the user isn't tricked into thinking
  // a hovered row is the current selection — see screenshot bug where
  // "New Worktree" looked picked just because the cursor was over it.
  return (
    <button
      type="button"
      {...interactionProps}
      disabled={disabled}
      className={`${DROPDOWN_CLASSES.item} ${
        disabled
          ? "cursor-not-allowed opacity-40"
          : isSelected
            ? DROPDOWN_CLASSES.itemSelected
            : DROPDOWN_CLASSES.itemHover
      } w-full justify-between`}
    >
      <div className="flex items-center gap-2">
        <AnyIcon
          icon={Icon}
          size={DROPDOWN_ITEM.iconSize}
          strokeWidth={1.75}
          className={entry.iconClassName}
        />
        <span>{label}</span>
      </div>
      {isSelected && <DropdownSelectedCheck />}
    </button>
  );
};

export default RunningLocationDropdownPanel;
