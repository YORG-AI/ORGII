/**
 * TabBar Component
 *
 * Shared tab bar for Workstation apps showing open tabs with status indicators.
 * Displays icon, name, and status (M/D/U/R) in a horizontal layout.
 * Includes control bar with actions for viewing all changes and split view.
 * Uses dnd-kit for drag and drop reordering.
 *
 * Shared by: CodeEditor, DatabaseManager, Browser
 *
 * Tab strip uses bg-workstation-bg by default; tabs are 32px pills on the 40px row.
 * The tab row has no bottom divider.
 */
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { useAtomValue, useSetAtom } from "jotai";
import React, {
  Fragment,
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { useActionSystemOptional } from "@src/ActionSystem";
import FileTypeIcon from "@src/components/FileTypeIcon";
import { TAB_PILL_DRAG_OVERLAY_CLASS } from "@src/components/TabPill/TabPillSurface";
import { TAB_PAIR_SEPARATOR_SLOT_CLASS } from "@src/components/TabPill/config";
import { NoDragRegion } from "@src/components/WindowChrome";
import SessionRawTranscriptDialog from "@src/engines/ChatPanel/components/SessionRawTranscriptDialog";
import {
  getCollapsedSidebarChromeOffset,
  useShouldOffsetWorkStationTopBar,
} from "@src/hooks/ui/sidebar/useCollapsedSidebarChromeOffset";
import { requestTeamInboxSessionHandoffAtom } from "@src/modules/MainApp/TeamInbox/store";
import { CollapsedSidebarButton } from "@src/scaffold/NavigationSidebar/CollapsedSidebarButton";
import {
  SESSION_TAB_DROP_TARGET_HIGHLIGHT_CLASS,
  type SessionReferenceOpen,
  type SessionTabTransfer,
} from "@src/shared/dnd/sessionTabDrag";
import { useSessionTabDropTarget } from "@src/shared/dnd/useSessionTabDropTarget";
import { useTabInsertionIndicator } from "@src/shared/dnd/useTabInsertionIndicator";
import { openTeamInboxInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabOpenAtoms";
import {
  canMoveWorkstationPrTabToChatPanel,
  moveWorkstationPrTabToChatPanelAtom,
} from "@src/store/chatPanel/chatPanelTabPlacementAtom";
import { type GitFileInfo, gitFileStatusMapAtom } from "@src/store/git";
import {
  moveSessionTabAtom,
  openSessionInWorkstationAtom,
} from "@src/store/session/sessionTabPlacementAtom";
import { tabScrollRevealAtom } from "@src/store/workstation/tabs";

import TabContextMenu from "./TabContextMenu";
import { SortableTab, TabBarControls } from "./components";
import { TAB_BAR_HEIGHT, TAB_STRIP_SECTION_RULE_CLASS } from "./config";
import {
  useAutoScrollToActive,
  useTabDrag,
  useTabGitInfoMap,
  useTabLabelCollapse,
} from "./hooks";
import type { WorkStationTab } from "./types";

// ============================================
// Types
// ============================================

export interface TabBarProps {
  /** Pane identifier for this tab bar */
  paneId?: string;
  /** List of open tabs */
  tabs: WorkStationTab[];
  /** Currently active tab id */
  activeTabId: string | null;
  /** Callback when tab is clicked */
  onTabClick: (tabId: string) => void;
  /** Callback when tab close button is clicked */
  onTabClose: (tabId: string) => void;
  /** Callback when tabs are reordered via drag and drop */
  onTabReorder?: (startIndex: number, endIndex: number) => void;
  /** Callback when more-options button is clicked */
  onMoreOptions?: () => void;
  /** Opens a new tab (e.g. Browser); shows + in the right control section */
  onNewTab?: () => void;
  /** Optional keyboard shortcut displayed for the new-tab control. */
  onNewTabShortcutId?: string;
  /** Callback to close all other tabs */
  onCloseOtherTabs?: (tabId: string) => void;
  /** Callback to close all saved tabs */
  onCloseSavedTabs?: () => void;
  /** Repository path for relative path calculation */
  repoPath?: string;
  /** Optional leading element rendered before the scroll row (fixed; not scrolled with tabs). */
  leadingSlot?: React.ReactNode;
  /**
   * Optional prefix rendered inside the tab scroll row before sortable tabs (same scroll
   * container). Use for surfaces that should visually read as one strip with tabs.
   */
  tabRowPrefix?: React.ReactNode;
  /** Optional trailing element rendered after control buttons (e.g., panel toggles) */
  trailingSlot?: React.ReactNode;
  /** Optional tab-row surface override; defaults to bg-workstation-bg. */
  surfaceClassName?: string;
  /**
   * When true, if the tab strip overflows horizontally, inactive tabs show icon only;
   * the selected tab keeps its text label. Widen the strip to show all labels again.
   */
  collapseInactiveTabLabelsOnOverflow?: boolean;
  dataTourTarget?: string;
}

type SortableTabListProps = {
  tabs: WorkStationTab[];
  tabIds: string[];
  activeTabId: string | null;
  tabGitInfoMap: Map<string, GitFileInfo>;
  hideInactiveTabLabels: boolean;
  onTabClick: (tabId: string) => void;
  onCloseClick: (event: React.MouseEvent, tabId: string) => void;
  onContextMenu: (event: React.MouseEvent, tab: WorkStationTab) => void;
};

const SortableTabList: React.FC<SortableTabListProps> = memo(
  ({
    tabs,
    tabIds,
    activeTabId,
    tabGitInfoMap,
    hideInactiveTabLabels,
    onTabClick,
    onCloseClick,
    onContextMenu,
  }) => (
    <div className="flex min-w-max shrink-0 items-center" role="tablist">
      <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
        <span
          className={`${TAB_PAIR_SEPARATOR_SLOT_CLASS} bg-transparent`}
          aria-hidden
        />
        {tabs.map((tab, i) => {
          const next = tabs[i + 1];
          const separatorVisible =
            !!next && tab.id !== activeTabId && next.id !== activeTabId;

          return (
            <Fragment key={tab.id}>
              <NoDragRegion>
                <SortableTab
                  tab={tab}
                  isActive={tab.id === activeTabId}
                  isDraggable={!tab.pinned}
                  onTabClick={onTabClick}
                  onCloseClick={onCloseClick}
                  onContextMenu={onContextMenu}
                  gitInfo={tabGitInfoMap.get(tab.id)}
                  hideLabel={hideInactiveTabLabels && tab.id !== activeTabId}
                />
              </NoDragRegion>
              {next && (
                <span
                  className={`${TAB_PAIR_SEPARATOR_SLOT_CLASS} ${
                    separatorVisible ? "bg-border-2" : "bg-transparent"
                  }`}
                  aria-hidden
                />
              )}
            </Fragment>
          );
        })}
      </SortableContext>
    </div>
  )
);

SortableTabList.displayName = "SortableTabList";

// ============================================
// Main Component
// ============================================

export const TabBar: React.FC<TabBarProps> = memo(
  ({
    paneId = "primary",
    tabs,
    activeTabId,
    onTabClick,
    onTabClose,
    onTabReorder,
    onMoreOptions,
    onNewTab,
    onNewTabShortcutId,
    onCloseOtherTabs,
    onCloseSavedTabs,
    repoPath = "",
    leadingSlot,
    tabRowPrefix,
    trailingSlot,
    surfaceClassName = "bg-workstation-bg",
    collapseInactiveTabLabelsOnOverflow = false,
    dataTourTarget,
  }) => {
    const { t } = useTranslation();
    const actionSystem = useActionSystemOptional();
    const dispatch = actionSystem?.dispatch;
    const shouldOffsetLeftChrome = useShouldOffsetWorkStationTopBar();

    const scrollReveal = useAtomValue(tabScrollRevealAtom);
    const gitStatusMap = useAtomValue(gitFileStatusMapAtom);
    const tabGitInfoMap = useTabGitInfoMap(tabs, repoPath, gitStatusMap);

    const tabsContainerRef = useRef<HTMLDivElement>(null);
    const tabBandRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const moveSessionTab = useSetAtom(moveSessionTabAtom);
    const moveWorkstationPrTabToChatPanel = useSetAtom(
      moveWorkstationPrTabToChatPanelAtom
    );
    const openSessionInWorkstation = useSetAtom(openSessionInWorkstationAtom);
    const openTeamInbox = useSetAtom(openTeamInboxInChatPanelTabAtom);
    const requestSessionHandoff = useSetAtom(
      requestTeamInboxSessionHandoffAtom
    );
    const handleSessionTabDrop = useCallback(
      (transfer: SessionTabTransfer) => moveSessionTab(transfer),
      [moveSessionTab]
    );
    const handleSessionReferenceDrop = useCallback(
      (reference: SessionReferenceOpen) =>
        openSessionInWorkstation({
          sessionId: reference.sessionId,
          title: reference.title,
        }),
      [openSessionInWorkstation]
    );
    const isSessionDragOver = useSessionTabDropTarget({
      target: "workstation",
      containerRef,
      onDrop: handleSessionTabDrop,
      onOpenSessionReference: handleSessionReferenceDrop,
    });

    const sensors = useSensors(
      useSensor(PointerSensor, {
        activationConstraint: { distance: 8 },
      }),
      useSensor(KeyboardSensor, {
        coordinateGetter: sortableKeyboardCoordinates,
      })
    );

    useAutoScrollToActive({
      activeTabId,
      tabsLength: tabs?.length ?? 0,
      containerRef: tabsContainerRef,
      scrollReveal,
    });

    const {
      draggingTabId,
      draggingTab,
      handleDragStart,
      handleDragMove,
      handleDragEnd,
      handleDragCancel,
    } = useTabDrag({
      tabs,
      onTabReorder,
    });
    useTabInsertionIndicator({ containerRef: tabBandRef, draggingTabId });

    const [contextMenu, setContextMenu] = useState<{
      position: { x: number; y: number };
      tab: WorkStationTab;
    } | null>(null);
    const [rawTranscriptSessionId, setRawTranscriptSessionId] = useState<
      string | null
    >(null);

    const hideInactiveTabLabels = useTabLabelCollapse({
      enabled: collapseInactiveTabLabelsOnOverflow,
      tabsDependency: tabs,
      activeTabDependency: activeTabId,
      containerRef: tabsContainerRef,
    });

    const handleTabClick = useCallback(
      (tabId: string) => onTabClick(tabId),
      [onTabClick]
    );

    const handleCloseClick = useCallback(
      (e: React.MouseEvent, tabId: string) => {
        e.stopPropagation();
        onTabClose(tabId);
      },
      [onTabClose]
    );

    const handleContextMenu = useCallback(
      (e: React.MouseEvent, tab: WorkStationTab) => {
        e.preventDefault();
        setContextMenu({ position: { x: e.clientX, y: e.clientY }, tab });
      },
      []
    );

    const handleCloseContextMenu = useCallback(() => setContextMenu(null), []);
    const handleMoveToChatPanel = useCallback(
      (tab: WorkStationTab) => {
        const sessionId = tab.data.sessionId;
        if (tab.type === "chat-session" && typeof sessionId === "string") {
          moveSessionTab({
            source: "workstation",
            sourceTabId: tab.id,
            sessionId,
            title: tab.title,
          });
          return;
        }

        moveWorkstationPrTabToChatPanel(tab.id);
      },
      [moveSessionTab, moveWorkstationPrTabToChatPanel]
    );
    const handleViewRawTranscript = useCallback((sessionId: string) => {
      setRawTranscriptSessionId(sessionId);
    }, []);
    const handleCreateWorkItemFromSession = useCallback(
      (tab: WorkStationTab) => {
        const sessionId = tab.data.sessionId;
        if (tab.type !== "chat-session" || typeof sessionId !== "string") {
          return;
        }
        requestSessionHandoff({ sessionId, title: tab.title });
        openTeamInbox(t("navigation:labels.inbox"));
      },
      [openTeamInbox, requestSessionHandoff, t]
    );
    const handleCloseRawTranscript = useCallback(() => {
      setRawTranscriptSessionId(null);
    }, []);
    const noopTabAction = useCallback((_tabId: string) => {}, []);
    const noopAction = useCallback(() => {}, []);

    const hasTabStrip = (tabs && tabs.length > 0) || Boolean(tabRowPrefix);
    const hasTabs = tabs && tabs.length > 0;
    const tabIds = useMemo(
      () => (hasTabs ? tabs.map((tab) => tab.id) : []),
      [hasTabs, tabs]
    );

    if (!hasTabStrip && !leadingSlot && !trailingSlot) {
      return null;
    }

    return (
      <div
        ref={containerRef}
        data-pane-id={paneId}
        data-session-tab-drop-target="workstation"
        data-tour-target={dataTourTarget}
        data-is-dragging={draggingTabId ? "true" : undefined}
        className={`work-station-tab-bar relative flex shrink-0 overflow-hidden ${surfaceClassName}`}
        data-tauri-drag-region
        style={
          {
            height: `${TAB_BAR_HEIGHT + 8}px`,
            paddingLeft: shouldOffsetLeftChrome
              ? getCollapsedSidebarChromeOffset()
              : undefined,
            WebkitAppRegion: "drag",
          } as React.CSSProperties
        }
      >
        <div className="mt-2 flex h-9 min-w-0 flex-1 items-center">
          {shouldOffsetLeftChrome ? <CollapsedSidebarButton /> : null}
          {leadingSlot ? (
            <div
              className="flex h-full shrink-0 items-stretch"
              data-tauri-drag-region
              style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
            >
              {leadingSlot}
            </div>
          ) : null}

          <div
            ref={tabBandRef}
            className="relative flex h-8 min-w-0 flex-1 items-center"
          >
            {isSessionDragOver ? (
              <div
                // Fill the tab band and empty space, excluding header buttons.
                className={`${SESSION_TAB_DROP_TARGET_HIGHLIGHT_CLASS} inset-0`}
                aria-hidden
              />
            ) : null}
            <div
              ref={tabsContainerRef}
              className="relative flex h-full min-w-0 max-w-full shrink items-center overflow-x-auto overflow-y-hidden scrollbar-hide"
              style={{ scrollBehavior: "smooth" } as React.CSSProperties}
            >
              {tabRowPrefix ? (
                <NoDragRegion className="flex h-full shrink-0 items-center gap-1">
                  {tabRowPrefix}
                </NoDragRegion>
              ) : null}
              {tabRowPrefix && hasTabs ? (
                <span className={TAB_STRIP_SECTION_RULE_CLASS} aria-hidden />
              ) : null}
              {hasTabs ? (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragStart={handleDragStart}
                  onDragMove={handleDragMove}
                  onDragEnd={handleDragEnd}
                  onDragCancel={handleDragCancel}
                >
                  <SortableTabList
                    tabs={tabs}
                    tabIds={tabIds}
                    activeTabId={activeTabId}
                    tabGitInfoMap={tabGitInfoMap}
                    hideInactiveTabLabels={
                      collapseInactiveTabLabelsOnOverflow &&
                      hideInactiveTabLabels
                    }
                    onTabClick={handleTabClick}
                    onCloseClick={handleCloseClick}
                    onContextMenu={handleContextMenu}
                  />

                  {createPortal(
                    <DragOverlay dropAnimation={null}>
                      {draggingTab && (
                        <div
                          className={TAB_PILL_DRAG_OVERLAY_CLASS}
                          style={{ zIndex: 9999 }}
                        >
                          <FileTypeIcon
                            fileName={draggingTab.title}
                            size="small"
                          />
                          <span className="max-w-[150px] overflow-hidden text-ellipsis whitespace-nowrap text-[13px]">
                            {draggingTab.title}
                          </span>
                        </div>
                      )}
                    </DragOverlay>,
                    document.body
                  )}
                </DndContext>
              ) : null}
            </div>

            <div
              className="h-8 min-w-px flex-1"
              data-tauri-drag-region
              style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
              aria-hidden
            />
          </div>

          <NoDragRegion>
            <TabBarControls
              hasTabs={hasTabs}
              onNewTab={onNewTab}
              onNewTabShortcutId={onNewTabShortcutId}
              onMoreOptions={onMoreOptions}
              trailingSlot={trailingSlot}
            />
          </NoDragRegion>
        </div>

        {contextMenu && (
          <TabContextMenu
            position={contextMenu.position}
            tab={contextMenu.tab}
            repoPath={repoPath}
            onClose={handleCloseContextMenu}
            onCloseTab={onTabClose}
            onCloseOtherTabs={onCloseOtherTabs ?? noopTabAction}
            onCloseSavedTabs={onCloseSavedTabs ?? noopAction}
            onMoveToChatPanel={
              (contextMenu.tab.type === "chat-session" &&
                typeof contextMenu.tab.data.sessionId === "string" &&
                contextMenu.tab.data.sessionId.length > 0) ||
              canMoveWorkstationPrTabToChatPanel(contextMenu.tab)
                ? handleMoveToChatPanel
                : undefined
            }
            onViewRawTranscript={handleViewRawTranscript}
            onCreateWorkItemFromSession={handleCreateWorkItemFromSession}
            dispatch={dispatch}
          />
        )}
        {rawTranscriptSessionId ? (
          <SessionRawTranscriptDialog
            visible
            sessionId={rawTranscriptSessionId}
            onClose={handleCloseRawTranscript}
          />
        ) : null}
      </div>
    );
  }
);

TabBar.displayName = "TabBar";

export default TabBar;

// Re-export types and config
export type { WorkStationTab } from "./types";
export {
  TAB_BAR_HEIGHT,
  MAX_VISIBLE_TABS,
  STATUS_LABELS,
  TAB_STRIP_SECTION_RULE_CLASS,
} from "./config";
