/**
 * SortableTab Component
 *
 * Individual sortable tab item with drag support, git status display,
 * and close button with unsaved indicator.
 */
import { useSortable } from "@dnd-kit/sortable";
import React, { memo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import { TabPillCloseButton } from "@src/components/TabPill/TabPillCloseButton";
import { TabPillSurface } from "@src/components/TabPill/TabPillSurface";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { CODE_EDITOR_TOUR_TARGETS } from "@src/scaffold/Tutorials/codeEditorTourConfig";
import type { GitFileInfo } from "@src/store/git";
import type { WorkStationTab } from "@src/store/workstation/tabs";

import {
  WorkstationTabContent,
  getWorkstationTabDisplayTitle,
} from "../WorkstationTabContent";
import {
  WORKSTATION_TAB_ICONS,
  resolveWorkstationTabIntegrationIcon,
} from "../WorkstationTabIcon";

// ============================================
// Types
// ============================================

export { resolveWorkstationTabIntegrationIcon, WORKSTATION_TAB_ICONS };

interface SortableTabProps {
  tab: WorkStationTab;
  isActive: boolean;
  isDraggable: boolean;
  onTabClick: (tabId: string) => void;
  onCloseClick: (event: React.MouseEvent, tabId: string) => void;
  onContextMenu: (event: React.MouseEvent, tab: WorkStationTab) => void;
  gitInfo?: GitFileInfo | null;
  /** Icon only (e.g. narrow tab strip); title still in native tooltip via getTabTitle(). */
  hideLabel?: boolean;
}

// ============================================
// Component
// ============================================

export const SortableTab: React.FC<SortableTabProps> = memo(
  ({
    tab,
    isActive,
    isDraggable,
    onTabClick,
    onCloseClick,
    onContextMenu,
    gitInfo = null,
    hideLabel = false,
  }) => {
    const { t } = useTranslation();
    const [isTabHovered, setIsTabHovered] = useState(false);
    const {
      attributes,
      listeners,
      setNodeRef,
      transform,
      transition,
      isDragging,
    } = useSortable({ id: tab.id, disabled: !isDraggable });

    // Always allow free movement for both tab reordering and drag-to-split
    const style: React.CSSProperties = {
      transform: transform
        ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
        : undefined,
      transition,
      zIndex: isDragging ? 100 : undefined,
    };

    const getTabTitle = () => {
      const filePath = tab.data.filePath as string | undefined;
      const sessionName = tab.data.sessionName as string | undefined;

      switch (tab.type) {
        case "file":
          return filePath || tab.title;
        case "git-diff":
          // Timeline diff: compact format since filename is the same
          if (tab.data.isTimeline) {
            const shortSha = String(tab.data.shortSha || "");
            const headSha = String(tab.data.headShortSha || "");
            return `${filePath || tab.title} (${shortSha}) ↔ (${headSha})`;
          }
          return `${filePath || tab.title} (Working Tree)`;
        case "terminal":
          return `Terminal: ${sessionName || tab.title}`;
        case "github-pr-detail": {
          const prTitle = tab.data.prTitle as string | undefined;
          return prTitle ? `#${tab.data.prNumber} ${prTitle}` : tab.title;
        }
        default:
          return getWorkstationTabDisplayTitle(tab, t);
      }
    };

    const shortcutId =
      tab.type === "explorer"
        ? "open_file_folder_tab"
        : tab.type === "terminal"
          ? "open_terminal_tab"
          : tab.type === "source-control"
            ? "open_source_control_tab"
            : null;
    const shortcut = shortcutId ? getShortcutKeys(shortcutId) : "";
    const shortcutTooltipLabel = getWorkstationTabDisplayTitle(tab, t);

    const hasUnsaved = !!tab.hasUnsavedChanges;
    const showCloseSlot = isTabHovered || hasUnsaved;
    const showCloseIcon = isTabHovered;
    const showLabelRightScrim = isTabHovered || hasUnsaved;
    const closeButtonLayoutClass =
      "-translate-y-1/2 absolute right-1 top-1/2 z-10 h-5 w-5";

    const tabPill = (
      <TabPillSurface
        ref={setNodeRef}
        style={style}
        {...attributes}
        role="tab"
        aria-selected={isActive}
        {...(isDraggable ? listeners : {})}
        data-tab-id={tab.id}
        data-tour-target={
          tab.type === "source-control"
            ? CODE_EDITOR_TOUR_TARGETS.sourceControl
            : undefined
        }
        data-action="editor.tab.switch"
        data-action-id={tab.id}
        isActive={isActive}
        isDragging={isDragging}
        hideLabel={hideLabel}
        onClick={() => !isDragging && onTabClick(tab.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu(event, tab);
        }}
        onMouseEnter={() => setIsTabHovered(true)}
        onMouseLeave={() => setIsTabHovered(false)}
        title={shortcut ? undefined : getTabTitle()}
      >
        <WorkstationTabContent
          tab={tab}
          isActive={isActive}
          gitInfo={gitInfo}
          hideLabel={hideLabel}
          showLabelRightScrim={showLabelRightScrim}
        />

        <TabPillCloseButton
          data-action="editor.tab.close"
          data-action-id={tab.id}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(event) => onCloseClick(event, tab.id)}
          title={
            showCloseIcon
              ? t("actions.close")
              : hasUnsaved
                ? t("common:placeholders.unsavedEdits")
                : t("actions.close")
          }
          hasUnsaved={hasUnsaved}
          showX={showCloseIcon}
          className={`grid place-items-center rounded text-text-3 transition-[opacity,colors,background-color] duration-150 ${SURFACE_TOKENS.hover} hover:text-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-6 focus-visible:ring-offset-0 ${closeButtonLayoutClass} ${
            showCloseSlot
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none opacity-0"
          }`}
        />
      </TabPillSurface>
    );

    if (!shortcut) return tabPill;

    return (
      <ToolbarTooltip
        label={shortcutTooltipLabel}
        shortcut={shortcut}
        position="bottom"
      >
        {tabPill}
      </ToolbarTooltip>
    );
  }
);

SortableTab.displayName = "SortableTab";

export default SortableTab;
