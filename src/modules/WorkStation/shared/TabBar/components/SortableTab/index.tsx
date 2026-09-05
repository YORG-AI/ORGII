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
import { TabLabelRowScrim } from "@src/components/TabPill/TabLabelRowScrim";
import { TabPillCloseButton } from "@src/components/TabPill/TabPillCloseButton";
import { TabPillSurface } from "@src/components/TabPill/TabPillSurface";
import {
  getStatusColor,
  getStatusColorForFile,
  getStatusLetterForFile,
} from "@src/config/gitStatus";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import {
  HugeiconsIcon,
  LockIcon as Lock,
  MoveLeftIcon as MoveHorizontal,
} from "@src/icons";
import { CODE_EDITOR_TOUR_TARGETS } from "@src/scaffold/Tutorials/codeEditorTourConfig";
import type { GitFileInfo } from "@src/store/git";
import {
  isPlaceholderBrowserSessionTitle,
  translatePlaceholderBrowserSessionTitle,
} from "@src/store/workstation/browser/tabs";
import {
  CODE_EDITOR_MAIN_TERMINAL_TAB_ID,
  resolveProjectManagerTabTitle,
} from "@src/store/workstation/tabs";

import type { WorkStationTab } from "../../types";
import {
  WORKSTATION_TAB_ICONS,
  WorkstationTabIcon,
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
// Helper Functions
// ============================================

/**
 * Get color class for git status letter - uses centralized VSCode styling
 */
function getGitStatusColor(statusLetter: string): string {
  return getStatusColor(statusLetter);
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

    const getDisplayTitle = () => {
      if (
        tab.type === "browser-session" &&
        isPlaceholderBrowserSessionTitle(tab.title)
      ) {
        return translatePlaceholderBrowserSessionTitle(tab.title, t);
      }
      if (
        tab.type === "project-dashboard" ||
        tab.type === "project-work-items" ||
        tab.type === "project-linear-projects" ||
        tab.type === "project-linear-work-items"
      ) {
        return resolveProjectManagerTabTitle(tab, t);
      }
      // Localized titles for the singleton tool tabs.
      switch (tab.type) {
        case "start":
          return t("navigation:routes.launchpad");
        case "search-sessions":
          return t("navigation:workstation.plusMenu.searchSessions");
        case "explorer":
          return t("common:labels.files");
        case "source-control":
          return t("common:actions.review");
        case "terminal":
          if (tab.id === CODE_EDITOR_MAIN_TERMINAL_TAB_ID) {
            return t("common:tabs.terminal");
          }
          break;
      }
      return tab.title;
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
          return getDisplayTitle();
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
    const shortcutTooltipLabel = getDisplayTitle();

    const hasUnsaved = !!tab.hasUnsavedChanges;
    const showCloseSlot = isTabHovered || hasUnsaved;
    const showCloseIcon = isTabHovered;
    const showLabelRightScrim = isTabHovered || hasUnsaved;
    const closeButtonLayoutClass =
      "-translate-y-1/2 absolute right-1 top-1/2 z-10 h-5 w-5";

    const titleTextClass = (base: string) =>
      `${base} ${
        tab.type === "git-diff" && tab.data.gitStatusLetter === "D"
          ? "text-danger-6 line-through"
          : tab.type === "file" && gitInfo
            ? getStatusColorForFile(gitInfo.status, gitInfo.staged)
            : isActive
              ? "text-text-1"
              : "text-text-2"
      }`;

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
        {/* Keep icon in-flow so width only comes from the label column; close stays overlay-only. */}
        <div className="flex shrink-0 items-center justify-center">
          <WorkstationTabIcon tab={tab} isActive={isActive} />
        </div>

        {!hideLabel && tab.type === "git-diff" && tab.data.isTimeline ? (
          <div
            className={`relative flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-[13px] ${
              isActive ? "text-text-1" : "text-text-2"
            }`}
          >
            <span className="min-w-0 flex-1 truncate">
              {tab.title} ({String(tab.data.shortSha)})
            </span>
            <HugeiconsIcon
              icon={MoveHorizontal}
              data-icon="move-horizontal"
              size={12}
              className="shrink-0"
            />
            <span className="shrink-0">
              ({String(tab.data.headShortSha || "HEAD")})
            </span>
            <HugeiconsIcon
              icon={Lock}
              data-icon="lock"
              size={11}
              className="shrink-0"
            />
            <TabLabelRowScrim visible={showLabelRightScrim} />
          </div>
        ) : !hideLabel ? (
          <div className="relative flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            <span
              className={titleTextClass(
                "min-w-0 flex-1 overflow-hidden text-[13px] text-ellipsis whitespace-nowrap"
              )}
            >
              {tab.type === "git-diff"
                ? `${tab.title} (Working Tree)`
                : getDisplayTitle()}
            </span>
            {tab.type === "git-diff" && !!tab.data.gitStatusLetter && (
              <span
                className={`shrink-0 text-[11px] font-bold ${getGitStatusColor(tab.data.gitStatusLetter as string)}`}
              >
                {String(tab.data.gitStatusLetter)}
              </span>
            )}
            {tab.type === "file" && gitInfo && (
              <span
                className={`shrink-0 text-[11px] font-bold ${getStatusColorForFile(gitInfo.status, gitInfo.staged)}`}
              >
                {getStatusLetterForFile(gitInfo.status, gitInfo.staged)}
              </span>
            )}
            <TabLabelRowScrim visible={showLabelRightScrim} />
          </div>
        ) : null}

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
