/**
 * BottomPanelHeader Component
 *
 * Header with tabs and tab-specific controls for the bottom panel.
 *
 * Uses the shared `PanelTabBar` which selects the chrome flavour
 * from `position`:
 * - `bottom` → pill tabs + inline tab actions (the existing layout).
 * - `right`  → TabBar chrome with tab actions dropped to a second row.
 *
 * Only the chrome is swapped on position change; the panel content
 * (terminals, output buffers, etc.) lives in `BottomPanelContent` as a
 * sibling and stays mounted.
 */
import { BrushCleaning, X } from "lucide-react";
import React, { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import {
  PanelPositionToggle,
  PanelTabBar,
} from "@src/modules/WorkStation/shared";
import type {
  PanelTabBarTab,
  PanelTabIconName,
} from "@src/modules/WorkStation/shared";
import { HEADER_ICON_SIZE } from "@src/modules/WorkStation/shared/tokens";
import {
  BOTTOM_PANEL_TABS,
  BOTTOM_PANEL_TAB_LABELS,
  BOTTOM_PANEL_TAB_ORDER,
  type BottomPanelTab,
} from "@src/store/ui/workStationAtom";
import type { SecondaryPanelPosition } from "@src/store/ui/workStationAtom";

import type { OutputChannel } from "../content/OutputContent/types";
import type { TabAction } from "../types";

// Lucide icon names used by the TabBar (right) chrome. Keep parallel with
// BOTTOM_PANEL_TAB_ORDER so the icons line up with the tabs.
const BOTTOM_PANEL_TAB_ICONS: Partial<
  Record<BottomPanelTab, PanelTabIconName>
> = {
  [BOTTOM_PANEL_TABS.PROBLEMS]: "TriangleAlert",
  [BOTTOM_PANEL_TABS.OUTPUT]: "ScrollText",
  [BOTTOM_PANEL_TABS.TEST_RESULTS]: "FlaskConical",
};

export interface BottomPanelHeaderProps {
  activeTab: BottomPanelTab;
  onTabChange: (tab: BottomPanelTab) => void;
  onClose: () => void;

  // Output tab controls
  outputChannels: OutputChannel[];
  activeChannelId: string | null;
  onSetActiveChannel: (id: string) => void;
  onClearChannel: (id: string) => void;

  // Terminal tab controls
  onKillTerminal: () => void;
  onAddTerminal: (options?: {
    shell?: string;
    args?: string[];
    name?: string;
    profileId?: string;
  }) => void;
  terminalSessionName?: string;
  terminalShellPath?: string;
  terminalPid?: number;

  // Problems tab actions (scan, expand/collapse, clear)
  problemsActions?: TabAction[];
  /** Badge nodes per tab key (e.g. Problems count) */
  tabBadges?: Record<string, React.ReactNode>;

  /** Panel position (right | bottom). When provided, shows a toggle button. */
  position?: SecondaryPanelPosition;
  onTogglePosition?: () => void;
}

const BottomPanelHeader: React.FC<BottomPanelHeaderProps> = memo(
  ({
    activeTab,
    onTabChange,
    onClose,
    outputChannels,
    activeChannelId,
    onSetActiveChannel,
    onClearChannel,
    onKillTerminal: _onKillTerminal,
    onAddTerminal: _onAddTerminal,
    terminalSessionName: _terminalSessionName,
    terminalShellPath: _terminalShellPath,
    terminalPid: _terminalPid,
    problemsActions,
    tabBadges,
    position,
    onTogglePosition,
  }) => {
    const { t } = useTranslation();

    const resolvedPosition: SecondaryPanelPosition = position ?? "bottom";

    // Build tab descriptors for PanelTabBar.
    const headerTabs = useMemo<PanelTabBarTab[]>(
      () =>
        BOTTOM_PANEL_TAB_ORDER.map((key) => ({
          key,
          label: t(BOTTOM_PANEL_TAB_LABELS[key]),
          icon: BOTTOM_PANEL_TAB_ICONS[key],
          badge: tabBadges?.[key],
        })),
      [t, tabBadges]
    );

    const handleTabChange = useCallback(
      (key: string) => onTabChange(key as BottomPanelTab),
      [onTabChange]
    );

    const outputChannelOptions = useMemo<SelectOption[]>(
      () =>
        outputChannels.map((channel) => ({
          value: channel.id,
          label: (
            <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
              <span className="min-w-0 truncate">{channel.name}</span>
              {channel.active && (
                <span className="shrink-0 text-[11px] text-text-3">
                  (running)
                </span>
              )}
            </span>
          ),
          triggerLabel: channel.name,
        })),
      [outputChannels]
    );

    const fallbackOutputChannelId =
      activeChannelId ??
      outputChannels.find((channel) => channel.type === "git")?.id ??
      outputChannels[0]?.id;

    const handleOutputChannelChange = useCallback(
      (value: string | number | (string | number)[]) => {
        if (typeof value === "string") {
          onSetActiveChannel(value);
        }
      },
      [onSetActiveChannel]
    );

    // ------------------------------------------------------------------
    // Tab-specific action buttons. Visible inline (bottom chrome) or on
    // a second row (right chrome) — PanelTabBar handles layout.
    // ------------------------------------------------------------------
    const tabActions = (
      <>
        {activeTab === BOTTOM_PANEL_TABS.OUTPUT && (
          <>
            {outputChannels.length > 1 && fallbackOutputChannelId && (
              <Select
                value={fallbackOutputChannelId}
                options={outputChannelOptions}
                onChange={handleOutputChannelChange}
                size="small"
                appearance="ghost"
                radius="lg"
                dropdownMinWidth={140}
                dropdownWidthMode="auto"
                dropdownAlign="right"
                placement="bottom"
                className="w-auto"
                selectorClassName="!h-7 max-w-[140px] !gap-1.5 !px-1.5 !text-[12px] [&_.select-suffix]:!ml-0"
              />
            )}

            <Button
              htmlType="button"
              variant="tertiary"
              size="small"
              iconOnly
              onClick={() => {
                if (activeChannelId) {
                  onClearChannel(activeChannelId);
                }
              }}
              title={t("tooltips.clearOutput")}
              icon={<BrushCleaning size={HEADER_ICON_SIZE.md} />}
            />
          </>
        )}

        {activeTab === BOTTOM_PANEL_TABS.PROBLEMS &&
          problemsActions &&
          problemsActions.length > 0 &&
          problemsActions.map((action) => (
            <Button
              key={action.key}
              htmlType="button"
              variant={action.danger ? "danger" : "tertiary"}
              appearance={action.danger ? "ghost" : undefined}
              size="small"
              iconOnly
              onClick={action.onClick}
              className={action.active ? "!bg-fill-2 !text-primary-6" : ""}
              title={action.tooltip}
              icon={action.icon}
            />
          ))}
      </>
    );

    // ------------------------------------------------------------------
    // Persistent controls — panel-level buttons (maximize, position
    // toggle, close). Always on the tab row in both chromes.
    // ------------------------------------------------------------------
    const persistentActions = (
      <>
        {position && onTogglePosition && (
          <PanelPositionToggle
            position={position}
            onToggle={onTogglePosition}
          />
        )}
        <Button
          htmlType="button"
          variant="tertiary"
          size="small"
          iconOnly
          onClick={onClose}
          title={t("tooltips.hidePanel")}
          icon={<X size={HEADER_ICON_SIZE.md} />}
        />
      </>
    );

    return (
      <PanelTabBar
        paneId="editor-bottom-panel"
        position={resolvedPosition}
        tabs={headerTabs}
        activeTabKey={activeTab}
        onTabChange={handleTabChange}
        tabActions={tabActions}
        persistentActions={persistentActions}
      />
    );
  }
);

BottomPanelHeader.displayName = "BottomPanelHeader";

export default BottomPanelHeader;
