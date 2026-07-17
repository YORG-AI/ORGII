/**
 * SidebarToggleButton
 *
 * Single-purpose icon button that flips a primary sidebar between collapsed
 * and expanded. Lives in tab bar trailing slots — never inside the sidebar
 * itself, so the button is reachable when the sidebar is collapsed.
 *
 * Two convenience variants:
 * - {@link WorkStationSidebarToggleButton} — reads the active My Station
 *   primary-sidebar callbacks via `activeStatusBarCallbacksAtom`.
 * - {@link SimulatorSidebarToggleButton}   — reads `simulatorPrimarySidebarCollapsedAtom`
 *   directly (Agent Station replay views).
 *
 * The plain {@link SidebarToggleButton} is the view component; both wrappers
 * pass the data they read into it. Splitting view from data keeps the icon /
 * styling unified across products without forcing a single atom shape on
 * every consumer.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { List } from "lucide-react";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { PanelLeftIcon, PanelRightIcon } from "@src/components/PanelIcons";
import type { TooltipProps } from "@src/components/Tooltip";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import {
  simulatorPrimarySidebarCollapsedAtom,
  simulatorPrimarySidebarPositionAtom,
} from "@src/store/ui/simulatorAtom";
import {
  workStationLayoutModeAtom,
  workStationPrimarySidebarCollapsedAtom,
  workStationPrimarySidebarCollapsedPersistAtom,
} from "@src/store/ui/workStationAtom";
import {
  activeStatusBarAppAtom,
  activeStatusBarCallbacksAtom,
} from "@src/store/ui/workStationLayout/statusBarAtoms";

import { WorkstationToolbarTooltip } from "./WorkstationToolbarTooltip";
import { HEADER_ICON_SIZE } from "./tokens";

// ============================================
// View component
// ============================================

export interface SidebarToggleButtonProps {
  collapsed: boolean;
  onToggle: () => void;
  /** Which side the sidebar is on. Drives icon orientation. */
  position?: "left" | "right";
  /** Icon size in px. Defaults to {@link HEADER_ICON_SIZE.md}. */
  iconSize?: number;
  /** Use the same list icon in both collapsed and expanded states. */
  stableListIcon?: boolean;
  /** Tooltip placement. Defaults to the standard bottom command tooltip. */
  tooltipPosition?: TooltipProps["position"];
  /** Keep the button visible for layout consistency, but make it inactive. */
  disabled?: boolean;
  /**
   * Show the `toggle_workstation_sidebar` shortcut hint in the tooltip.
   * Defaults to `true`. Set `false` for sidebars that are intentionally not
   * bound to that shortcut (e.g. Kanban), so the tooltip doesn't advertise
   * a keybinding that has no effect on this sidebar.
   */
  showShortcut?: boolean;
}

const SidebarToggleButtonComponent: React.FC<SidebarToggleButtonProps> = ({
  collapsed,
  onToggle,
  position = "left",
  iconSize = HEADER_ICON_SIZE.md,
  stableListIcon = false,
  tooltipPosition = "bottom",
  disabled = false,
  showShortcut = true,
}) => {
  const { t } = useTranslation("sessions");
  const Icon = position === "right" ? PanelRightIcon : PanelLeftIcon;
  const label = collapsed
    ? t("simulator.titleBar.showSidebar")
    : t("simulator.titleBar.hideSidebar");
  const shortcut = showShortcut
    ? getShortcutKeys("toggle_workstation_sidebar")
    : undefined;
  return (
    <WorkstationToolbarTooltip
      label={label}
      shortcut={shortcut}
      position={tooltipPosition}
    >
      <span className="inline-flex">
        <Button
          htmlType="button"
          variant="tertiary"
          size="small"
          iconOnly
          disabled={disabled}
          onClick={disabled ? undefined : onToggle}
          aria-label={label}
          icon={
            stableListIcon ? (
              <List size={iconSize} strokeWidth={2.25} />
            ) : (
              <Icon
                size={iconSize}
                strokeWidth={1.75}
                fillSidebar={!collapsed}
              />
            )
          }
        />
      </span>
    </WorkstationToolbarTooltip>
  );
};

export const SidebarToggleButton = memo(SidebarToggleButtonComponent);
SidebarToggleButton.displayName = "SidebarToggleButton";

// ============================================
// My Station wrapper (status-bar callbacks)
// ============================================

interface WorkStationSidebarToggleButtonProps {
  /** Override icon size (px). Defaults to {@link HEADER_ICON_SIZE.md}. */
  iconSize?: number;
  /** Keep the toggle position visible when the active app has no sidebar. */
  disabled?: boolean;
}

/**
 * Always renders the My Station primary-sidebar toggle in the 40px app header.
 * Active apps can override the callback/collapsed state; otherwise the shared
 * primary-sidebar atom is used so the header chrome never collapses away.
 */
const WorkStationSidebarToggleButtonComponent: React.FC<
  WorkStationSidebarToggleButtonProps
> = ({ iconSize, disabled = false }) => {
  const activeApp = useAtomValue(activeStatusBarAppAtom);
  const callbacks = useAtomValue(activeStatusBarCallbacksAtom);
  const fallbackCollapsed = useAtomValue(
    workStationPrimarySidebarCollapsedAtom
  );
  const fallbackLayoutMode = useAtomValue(workStationLayoutModeAtom);
  const setFallbackCollapsed = useSetAtom(
    workStationPrimarySidebarCollapsedPersistAtom
  );

  const handleFallbackToggle = useCallback(() => {
    setFallbackCollapsed("toggle");
  }, [setFallbackCollapsed]);

  const layoutMode = callbacks.layoutMode ?? fallbackLayoutMode;
  const position = layoutMode === "right" ? "right" : "left";

  return (
    <SidebarToggleButton
      collapsed={callbacks.primaryPanelCollapsed ?? fallbackCollapsed}
      onToggle={callbacks.onTogglePrimaryPanel ?? handleFallbackToggle}
      position={position}
      iconSize={iconSize}
      stableListIcon
      tooltipPosition={activeApp === "browser" ? "top" : "bottom"}
      disabled={disabled}
    />
  );
};

export const WorkStationSidebarToggleButton = memo(
  WorkStationSidebarToggleButtonComponent
);
WorkStationSidebarToggleButton.displayName = "WorkStationSidebarToggleButton";

// ============================================
// Agent Station wrapper (simulator atoms)
// ============================================

interface SimulatorSidebarToggleButtonProps {
  /** Override icon size (px). Defaults to {@link HEADER_ICON_SIZE.md}. */
  iconSize?: number;
  /** Keep the toggle position visible when the active app has no sidebar. */
  disabled?: boolean;
}

const SimulatorSidebarToggleButtonComponent: React.FC<
  SimulatorSidebarToggleButtonProps
> = ({ iconSize, disabled = false }) => {
  const [collapsed, setCollapsed] = useAtom(
    simulatorPrimarySidebarCollapsedAtom
  );
  const position = useAtomValue(simulatorPrimarySidebarPositionAtom);
  const onToggle = useCallback(
    () => setCollapsed((prev) => !prev),
    [setCollapsed]
  );
  return (
    <SidebarToggleButton
      collapsed={collapsed}
      onToggle={onToggle}
      position={position}
      iconSize={iconSize}
      stableListIcon
      disabled={disabled}
    />
  );
};

export const SimulatorSidebarToggleButton = memo(
  SimulatorSidebarToggleButtonComponent
);
SimulatorSidebarToggleButton.displayName = "SimulatorSidebarToggleButton";
