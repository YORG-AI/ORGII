import type React from "react";

import type { WorkstationTabHeaderHost } from "@src/hooks/workStation";
import type { ProjectManagerBreadcrumbSegment } from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";

import type {
  StatusCounts,
  StatusFilterType,
  WorkItemsViewTab,
} from "../../types";

export type { StatusCounts, WorkItemsViewTab } from "../../types";

export interface WorkItemsPageHeaderProps {
  projectName: string;
  breadcrumbSegments?: readonly ProjectManagerBreadcrumbSegment[];
  /** Provider/type icon rendered before the final breadcrumb segment. */
  identityIcon?: React.ReactNode;
  onOpenProjects?: () => void;
  activeTab: WorkItemsViewTab;
  onTabChange?: (tab: WorkItemsViewTab) => void;
  statusFilter?: string;
  onStatusFilterChange?: (filter: string) => void;
  statusCounts: StatusCounts;
  statusFilterKeys?: readonly StatusFilterType[];
  showProperties?: boolean;
  onToggleProperties?: () => void;
  onAddProject?: () => void;
  onAddWorkItem?: () => void;
  onSearch?: () => void;
  onCollapseAll?: () => void;
  onRefresh?: () => void;
  refreshLoading?: boolean;
  visibleTabs?: readonly WorkItemsViewTab[];
  leadingControls?: React.ReactNode;
  trailingControls?: React.ReactNode;
  publishToWorkstationHeader?: boolean;
  workstationHeaderHost?: WorkstationTabHeaderHost;
  className?: string;
}
