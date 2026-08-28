import React, { type FC, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { DropdownItem, DropdownPanel } from "@src/components/Dropdown/exports";
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
  FilterMailIcon,
  FolderInputIcon,
  FolderOutputIcon,
  HugeiconsIcon,
  ListChevronsDownUpIcon,
  Refresh04Icon,
  SlidersHorizontalIcon,
  SquareArrowUpRightIcon,
  TickDouble01Icon,
} from "@src/icons";

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
    });

    const handleSelect = useCallback(
      (mode: string) => {
        onSelect(mode);
        close();
      },
      [onSelect, close]
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
                <div className={DROPDOWN_CLASSES.sectionLabel}>
                  {t("sidebar.groupBy.title")}
                </div>
                {groupByModes.map((mode) => {
                  const active = mode === groupByMode;
                  return (
                    <DropdownItem
                      key={mode}
                      dataTestId={`sidebar-group-by-${mode}`}
                      selected={active}
                      onClick={() => handleSelect(mode)}
                    >
                      {getGroupByLabel?.(mode) ?? t(`sidebar.groupBy.${mode}`)}
                    </DropdownItem>
                  );
                })}
                <div className={DROPDOWN_CLASSES.menuSeparatorInset} />
                <DropdownItem
                  selected={includeExternal}
                  onClick={handleToggleIncludeExternal}
                >
                  {t("sidebar.filters.includeExternal")}
                </DropdownItem>
                {hasExtraActions && (
                  <>
                    <div className={DROPDOWN_CLASSES.menuSeparatorInset} />
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
                    <div className={DROPDOWN_CLASSES.menuSeparatorInset} />
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
                          icon={SquareArrowUpRightIcon}
                          data-icon="arrow-up-right"
                          size={DROPDOWN_ITEM.iconSize}
                          strokeWidth={2}
                          className="text-text-3"
                        />
                      }
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
      </>
    );
  }
);

SessionFilterButton.displayName = "SessionFilterButton";
