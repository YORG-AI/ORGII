import type { LinearProjectSelection } from "@src/modules/ProjectManager/Panels/ProjectManagerSidebar/content/WorkspaceTreeContent";
import type { QuickAction } from "@src/modules/WorkStation/shared";
import type { WorkStationTab } from "@src/store/workstation/tabs/types";

import type { EmbeddedWorkItemDetailState } from "../WorkItems";

export interface ProjectManagerLayoutProps {
  repoPath: string;
  repoName: string;
}

export type ActiveRepoView =
  | "projects"
  | "work-items"
  | "linear-projects"
  | "linear-work-items"
  | "settings"
  | null;

export type SelectProjectHandler = (
  projectId: string,
  projectName: string,
  projectSlug?: string
) => void;

type CreateWorkItemHandler = (
  projectId?: string,
  projectName?: string,
  projectSlug?: string
) => void;

export type ExpandWorkItemToTabHandler = (
  projectId: string | undefined,
  projectName: string | undefined,
  projectSlug: string | undefined,
  workItemId: string,
  workItemName: string,
  pendingUpdates?: Record<string, unknown>,
  workItemStatus?: string
) => void;

type OpenChatSessionHandler = (
  sessionId: string,
  title?: string,
  workItemId?: string,
  workItemShortId?: string
) => void;

export interface ProjectManagerContentRouterProps {
  repoPath: string;
  tabs: WorkStationTab[];
  activeTab: WorkStationTab | null;
  projectQuickActions: QuickAction[];
  onSelectProject: SelectProjectHandler;
  onOpenProjects: () => void;
  onCreateProject: () => void;
  onCreateWorkItem: CreateWorkItemHandler;
  onOpenLinearProjects: (selection?: LinearProjectSelection) => void;
  onOpenRepoSettings: (section?: string) => void;
  onExpandWorkItemToTab: ExpandWorkItemToTabHandler;
  onOpenChatSession: OpenChatSessionHandler;
  onCloseTab: (tabId: string) => void;
  onUpdateTabData: (
    tabId: string,
    data: Partial<Record<string, unknown>>
  ) => void;
  onUpdateTabMeta: (
    tabId: string,
    meta: Partial<Pick<WorkStationTab, "title" | "icon">>
  ) => void;
  onSetTabUnsaved: (tabId: string, unsaved: boolean) => void;
  onEmbeddedWorkItemDetailStateChange: (
    tabId: string,
    state: EmbeddedWorkItemDetailState,
    projectName: string
  ) => void;
  onProjectListRefreshRequested: () => void;
}
