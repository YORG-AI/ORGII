/**
 * GenericBottomPanel Component
 *
 * A reusable bottom panel with tabs, resize handle, maximize/collapse.
 * Follows the same pattern as EditorBottomPanel but decoupled from
 * Code Editor-specific state and the ActionSystem.
 *
 * Used by: Settings (LSP, Lint, Downloads output), and any module
 * needing a resizable bottom panel with multiple tabs.
 *
 * All tabs stay mounted (hidden via display:none) to preserve state.
 */
import { ChevronDown, ChevronUp, X } from "lucide-react";
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import TabPill from "@src/components/TabPill";
import {
  HEADER_BUTTON,
  HEADER_ICON_SIZE,
} from "@src/config/workstation/tokens";
import { useResizeContextMenu } from "@src/hooks/ui/useResizeContextMenu";
import { HorizontalResizeHandle } from "@src/scaffold/Resize";

import type { GenericBottomPanelProps } from "./types";
import { useGenericBottomPanelResize } from "./useGenericBottomPanelResize";

const DEFAULT_HEIGHT = 200;
const MIN_HEIGHT = 120;

const GenericBottomPanel: React.FC<GenericBottomPanelProps> = memo(
  ({
    tabs,
    activeTab,
    onTabChange,
    isCollapsed,
    onToggleCollapse,
    height,
    onHeightChange,
    isMaximized = false,
    onToggleMaximize,
    className = "",
  }) => {
    const { t } = useTranslation();

    const { panelRef, handleMouseDown } = useGenericBottomPanelResize({
      height,
      onHeightChange,
    });

    const handleContextMenu = useResizeContextMenu({
      dimension: "height",
      currentSize: height,
      defaultSize: DEFAULT_HEIGHT,
      minSize: MIN_HEIGHT,
      onSizeChange: onHeightChange,
    });

    const tabPillItems = tabs.map((tab) => ({
      key: tab.key,
      label: tab.label,
      badge: tab.badge,
    }));

    const activeTabConfig = tabs.find((tab) => tab.key === activeTab);

    return (
      <div
        ref={panelRef}
        className={`group/panel relative flex shrink-0 flex-col bg-bg-2 ${className}`}
        style={{
          height: isMaximized ? "100%" : `${height}px`,
          display: isCollapsed ? "none" : "flex",
        }}
      >
        {!isMaximized && (
          <HorizontalResizeHandle
            onMouseDown={handleMouseDown}
            onContextMenu={handleContextMenu}
          />
        )}

        {/* Header with tabs and controls */}
        <div className="flex h-10 shrink-0 items-center justify-between pl-2 pr-3">
          <div className="flex min-w-0 flex-1 items-center">
            <TabPill
              activeTab={activeTab}
              tabs={tabPillItems}
              onChange={onTabChange}
              variant="pill"
              color="fill"
              fillWidth={false}
            />
          </div>

          <div className="invisible flex items-center gap-1.5 group-hover/panel:visible">
            {/* Per-tab actions */}
            {activeTabConfig?.actions?.map((action) => (
              <button
                key={action.key}
                onClick={action.onClick}
                className={
                  action.active
                    ? HEADER_BUTTON.active
                    : action.danger
                      ? HEADER_BUTTON.danger
                      : HEADER_BUTTON.action
                }
                title={action.tooltip}
              >
                {action.icon}
              </button>
            ))}

            {/* Per-tab header extra (e.g. channel selector) */}
            {activeTabConfig?.headerExtra}

            {onToggleMaximize && (
              <button
                onClick={onToggleMaximize}
                className={HEADER_BUTTON.action}
                title={
                  isMaximized
                    ? t("tooltips.restorePanel")
                    : t("tooltips.maximizePanel")
                }
              >
                {isMaximized ? (
                  <ChevronDown size={HEADER_ICON_SIZE.md} />
                ) : (
                  <ChevronUp size={HEADER_ICON_SIZE.md} />
                )}
              </button>
            )}

            <button
              onClick={onToggleCollapse}
              className={HEADER_BUTTON.action}
              title={t("tooltips.hidePanel")}
            >
              <X size={HEADER_ICON_SIZE.md} />
            </button>
          </div>
        </div>

        {/* Tab content — all tabs mounted, hidden via display:none */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {tabs.map((tab) => (
            <div
              key={tab.key}
              style={{ display: activeTab === tab.key ? "flex" : "none" }}
              className="h-full w-full flex-col"
            >
              {tab.content}
            </div>
          ))}
        </div>
      </div>
    );
  }
);

GenericBottomPanel.displayName = "GenericBottomPanel";

export default GenericBottomPanel;
export type {
  GenericBottomPanelProps,
  BottomPanelTabConfig,
  BottomPanelTabAction,
} from "./types";
