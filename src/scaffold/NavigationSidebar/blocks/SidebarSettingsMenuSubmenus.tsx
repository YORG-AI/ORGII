import React from "react";
import { createPortal } from "react-dom";

import DropdownSelectedCheck from "@src/components/Dropdown/DropdownSelectedCheck";
import type { SubmenuAnchor } from "@src/components/Dropdown/submenuLayout";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import type { AppearanceMode } from "@src/config/appearance/globalThemes";

import { PresenceMenuItems } from "./SidebarBottomBar";
import { SidebarLayoutSettingsSubmenu } from "./SidebarLayoutSettingsSubmenu";

export type SettingsSubmenu = "presence" | "appearance" | "layout";

/** Placement of a settings submenu, computed by the shared submenu geometry. */
export type SubmenuPosition = SubmenuAnchor;

interface AppearanceOption {
  value: AppearanceMode;
  label: string;
}

interface SkinOption {
  value: string | number;
  label: React.ReactNode;
  /** Swatch preview supplied by the skin registry. */
  icon?: React.ReactNode;
}

interface SkinOptionGroup {
  label: string;
  options: SkinOption[];
}

interface SidebarSettingsMenuSubmenusProps {
  activeSubmenu: SettingsSubmenu | null;
  appearanceMode: AppearanceMode;
  appearanceModeLabel: string;
  appearanceModeOptions: readonly AppearanceOption[];
  skinId: string;
  submenuPanelRef: React.Ref<HTMLDivElement>;
  submenuPosition: SubmenuPosition | null;
  skinOptions: readonly SkinOptionGroup[];
  skinLabel: string;
  onPresenceSelectionComplete: () => void;
  onSelectAppearanceMode: (mode: AppearanceMode) => void;
  onSelectSkin: (skinId: string) => void;
  onSubmenuMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  onSubmenuPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
}

export function SidebarSettingsMenuSubmenus({
  activeSubmenu,
  appearanceMode,
  appearanceModeLabel,
  appearanceModeOptions,
  skinId,
  submenuPanelRef,
  submenuPosition,
  skinOptions,
  skinLabel,
  onPresenceSelectionComplete,
  onSelectAppearanceMode,
  onSelectSkin,
  onSubmenuMouseDown,
  onSubmenuPointerDown,
}: SidebarSettingsMenuSubmenusProps): React.ReactPortal | null {
  if (!activeSubmenu || !submenuPosition) return null;

  if (activeSubmenu === "presence") {
    return createPortal(
      <div
        ref={submenuPanelRef}
        className={`${DROPDOWN_CLASSES.menuPanelBase} ${DROPDOWN_WIDTHS.panelWidthClass} fixed`}
        style={{ left: submenuPosition.left, top: submenuPosition.top }}
        onPointerDown={onSubmenuPointerDown}
        onMouseDown={onSubmenuMouseDown}
      >
        <PresenceMenuItems onSelectionComplete={onPresenceSelectionComplete} />
      </div>,
      document.body
    );
  }

  if (activeSubmenu === "layout") {
    return createPortal(
      <SidebarLayoutSettingsSubmenu
        panelRef={submenuPanelRef}
        position={submenuPosition}
        onPointerDown={onSubmenuPointerDown}
        onMouseDown={onSubmenuMouseDown}
      />,
      document.body
    );
  }

  if (activeSubmenu === "appearance") {
    return createPortal(
      <div
        ref={submenuPanelRef}
        className={`${DROPDOWN_CLASSES.menuPanelWithHeaderBase} ${DROPDOWN_WIDTHS.panelWidthClass} fixed`}
        style={{ left: submenuPosition.left, top: submenuPosition.top }}
        onPointerDown={onSubmenuPointerDown}
        onMouseDown={onSubmenuMouseDown}
      >
        <div
          className={`${DROPDOWN_CLASSES.itemsColumnPadded} scrollbar-overlay max-h-[320px] overflow-y-auto`}
        >
          <div className={DROPDOWN_CLASSES.sectionLabel}>
            {appearanceModeLabel}
          </div>
          {appearanceModeOptions.map((option) => {
            const selected = appearanceMode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                className={`${DROPDOWN_CLASSES.menuActionItem} ${selected ? DROPDOWN_CLASSES.itemSelected : ""} justify-between`}
                onClick={() => onSelectAppearanceMode(option.value)}
                aria-selected={selected}
              >
                <span>{option.label}</span>
                {selected && <DropdownSelectedCheck />}
              </button>
            );
          })}
          <div className={DROPDOWN_CLASSES.menuGroupSeparator} />
          <div className={DROPDOWN_CLASSES.sectionLabel}>{skinLabel}</div>
          {skinOptions.map((group) => (
            <React.Fragment key={group.label}>
              {group.options.map((skin) => {
                const selected = skinId === skin.value;
                return (
                  <button
                    key={skin.value}
                    type="button"
                    className={`${DROPDOWN_CLASSES.menuActionItem} ${selected ? DROPDOWN_CLASSES.itemSelected : ""} justify-between`}
                    onClick={() => onSelectSkin(String(skin.value))}
                    aria-selected={selected}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {skin.icon}
                      <span className="truncate">{skin.label}</span>
                    </span>
                    {selected && <DropdownSelectedCheck />}
                  </button>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      </div>,
      document.body
    );
  }

  return null;
}
