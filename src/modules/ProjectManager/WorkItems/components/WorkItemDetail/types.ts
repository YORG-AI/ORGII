import type { ReactNode } from "react";

import type { WorkstationTabHeaderHost } from "@src/hooks/workStation";
import type { ProjectManagerBreadcrumbSegment } from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";
import type { Person } from "@src/types/core/shared";
import type {
  WorkItem as WorkItemExtended,
  WorkItemLabel,
  WorkItemMilestone,
  WorkItemProject,
} from "@src/types/core/workItem";

import type { WorkItemExternalStatusConfig } from "../WorkItemProperties/types";

export const WORK_ITEM_DETAIL_SURFACE = {
  main: "main",
  nested: "nested",
} as const;

export type WorkItemDetailSurface =
  (typeof WORK_ITEM_DETAIL_SURFACE)[keyof typeof WORK_ITEM_DETAIL_SURFACE];

export type WorkItemUpdateHandler = (
  updates: Partial<WorkItemExtended>
) => void | Promise<void>;

export interface WorkItemDetailActions {
  save: () => void;
  cancel: () => void;
}

export interface WorkItemDetailProps {
  workItem: WorkItemExtended;
  onClose: () => void;
  onNavigate: (direction: "prev" | "next") => void;
  hasPrev: boolean;
  hasNext: boolean;
  onUpdateWorkItem?: WorkItemUpdateHandler;
  onDeleteWorkItem?: (id: string) => void;
  availableProjects?: WorkItemProject[];
  availableMilestones?: WorkItemMilestone[];
  availableLabels?: WorkItemLabel[];
  availableMembers?: Person[];
  externalStatusConfig?: WorkItemExternalStatusConfig;
  showTime?: boolean;
  onPendingChangesChange?: (hasPending: boolean) => void;
  externalSaveBar?: boolean;
  onRegisterActions?: (actions: WorkItemDetailActions) => void;
  repoPath?: string | null;
  projectSlug?: string | null;
  orgId?: string | null;
  shortId?: string | null;
  onRefreshWorkItem?: () => void;
  onOpenSession?: (sessionId: string, title?: string) => void;
  initialPendingUpdates?: Partial<WorkItemExtended>;
  surface?: WorkItemDetailSurface;
  /** Full parent path. The last segment returns to the containing list. */
  breadcrumbSegments?: readonly ProjectManagerBreadcrumbSegment[];
  breadcrumbProjectName?: string;
  breadcrumbIcon?: ReactNode;
  titleEditable?: boolean;
  propertiesOpen?: boolean;
  onToggleProperties?: () => void;
  publishHeaderToWorkstation?: boolean;
  workstationHeaderHost?: WorkstationTabHeaderHost;
}
