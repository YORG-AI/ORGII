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
  FilterMailIcon,
  FolderInputIcon,
  FolderOutputIcon,
  FolderSymlinkIcon,
  HugeiconsIcon,
  Layers01Icon,
  ListChevronsDownUpIcon,
  Refresh04Icon,
  SlidersHorizontalIcon,
  SquareArrowUpRight02Icon,
  TickDouble01Icon,
} from "@src/icons";
import { getViewportSize } from "@src/util/ui/window/viewport";

import HoverAnimatedIcon, {
  triggerIconAnimation,
} from "../components/HoverAnimatedIcon";
import { GROUP_BY_MODES } from "./types";

interface SessionFilterButtonProps {
  groupByMode: string;
  includeExternal: boolean;
  groupByModes?: readonly string[];
  getGroupByLabel?: (mode: string) => string;
  onSelect: (mode: string) => void;
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
    includeExternal,
    groupByModes = GROUP_BY_MODES,
    getGroupByLabel,
    onSelect,
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
    // Grouping lives one level down: it is a mode the user sets rarely, while
    // every other row here acts on the list immediately. Keeping the three
    // modes out of the first level keeps the actions readable at a glance and
    // still shows the current mode on the row that opens them.
    const groupTriggerRef = useRef<HTMLDivElement | null>(null);
    const submenuPanelRef = useRef<HTMLDivElement | null>(null);
    const submenuInsideRefs = useMemo(() => [submenuPanelRef], []);
    const [isGroupSubmenuOpen, setIsGroupSubmenuOpen] = useState(false);
    const [submenuAnchor, setSubmenuAnchor] = useState<SubmenuAnchor | null>(
      null
    );

    const closeGroupSubmenu = useCallback(() => {
      setIsGroupSubmenuOpen(false);
      setSubmenuAnchor(null);
    }, []);

    const handleMenuOpenChange = useCallback(
      (open: boolean) => {
        if (!open) closeGroupSubmenu();
      },
      [closeGroupSubmenu]
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
      if (!isGroupSubmenuOpen || !submenuAnchor || !submenuPanelRef.current) {
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
    }, [isGroupSubmenuOpen, submenuAnchor]);

    const openGroupSubmenu = useCallback(
      (trigger: HTMLElement) => {
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
        setIsGroupSubmenuOpen(true);
      },
      [panelPosition.bottom, panelRef]
    );

    const handleGroupTriggerEnter = useCallback(() => {
      const trigger = groupTriggerRef.current;
      if (trigger) openGroupSubmenu(trigger);
    }, [openGroupSubmenu]);

    const handleGroupTriggerClick = useCallback(() => {
      // Keyboard and automated interactions never fire the hover that normally
      // opens this row, so a click opens it too.
      if (isGroupSubmenuOpen) {
        closeGroupSubmenu();
        return;
      }
      handleGroupTriggerEnter();
    }, [closeGroupSubmenu, handleGroupTriggerEnter, isGroupSubmenuOpen]);

    const handleSelect = useCallback(
      (mode: string) => {
        onSelect(mode);
        closeGroupSubmenu();
        close();
      },
      [onSelect, closeGroupSubmenu, close]
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
          disabled={isOpen}
        >
          <div ref={triggerRef} className="inline-flex">
            <IconButton
              aria-label={t("sidebar.groupBy.title")}
              data-testid="sidebar-session-filter-button"
              size="lg"
              variant="default"
              className={`!rounded-full ${
                isOpen
                  ? "!bg-sidebar-selected !text-text-1 hover:!bg-sidebar-selected"
                  : "!text-text-2 hover:!bg-sidebar-selected hover:!text-text-1"
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
                    isGroupSubmenuOpen ? DROPDOWN_CLASSES.itemActive : ""
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
                  ariaExpanded={isGroupSubmenuOpen}
                  onMouseEnter={handleGroupTriggerEnter}
                  onClick={handleGroupTriggerClick}
                >
                  {t("sidebar.groupBy.title")}
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
                  onMouseEnter={closeGroupSubmenu}
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
                        onMouseEnter={closeGroupSubmenu}
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
                        onMouseEnter={closeGroupSubmenu}
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
                        onMouseEnter={closeGroupSubmenu}
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
                        onMouseEnter={closeGroupSubmenu}
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
                        onMouseEnter={closeGroupSubmenu}
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
                          icon={SquareArrowUpRight02Icon}
                          data-icon="arrow-up-right"
                          size={DROPDOWN_ITEM.iconSize}
                          strokeWidth={2}
                          className="text-text-3"
                        />
                      }
                      onMouseEnter={closeGroupSubmenu}
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
          isGroupSubmenuOpen &&
          submenuAnchor &&
          createPortal(
            <DropdownPanel
              ref={submenuPanelRef}
              className={`${DROPDOWN_WIDTHS.panelWidthClass} fixed`}
              maxHeight="none"
              style={{ top: submenuAnchor.top, left: submenuAnchor.left }}
              data-testid="sidebar-group-by-submenu"
              onPointerDown={handleSubmenuPointerDown}
              onMouseDown={handleSubmenuMouseDown}
            >
              <div className={DROPDOWN_CLASSES.itemsColumnPadded}>
                <div className={DROPDOWN_CLASSES.sectionLabel}>
                  {t("sidebar.groupBy.title")}
                </div>
                {groupByModes.map((mode) => (
                  <DropdownItem
                    key={mode}
                    dataTestId={`sidebar-group-by-${mode}`}
                    selected={mode === groupByMode}
                    onClick={() => handleSelect(mode)}
                  >
                    {resolveGroupByLabel(mode)}
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
