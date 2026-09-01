/**
 * Shared dropdown list chrome for app switchers (My Station route picker +
 * Agent Station dock picker). Row hover/selected use {@link DROPDOWN_CLASSES}
 * (`itemHover` → fill-2, `itemSelected` → primary-1) with callers supplying
 * selection semantics only.
 */
import React, { memo } from "react";
import { createPortal } from "react-dom";

import AnyIcon from "@src/components/AnyIcon";
import DropdownSelectedCheck from "@src/components/Dropdown/DropdownSelectedCheck";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import type { DropdownEnginePosition } from "@src/hooks/dropdown/useDropdownEngine";
import type { IconSvgElement } from "@src/icons";

export interface AppSwitcherMenuItem {
  id: string;
  /**
   * Optional leading icon. When omitted, the row renders label-only.
   * Used by the Agent Team member picker which mirrors the icon-less
   * chat-panel switcher style.
   */
  icon?: IconSvgElement;
  label: string;
  /**
   * When true, the row is rendered greyed out and clicks are ignored.
   * Used by the Agent Team member picker to suppress members that have
   * not received any tasks yet.
   */
  disabled?: boolean;
  /**
   * Optional right-aligned secondary label (e.g. "No tasks", runtime
   * status). Rendered before the selected-check.
   */
  trailingLabel?: string;
  tourTarget?: string;
}

export interface AppSwitcherDropdownPanelProps {
  panelRef: React.RefObject<HTMLDivElement | null>;
  panelPosition: DropdownEnginePosition;
  items: readonly AppSwitcherMenuItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}

const AppSwitcherDropdownPanelComponent: React.FC<
  AppSwitcherDropdownPanelProps
> = ({ panelRef, panelPosition, items, activeId, onSelect, onClose }) =>
  createPortal(
    <div
      ref={panelRef as React.Ref<HTMLDivElement>}
      className={`${DROPDOWN_CLASSES.panel} w-max`}
      style={{
        position: "fixed",
        ...(panelPosition.top !== undefined
          ? { top: panelPosition.top }
          : { bottom: panelPosition.bottom }),
        left: panelPosition.left,
        minWidth: panelPosition.width,
        width: "max-content",
        zIndex: DROPDOWN_PANEL.zIndex,
      }}
    >
      <div className={`${DROPDOWN_CLASSES.optionsContainer} w-full`}>
        {items.map((item) => {
          const isActive = item.id === activeId;
          const isDisabled = item.disabled === true;
          return (
            <button
              key={item.id}
              type="button"
              disabled={isDisabled}
              aria-disabled={isDisabled || undefined}
              data-tour-target={item.tourTarget}
              className={`${DROPDOWN_CLASSES.item} ${
                isActive
                  ? DROPDOWN_CLASSES.itemSelected
                  : DROPDOWN_CLASSES.itemHover
              } w-full justify-between text-left whitespace-nowrap ${
                isDisabled ? "cursor-not-allowed opacity-50" : ""
              }`}
              onClick={() => {
                if (isDisabled) return;
                onClose();
                onSelect(item.id);
              }}
            >
              {item.icon && (
                <AnyIcon
                  icon={item.icon}
                  size={DROPDOWN_ITEM.iconSize}
                  strokeWidth={1.75}
                  className="shrink-0"
                />
              )}
              <span className="flex-1 whitespace-nowrap">{item.label}</span>
              {item.trailingLabel && (
                <span className="shrink-0 text-[11px] whitespace-nowrap text-text-3">
                  {item.trailingLabel}
                </span>
              )}
              {isActive && <DropdownSelectedCheck />}
            </button>
          );
        })}
      </div>
    </div>,
    document.body
  );

export const AppSwitcherDropdownPanel = memo(AppSwitcherDropdownPanelComponent);
AppSwitcherDropdownPanel.displayName = "AppSwitcherDropdownPanel";
