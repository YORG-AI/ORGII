/**
 * WorkItemsPageHeader Component
 *
 * Header for the Work Items page.
 * Displays: {Project Name} … [Status filter] | [Overview | List | …].
 * In Workstation Project Manager, search can live on the tab bar trailing slot,
 * while view/filter/action controls live in the 40px page header. The breadcrumb
 * is path-only.
 *
 * Uses shared WorkStation header tokens for consistent styling.
 */
import {
  Box,
  Info,
  ListChecks,
  ListChevronsDownUp,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import {
  HEADER_CLASSES,
  HEADER_ICON_SIZE,
} from "@src/config/workstation/tokens";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { useRefreshSpin } from "@src/hooks/ui";
import {
  type WorkstationTabHeaderHost,
  usePublishWorkstationTabHeader,
} from "@src/hooks/workStation";
import ProjectManagerBreadcrumb from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";
import type { ProjectManagerBreadcrumbSegment } from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";
import {
  WorkstationHeaderSectionSeparator,
  WorkstationToolbarTooltip,
} from "@src/modules/WorkStation/shared";

import type { StatusFilterType } from "../../types";
import WorkItemsStatusFilterSelect from "../WorkItemsStatusFilterSelect";

// ============================================
// Types
// ============================================

export type WorkItemsViewTab =
  | "Overview"
  | "List"
  | "Kanban"
  | "Gantt"
  | "Calendar"
  | "Settings";

/** Pre-computed status counts from Rust (avoid JS recomputation) */
export interface StatusCounts {
  all: number;
  backlog: number;
  todo: number;
  inProgress: number;
  inReview: number;
  done: number;
  cancelled: number;
  duplicate: number;
  open: number;
  closed: number;
  // Index signature for dynamic key access
  [key: string]: number;
}

export interface WorkItemsPageHeaderProps {
  /** Current project name to display in breadcrumb */
  projectName: string;
  breadcrumbSegments?: readonly ProjectManagerBreadcrumbSegment[];
  /** Provider/type icon rendered before the first breadcrumb segment. */
  identityIcon?: React.ReactNode;
  /** Navigate back to the Projects list from the breadcrumb */
  onOpenProjects?: () => void;
  /** Currently selected view tab */
  activeTab: WorkItemsViewTab;
  /** Callback when tab is changed */
  onTabChange?: (tab: WorkItemsViewTab) => void;
  /** Status filter (shown inline when activeTab is "List") */
  statusFilter?: string;
  /** Callback when status filter is changed */
  onStatusFilterChange?: (filter: string) => void;
  /** Pre-computed status counts for status filter badges. */
  statusCounts: StatusCounts;
  /** Status filters available for the active work item source. */
  statusFilterKeys?: readonly StatusFilterType[];
  /** Whether the properties panel is visible */
  showProperties?: boolean;
  /** Callback to toggle properties panel visibility */
  onToggleProperties?: () => void;
  /** Callback when "Add Project" button is clicked */
  onAddProject?: () => void;
  /** Callback when "Add Work Item" button is clicked */
  onAddWorkItem?: () => void;
  /** Callback when search button is clicked (opens PageSearch) */
  onSearch?: () => void;
  /** Collapse every visible list status section. */
  onCollapseAll?: () => void;
  /** Callback when refresh button is clicked */
  onRefresh?: () => void;
  /** Whether refresh is in progress (for spin animation) */
  refreshLoading?: boolean;
  /** Tabs supported by the current surface. Defaults to all Work Items views. */
  visibleTabs?: readonly WorkItemsViewTab[];
  /** Additional controls shown next to the breadcrumb on the left side. */
  leadingControls?: React.ReactNode;
  /** Additional controls shown before search/view controls. */
  trailingControls?: React.ReactNode;
  /** Publish controls into the global WorkstationTabHeader instead of rendering an inline 40px row. */
  publishToWorkstationHeader?: boolean;
  /** Target workstation host slot for the published header. */
  workstationHeaderHost?: WorkstationTabHeaderHost;
  /** Additional className */
  className?: string;
}

// ============================================
// Constants
// ============================================

interface AddActionsButtonProps {
  onAddProject?: () => void;
  onAddWorkItem?: () => void;
  addProjectLabel: string;
  addWorkItemLabel: string;
}

const AddActionsButton: React.FC<AddActionsButtonProps> = ({
  onAddProject,
  onAddWorkItem,
  addProjectLabel,
  addWorkItemLabel,
}) => {
  const {
    isOpen,
    isPositioned,
    toggle,
    close,
    triggerRef,
    panelRef,
    panelPosition,
  } = useDropdownEngine<HTMLButtonElement>({
    gap: DROPDOWN_PANEL.triggerGapTight,
    align: "right",
    closeOnEsc: true,
    placement: "bottom",
  });

  const handleAddProject = useCallback(() => {
    close();
    onAddProject?.();
  }, [close, onAddProject]);

  const handleAddWorkItem = useCallback(() => {
    close();
    onAddWorkItem?.();
  }, [close, onAddWorkItem]);

  if (!onAddProject && !onAddWorkItem) return null;

  if (!onAddProject || !onAddWorkItem) {
    const label = onAddWorkItem ? addWorkItemLabel : addProjectLabel;
    return (
      <WorkstationToolbarTooltip label={label}>
        <Button
          htmlType="button"
          variant="tertiary"
          size="small"
          iconOnly
          onClick={onAddWorkItem ?? onAddProject}
          aria-label={label}
          data-testid={
            onAddWorkItem
              ? "work-items-create-work-item"
              : "work-items-create-project"
          }
          icon={<Plus size={HEADER_ICON_SIZE.md} strokeWidth={2} />}
        />
      </WorkstationToolbarTooltip>
    );
  }

  return (
    <>
      <WorkstationToolbarTooltip label={addWorkItemLabel} disabled={isOpen}>
        <Button
          ref={triggerRef}
          htmlType="button"
          variant="tertiary"
          size="small"
          iconOnly
          className={isOpen ? "!bg-surface-selected !text-primary-6" : ""}
          onClick={toggle}
          aria-label={addWorkItemLabel}
          data-testid="work-items-create-menu"
          icon={<Plus size={HEADER_ICON_SIZE.md} strokeWidth={2} />}
        />
      </WorkstationToolbarTooltip>
      {isOpen &&
        isPositioned &&
        createPortal(
          <div
            ref={panelRef}
            className={`${DROPDOWN_CLASSES.menuPanelBase} fixed ${DROPDOWN_WIDTHS.sidebarMenuClass}`}
            style={{
              top: panelPosition.top,
              bottom: panelPosition.bottom,
              left:
                panelPosition.right === undefined
                  ? panelPosition.left
                  : undefined,
              right: panelPosition.right,
            }}
            role="menu"
          >
            <button
              type="button"
              onClick={handleAddWorkItem}
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left`}
              role="menuitem"
              data-testid="work-items-create-work-item"
            >
              <ListChecks
                size={DROPDOWN_ITEM.iconSize}
                strokeWidth={1.75}
                className="text-text-2"
              />
              <span className="min-w-0 flex-1 truncate">
                {addWorkItemLabel}
              </span>
            </button>
            <button
              type="button"
              onClick={handleAddProject}
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left`}
              role="menuitem"
              data-testid="work-items-create-project"
            >
              <Box
                size={DROPDOWN_ITEM.iconSize}
                strokeWidth={1.75}
                className="text-text-2"
              />
              <span className="min-w-0 flex-1 truncate">{addProjectLabel}</span>
            </button>
          </div>,
          document.body
        )}
    </>
  );
};

// ============================================
// Component
// ============================================

const WorkItemsPageHeader: React.FC<WorkItemsPageHeaderProps> = ({
  projectName,
  breadcrumbSegments,
  identityIcon,
  onOpenProjects,
  activeTab,
  onTabChange: _onTabChange,
  statusFilter,
  onStatusFilterChange,
  statusCounts,
  statusFilterKeys,
  showProperties = true,
  onToggleProperties,
  onAddProject,
  onAddWorkItem,
  onSearch,
  onCollapseAll,
  onRefresh,
  refreshLoading = false,
  visibleTabs: _visibleTabs,
  leadingControls,
  trailingControls,
  publishToWorkstationHeader = false,
  workstationHeaderHost = "project",
  className = "",
}) => {
  const { t } = useTranslation("projects");
  const { spinClass: refreshSpinClass, handleClick: handleRefreshClick } =
    useRefreshSpin(onRefresh ?? (() => {}), refreshLoading);
  const resolvedBreadcrumbSegments = useMemo(() => {
    const segments = breadcrumbSegments ?? [
      { label: t("projects.dashboardTitle") },
      { label: projectName },
    ];
    return segments.map((segment, index) => {
      if (index === segments.length - 1) {
        return {
          ...segment,
          icon: segment.icon ?? identityIcon ?? (
            <Box size={HEADER_ICON_SIZE.sm} strokeWidth={1.75} />
          ),
        };
      }
      if (index === 0 && onOpenProjects && !segment.onClick) {
        return { ...segment, onClick: onOpenProjects };
      }
      return segment;
    });
  }, [breadcrumbSegments, identityIcon, onOpenProjects, projectName, t]);

  const activeTabSupportsStatusFilter =
    activeTab === "List" || activeTab === "Kanban";
  const showStatusFilter =
    activeTabSupportsStatusFilter && statusFilter && onStatusFilterChange;
  const showCollapseAll = activeTab === "List" && onCollapseAll;

  const searchControl = onSearch && (
    <WorkstationToolbarTooltip label={t("common:actions.search")}>
      <Button
        htmlType="button"
        variant="tertiary"
        size="small"
        iconOnly
        onClick={onSearch}
        aria-label={t("common:actions.search")}
        icon={<Search size={HEADER_ICON_SIZE.sm} />}
      />
    </WorkstationToolbarTooltip>
  );

  const addControls = (onAddWorkItem || onAddProject) && (
    <AddActionsButton
      onAddProject={onAddProject}
      onAddWorkItem={onAddWorkItem}
      addProjectLabel={t("projects.createProject")}
      addWorkItemLabel={t("workItems.createWorkItem")}
    />
  );

  const propertiesLabel = showProperties
    ? t("workItems.hideProperties")
    : t("workItems.showProperties");
  const propertiesControl = onToggleProperties && (
    <WorkstationToolbarTooltip label={propertiesLabel}>
      <Button
        htmlType="button"
        variant="tertiary"
        size="small"
        iconOnly
        className={showProperties ? "!bg-surface-selected !text-primary-6" : ""}
        onClick={onToggleProperties}
        aria-label={propertiesLabel}
        icon={<Info size={HEADER_ICON_SIZE.sm} />}
      />
    </WorkstationToolbarTooltip>
  );

  const headerContent = (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <ProjectManagerBreadcrumb
        segments={resolvedBreadcrumbSegments}
        trailingNode={leadingControls}
      />
    </div>
  );

  const headerTrailing = (
    <div className="flex flex-shrink-0 items-center gap-px">
      {trailingControls}
      {trailingControls && (searchControl || showStatusFilter) && (
        <WorkstationHeaderSectionSeparator className="mx-0.5" />
      )}
      {searchControl}

      {showStatusFilter && (
        <WorkItemsStatusFilterSelect
          value={statusFilter as StatusFilterType}
          onChange={(value) => onStatusFilterChange(value)}
          statusCounts={statusCounts}
          filterKeys={statusFilterKeys}
        />
      )}

      {showStatusFilter && (
        <WorkstationHeaderSectionSeparator className="mx-1" />
      )}

      {(showCollapseAll || onRefresh || addControls) && (
        <div className="flex flex-shrink-0 items-center gap-px">
          {showCollapseAll && (
            <WorkstationToolbarTooltip label={t("common:actions.collapseAll")}>
              <Button
                htmlType="button"
                variant="tertiary"
                size="small"
                iconOnly
                onClick={onCollapseAll}
                aria-label={t("common:actions.collapseAll")}
                icon={<ListChevronsDownUp size={HEADER_ICON_SIZE.md} />}
              />
            </WorkstationToolbarTooltip>
          )}

          {onRefresh && (
            <WorkstationToolbarTooltip label={t("common:actions.refresh")}>
              <Button
                htmlType="button"
                variant="tertiary"
                size="small"
                iconOnly
                onClick={handleRefreshClick}
                aria-label={t("common:actions.refresh")}
                icon={
                  <RefreshCw
                    size={HEADER_ICON_SIZE.sm}
                    strokeWidth={2}
                    className={refreshSpinClass}
                  />
                }
              />
            </WorkstationToolbarTooltip>
          )}
          {addControls}
        </div>
      )}

      {propertiesControl && (
        <>
          <WorkstationHeaderSectionSeparator className="mx-0.5" />
          {propertiesControl}
        </>
      )}
    </div>
  );

  usePublishWorkstationTabHeader({
    host: workstationHeaderHost,
    content: {
      content: headerContent,
      trailing: headerTrailing,
    },
    enabled: publishToWorkstationHeader,
  });

  if (publishToWorkstationHeader) return null;

  return (
    <div className={`${HEADER_CLASSES.pageHeader} ${className}`}>
      {headerContent}
      {headerTrailing}
    </div>
  );
};

export default WorkItemsPageHeader;
