import React from "react";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import {
  KEYBOARD_SHORTCUT_VARIANT,
  KeyboardShortcut,
} from "@src/components/KeyboardShortcut";
import { ArrowRight01Icon, HugeiconsIcon } from "@src/icons";
import type { ContextMenuItem } from "@src/types/core/shared";

interface SubmenuPanelProps {
  panelRef: React.RefObject<HTMLDivElement | null>;
  items: ContextMenuItem[];
  position: { x: number; y: number };
  activeNestedItemId?: string;
  onItemClick: (item: ContextMenuItem, event: React.MouseEvent) => void;
  onItemMouseEnter: (item: ContextMenuItem, event: React.MouseEvent) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  showNumericShortcuts?: boolean;
}

export const SubmenuPanel: React.FC<SubmenuPanelProps> = ({
  panelRef,
  items,
  position,
  activeNestedItemId,
  onItemClick,
  onItemMouseEnter,
  onMouseEnter,
  onMouseLeave,
  showNumericShortcuts = false,
}) => {
  return (
    <div
      ref={panelRef}
      className={`work-item-context-menu work-item-context-menu--submenu ${DROPDOWN_CLASSES.menuPanelBase} ${DROPDOWN_WIDTHS.sidebarMenuClass}`}
      style={{ left: position.x, top: position.y }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {items.map((item, index) => {
        if (item.divider) {
          return (
            <div key={item.id} className="work-item-context-menu__divider" />
          );
        }

        const hasNested = item.submenu && item.submenu.length > 0;
        const isActive = activeNestedItemId === item.id;

        return (
          <button
            key={item.id}
            type="button"
            className={`work-item-context-menu__item ${DROPDOWN_CLASSES.item} w-full justify-between border-none bg-transparent text-left ${DROPDOWN_CLASSES.itemHover} ${
              item.disabled ? DROPDOWN_CLASSES.itemDisabled : ""
            } ${isActive ? DROPDOWN_CLASSES.itemActive : ""}`}
            onClick={(event) => onItemClick(item, event)}
            onMouseEnter={(event) => onItemMouseEnter(item, event)}
            disabled={item.disabled}
          >
            {item.icon && (
              <span
                className={`work-item-context-menu__icon ${DROPDOWN_ITEM.iconSizeClass} [&_svg]:h-[13px] [&_svg]:w-[13px]`}
                style={item.iconColor ? { color: item.iconColor } : undefined}
              >
                {item.icon}
              </span>
            )}
            <span className="work-item-context-menu__label">{item.label}</span>
            {item.secondary && (
              <span className="work-item-context-menu__secondary">
                {item.secondary}
              </span>
            )}
            {hasNested ? (
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                data-icon="chevron-right"
                size={DROPDOWN_ITEM.iconSize}
                className="work-item-context-menu__arrow"
              />
            ) : showNumericShortcuts ? (
              <KeyboardShortcut
                shortcut={String(index + 1)}
                variant={KEYBOARD_SHORTCUT_VARIANT.dropdown}
                className="work-item-context-menu__shortcut"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
};
