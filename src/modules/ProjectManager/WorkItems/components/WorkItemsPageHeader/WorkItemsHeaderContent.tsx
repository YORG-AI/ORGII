import type { TFunction } from "i18next";

import Button from "@src/components/Button";
import { HeaderSectionSeparator } from "@src/components/HeaderSectionSeparator";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import {
  HugeiconsIcon,
  InformationCircleIcon,
  ListChevronsDownUpIcon,
  Refresh04Icon,
  Search01Icon,
} from "@src/icons";
import ProjectManagerBreadcrumb from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";

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
  section: "content" | "trailing";
  breadcrumbSegments: NonNullable<
    WorkItemsPageHeaderProps["breadcrumbSegments"]
  >;
  refreshSpinClass?: string;
  onRefreshClick: () => void;
  t: TFunction<"projects">;
}

export function WorkItemsHeaderContent({
  section,
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

  if (section === "content") {
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

  return (
    <div className="flex shrink-0 items-center gap-px">
      {trailingControls}
      {trailingControls && (onSearch || showStatusFilter) && (
        <HeaderSectionSeparator className="mx-0.5" />
      )}
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
      {showStatusFilter && <HeaderSectionSeparator className="mx-1" />}
      {(showCollapseAll || onRefresh || onAddProject || onAddWorkItem) && (
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
            <ToolbarTooltip label={t("common:actions.refresh")}>
              <Button
                htmlType="button"
                variant="tertiary"
                size="small"
                iconOnly
                onClick={onRefreshClick}
                aria-label={t("common:actions.refresh")}
                icon={
                  <HugeiconsIcon
                    icon={Refresh04Icon}
                    data-icon="refresh-cw"
                    size={HEADER_ICON_SIZE.sm}
                    strokeWidth={2}
                    className={refreshSpinClass}
                  />
                }
              />
            </ToolbarTooltip>
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
    </div>
  );
}
