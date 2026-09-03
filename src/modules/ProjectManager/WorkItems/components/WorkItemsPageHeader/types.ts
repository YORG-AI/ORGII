import type React from "react";

import type { WorkstationTabHeaderHost } from "@src/hooks/tabHost/useWorkstationTabHeader";
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
  /** Presentation actions that stay at the far end of the header row. */
  endControls?: React.ReactNode;
  /** Render the existing header controls as rows pinned in a split list. */
  splitListHeader?: boolean;
  /** Optional parent-owned context control before the first split-header row. */
  splitHeaderLeading?: React.ReactNode;
  publishToWorkstationHeader?: boolean;
  workstationHeaderHost?: WorkstationTabHeaderHost;
  /** Disable the shell sidebar toggle when this page has no sidebar. */
  sidebarToggleDisabled?: boolean;
  className?: string;
}
