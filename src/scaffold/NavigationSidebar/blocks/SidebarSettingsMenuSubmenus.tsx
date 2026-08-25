import React from "react";
import { createPortal } from "react-dom";

import DropdownSelectedCheck from "@src/components/Dropdown/DropdownSelectedCheck";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import type { AppearanceMode } from "@src/config/appearance/globalThemes";

import { PresenceMenuItems } from "./SidebarBottomBar";
import { SidebarWorkstationSettingsSubmenu } from "./SidebarWorkstationSettingsSubmenu";

export type SettingsSubmenu =
  | "presence"
  | "appearance"
  | "chatPanelLocation"
  | "workstation";

export interface SubmenuPosition {
  left: number;
  bottom: number;
}

interface AppearanceOption {
  value: AppearanceMode;
  label: string;
}

interface ThemeOption {
  value: string | number;
  label: string;
}

interface SidebarSettingsMenuSubmenusProps {
  activeSubmenu: SettingsSubmenu | null;
  appearanceMode: AppearanceMode;
  appearanceModeLabel: string;
  appearanceModeOptions: readonly AppearanceOption[];
  globalThemeId: string;
  submenuPanelRef: React.Ref<HTMLDivElement>;
  submenuPosition: SubmenuPosition | null;
  themeOptions: readonly ThemeOption[];
  themePresetLabel: string;
  onPresenceSelectionComplete: () => void;
  onSelectAppearanceMode: (mode: AppearanceMode) => void;
  onSelectTheme: (themeId: string) => void;
  onSubmenuMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  onSubmenuPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
}

export function SidebarSettingsMenuSubmenus({
  activeSubmenu,
  appearanceMode,
  appearanceModeLabel,
  appearanceModeOptions,
  globalThemeId,
  submenuPanelRef,
  submenuPosition,
  themeOptions,
  themePresetLabel,
  onPresenceSelectionComplete,
  onSelectAppearanceMode,
  onSelectTheme,
  onSubmenuMouseDown,
  onSubmenuPointerDown,
}: SidebarSettingsMenuSubmenusProps): React.ReactPortal | null {
  if (!activeSubmenu || !submenuPosition) return null;

  if (activeSubmenu === "presence") {
    return createPortal(
      <div
        ref={submenuPanelRef}
        className={`${DROPDOWN_CLASSES.menuPanelBase} ${DROPDOWN_WIDTHS.panelWidthClass} fixed`}
        style={{ left: submenuPosition.left, bottom: submenuPosition.bottom }}
        onPointerDown={onSubmenuPointerDown}
        onMouseDown={onSubmenuMouseDown}
      >
        <PresenceMenuItems onSelectionComplete={onPresenceSelectionComplete} />
      </div>,
      document.body
    );
  }

  if (
    activeSubmenu === "chatPanelLocation" ||
    activeSubmenu === "workstation"
  ) {
    return createPortal(
      <SidebarWorkstationSettingsSubmenu
        panelRef={submenuPanelRef}
        position={submenuPosition}
        mode={activeSubmenu}
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
        style={{ left: submenuPosition.left, bottom: submenuPosition.bottom }}
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
          <div className={DROPDOWN_CLASSES.menuSeparatorInset} />
          <div className={DROPDOWN_CLASSES.sectionLabel}>
            {themePresetLabel}
          </div>
          {themeOptions.map((theme) => {
            const selected = globalThemeId === theme.value;
            return (
              <button
                key={theme.value}
                type="button"
                className={`${DROPDOWN_CLASSES.menuActionItem} ${selected ? DROPDOWN_CLASSES.itemSelected : ""} justify-between`}
                onClick={() => onSelectTheme(String(theme.value))}
                aria-selected={selected}
              >
                <span>{theme.label}</span>
                {selected && <DropdownSelectedCheck />}
              </button>
            );
          })}
        </div>
      </div>,
      document.body
    );
  }

  return null;
}
