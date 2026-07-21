import type { TFunction } from "i18next";
import { Info, ListChevronsDownUp, RefreshCw, Search } from "lucide-react";

import Button from "@src/components/Button";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import ProjectManagerBreadcrumb from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";
import {
  WorkstationHeaderSectionSeparator,
  WorkstationToolbarTooltip,
} from "@src/modules/WorkStation/shared";

import type { StatusFilterType } from "../../types";
import WorkItemsStatusFilterSelect from "../WorkItemsStatusFilterSelect";
import { AddActionsButton } from "./AddActionsButton";
import { shouldShowCollapseAll, shouldShowWorkItemStatusFilter } from "./model";
import type { WorkItemsPageHeaderProps } from "./types";

interface WorkItemsHeaderContentProps extends Pick<
  WorkItemsPageHeaderProps,
  | "activeTab"
  | "leadingControls"
  | "trailingControls"
  | "onSearch"
  | "statusFilter"
  | "onStatusFilterChange"
  | "statusCounts"
  | "statusFilterKeys"
  | "onCollapseAll"
  | "onRefresh"
  | "onAddProject"
  | "onAddWorkItem"
  | "onToggleProperties"
  | "showProperties"
> {
  breadcrumbSegments: NonNullable<
    WorkItemsPageHeaderProps["breadcrumbSegments"]
  >;
  refreshSpinClass?: string;
  onRefreshClick: () => void;
  t: TFunction<"projects">;
}

export function WorkItemsHeaderContent({
  activeTab,
  breadcrumbSegments,
  leadingControls,
  trailingControls,
  onSearch,
  statusFilter,
  onStatusFilterChange,
  statusCounts,
  statusFilterKeys,
  onCollapseAll,
  onRefresh,
  onAddProject,
  onAddWorkItem,
  onToggleProperties,
  showProperties = true,
  refreshSpinClass,
  onRefreshClick,
  t,
}: WorkItemsHeaderContentProps) {
  const showStatusFilter = shouldShowWorkItemStatusFilter(
    activeTab,
    statusFilter,
    Boolean(onStatusFilterChange)
  );
  const showCollapseAll = shouldShowCollapseAll(
    activeTab,
    Boolean(onCollapseAll)
  );
  const propertiesLabel = showProperties
    ? t("workItems.hideProperties")
    : t("workItems.showProperties");

  return (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <ProjectManagerBreadcrumb
          segments={breadcrumbSegments}
          trailingNode={leadingControls}
        />
      </div>
      <div className="flex flex-shrink-0 items-center gap-1">
        {trailingControls}
        {trailingControls && (onSearch || showStatusFilter) && (
          <WorkstationHeaderSectionSeparator className="mx-0.5" />
        )}
        {onSearch && (
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
        )}
        {showStatusFilter && (
          <WorkItemsStatusFilterSelect
            value={statusFilter as StatusFilterType}
            onChange={(value) => onStatusFilterChange?.(value)}
            statusCounts={statusCounts}
            filterKeys={statusFilterKeys}
          />
        )}
        {showStatusFilter && (
          <WorkstationHeaderSectionSeparator className="mx-1" />
        )}
        {(showCollapseAll || onRefresh || onAddProject || onAddWorkItem) && (
          <div className="flex flex-shrink-0 items-center gap-px">
            {showCollapseAll && (
              <WorkstationToolbarTooltip
                label={t("common:actions.collapseAll")}
              >
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
                  onClick={onRefreshClick}
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
            <AddActionsButton
              onAddProject={onAddProject}
              onAddWorkItem={onAddWorkItem}
              addProjectLabel={t("projects.createProject")}
              addWorkItemLabel={t("workItems.createWorkItem")}
            />
          </div>
        )}
        {onToggleProperties && (
          <>
            <WorkstationHeaderSectionSeparator className="mx-0.5" />
            <WorkstationToolbarTooltip label={propertiesLabel}>
              <Button
                htmlType="button"
                variant="tertiary"
                size="small"
                iconOnly
                className={
                  showProperties ? "!bg-surface-selected !text-primary-6" : ""
                }
                onClick={onToggleProperties}
                aria-label={propertiesLabel}
                icon={<Info size={HEADER_ICON_SIZE.sm} />}
              />
            </WorkstationToolbarTooltip>
          </>
        )}
      </div>
    </>
  );
}
