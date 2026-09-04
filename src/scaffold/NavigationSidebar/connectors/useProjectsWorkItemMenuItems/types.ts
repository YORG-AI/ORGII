import type {
  EnrichedWorkItem,
  LabelEntry,
  MemberEntry,
  ProjectData,
} from "@src/api/http/project";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type {
  ChatPanelSelectedProject,
  ChatPanelSelectedWorkItem,
} from "@src/store/ui/chatPanelAtom";
import type {
  WorkItemPriority,
  WorkItemStatus,
} from "@src/types/core/workItem";

export interface SidebarProject {
  projectData: ProjectData;
  projectSyncAdapterId: string | null;
  orgId: string;
  orgName: string;
  labelMap: Map<string, LabelEntry>;
  memberMap: Map<string, MemberEntry>;
}

export interface SidebarWorkItem extends EnrichedWorkItem {
  projectId: string;
  projectName: string;
  projectSlug: string;
  orgId: string;
  orgName: string;
  projectSyncAdapterId: string | null;
  source: "local";
}

export interface SidebarLinearWorkItem {
  id: string;
  title: string;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  projectId: string;
  projectName: string;
  connectionId: string;
  teamId?: string;
  teamName?: string;
  orgId: string;
  orgName: string;
  source: "linear";
}

export interface LinearOrgRecord {
  id: string;
  connectionId: string;
  teamId: string;
  teamName: string;
  orgName: string;
}

export interface LinearOrgLoadState {
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

export interface UseProjectsWorkItemMenuItemsParams {
  enabled: boolean;
  groupVisibleCounts: ReadonlyMap<string, number>;
  searchQuery: string;
  selectedOrgId?: string;
}

export interface SidebarLocalOrgRecord {
  id: string;
  name: string;
  sync_provider?: string | null;
}

export interface UseProjectsWorkItemMenuItemsResult {
  menuItems: NavigationMenuItem[];
  projectMap: Map<string, SidebarProject>;
  workItemMap: Map<string, SidebarWorkItem>;
  linearWorkItemMap: Map<string, SidebarLinearWorkItem>;
  localOrgMap: Map<string, SidebarLocalOrgRecord>;
  linearOrgMap: Map<string, LinearOrgRecord>;
  loading: boolean;
  linkedSessionIds: ReadonlySet<string>;
  getLoadMoreGroupId: (id: string) => string | null;
  loadLinearOrgWorkItems: (orgId: string) => void;
  toChatPanelProject: (project: SidebarProject) => ChatPanelSelectedProject;
  toChatPanelWorkItem: (workItem: SidebarWorkItem) => ChatPanelSelectedWorkItem;
  openLocalOrg: (org: SidebarLocalOrgRecord) => void;
  openLinearOrg: (org: LinearOrgRecord) => void;
  openLinearWorkItem: (workItem: SidebarLinearWorkItem) => void;
}
