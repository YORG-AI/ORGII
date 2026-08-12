/**
 * Project Manager Tab Factories
 *
 * Tab factories for the project manager using defineTabFactory.
 */
import { PROJECT_ORG_SYNC_PROVIDER } from "@src/api/http/project";
import {
  PROJECT_ORG_SURFACE_VIEW,
  type ProjectOrgSurfaceView,
} from "@src/types/ui/projectOrg";

import { defineTabFactory } from "../tabFactory";
import type { WorkStationTab } from "../types";

export {
  PROJECT_ORG_SURFACE_VIEW,
  type ProjectOrgSurfaceView,
} from "@src/types/ui/projectOrg";

export const STORY_MANAGER_PROJECT_TAB_ICON = "Box";
export const STORY_WORK_ITEMS_TAB_ICON = "ChartNoAxesGantt";
export const WORK_ITEM_DETAIL_TAB_ICON = "CircleDot";

export const STORY_ORG_SCOPE = {
  ALL: "all",
  PERSONAL_ORG: "personal_org",
  PROJECT_ORG: "project_org",
} as const;

export const STORY_PERSONAL_ORG_FILTER_ID = "personal-org";
export const STORY_PERSONAL_ORG_NAME = "Personal Org";

export type ProjectOrgScope =
  (typeof STORY_ORG_SCOPE)[keyof typeof STORY_ORG_SCOPE];

export interface ProjectOrgFilterTabData {
  orgScope: ProjectOrgScope;
  orgId?: string;
  orgName?: string;
  orgSyncProvider?: string | null;
}

const STORY_WORKSPACE_TAB_DATA: ProjectOrgFilterTabData = {
  orgScope: STORY_ORG_SCOPE.ALL,
};

function getProjectOrgFilterTabKey(data: ProjectOrgFilterTabData): string {
  if (data.orgScope === STORY_ORG_SCOPE.ALL) return "main";
  return `org:${data.orgId ?? STORY_PERSONAL_ORG_FILTER_ID}`;
}

function getProjectOrgFilterTitle(
  data: ProjectOrgFilterTabData,
  fallback: string,
  suffix: string
): string {
  if (data.orgScope !== STORY_ORG_SCOPE.ALL) {
    return `${data.orgName ?? STORY_PERSONAL_ORG_NAME} ${suffix}`;
  }
  return fallback;
}

/** i18n keys for workspace-scoped project manager surfaces (sidebar-aligned). */
export const PROJECT_MANAGER_WORKSPACE_TITLE_KEY = {
  PROJECTS: "projects:workspace.projects",
  WORK_ITEMS: "projects:workspace.workItems",
  LINEAR_PROJECTS: "projects:workspace.projects",
  LINEAR_WORK_ITEMS: "projects:workspace.workItems",
} as const;

export function resolveProjectManagerTabTitle(
  tab: Pick<WorkStationTab, "type" | "title" | "data">,
  translate: (key: string) => string
): string {
  const orgScope = tab.data.orgScope as ProjectOrgScope | undefined;

  if (tab.type === "project-dashboard") {
    const projectsLabel = translate(
      PROJECT_MANAGER_WORKSPACE_TITLE_KEY.PROJECTS
    );
    if (orgScope === STORY_ORG_SCOPE.ALL || orgScope === undefined) {
      return projectsLabel;
    }
    const orgName =
      (tab.data.orgName as string | undefined) ?? STORY_PERSONAL_ORG_NAME;
    return `${orgName} ${projectsLabel}`;
  }

  if (tab.type === "project-work-items") {
    const workItemsLabel = translate(
      PROJECT_MANAGER_WORKSPACE_TITLE_KEY.WORK_ITEMS
    );
    if (orgScope === STORY_ORG_SCOPE.ALL || orgScope === undefined) {
      return workItemsLabel;
    }
    const orgName =
      (tab.data.orgName as string | undefined) ?? STORY_PERSONAL_ORG_NAME;
    return `${orgName} ${workItemsLabel}`;
  }

  if (
    tab.type === "project-linear-projects" ||
    tab.type === "project-linear-work-items"
  ) {
    const linearSurface = normalizeProjectLinearSurfaceView(
      tab.data.linearSurface ??
        (tab.type === "project-linear-work-items"
          ? PROJECT_LINEAR_SURFACE_VIEW.WORK_ITEMS
          : PROJECT_LINEAR_SURFACE_VIEW.PROJECTS)
    );
    const surfaceLabel = translate(
      linearSurface === PROJECT_LINEAR_SURFACE_VIEW.WORK_ITEMS
        ? PROJECT_MANAGER_WORKSPACE_TITLE_KEY.LINEAR_WORK_ITEMS
        : PROJECT_MANAGER_WORKSPACE_TITLE_KEY.LINEAR_PROJECTS
    );
    const orgName = tab.data.teamName as string | undefined;
    return orgName ? `${orgName} ${surfaceLabel}` : `Linear ${surfaceLabel}`;
  }

  return tab.title;
}

// ============================================
// Singleton Tabs
// ============================================

export const projectDashboardTabFactory =
  defineTabFactory<ProjectOrgFilterTabData>({
    tabType: "project-dashboard",
    idStrategy: {
      type: "keyed",
      prefix: "project-dashboard",
      getKey: getProjectOrgFilterTabKey,
    },
    getTitle: (data) => getProjectOrgFilterTitle(data, "Projects", "Projects"),
    icon: STORY_MANAGER_PROJECT_TAB_ICON,
  });

export function createProjectDashboardTab(
  data: ProjectOrgFilterTabData = STORY_WORKSPACE_TAB_DATA
): WorkStationTab {
  return projectDashboardTabFactory(data);
}

export const projectWorkItemsIndexTabFactory =
  defineTabFactory<ProjectOrgFilterTabData>({
    tabType: "project-work-items",
    idStrategy: {
      type: "keyed",
      prefix: "project-work-items",
      getKey: getProjectOrgFilterTabKey,
    },
    getTitle: (data) =>
      getProjectOrgFilterTitle(data, "Work Items", "Work Items"),
    icon: "ListChecks",
  });

export function createProjectWorkItemsIndexTab(
  data: ProjectOrgFilterTabData = STORY_WORKSPACE_TAB_DATA
): WorkStationTab {
  return projectWorkItemsIndexTabFactory(data);
}

export const PROJECT_LINEAR_SURFACE_VIEW = {
  PROJECTS: "projects",
  WORK_ITEMS: "work-items",
} as const;

export type ProjectLinearSurfaceView =
  (typeof PROJECT_LINEAR_SURFACE_VIEW)[keyof typeof PROJECT_LINEAR_SURFACE_VIEW];

export const PROJECT_DETAIL_SURFACE_VIEW = {
  OVERVIEW: "overview",
  WORK_ITEMS: "work-items",
} as const;

export type ProjectDetailSurfaceView =
  (typeof PROJECT_DETAIL_SURFACE_VIEW)[keyof typeof PROJECT_DETAIL_SURFACE_VIEW];

export interface ProjectLinearProjectsTabData {
  connectionId?: string;
  projectId?: string;
  projectName?: string;
  teamId?: string;
  teamName?: string;
  linearSurface?: ProjectLinearSurfaceView;
}

export const projectLinearProjectsTabFactory =
  defineTabFactory<ProjectLinearProjectsTabData>({
    tabType: "project-linear-projects",
    idStrategy: { type: "singleton", id: "project-linear-projects:main" },
    getTitle: () => "Linear Projects",
    icon: STORY_MANAGER_PROJECT_TAB_ICON,
  });

export function createProjectLinearProjectsTab(
  data: ProjectLinearProjectsTabData = {}
): WorkStationTab {
  return projectLinearProjectsTabFactory({
    ...data,
    linearSurface: PROJECT_LINEAR_SURFACE_VIEW.PROJECTS,
  });
}

export const projectLinearWorkItemsTabFactory =
  defineTabFactory<ProjectLinearProjectsTabData>({
    tabType: "project-linear-work-items",
    idStrategy: { type: "singleton", id: "project-linear-work-items:main" },
    getTitle: () => "Linear Work Items",
    icon: "ListChecks",
  });

export function createProjectLinearWorkItemsTab(
  data: ProjectLinearProjectsTabData = {}
): WorkStationTab {
  return projectLinearWorkItemsTabFactory({
    ...data,
    linearSurface: PROJECT_LINEAR_SURFACE_VIEW.WORK_ITEMS,
  });
}

export function normalizeProjectLinearSurfaceView(
  value: unknown
): ProjectLinearSurfaceView {
  if (
    value === PROJECT_LINEAR_SURFACE_VIEW.PROJECTS ||
    value === PROJECT_LINEAR_SURFACE_VIEW.WORK_ITEMS
  ) {
    return value;
  }
  return PROJECT_LINEAR_SURFACE_VIEW.PROJECTS;
}

export function normalizeProjectDetailSurfaceView(
  value: unknown
): ProjectDetailSurfaceView {
  if (
    value === PROJECT_DETAIL_SURFACE_VIEW.OVERVIEW ||
    value === PROJECT_DETAIL_SURFACE_VIEW.WORK_ITEMS
  ) {
    return value;
  }
  return PROJECT_DETAIL_SURFACE_VIEW.OVERVIEW;
}

export function getProjectLinearProjectsTabChrome(projectName?: string) {
  return {
    title: projectName || "Linear Projects",
    icon: STORY_MANAGER_PROJECT_TAB_ICON,
  };
}

export function getProjectLinearWorkItemsTabChrome(projectName?: string) {
  return {
    title: projectName || "Linear Work Items",
    icon: "ListChecks",
  };
}

export interface ProjectSettingsTabData {
  section: string;
}

export interface ProjectOrgSettingsTabData extends ProjectOrgFilterTabData {
  orgScope: typeof STORY_ORG_SCOPE.PROJECT_ORG;
  orgId: string;
  orgName?: string;
  orgSyncProvider?: string | null;
  section?: string;
}

export interface ProjectGitSyncReviewTabData extends ProjectOrgFilterTabData {
  orgScope: typeof STORY_ORG_SCOPE.PROJECT_ORG;
  orgId: string;
  orgName?: string;
  orgSyncProvider: typeof PROJECT_ORG_SYNC_PROVIDER.GIT_FOLDER;
}

export const projectSettingsTabFactory =
  defineTabFactory<ProjectSettingsTabData>({
    tabType: "project-settings",
    idStrategy: { type: "singleton", id: "project-settings:main" },
    getTitle: () => "Settings",
    icon: "Settings",
  });

export function createProjectSettingsTab(section?: string): WorkStationTab {
  return projectSettingsTabFactory({ section: section ?? "general" });
}

export const projectOrgSettingsTabFactory =
  defineTabFactory<ProjectOrgSettingsTabData>({
    tabType: "project-org-settings",
    idStrategy: {
      type: "keyed",
      prefix: "project-org-settings",
      getKey: (data) => data.orgId,
    },
    getTitle: (data) => `${data.orgName ?? "Org"} Settings`,
    icon: "Settings",
  });

export function createProjectOrgSettingsTab(
  org: {
    id: string;
    name?: string;
    sync_provider?: string | null;
  },
  _section?: string
): WorkStationTab {
  return createProjectOrgTab(
    {
      id: org.id,
      name: org.name,
      sync_provider: org.sync_provider,
    },
    PROJECT_ORG_SURFACE_VIEW.SETTINGS,
    STORY_ORG_SCOPE.PROJECT_ORG
  );
}

export interface ProjectOrgTabData extends ProjectOrgFilterTabData {
  orgView?: ProjectOrgSurfaceView;
}

export const projectOrgTabFactory = defineTabFactory<ProjectOrgTabData>({
  tabType: "project-org",
  idStrategy: {
    type: "keyed",
    prefix: "project-org",
    getKey: (data) => data.orgId ?? STORY_PERSONAL_ORG_FILTER_ID,
  },
  getTitle: (data) => data.orgName ?? STORY_PERSONAL_ORG_NAME,
  icon: "Building2",
});

export function createProjectOrgTab(
  org: {
    id: string;
    name?: string;
    sync_provider?: string | null;
  },
  orgView: ProjectOrgSurfaceView = PROJECT_ORG_SURFACE_VIEW.WORK_ITEMS,
  orgScope:
    | typeof STORY_ORG_SCOPE.PERSONAL_ORG
    | typeof STORY_ORG_SCOPE.PROJECT_ORG = STORY_ORG_SCOPE.PROJECT_ORG
): WorkStationTab {
  return projectOrgTabFactory({
    orgScope,
    orgId: org.id,
    orgName: org.name,
    orgSyncProvider: org.sync_provider,
    orgView,
  });
}

export function normalizeProjectOrgSurfaceView(
  value: unknown
): ProjectOrgSurfaceView {
  if (
    typeof value === "string" &&
    (Object.values(PROJECT_ORG_SURFACE_VIEW) as string[]).includes(value)
  ) {
    return value as ProjectOrgSurfaceView;
  }
  return PROJECT_ORG_SURFACE_VIEW.WORK_ITEMS;
}

export const projectGitSyncReviewTabFactory =
  defineTabFactory<ProjectGitSyncReviewTabData>({
    tabType: "project-git-sync-review",
    idStrategy: {
      type: "keyed",
      prefix: "project-git-sync-review",
      getKey: (data) => data.orgId,
    },
    getTitle: (data) => `${data.orgName ?? "Org"} Git Sync`,
    icon: "GitMerge",
  });

export function createProjectGitSyncReviewTab(
  orgId: string,
  orgName?: string
): WorkStationTab {
  return projectGitSyncReviewTabFactory({
    orgScope: STORY_ORG_SCOPE.PROJECT_ORG,
    orgId,
    orgName,
    orgSyncProvider: PROJECT_ORG_SYNC_PROVIDER.GIT_FOLDER,
  });
}

// ============================================
// Project Work Items Tab
// ============================================

export interface ProjectWorkItemsTabData {
  projectId: string;
  projectName: string;
  projectSlug?: string;
  projectView?: ProjectDetailSurfaceView;
  orgScope?: ProjectOrgScope;
  orgId?: string;
  orgName?: string;
}

export const projectWorkItemsTabFactory =
  defineTabFactory<ProjectWorkItemsTabData>({
    tabType: "project-workitems",
    idStrategy: {
      type: "keyed",
      prefix: "project-workitems",
      getKey: (data) => data.projectId,
    },
    getTitle: (data) => data.projectName,
    icon: STORY_WORK_ITEMS_TAB_ICON,
  });

export function createProjectWorkItemsTab(
  projectId: string,
  projectName: string,
  projectSlug?: string,
  projectView: ProjectDetailSurfaceView = PROJECT_DETAIL_SURFACE_VIEW.OVERVIEW,
  org?: ProjectOrgFilterTabData
): WorkStationTab {
  return projectWorkItemsTabFactory({
    projectId,
    projectName,
    projectSlug,
    projectView,
    orgScope: org?.orgScope,
    orgId: org?.orgId,
    orgName: org?.orgName,
  });
}

// ============================================
// Work Item Detail Tab
// ============================================

export interface WorkItemDetailTabData {
  projectId?: string;
  projectName?: string;
  projectSlug?: string;
  orgId?: string;
  workItemId: string;
  workItemName: string;
  workItemStatus?: string;
  pendingUpdates?: Record<string, unknown>;
  returnTabId?: string;
}

function getWorkItemDetailTabTitle(workItemName?: string) {
  return workItemName || "Work Item";
}

export const workItemDetailTabFactory = defineTabFactory<WorkItemDetailTabData>(
  {
    tabType: "workItem-detail",
    idStrategy: {
      type: "keyed",
      prefix: "workItem-detail",
      getKey: (data) =>
        `${data.orgId ?? "personal-org"}:${data.projectId || "standalone"}:${data.workItemId}`,
    },
    getTitle: (data) => getWorkItemDetailTabTitle(data.workItemName),
    icon: WORK_ITEM_DETAIL_TAB_ICON,
  }
);

export function getProjectWorkItemsTabChrome(projectName: string) {
  return {
    title: projectName,
    icon: STORY_WORK_ITEMS_TAB_ICON,
  };
}

export function getWorkItemDetailTabChrome(workItemName?: string) {
  return {
    title: getWorkItemDetailTabTitle(workItemName),
    icon: WORK_ITEM_DETAIL_TAB_ICON,
  };
}

export function createWorkItemDetailTab(
  projectId: string | undefined,
  projectName: string | undefined,
  workItemId: string,
  workItemName: string,
  projectSlug?: string,
  pendingUpdates?: Record<string, unknown>,
  returnTabId?: string,
  workItemStatus?: string,
  orgId?: string
): WorkStationTab {
  return workItemDetailTabFactory({
    projectId,
    projectName,
    projectSlug,
    orgId,
    workItemId,
    workItemName,
    ...(workItemStatus && { workItemStatus }),
    ...(pendingUpdates &&
      Object.keys(pendingUpdates).length > 0 && { pendingUpdates }),
    ...(returnTabId && { returnTabId }),
  });
}
