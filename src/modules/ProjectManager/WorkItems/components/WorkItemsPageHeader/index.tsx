import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { HEADER_CLASSES } from "@src/config/workstation/tokens";
import { useRefreshSpin } from "@src/hooks/ui";
import { usePublishWorkstationTabHeader } from "@src/hooks/workStation";

import { WorkItemsHeaderContent } from "./WorkItemsHeaderContent";
import type { WorkItemsPageHeaderProps } from "./types";

export type { StatusCounts, WorkItemsViewTab } from "./types";

const WorkItemsPageHeader = ({
  projectName,
  breadcrumbSegments,
  activeTab,
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
  leadingControls,
  trailingControls,
  publishToWorkstationHeader = false,
  workstationHeaderHost = "project",
  className = "",
}: WorkItemsPageHeaderProps) => {
  const { t } = useTranslation("projects");
  const { spinClass: refreshSpinClass, handleClick: handleRefreshClick } =
    useRefreshSpin(onRefresh ?? (() => {}), refreshLoading);
  const resolvedBreadcrumbSegments = useMemo(
    () =>
      breadcrumbSegments ?? [
        { label: t("projects.dashboardTitle") },
        { label: projectName },
      ],
    [breadcrumbSegments, projectName, t]
  );
  const content = (
    <WorkItemsHeaderContent
      activeTab={activeTab}
      breadcrumbSegments={resolvedBreadcrumbSegments}
      leadingControls={leadingControls}
      trailingControls={trailingControls}
      onSearch={onSearch}
      statusFilter={statusFilter}
      onStatusFilterChange={onStatusFilterChange}
      statusCounts={statusCounts}
      statusFilterKeys={statusFilterKeys}
      onCollapseAll={onCollapseAll}
      onRefresh={onRefresh}
      onAddProject={onAddProject}
      onAddWorkItem={onAddWorkItem}
      onToggleProperties={onToggleProperties}
      showProperties={showProperties}
      refreshSpinClass={refreshSpinClass}
      onRefreshClick={handleRefreshClick}
      t={t}
    />
  );

  usePublishWorkstationTabHeader({
    host: workstationHeaderHost,
    content: { content },
    enabled: publishToWorkstationHeader,
  });
  if (publishToWorkstationHeader) return null;
  return (
    <div className={`${HEADER_CLASSES.pageHeader} ${className}`}>{content}</div>
  );
};

export default WorkItemsPageHeader;
