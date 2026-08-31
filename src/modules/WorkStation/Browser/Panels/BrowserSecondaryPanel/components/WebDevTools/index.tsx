/**
 * WebDevTools
 *
 * Hideable right panel showing console logs, network requests, element inspector, etc.
 * Uses Tailwind CSS for styling.
 *
 * Features:
 * - Console tab: View console logs
 * - Network tab: View network requests
 * - Components tab: DOM tree + Design/CSS editing (bidirectional with webview)
 *
 * Elements panel state/effects live in hooks/useWebDevToolsElementsPanel.ts.
 */
import {
  HEADER_BUTTON,
  HEADER_ICON_SIZE,
} from "@/src/modules/WorkStation/shared/tokens";
import React, { memo, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import TabPill from "@src/components/TabPill";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import { useRatioResize } from "@src/hooks/ui";
import {
  Cancel01Icon,
  CopyPlusIcon,
  HugeiconsIcon,
  ListChevronsDownUpIcon,
  Loading03Icon,
  Refresh04Icon,
} from "@src/icons";
import {
  PanelPositionToggle,
  PanelTabBar,
} from "@src/modules/WorkStation/shared";
import type { PanelTabBarTab } from "@src/modules/WorkStation/shared";
import {
  HorizontalResizeHandle,
  VerticalResizeHandle,
} from "@src/scaffold/Resize";

import { CSSPanel } from "./components/CSSPanel";
import { ConsoleTab } from "./components/ConsoleTab";
import { DOMTreeContent } from "./components/DOMTreeContent";
import { DesignPanel } from "./components/DesignPanel";
import { NetworkTab } from "./components/NetworkTab";
import { SourcePanel } from "./components/SourcePanel";
import { StyleEditsFooter } from "./components/StyleEditsFooter";
import { useWebDevToolsElementsPanel } from "./hooks/useWebDevToolsElementsPanel";
import type { ComponentsSubTab, DevToolsTab, WebDevToolsProps } from "./types";

// Re-export types for external use
export type {
  ConsoleEntry,
  FilterLevel,
  LogLevel,
  NetworkEntry,
  WebDevToolsProps,
} from "./types";

// ============================================
// Main Component
// ============================================

const WebDevTools: React.FC<WebDevToolsProps> = memo(
  ({
    isOpen,
    onClose,
    entries,
    onClearEntries,
    networkEntries = [],
    onClearNetworkEntries,
    width: _initialWidth = 350,
    onWidthChange: _onWidthChange,
    minWidth: _minWidth = 250,
    maxWidth: _maxWidth = 600,
    preserveLogs,
    onTogglePreserveLogs,
    selectedElement,
    webviewLabel = "",
    repoPath = "",
    currentUrl = "",
    position = "right",
    onTogglePosition,
  }) => {
    const { t } = useTranslation();
    const [activeTab, setActiveTab] = useState<DevToolsTab>("elements");

    const devtoolsHeaderTabs = useMemo<PanelTabBarTab[]>(
      () => [
        {
          key: "elements",
          label: selectedElement
            ? `${t("tabs.elements")} •`
            : t("tabs.elements"),
          icon: "Layers",
        },
        {
          key: "console",
          label: t("tabs.console"),
          icon: "SquareChevronRight",
        },
        { key: "network", label: t("tabs.network"), icon: "ArrowUpDown" },
      ],
      [t, selectedElement]
    );

    const handleDevtoolsTabChange = useCallback(
      (key: string) => setActiveTab(key as DevToolsTab),
      []
    );

    const [componentsSubTab, setComponentsSubTab] =
      useState<ComponentsSubTab>("design");
    const [collapseAllKey, setCollapseAllKey] = useState(0);
    const [expandAllKey, setExpandAllKey] = useState(0);
    const [isAllCollapsed, setIsAllCollapsed] = useState(false);

    // ---- Elements Panel Logic ----
    const {
      domTree,
      treeLoading,
      treeError,
      expandedNodes,
      highlightedXpath,
      refreshTreeSpinClass,
      handleRefreshTreeClick,
      collapseAll,
      toggleExpanded,
      revealState,
      highlightNode,
      effectiveSelectedXPath,
      handleTreeSelect,
      computedStyles,
      stylesLoading,
      stylesPending,
      styleEditCount,
      handleStyleChange,
      handleStyleEditsUndo,
      handleStyleEditsSend,
      sourceLocation,
      openFileAtLine,
      searchForComponent,
      canSearchForComponent,
    } = useWebDevToolsElementsPanel({
      isOpen,
      activeTab,
      repoPath,
      webviewLabel,
      currentUrl,
      selectedElement,
    });

    // ---- Split Pane (DOM tree + Design panel) ----
    const splitContainerRef = useRef<HTMLDivElement>(null);
    const splitDirection: "vertical" | "horizontal" =
      position === "bottom" ? "horizontal" : "vertical";
    const { ratio: splitRatio, handleMouseDown: handleSplitMouseDown } =
      useRatioResize(splitContainerRef, {
        initialRatio: 0.45,
        minRatio: 0.2,
        maxRatio: 0.8,
        direction: splitDirection,
      });

    const isHorizontalSplit = splitDirection === "horizontal";
    const splitContainerClass = isHorizontalSplit
      ? "flex h-full flex-row overflow-hidden"
      : "flex h-full flex-col overflow-hidden";
    const treeSectionStyle: React.CSSProperties = isHorizontalSplit
      ? { width: `${splitRatio * 100}%` }
      : { height: `${splitRatio * 100}%` };
    const designSectionStyle: React.CSSProperties = isHorizontalSplit
      ? { width: `${(1 - splitRatio) * 100}%` }
      : { height: `${(1 - splitRatio) * 100}%` };

    if (!isOpen) return null;

    return (
      <div className="station-sidebar-scroll-area group/devtools relative flex h-full w-full min-w-0 flex-col bg-workstation-bg">
        <PanelTabBar
          paneId="devtools-panel"
          position={position}
          tabs={devtoolsHeaderTabs}
          activeTabKey={activeTab}
          onTabChange={handleDevtoolsTabChange}
          persistentActions={
            <>
              {onTogglePosition && (
                <PanelPositionToggle
                  position={position}
                  onToggle={onTogglePosition}
                />
              )}
              <ToolbarTooltip label={t("tooltips.closeDevTools")}>
                <Button
                  htmlType="button"
                  variant="tertiary"
                  size="small"
                  iconOnly
                  onClick={onClose}
                  aria-label={t("tooltips.closeDevTools")}
                  icon={
                    <HugeiconsIcon
                      icon={Cancel01Icon}
                      data-icon="x"
                      size={HEADER_ICON_SIZE.md}
                    />
                  }
                />
              </ToolbarTooltip>
            </>
          }
        />

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="min-w-0 flex-1 overflow-hidden">
            {activeTab === "console" && (
              <ConsoleTab
                entries={entries}
                onClear={onClearEntries}
                preserveLogs={preserveLogs}
                onTogglePreserveLogs={onTogglePreserveLogs}
              />
            )}
            {activeTab === "network" && (
              <NetworkTab
                entries={networkEntries}
                onClear={onClearNetworkEntries || (() => {})}
              />
            )}
            {activeTab === "elements" && (
              <div ref={splitContainerRef} className={splitContainerClass}>
                {/* DOM Tree section */}
                <div
                  className="flex flex-col overflow-hidden"
                  style={treeSectionStyle}
                >
                  <div className="flex h-10 shrink-0 items-center justify-between px-3">
                    <TabPill
                      activeTab="dom-tree"
                      tabs={[{ key: "dom-tree", label: t("tooltips.domTree") }]}
                      variant="simple"
                      fillWidth={false}
                      size="small"
                    />
                    <div className="invisible flex items-center gap-1 group-hover/devtools:visible">
                      {treeLoading && (
                        <HugeiconsIcon
                          icon={Loading03Icon}
                          data-icon="loader-2"
                          size={SPINNER_TOKENS.small}
                          className="animate-spin text-text-3"
                        />
                      )}
                      <ToolbarTooltip label={t("tooltips.collapseAll")}>
                        <button
                          type="button"
                          onClick={collapseAll}
                          className={HEADER_BUTTON.actionTreeRow}
                          aria-label={t("tooltips.collapseAll")}
                        >
                          <HugeiconsIcon
                            icon={ListChevronsDownUpIcon}
                            data-icon="list-chevrons-down-up"
                            size={HEADER_ICON_SIZE.md}
                          />
                        </button>
                      </ToolbarTooltip>
                      <ToolbarTooltip label={t("tooltips.refreshTree")}>
                        <button
                          type="button"
                          onClick={handleRefreshTreeClick}
                          className={HEADER_BUTTON.actionTreeRow}
                          aria-label={t("tooltips.refreshTree")}
                        >
                          <HugeiconsIcon
                            icon={Refresh04Icon}
                            data-icon="refresh-cw"
                            size={HEADER_ICON_SIZE.sm}
                            className={refreshTreeSpinClass}
                          />
                        </button>
                      </ToolbarTooltip>
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <DOMTreeContent
                      tree={domTree}
                      expandedNodes={expandedNodes}
                      selectedXPath={effectiveSelectedXPath}
                      highlightedXPath={highlightedXpath}
                      onToggle={toggleExpanded}
                      onSelect={handleTreeSelect}
                      onHover={highlightNode}
                      loading={treeLoading}
                      error={treeError}
                      revealXPath={revealState.xpath}
                      revealKey={revealState.key}
                    />
                  </div>
                </div>

                {/* Resize handle */}
                {isHorizontalSplit ? (
                  <VerticalResizeHandle onMouseDown={handleSplitMouseDown} />
                ) : (
                  <HorizontalResizeHandle onMouseDown={handleSplitMouseDown} />
                )}

                {/* Design / CSS / Source section */}
                <div
                  className="flex flex-col overflow-hidden"
                  style={designSectionStyle}
                >
                  <div className="flex h-10 shrink-0 items-center justify-between px-3">
                    <TabPill
                      activeTab={componentsSubTab}
                      onChange={(key) =>
                        setComponentsSubTab(key as ComponentsSubTab)
                      }
                      variant="simple"
                      fillWidth={false}
                      size="small"
                      tabs={[
                        { key: "design", label: t("tabs.design") },
                        { key: "css", label: t("tabs.css") },
                        {
                          key: "source",
                          label: sourceLocation?.path
                            ? `${t("tabs.source")} •`
                            : t("tabs.source"),
                        },
                      ]}
                    />
                    <div className="invisible flex items-center gap-1 group-hover/devtools:visible">
                      {(stylesLoading || stylesPending) && (
                        <HugeiconsIcon
                          icon={Loading03Icon}
                          data-icon="loader-2"
                          size={SPINNER_TOKENS.small}
                          className="animate-spin text-text-3"
                        />
                      )}
                      <ToolbarTooltip
                        label={
                          isAllCollapsed
                            ? t("tooltips.expandAll")
                            : t("tooltips.collapseAll")
                        }
                      >
                        <button
                          type="button"
                          onClick={() => {
                            if (isAllCollapsed) {
                              setExpandAllKey((prev) => prev + 1);
                              setIsAllCollapsed(false);
                            } else {
                              setCollapseAllKey((prev) => prev + 1);
                              setIsAllCollapsed(true);
                            }
                          }}
                          className={HEADER_BUTTON.actionTreeRow}
                          aria-label={
                            isAllCollapsed
                              ? t("tooltips.expandAll")
                              : t("tooltips.collapseAll")
                          }
                        >
                          {isAllCollapsed ? (
                            <HugeiconsIcon
                              icon={CopyPlusIcon}
                              data-icon="copy-plus"
                              size={HEADER_ICON_SIZE.sm}
                            />
                          ) : (
                            <HugeiconsIcon
                              icon={ListChevronsDownUpIcon}
                              data-icon="list-chevrons-down-up"
                              size={HEADER_ICON_SIZE.md}
                            />
                          )}
                        </button>
                      </ToolbarTooltip>
                    </div>
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    <div className="min-h-0 flex-1 overflow-hidden">
                      {componentsSubTab === "design" && (
                        <DesignPanel
                          styles={computedStyles}
                          onStyleChange={handleStyleChange}
                          isPending={stylesPending}
                          collapseAllKey={collapseAllKey}
                          expandAllKey={expandAllKey}
                        />
                      )}
                      {componentsSubTab === "css" && (
                        <CSSPanel
                          styles={computedStyles}
                          onStyleChange={handleStyleChange}
                          isPending={stylesPending}
                          collapseAllKey={collapseAllKey}
                          expandAllKey={expandAllKey}
                        />
                      )}
                      {componentsSubTab === "source" && (
                        <SourcePanel
                          key={
                            sourceLocation?.path ??
                            sourceLocation?.componentName ??
                            sourceLocation?.searchHint ??
                            "no-source"
                          }
                          sourceLocation={sourceLocation}
                          onOpenFile={openFileAtLine}
                          onSearchComponent={searchForComponent}
                          canSearchComponent={canSearchForComponent(
                            sourceLocation
                          )}
                          collapseAllKey={collapseAllKey}
                          expandAllKey={expandAllKey}
                        />
                      )}
                    </div>
                    {(componentsSubTab === "design" ||
                      componentsSubTab === "css") && (
                      <StyleEditsFooter
                        editCount={styleEditCount}
                        onUndo={handleStyleEditsUndo}
                        onSend={handleStyleEditsSend}
                        disabled={stylesPending}
                      />
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }
);

WebDevTools.displayName = "WebDevTools";

export default WebDevTools;
