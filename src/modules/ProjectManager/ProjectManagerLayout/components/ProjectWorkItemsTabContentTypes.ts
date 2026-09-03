/**
 * Shared type definitions for ProjectWorkItemsTabContent and its extracted
 * sibling modules (data loader, workspace-data hook, interactions hook).
 * Extracted to keep the tab-content component under the 600-line limit.
 */
import type React from "react";

import type {
  WorkItemReadBucket,
  WorkspaceWorkItemsData,
} from "@src/api/http/project";
import type { WorkstationTabHeaderHost } from "@src/hooks/tabHost/useWorkstationTabHeader";
import type { LinearProjectSelection } from "@src/modules/ProjectManager/Panels/ProjectManagerSidebar/content/WorkspaceTreeContent";
import type { ProjectManagerBreadcrumbSegment } from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";
import type { WorkspaceWorkItem } from "@src/modules/ProjectManager/workspaceAggregate";

export interface ProjectWorkItemsTabContentProps {
  breadcrumbSegments?: readonly ProjectManagerBreadcrumbSegment[];
  workStationTabId?: string;
  workstationHeaderHost?: WorkstationTabHeaderHost;
  /** Disable the shell sidebar toggle when this page has no sidebar. */
  sidebarToggleDisabled?: boolean;
  /** Navigate from the breadcrumb root back to the Projects index. */
  onOpenProjects?: () => void;
  onCreateProject?: () => void;
  onCreateWorkItem?: () => void;
  onOpenLinearProject?: (selection: LinearProjectSelection) => void;
  orgId?: string;
  allowExternalSources?: boolean;
  onOpenWorkItem: (selection: ProjectWorkItemSelection) => void;
  /** Org hub surface pills shown after the breadcrumb (Overview / Projects / …). */
  orgSurfaceControls?: React.ReactNode;
  /** Parent-owned context control shown before split-list header content. */
  splitHeaderLeading?: React.ReactNode;
}

export interface AggregatedWorkItemProject {
  meta: {
    id: string;
    name: string;
  };
  slug: string;
}

export interface AggregatedWorkItem {
  project?: AggregatedWorkItemProject;
  item: WorkspaceWorkItem;
  shortId: string;
  orgId: string;
  orgName?: string;
}

export interface ProjectWorkItemSelection {
  workItem: WorkspaceWorkItem;
  shortId: string;
  orgId: string;
  orgName?: string;
  projectId?: string;
  projectName?: string;
  projectSlug?: string;
}

export type WorkspaceSourceMode = "local_only" | "include_external";
export type ProjectWorkItemsViewTab = "List" | "Kanban";

export interface ReadWorkspaceBucketOptions {
  workspaceData: WorkspaceWorkItemsData;
  orgId?: string;
  readBucket?: WorkItemReadBucket;
  linearWorkItems: WorkspaceWorkItem[];
}
