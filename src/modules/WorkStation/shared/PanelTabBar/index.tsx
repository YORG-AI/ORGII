/**
 * PanelTabBar
 *
 * Shared tab-header chrome for any panel that needs position-aware tabs.
 * Currently driving the Workstation "secondary panel" slot (Browser
 * DevTools, Code Editor bottom panel), but designed so any panel — primary
 * or secondary, modal or dock — can reuse the same tab + slot contract.
 *
 * Both `bottom` and `right` positions render the same icon-only square tab
 * buttons. Each button shows only the glyph from `tab.icon`; hovering
 * reveals a plain-text tooltip with the tab label (no keyboard shortcut).
 *
 * Tabs and content stay mounted across position toggles — only the
 * chrome flavour swaps. Caller owns the active tab state.
 */
import type { ReactNode } from "react";
import React, { memo, useCallback } from "react";

import AnyIcon from "@src/components/AnyIcon";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import { useImmediateCursorReset } from "@src/hooks/ui/useImmediateCursorReset";
import {
  ArrowUpDownIcon as ArrowUpDown,
  TestTubeIcon as FlaskConical,
  type IconSvgElement,
  Layers01Icon as Layers,
  ScrollIcon as ScrollText,
  SquareChevronRightIcon as SquareChevronRight,
  TriangleAlertIcon as TriangleAlert,
} from "@src/icons";
import type { SecondaryPanelPosition } from "@src/store/ui/workStationAtom";

export { PanelPositionToggle } from "./PositionToggle";

const PANEL_TAB_ICONS = {
  ArrowUpDown,
  FlaskConical,
  Layers,
  ScrollText,
  SquareChevronRight,
  TriangleAlert,
} as const satisfies Record<string, IconSvgElement>;

export type PanelTabIconName = keyof typeof PANEL_TAB_ICONS;

export interface PanelTabBarTab {
  key: string;
  label: string;
  icon?: PanelTabIconName;
  /** Optional badge node rendered next to the icon. */
  badge?: ReactNode;
}

export interface PanelTabBarProps {
  position: SecondaryPanelPosition;
  tabs: PanelTabBarTab[];
  activeTabKey: string;
  onTabChange: (key: string) => void;

  /** Per-tab action buttons. In `bottom` they sit inline; in `right` they
   *  drop to a second row. */
  tabActions?: ReactNode;
  /** Persistent controls (position toggle, close). Always on the tab row. */
  persistentActions?: ReactNode;

  /** Stable id used to namespace the panel (for aria). */
  paneId: string;

  /** When true, per-tab actions stay invisible until the panel is hovered. */
  hideTabActionsUntilHover?: boolean;

  /** Optional class for the outer wrapper. */
  className?: string;
}

// ── Icon-only tab strip ───────────────────────────────────────────────────────

const ICON_SIZE = 14;

function renderPanelTabIcon(
  name: PanelTabIconName | undefined
): React.ReactNode {
  if (!name) return null;
  const IconComponent = PANEL_TAB_ICONS[name];
  return <AnyIcon icon={IconComponent} size={ICON_SIZE} strokeWidth={1.75} />;
}

interface IconTabStripProps {
  tabs: PanelTabBarTab[];
  activeTabKey: string;
  onTabChange: (key: string) => void;
  /**
   * - `"always"` (bottom) — every tab shows icon + label.
   * - `"active-only"` (right) — only the active tab shows label; others icon-only with tooltip.
   * - `"never"` — icon-only with tooltip for all tabs.
   */
  labelMode?: "always" | "active-only" | "never";
  tooltipPosition?: "bottom" | "top";
}

interface PanelTabButtonProps {
  tab: PanelTabBarTab;
  isActive: boolean;
  showLabel: boolean;
  onTabChange: (key: string) => void;
}

const PanelTabButton: React.FC<PanelTabButtonProps> = memo(
  ({ tab, isActive, showLabel, onTabChange }) => {
    const { cursorReset, markClicked, resetCursor } =
      useImmediateCursorReset(isActive);

    const handleClick = useCallback(() => {
      markClicked();
      onTabChange(tab.key);
    }, [markClicked, onTabChange, tab.key]);

    return (
      <button
        type="button"
        data-active={isActive ? "true" : "false"}
        onClick={handleClick}
        onMouseLeave={resetCursor}
        aria-label={tab.label}
        aria-selected={isActive}
        role="tab"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        className={`relative flex h-8 shrink-0 ${
          cursorReset || isActive ? "cursor-default" : "cursor-pointer"
        } items-center justify-center gap-1.5 rounded outline-none transition-colors duration-150 ${
          showLabel ? "px-2" : "w-8"
        } ${
          isActive
            ? "bg-fill-1 text-primary-6"
            : "bg-transparent text-text-2 hover:bg-surface-hover hover:text-text-1"
        }`}
      >
        {renderPanelTabIcon(tab.icon)}
        {showLabel && (
          <span className="whitespace-nowrap text-[12px] font-medium">
            {tab.label}
          </span>
        )}
        {tab.badge && (
          <span className="pointer-events-none absolute -right-0.5 -top-0.5">
            {tab.badge}
          </span>
        )}
      </button>
    );
  }
);

PanelTabButton.displayName = "PanelTabButton";

const IconTabStrip: React.FC<IconTabStripProps> = memo(
  ({
    tabs,
    activeTabKey,
    onTabChange,
    labelMode = "never",
    tooltipPosition = "bottom",
  }) => (
    <div className="flex items-center gap-px">
      {tabs.map((tab) => {
        const isActive = tab.key === activeTabKey;
        const showLabel =
          labelMode === "always" || (labelMode === "active-only" && isActive);

        const btn = (
          <PanelTabButton
            tab={tab}
            isActive={isActive}
            showLabel={showLabel}
            onTabChange={onTabChange}
          />
        );

        if (showLabel)
          return <React.Fragment key={tab.key}>{btn}</React.Fragment>;

        return (
          <ToolbarTooltip
            key={tab.key}
            label={tab.label}
            position={tooltipPosition}
          >
            {btn}
          </ToolbarTooltip>
        );
      })}
    </div>
  )
);

IconTabStrip.displayName = "IconTabStrip";

// ── PanelTabBar ───────────────────────────────────────────────────────────────

const PanelTabBar: React.FC<PanelTabBarProps> = memo(
  ({
    position,
    tabs,
    activeTabKey,
    onTabChange,
    tabActions,
    persistentActions,
    hideTabActionsUntilHover = false,
    className,
  }) => {
    const handleTabChange = useCallback(
      (key: string) => onTabChange(key),
      [onTabChange]
    );

    // Both positions use the same icon-only strip. Layout differs only in
    // how tab actions are arranged relative to the persistent controls.
    return (
      <div
        className={`shrink-0 bg-workstation-bg @container/spheader ${className ?? ""}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-y-1 px-2 pb-1.5 pt-1.5 @[520px]/spheader:h-10 @[520px]/spheader:flex-nowrap @[520px]/spheader:gap-x-1.5 @[520px]/spheader:py-0">
          {/* Tab strip */}
          <div className="order-1 flex min-w-0 flex-1 items-center">
            <IconTabStrip
              tabs={tabs}
              activeTabKey={activeTabKey}
              onTabChange={handleTabChange}
              labelMode={
                position === "bottom"
                  ? "always"
                  : position === "right"
                    ? "active-only"
                    : "never"
              }
              tooltipPosition="bottom"
            />
          </div>

          {/* Persistent actions (position toggle, close) */}
          <div className="order-2 flex items-center gap-px @[520px]/spheader:order-3">
            {persistentActions}
          </div>

          {/* Per-tab actions */}
          {tabActions && (
            <div
              className={`order-3 flex w-full items-center justify-end gap-px pt-1 @[520px]/spheader:order-2 @[520px]/spheader:w-auto @[520px]/spheader:pt-0 ${
                hideTabActionsUntilHover
                  ? "invisible group-hover/panel:visible"
                  : ""
              }`}
            >
              {tabActions}
            </div>
          )}
        </div>
      </div>
    );
  }
);

PanelTabBar.displayName = "PanelTabBar";

export default PanelTabBar;
