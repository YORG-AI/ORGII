/**
 * Shared type definitions for ProjectWorkItemsTabContent and its extracted
 * sibling modules (data loader, workspace-data hook, interactions hook).
 * Extracted to keep the tab-content component under the 600-line limit.
 */
import type React from "react";

import type { projectApi } from "@src/api/http/project";
import type { WorkstationTabHeaderHost } from "@src/hooks/workStation";
import type { LinearProjectSelection } from "@src/modules/ProjectManager/Panels/ProjectManagerSidebar/content/WorkspaceTreeContent";
import type { WorkspaceWorkItem } from "@src/modules/ProjectManager/workspaceAggregate";

import {
  WORKSPACE_ACTIVE_READ_BUCKET,
  WORKSPACE_COMPLETED_READ_BUCKET,
} from "./ProjectWorkItemsTabContentConstants";

export interface ProjectWorkItemsTabContentProps {
  breadcrumbSegments?: readonly { label: string }[];
  workStationTabId?: string;
  workstationHeaderHost?: WorkstationTabHeaderHost;
  onCreateProject?: () => void;
  onCreateWorkItem?: () => void;
  onOpenLinearProject?: (selection: LinearProjectSelection) => void;
  orgId?: string;
  allowExternalSources?: boolean;
  onOpenWorkItem: (selection: ProjectWorkItemSelection) => void;
  /** Org hub surface pills shown after the breadcrumb (Overview / Projects / …). */
  orgSurfaceControls?: React.ReactNode;
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

export type WorkspaceProjectRecord = Awaited<
  ReturnType<typeof projectApi.readProjects>
>[number];

export interface ReadWorkspaceBucketOptions {
  projects: WorkspaceProjectRecord[];
  orgNameById: Map<string, string>;
  orgId?: string;
  readBucket:
    | typeof WORKSPACE_ACTIVE_READ_BUCKET
    | typeof WORKSPACE_COMPLETED_READ_BUCKET;
  linearWorkItems: WorkspaceWorkItem[];
}
