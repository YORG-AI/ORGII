import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  HEADER_CLASSES,
  HEADER_ICON_SIZE,
} from "@src/config/workstation/tokens";
import { usePublishWorkstationTabHeader } from "@src/hooks/tabHost/useWorkstationTabHeader";
import { useRefreshSpin } from "@src/hooks/ui";
import { DeliveryBox01Icon, HugeiconsIcon } from "@src/icons";

import { WorkItemsHeaderContent } from "./WorkItemsHeaderContent";
import type { WorkItemsPageHeaderProps } from "./types";

export type { StatusCounts, WorkItemsViewTab } from "./types";

const WorkItemsPageHeader = ({
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
}: WorkItemsPageHeaderProps) => {
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
            <HugeiconsIcon
              icon={DeliveryBox01Icon}
              data-icon="box"
              size={HEADER_ICON_SIZE.sm}
              strokeWidth={1.75}
            />
          ),
        };
      }
      if (index === 0 && onOpenProjects && !segment.onClick) {
        return { ...segment, onClick: onOpenProjects };
      }
      return segment;
    });
  }, [breadcrumbSegments, identityIcon, onOpenProjects, projectName, t]);

  const sharedContentProps = {
    activeTab,
    breadcrumbSegments: resolvedBreadcrumbSegments,
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
    showProperties,
    refreshSpinClass,
    onRefreshClick: handleRefreshClick,
    t,
  };
  const headerContent = (
    <WorkItemsHeaderContent section="content" {...sharedContentProps} />
  );
  const headerTrailing = (
    <WorkItemsHeaderContent section="trailing" {...sharedContentProps} />
  );

  usePublishWorkstationTabHeader({
    host: workstationHeaderHost,
    content: { content: headerContent, trailing: headerTrailing },
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
