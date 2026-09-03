import React from "react";
import { createPortal } from "react-dom";

import { PILL_SM_ICON_SIZE } from "@src/components/CompoundPill/config";
import DropdownItem from "@src/components/Dropdown/DropdownItem";
import type { SubmenuAnchor } from "@src/components/Dropdown/submenuLayout";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import SegmentedTextPill from "@src/components/SegmentedTextPill";
import {
  APPEARANCE_MODE,
  type AppearanceMode,
} from "@src/config/appearance/globalThemes";
import {
  ArrowUpRight01Icon,
  HugeiconsIcon,
  MonitorIcon,
  MoonIcon,
  Sun01Icon,
} from "@src/icons";

import { PresenceMenuItems } from "./SidebarBottomBar";
import { SidebarLayoutSettingsSubmenu } from "./SidebarLayoutSettingsSubmenu";

export type SettingsSubmenu = "presence" | "appearance" | "layout";

/** Placement of a settings submenu, computed by the shared submenu geometry. */
export type SubmenuPosition = SubmenuAnchor;

interface AppearanceOption {
  value: AppearanceMode;
  label: string;
}

interface SidebarSettingsMenuSubmenusProps {
  activeSubmenu: SettingsSubmenu | null;
  appearanceMode: AppearanceMode;
  themeLabel: string;
  appearanceModeOptions: readonly AppearanceOption[];
  modifyAppearanceLabel: string;
  submenuPanelRef: React.Ref<HTMLDivElement>;
  submenuPosition: SubmenuPosition | null;
  onModifyAppearance: () => void;
  onPresenceSelectionComplete: () => void;
  onSelectAppearanceMode: (mode: AppearanceMode) => void;
  onSubmenuMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  onSubmenuPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
}

export function SidebarSettingsMenuSubmenus({
  activeSubmenu,
  appearanceMode,
  themeLabel,
  appearanceModeOptions,
  modifyAppearanceLabel,
  submenuPanelRef,
  submenuPosition,
  onModifyAppearance,
  onPresenceSelectionComplete,
  onSelectAppearanceMode,
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
    const appearanceModePillOptions = appearanceModeOptions.map((option) => {
      const icon =
        option.value === APPEARANCE_MODE.SYSTEM
          ? MonitorIcon
          : option.value === APPEARANCE_MODE.LIGHT
            ? Sun01Icon
            : MoonIcon;

      return {
        value: option.value,
        ariaLabel: option.label,
        label: (
          <HugeiconsIcon
            icon={icon}
            data-icon={`theme-${option.value}`}
            size={PILL_SM_ICON_SIZE}
            strokeWidth={1.75}
            className="block"
            aria-hidden
          />
        ),
      };
    });

    return createPortal(
      <div
        ref={submenuPanelRef}
        className={`${DROPDOWN_CLASSES.menuPanelWithHeaderBase} ${DROPDOWN_WIDTHS.panelWidthClass} fixed`}
        style={{ left: submenuPosition.left, top: submenuPosition.top }}
        onPointerDown={onSubmenuPointerDown}
        onMouseDown={onSubmenuMouseDown}
      >
        <div
          className={`${DROPDOWN_CLASSES.itemsColumnPadded} scrollbar-overlay max-h-80 overflow-y-auto`}
        >
          <div className={DROPDOWN_CLASSES.menuControlItem}>
            <span className="min-w-0 flex-1 truncate">{themeLabel}</span>
            <SegmentedTextPill
              ariaLabel={themeLabel}
              size="small"
              value={appearanceMode}
              options={appearanceModePillOptions}
              onChange={onSelectAppearanceMode}
            />
          </div>
          <div className={DROPDOWN_CLASSES.menuGroupSeparator} />
          <DropdownItem
            fullWidth
            tabIndex={0}
            onClick={onModifyAppearance}
            role="menuitem"
            suffix={
              <HugeiconsIcon
                icon={ArrowUpRight01Icon}
                data-icon="arrow-up-right"
                size={13}
                strokeWidth={2}
                className="text-text-3"
              />
            }
          >
            {modifyAppearanceLabel}
          </DropdownItem>
        </div>
      </div>,
      document.body
    );
  }

  return null;
}
