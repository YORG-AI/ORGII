import type { TFunction } from "i18next";

import Button from "@src/components/Button";
import { HeaderSectionSeparator } from "@src/components/HeaderSectionSeparator";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import {
  HugeiconsIcon,
  InformationCircleIcon,
  ListChevronsDownUpIcon,
  Search01Icon,
} from "@src/icons";
import ProjectManagerBreadcrumb from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";
import { WorkManagementRefreshButton } from "@src/modules/shared/components/WorkManagementRefreshButton";

import type { StatusFilterType } from "../../types";
import WorkItemsStatusFilterSelect from "../WorkItemsStatusFilterSelect";
import { AddActionsButton } from "./AddActionsButton";
import { shouldShowCollapseAll, shouldShowWorkItemStatusFilter } from "./model";
import type { WorkItemsPageHeaderProps } from "./types";

export interface WorkItemsHeaderActionsProps extends Pick<
  WorkItemsPageHeaderProps,
  | "activeTab"
  | "trailingControls"
  | "endControls"
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
  | "refreshLoading"
> {
  t: TFunction<"projects">;
  placement?: "header" | "list";
}

interface WorkItemsHeaderContentProps
  extends
    WorkItemsHeaderActionsProps,
    Pick<WorkItemsPageHeaderProps, "leadingControls"> {
  section: "content" | "trailing";
  breadcrumbSegments: NonNullable<
    WorkItemsPageHeaderProps["breadcrumbSegments"]
  >;
}

/** List-scoped controls reused in the page header and compact split pane. */
export function WorkItemsHeaderActions({
  activeTab,
  trailingControls,
  endControls,
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
  refreshLoading = false,
  t,
  placement = "header",
}: WorkItemsHeaderActionsProps) {
  const showStatusFilter = shouldShowWorkItemStatusFilter(
    activeTab,
    statusFilter,
    Boolean(onStatusFilterChange)
  );
  const showCollapseAll = shouldShowCollapseAll(
    activeTab,
    Boolean(onCollapseAll)
  );
  const showPrimaryActions = Boolean(
    showCollapseAll || onRefresh || onAddProject || onAddWorkItem
  );
  const propertiesLabel = showProperties
    ? t("workItems.hideProperties")
    : t("workItems.showProperties");

  return (
    <div
      className={`flex min-w-0 items-center gap-px ${
        placement === "list" ? "flex-1" : "shrink-0"
      }`}
    >
      {onSearch && (
        <ToolbarTooltip label={t("common:actions.search")}>
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            onClick={onSearch}
            aria-label={t("common:actions.search")}
            icon={
              <HugeiconsIcon
                icon={Search01Icon}
                data-icon="search"
                size={HEADER_ICON_SIZE.sm}
              />
            }
          />
        </ToolbarTooltip>
      )}
      {showStatusFilter && (
        <WorkItemsStatusFilterSelect
          value={statusFilter as StatusFilterType}
          onChange={(value) => onStatusFilterChange?.(value)}
          statusCounts={statusCounts}
          filterKeys={statusFilterKeys}
        />
      )}
      {trailingControls}
      {showPrimaryActions && (
        <div className="flex shrink-0 items-center gap-px">
          {showCollapseAll && (
            <ToolbarTooltip label={t("common:actions.collapseAll")}>
              <Button
                htmlType="button"
                variant="tertiary"
                size="small"
                iconOnly
                onClick={onCollapseAll}
                aria-label={t("common:actions.collapseAll")}
                icon={
                  <HugeiconsIcon
                    icon={ListChevronsDownUpIcon}
                    data-icon="list-chevrons-down-up"
                    size={HEADER_ICON_SIZE.md}
                  />
                }
              />
            </ToolbarTooltip>
          )}
          {onRefresh && (
            <WorkManagementRefreshButton
              label={t("common:actions.refresh")}
              loading={refreshLoading}
              onRefresh={onRefresh}
            />
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
          <HeaderSectionSeparator className="mx-0.5" />
          <ToolbarTooltip label={propertiesLabel}>
            <Button
              htmlType="button"
              variant="tertiary"
              size="small"
              iconOnly
              className={
                showProperties ? "bg-surface-selected! text-primary-6!" : ""
              }
              onClick={onToggleProperties}
              aria-label={propertiesLabel}
              icon={
                <HugeiconsIcon
                  icon={InformationCircleIcon}
                  data-icon="info"
                  size={HEADER_ICON_SIZE.sm}
                />
              }
            />
          </ToolbarTooltip>
        </>
      )}
      {endControls}
    </div>
  );
}

export function WorkItemsHeaderContent({
  section,
  breadcrumbSegments,
  leadingControls,
  ...actionProps
}: WorkItemsHeaderContentProps) {
  if (section === "trailing") {
    return <WorkItemsHeaderActions {...actionProps} />;
  }
  if (breadcrumbSegments.length === 0) {
    return leadingControls ? (
      <div className="contents">{leadingControls}</div>
    ) : null;
  }
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <ProjectManagerBreadcrumb
        segments={breadcrumbSegments}
        trailingNode={leadingControls}
      />
    </div>
  );
}
