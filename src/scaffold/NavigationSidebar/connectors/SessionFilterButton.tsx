import { useAtom } from "jotai";
import React, {
  type FC,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { DropdownItem, DropdownPanel } from "@src/components/Dropdown/exports";
import {
  type SubmenuAnchor,
  clampSubmenuTop,
  getSubmenuAnchor,
} from "@src/components/Dropdown/submenuLayout";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import IconButton from "@src/components/IconButton";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import { useDropdownEngine } from "@src/hooks/dropdown";
import {
  ArrowRight01Icon,
  ArrowUpDownIcon,
  ArrowUpRight01Icon,
  FilterMailIcon,
  FolderInputIcon,
  FolderOutputIcon,
  FolderSymlinkIcon,
  HugeiconsIcon,
  Layers01Icon,
  ListChevronsDownUpIcon,
  Refresh04Icon,
  SlidersHorizontalIcon,
  TickDouble01Icon,
  ViewIcon,
} from "@src/icons";
import { SIDEBAR_TOOLTIP_HOVER_DELAY } from "@src/scaffold/NavigationSidebar/config";
import { getViewportSize } from "@src/util/ui/window/viewport";

import HoverAnimatedIcon, {
  triggerIconAnimation,
} from "../components/HoverAnimatedIcon";
import {
  SESSION_SORT_MODES,
  sidebarSessionSortAtom,
} from "./sidebarSessionOrder";
import {
  GROUP_BY_MODES,
  SESSION_GROUP_VISIBLE_COUNTS,
  type SessionGroupVisibleCount,
} from "./types";

type SessionFilterSubmenu = "groupBy" | "visibleCount" | "sort";

interface SessionFilterButtonProps {
  groupByMode: string;
  groupVisibleCount: SessionGroupVisibleCount;
  includeExternal: boolean;
  groupByModes?: readonly string[];
  getGroupByLabel?: (mode: string) => string;
  onSelect: (mode: string) => void;
  onSelectGroupVisibleCount: (count: SessionGroupVisibleCount) => void;
  onToggleIncludeExternal: (includeExternal: boolean) => void;
  /**
   * Open Runtime → Scanning, where each external source is shown or hidden
   * individually. Refines the all-or-nothing `includeExternal` toggle above it.
   */
  onConfigureExternalSources?: () => void;
  /** Collapse every section in the sidebar. */
  onCollapseAll?: () => void;
  /** Mark all currently-loaded sessions as visited. */
  onMarkAllRead?: () => void;
  /** Refresh the sidebar session list from the backing stores. */
  onRefreshSessions?: () => void;
  /** Open the JSON Session export modal for the active Session. */
  onExportSessionJson?: () => void;
  /** Open the JSON Session import modal. */
  onImportSessionJson?: () => void;
  canExportSessionJson?: boolean;
}

export const SessionFilterButton: FC<SessionFilterButtonProps> = React.memo(
  ({
    groupByMode,
    groupVisibleCount,
    includeExternal,
    groupByModes = GROUP_BY_MODES,
    getGroupByLabel,
    onSelect,
    onSelectGroupVisibleCount,
    onToggleIncludeExternal,
    onConfigureExternalSources,
    onCollapseAll,
    onMarkAllRead,
    onRefreshSessions,
    onExportSessionJson,
    onImportSessionJson,
    canExportSessionJson = true,
  }) => {
    const { t } = useTranslation("navigation");
    const { t: tCommon } = useTranslation("common");
    // Multi-choice settings live one level down, while every other row here
    // acts on the list immediately. Keeping their options out of the first
    // level keeps the actions readable and still shows each current value.
    const [sortMode, setSortMode] = useAtom(sidebarSessionSortAtom);
    const sortTriggerRef = useRef<HTMLDivElement | null>(null);
    const groupTriggerRef = useRef<HTMLDivElement | null>(null);
    const visibleCountTriggerRef = useRef<HTMLDivElement | null>(null);
    const submenuPanelRef = useRef<HTMLDivElement | null>(null);
    const submenuInsideRefs = useMemo(() => [submenuPanelRef], []);
    const [activeSubmenu, setActiveSubmenu] =
      useState<SessionFilterSubmenu | null>(null);
    const [submenuAnchor, setSubmenuAnchor] = useState<SubmenuAnchor | null>(
      null
    );

    const closeSubmenu = useCallback(() => {
      setActiveSubmenu(null);
      setSubmenuAnchor(null);
    }, []);

    const handleMenuOpenChange = useCallback(
      (open: boolean) => {
        if (!open) closeSubmenu();
      },
      [closeSubmenu]
    );

    const {
      isOpen,
      isPositioned,
      toggle,
      close,
      triggerRef,
      panelRef,
      panelPosition,
    } = useDropdownEngine<HTMLDivElement>({
      placement: "top",
      align: "left",
      gap: DROPDOWN_PANEL.triggerGap,
      // Click-opened sidebar menu: own keyboard focus so Escape works even
      // when focus was parked in the chat composer / terminal pane.
      captureKeyboardFocus: true,
      onOpenChange: handleMenuOpenChange,
      additionalInsideRefs: submenuInsideRefs,
    });

    // The submenu's real height is only known once it has rendered, so the
    // anchor's preferred top is corrected here rather than on open.
    useLayoutEffect(() => {
      if (!activeSubmenu || !submenuAnchor || !submenuPanelRef.current) {
        return;
      }

      const { height: submenuHeight } =
        submenuPanelRef.current.getBoundingClientRect();
      const { height: viewportHeight } = getViewportSize();
      const clampedTop = clampSubmenuTop({
        anchor: submenuAnchor,
        submenuHeight,
        viewportHeight,
      });

      if (clampedTop === submenuAnchor.top) return;
      setSubmenuAnchor((current) =>
        current ? { ...current, top: clampedTop } : current
      );
    }, [activeSubmenu, submenuAnchor]);

    const openSubmenu = useCallback(
      (submenu: SessionFilterSubmenu, trigger: HTMLElement) => {
        const { width: viewportWidth, height: viewportHeight } =
          getViewportSize();
        setSubmenuAnchor(
          getSubmenuAnchor({
            triggerRect: trigger.getBoundingClientRect(),
            parentRect: panelRef.current?.getBoundingClientRect() ?? null,
            submenuWidth: DROPDOWN_WIDTHS.panelWidth,
            viewportWidth,
            viewportHeight,
            opensUpward: panelPosition.bottom !== undefined,
          })
        );
        setActiveSubmenu(submenu);
      },
      [panelPosition.bottom, panelRef]
    );

    const handleSubmenuTriggerEnter = useCallback(
      (submenu: SessionFilterSubmenu) => {
        const trigger =
          submenu === "groupBy"
            ? groupTriggerRef.current
            : submenu === "sort"
              ? sortTriggerRef.current
              : visibleCountTriggerRef.current;
        if (trigger) openSubmenu(submenu, trigger);
      },
      [openSubmenu]
    );

    const handleSubmenuTriggerClick = useCallback(
      (submenu: SessionFilterSubmenu) => {
        // Keyboard and automated interactions never fire the hover that normally
        // opens this row, so a click opens it too.
        if (activeSubmenu === submenu) {
          closeSubmenu();
          return;
        }
        handleSubmenuTriggerEnter(submenu);
      },
      [activeSubmenu, closeSubmenu, handleSubmenuTriggerEnter]
    );

    const handleSelect = useCallback(
      (mode: string) => {
        onSelect(mode);
        closeSubmenu();
        close();
      },
      [onSelect, closeSubmenu, close]
    );

    const handleGroupVisibleCountSelect = useCallback(
      (count: SessionGroupVisibleCount) => {
        onSelectGroupVisibleCount(count);
        closeSubmenu();
        close();
      },
      [close, closeSubmenu, onSelectGroupVisibleCount]
    );

    const handleToggleIncludeExternal = useCallback(() => {
      onToggleIncludeExternal(!includeExternal);
    }, [includeExternal, onToggleIncludeExternal]);

    const handleConfigureExternalSources = useCallback(() => {
      onConfigureExternalSources?.();
      close();
    }, [onConfigureExternalSources, close]);

    const handleCollapseAll = useCallback(() => {
      onCollapseAll?.();
      close();
    }, [onCollapseAll, close]);

    const handleMarkAllRead = useCallback(() => {
      onMarkAllRead?.();
      close();
    }, [onMarkAllRead, close]);

    const handleRefreshSessions = useCallback(() => {
      onRefreshSessions?.();
      close();
    }, [onRefreshSessions, close]);

    const handleExportSessionJson = useCallback(() => {
      onExportSessionJson?.();
      close();
    }, [onExportSessionJson, close]);

    const handleImportSessionJson = useCallback(() => {
      onImportSessionJson?.();
      close();
    }, [onImportSessionJson, close]);

    const handleSubmenuPointerDown = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        event.stopPropagation();
      },
      []
    );

    const handleSubmenuMouseDown = useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        event.stopPropagation();
      },
      []
    );

    const resolveGroupByLabel = useCallback(
      (mode: string) => getGroupByLabel?.(mode) ?? t(`sidebar.groupBy.${mode}`),
      [getGroupByLabel, t]
    );

    const hasExtraActions = Boolean(
      onCollapseAll ||
      onMarkAllRead ||
      onRefreshSessions ||
      onExportSessionJson ||
      onImportSessionJson
    );

    return (
      <>
        <ToolbarTooltip
          label={t("sidebar.groupBy.title")}
          position="top"
          mouseEnterDelay={SIDEBAR_TOOLTIP_HOVER_DELAY}
          disabled={isOpen}
        >
          <div ref={triggerRef} className="inline-flex">
            <IconButton
              aria-label={t("sidebar.groupBy.title")}
              data-testid="sidebar-session-filter-button"
              size="lg"
              variant="default"
              className={`rounded-lg! ${
                isOpen
                  ? "bg-sidebar-selected! text-text-1! hover:bg-sidebar-selected!"
                  : "text-text-2! hover:bg-sidebar-selected! hover:text-text-1!"
              }`}
              onClick={toggle}
              onMouseEnter={(event) =>
                triggerIconAnimation(event.currentTarget)
              }
            >
              <HoverAnimatedIcon
                icon={FilterMailIcon}
                iconName="list-filter"
                size={16}
                strokeWidth={2}
                className={isOpen ? "text-text-1" : "text-text-2"}
              />
            </IconButton>
          </div>
        </ToolbarTooltip>

        {isOpen &&
          isPositioned &&
          createPortal(
            <DropdownPanel
              ref={panelRef}
              className={`${DROPDOWN_WIDTHS.sidebarMenuClass} fixed`}
              maxHeight="none"
              style={{
                top: panelPosition.top,
                bottom: panelPosition.bottom,
                left: panelPosition.left,
              }}
            >
              <div className={DROPDOWN_CLASSES.itemsColumnPadded}>
                <DropdownItem
                  ref={groupTriggerRef}
                  dataTestId="sidebar-group-by-trigger"
                  className={
                    activeSubmenu === "groupBy"
                      ? DROPDOWN_CLASSES.itemActive
                      : ""
                  }
                  icon={
                    <HugeiconsIcon
                      icon={Layers01Icon}
                      data-icon="layers"
                      size={DROPDOWN_ITEM.iconSize}
                      strokeWidth={2}
                    />
                  }
                  suffix={
                    <span className="flex items-center gap-1">
                      <span className="text-text-3">
                        {resolveGroupByLabel(groupByMode)}
                      </span>
                      <HugeiconsIcon
                        icon={ArrowRight01Icon}
                        data-icon="chevron-right"
                        size={DROPDOWN_ITEM.iconSize}
                        strokeWidth={2}
                        className="text-text-3"
                      />
                    </span>
                  }
                  ariaHasPopup="menu"
                  ariaExpanded={activeSubmenu === "groupBy"}
                  onMouseEnter={() => handleSubmenuTriggerEnter("groupBy")}
                  onClick={() => handleSubmenuTriggerClick("groupBy")}
                >
                  {t("sidebar.groupBy.title")}
                </DropdownItem>
                <DropdownItem
                  ref={sortTriggerRef}
                  dataTestId="sidebar-sort-trigger"
                  icon={
                    <HugeiconsIcon
                      icon={ArrowUpDownIcon}
                      data-icon="arrow-up-down"
                      size={DROPDOWN_ITEM.iconSize}
                      strokeWidth={2}
                    />
                  }
                  ariaHasPopup="menu"
                  ariaExpanded={activeSubmenu === "sort"}
                  onMouseEnter={() => handleSubmenuTriggerEnter("sort")}
                  onClick={() => handleSubmenuTriggerClick("sort")}
                  suffix={
                    <span className="flex items-center gap-1 text-text-3">
                      {t(`sidebar.sort.${sortMode}`)}
                      <HugeiconsIcon
                        icon={ArrowRight01Icon}
                        size={DROPDOWN_ITEM.iconSize}
                      />
                    </span>
                  }
                >
                  {t("sidebar.sort.title")}
                </DropdownItem>
                <DropdownItem
                  ref={visibleCountTriggerRef}
                  dataTestId="sidebar-show-trigger"
                  className={
                    activeSubmenu === "visibleCount"
                      ? DROPDOWN_CLASSES.itemActive
                      : ""
                  }
                  icon={
                    <HugeiconsIcon
                      icon={ViewIcon}
                      data-icon="view"
                      size={DROPDOWN_ITEM.iconSize}
                      strokeWidth={2}
                    />
                  }
                  suffix={
                    <span className="flex items-center gap-1">
                      <span className="text-text-3">
                        {t(`sidebar.show.recent${groupVisibleCount}`)}
                      </span>
                      <HugeiconsIcon
                        icon={ArrowRight01Icon}
                        data-icon="chevron-right"
                        size={DROPDOWN_ITEM.iconSize}
                        strokeWidth={2}
                        className="text-text-3"
                      />
                    </span>
                  }
                  ariaHasPopup="menu"
                  ariaExpanded={activeSubmenu === "visibleCount"}
                  onMouseEnter={() => handleSubmenuTriggerEnter("visibleCount")}
                  onClick={() => handleSubmenuTriggerClick("visibleCount")}
                >
                  {t("sidebar.show.title")}
                </DropdownItem>
                <div className={DROPDOWN_CLASSES.menuGroupSeparator} />
                <DropdownItem
                  dataTestId="sidebar-include-external"
                  selected={includeExternal}
                  icon={
                    <HugeiconsIcon
                      icon={FolderSymlinkIcon}
                      data-icon="folder-symlink"
                      size={DROPDOWN_ITEM.iconSize}
                      strokeWidth={2}
                    />
                  }
                  onMouseEnter={closeSubmenu}
                  onClick={handleToggleIncludeExternal}
                >
                  {t("sidebar.filters.includeExternal")}
                </DropdownItem>
                {hasExtraActions && (
                  <>
                    <div className={DROPDOWN_CLASSES.menuGroupSeparator} />
                    {onRefreshSessions && (
                      <DropdownItem
                        dataTestId="sidebar-refresh-sessions"
                        icon={
                          <HugeiconsIcon
                            icon={Refresh04Icon}
                            data-icon="refresh-cw"
                            size={DROPDOWN_ITEM.iconSize}
                            strokeWidth={2}
                          />
                        }
                        onMouseEnter={closeSubmenu}
                        onClick={handleRefreshSessions}
                      >
                        {tCommon("actions.refresh")}
                      </DropdownItem>
                    )}
                    {onExportSessionJson && (
                      <DropdownItem
                        icon={
                          <HugeiconsIcon
                            icon={FolderOutputIcon}
                            data-icon="folder-output"
                            size={DROPDOWN_ITEM.iconSize}
                            strokeWidth={2}
                          />
                        }
                        disabled={!canExportSessionJson}
                        onMouseEnter={closeSubmenu}
                        onClick={handleExportSessionJson}
                      >
                        {tCommon("sessions:chat.importExport.exportAction")}
                      </DropdownItem>
                    )}
                    {onImportSessionJson && (
                      <DropdownItem
                        icon={
                          <HugeiconsIcon
                            icon={FolderInputIcon}
                            data-icon="folder-input"
                            size={DROPDOWN_ITEM.iconSize}
                            strokeWidth={2}
                          />
                        }
                        onMouseEnter={closeSubmenu}
                        onClick={handleImportSessionJson}
                      >
                        {tCommon("sessions:chat.importExport.importAction")}
                      </DropdownItem>
                    )}
                    {onCollapseAll && (
                      <DropdownItem
                        icon={
                          <HugeiconsIcon
                            icon={ListChevronsDownUpIcon}
                            data-icon="list-chevrons-down-up"
                            size={DROPDOWN_ITEM.iconSize}
                            strokeWidth={2}
                          />
                        }
                        onMouseEnter={closeSubmenu}
                        onClick={handleCollapseAll}
                      >
                        {t("sidebar.actions.collapseAll")}
                      </DropdownItem>
                    )}
                    {onMarkAllRead && (
                      <DropdownItem
                        icon={
                          <HugeiconsIcon
                            icon={TickDouble01Icon}
                            data-icon="check-check"
                            size={DROPDOWN_ITEM.iconSize}
                            strokeWidth={2}
                          />
                        }
                        onMouseEnter={closeSubmenu}
                        onClick={handleMarkAllRead}
                      >
                        {t("sidebar.actions.markAllRead")}
                      </DropdownItem>
                    )}
                  </>
                )}
                {onConfigureExternalSources && (
                  <>
                    {/* Last section, on its own: unlike every item above —
                        which acts on this list in place — it leaves the menu
                        for Runtime → Scanning. The trailing arrow says so. */}
                    <div className={DROPDOWN_CLASSES.menuGroupSeparator} />
                    <DropdownItem
                      dataTestId="sidebar-configure-external-sources"
                      icon={
                        <HugeiconsIcon
                          icon={SlidersHorizontalIcon}
                          data-icon="sliders-horizontal"
                          size={DROPDOWN_ITEM.iconSize}
                          strokeWidth={2}
                        />
                      }
                      suffix={
                        <HugeiconsIcon
                          icon={ArrowUpRight01Icon}
                          data-icon="arrow-up-right"
                          size={DROPDOWN_ITEM.iconSize}
                          strokeWidth={2}
                          className="text-text-3"
                        />
                      }
                      onMouseEnter={closeSubmenu}
                      onClick={handleConfigureExternalSources}
                    >
                      {t("sidebar.filters.manageExternalSources")}
                    </DropdownItem>
                  </>
                )}
              </div>
            </DropdownPanel>,
            document.body
          )}

        {isOpen &&
          activeSubmenu &&
          submenuAnchor &&
          createPortal(
            <DropdownPanel
              ref={submenuPanelRef}
              className={`${DROPDOWN_WIDTHS.panelWidthClass} fixed`}
              maxHeight="none"
              style={{ top: submenuAnchor.top, left: submenuAnchor.left }}
              data-testid={
                activeSubmenu === "groupBy"
                  ? "sidebar-group-by-submenu"
                  : activeSubmenu === "sort"
                    ? "sidebar-sort-submenu"
                    : "sidebar-show-submenu"
              }
              onPointerDown={handleSubmenuPointerDown}
              onMouseDown={handleSubmenuMouseDown}
            >
              <div className={DROPDOWN_CLASSES.itemsColumnPadded}>
                {activeSubmenu === "groupBy"
                  ? groupByModes.map((mode) => (
                      <DropdownItem
                        key={mode}
                        dataTestId={`sidebar-group-by-${mode}`}
                        selected={mode === groupByMode}
                        onClick={() => handleSelect(mode)}
                      >
                        {resolveGroupByLabel(mode)}
                      </DropdownItem>
                    ))
                  : activeSubmenu === "sort"
                    ? SESSION_SORT_MODES.map((mode) => (
                        <DropdownItem
                          key={mode}
                          dataTestId={`sidebar-sort-${mode}`}
                          selected={mode === sortMode}
                          onClick={() => {
                            setSortMode(mode);
                            closeSubmenu();
                            close();
                          }}
                        >
                          {t(`sidebar.sort.${mode}`)}
                        </DropdownItem>
                      ))
                    : SESSION_GROUP_VISIBLE_COUNTS.map((count) => (
                        <DropdownItem
                          key={count}
                          dataTestId={`sidebar-show-recent-${count}`}
                          selected={count === groupVisibleCount}
                          onClick={() => handleGroupVisibleCountSelect(count)}
                        >
                          {t(`sidebar.show.recent${count}`)}
                        </DropdownItem>
                      ))}
              </div>
            </DropdownPanel>,
            document.body
          )}
      </>
    );
  }
);

SessionFilterButton.displayName = "SessionFilterButton";
