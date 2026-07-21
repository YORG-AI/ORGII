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
  activeTab: WorkItemsViewTab;
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
  leadingControls?: React.ReactNode;
  trailingControls?: React.ReactNode;
  publishToWorkstationHeader?: boolean;
  workstationHeaderHost?: WorkstationTabHeaderHost;
  className?: string;
}
