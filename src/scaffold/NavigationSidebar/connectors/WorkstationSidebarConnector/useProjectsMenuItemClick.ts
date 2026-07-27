import { useSetAtom } from "jotai";
import { useCallback } from "react";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import {
  openCreateTargetInChatPanelStartPageAtom,
  openOrganizationInChatPanelTabAtom,
  openProjectInChatPanelTabAtom,
  openWorkItemInChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { SESSION_SIDEBAR_PAGE_SIZE } from "@src/store/session";
import {
  CHAT_PANEL_CREATE_TARGET,
  type ChatPanelSelectedProject,
  type ChatPanelSelectedWorkItem,
} from "@src/store/ui/chatPanelAtom";
import { STORY_ORG_SCOPE } from "@src/store/workstation/tabs";

import {
  COLLAB_ADD_ORG_MENU_ITEM_ID,
  PROJECTS_IMPORT_GITHUB_ISSUES_MENU_ITEM_ID,
  PROJECTS_NEW_PROJECT_MENU_ITEM_ID,
  PROJECTS_NEW_WORK_ITEM_MENU_ITEM_ID,
} from "../sidebarConnectorUtils";
import {
  getProjectsLinearLoadOrgId,
  getProjectsLinearOrgId,
  getProjectsLinearWorkItemId,
  getProjectsLocalOrgId,
  getProjectsProjectOverviewSlug,
  getProjectsWorkItemCreateOrgId,
  getProjectsWorkItemId,
} from "../useProjectsWorkItemMenuItems";

interface UseProjectsMenuItemClickParams<
  Project,
  WorkItem,
  LocalOrg extends { id: string; name: string; sync_provider?: string | null },
  LinearOrg,
  LinearWorkItem,
> {
  activateMyStationRouteForProjectTabContent: () => void;
  activateMyStationRouteForProjectsContent: () => void;
  getProjectsLoadMoreGroupId: (id: string) => string | null;
  loadProjectsLinearOrgWorkItems: (orgId: string) => void;
  openProjectsLinearOrg: (org: LinearOrg) => void;
  openProjectsLinearWorkItem: (workItem: LinearWorkItem) => void;
  projectsLinearOrgMap: ReadonlyMap<string, LinearOrg>;
  projectsLinearWorkItemMap: ReadonlyMap<string, LinearWorkItem>;
  projectsLocalOrgMap: ReadonlyMap<string, LocalOrg>;
  projectsProjectMap: ReadonlyMap<string, Project>;
  projectsWorkItemMap: ReadonlyMap<string, WorkItem>;
  linkedSessionIds: ReadonlySet<string>;
  openLinkedSession: (item: NavigationMenuItem) => void;
  resetWorkManagementStateForProjectsContent: () => void;
  setProjectsGroupVisibleCounts: React.Dispatch<
    React.SetStateAction<Map<string, number>>
  >;
  setProjectsSelectedMenuItemId: (id: string) => void;
  toChatPanelProject: (project: Project) => ChatPanelSelectedProject;
  toChatPanelWorkItem: (workItem: WorkItem) => ChatPanelSelectedWorkItem;
}

interface OpenNewWorkItemFromSidebarParams {
  openWorkItemCreator: () => void;
  resetWorkManagementStateForProjectsContent: () => void;
  setProjectsSelectedMenuItemId: (id: string) => void;
}

interface TryOpenLinkedSessionFromSidebarParams {
  item: NavigationMenuItem;
  linkedSessionIds: ReadonlySet<string>;
  setProjectsSelectedMenuItemId: (id: string) => void;
  openLinkedSession: (item: NavigationMenuItem) => void;
}

export function tryOpenLinkedSessionFromSidebar({
  item,
  linkedSessionIds,
  setProjectsSelectedMenuItemId,
  openLinkedSession,
}: TryOpenLinkedSessionFromSidebarParams): boolean {
  if (!linkedSessionIds.has(item.id)) return false;
  setProjectsSelectedMenuItemId(item.key);
  openLinkedSession(item);
  return true;
}

export function openNewWorkItemFromSidebar({
  openWorkItemCreator,
  resetWorkManagementStateForProjectsContent,
  setProjectsSelectedMenuItemId,
}: OpenNewWorkItemFromSidebarParams): void {
  resetWorkManagementStateForProjectsContent();
  setProjectsSelectedMenuItemId(PROJECTS_NEW_WORK_ITEM_MENU_ITEM_ID);
  openWorkItemCreator();
}

export function useProjectsMenuItemClick<
  Project,
  WorkItem,
  LocalOrg extends { id: string; name: string; sync_provider?: string | null },
  LinearOrg,
  LinearWorkItem,
>({
  activateMyStationRouteForProjectTabContent,
  activateMyStationRouteForProjectsContent,
  getProjectsLoadMoreGroupId,
  loadProjectsLinearOrgWorkItems,
  openProjectsLinearOrg,
  openProjectsLinearWorkItem,
  projectsLinearOrgMap,
  projectsLinearWorkItemMap,
  projectsLocalOrgMap,
  projectsProjectMap,
  projectsWorkItemMap,
  linkedSessionIds,
  openLinkedSession,
  resetWorkManagementStateForProjectsContent,
  setProjectsGroupVisibleCounts,
  setProjectsSelectedMenuItemId,
  toChatPanelProject,
  toChatPanelWorkItem,
}: UseProjectsMenuItemClickParams<
  Project,
  WorkItem,
  LocalOrg,
  LinearOrg,
  LinearWorkItem
>): (key: string, item: NavigationMenuItem) => void {
  // Detail surfaces (org hub / project / work item) open as dedicated chat-pane
  // tabs. Creator actions target the singleton Launchpad instead.
  const openWorkItemTab = useSetAtom(openWorkItemInChatPanelTabAtom);
  const openProjectTab = useSetAtom(openProjectInChatPanelTabAtom);
  const openOrganizationTab = useSetAtom(openOrganizationInChatPanelTabAtom);
  const openCreateTargetInStartPage = useSetAtom(
    openCreateTargetInChatPanelStartPageAtom
  );
  return useCallback(
    (_key: string, item: NavigationMenuItem) => {
      if (item.id === COLLAB_ADD_ORG_MENU_ITEM_ID) {
        resetWorkManagementStateForProjectsContent();
        setProjectsSelectedMenuItemId(COLLAB_ADD_ORG_MENU_ITEM_ID);
        openCreateTargetInStartPage({
          target: CHAT_PANEL_CREATE_TARGET.COLLAB_ORG,
        });
        return;
      }

      if (item.id === PROJECTS_NEW_PROJECT_MENU_ITEM_ID) {
        resetWorkManagementStateForProjectsContent();
        setProjectsSelectedMenuItemId(PROJECTS_NEW_PROJECT_MENU_ITEM_ID);
        openCreateTargetInStartPage({
          target: CHAT_PANEL_CREATE_TARGET.PROJECT,
        });
        return;
      }

      if (item.id === PROJECTS_IMPORT_GITHUB_ISSUES_MENU_ITEM_ID) {
        resetWorkManagementStateForProjectsContent();
        setProjectsSelectedMenuItemId(
          PROJECTS_IMPORT_GITHUB_ISSUES_MENU_ITEM_ID
        );
        openCreateTargetInStartPage({
          target: CHAT_PANEL_CREATE_TARGET.GITHUB_ISSUES_PROJECT,
        });
        return;
      }

      if (item.id === PROJECTS_NEW_WORK_ITEM_MENU_ITEM_ID) {
        openNewWorkItemFromSidebar({
          openWorkItemCreator: () =>
            openCreateTargetInStartPage({
              target: CHAT_PANEL_CREATE_TARGET.WORK_ITEM,
            }),
          resetWorkManagementStateForProjectsContent,
          setProjectsSelectedMenuItemId,
        });
        return;
      }

      if (
        tryOpenLinkedSessionFromSidebar({
          item,
          linkedSessionIds,
          setProjectsSelectedMenuItemId,
          openLinkedSession,
        })
      )
        return;

      const localOrgId = getProjectsLocalOrgId(item.id);
      if (localOrgId) {
        const localOrg = projectsLocalOrgMap.get(localOrgId);
        if (!localOrg) return;
        activateMyStationRouteForProjectsContent();
        setProjectsSelectedMenuItemId(item.id);
        openOrganizationTab({
          organization: {
            kind: "local",
            projectOrg: {
              orgId: localOrg.id,
              orgName: localOrg.name,
              orgScope: STORY_ORG_SCOPE.PROJECT_ORG,
              orgSyncProvider: localOrg.sync_provider,
            },
          },
          title: localOrg.name,
        });
        return;
      }

      const linearOrgId = getProjectsLinearOrgId(item.id);
      if (linearOrgId) {
        const linearOrg = projectsLinearOrgMap.get(linearOrgId);
        if (!linearOrg) return;
        activateMyStationRouteForProjectTabContent();
        setProjectsSelectedMenuItemId(item.id);
        openProjectsLinearOrg(linearOrg);
        return;
      }

      const createWorkItemOrgId = getProjectsWorkItemCreateOrgId(item.id);
      if (createWorkItemOrgId) {
        resetWorkManagementStateForProjectsContent();
        setProjectsSelectedMenuItemId(item.id);
        // The row is org-scoped, so the creation surface must carry the org:
        // NEW_WORK_ITEM without `createProjectContext` writes standalone
        // items under personal-org (see createWorkItemFromDraft).
        openCreateTargetInStartPage({
          target: CHAT_PANEL_CREATE_TARGET.WORK_ITEM,
          createProjectContext: { orgId: createWorkItemOrgId },
        });
        return;
      }

      const linearLoadOrgId = getProjectsLinearLoadOrgId(item.id);
      if (linearLoadOrgId) {
        loadProjectsLinearOrgWorkItems(linearLoadOrgId);
        return;
      }

      const loadMoreGroupId = getProjectsLoadMoreGroupId(item.id);
      if (loadMoreGroupId) {
        setProjectsGroupVisibleCounts((previousCounts) => {
          const nextCounts = new Map(previousCounts);
          const current =
            nextCounts.get(loadMoreGroupId) ?? SESSION_SIDEBAR_PAGE_SIZE;
          nextCounts.set(loadMoreGroupId, current + SESSION_SIDEBAR_PAGE_SIZE);
          return nextCounts;
        });
        return;
      }

      const projectOverviewSlug = getProjectsProjectOverviewSlug(item.id);
      if (projectOverviewSlug) {
        const project = projectsProjectMap.get(projectOverviewSlug);
        if (!project) return;
        activateMyStationRouteForProjectsContent();
        setProjectsSelectedMenuItemId(item.id);
        openProjectTab(toChatPanelProject(project));
        return;
      }

      const linearWorkItemId = getProjectsLinearWorkItemId(item.id);
      if (linearWorkItemId) {
        const linearWorkItem = projectsLinearWorkItemMap.get(linearWorkItemId);
        if (!linearWorkItem) return;
        activateMyStationRouteForProjectTabContent();
        setProjectsSelectedMenuItemId(item.id);
        openProjectsLinearWorkItem(linearWorkItem);
        return;
      }

      const workItemId = getProjectsWorkItemId(item.id);
      if (!workItemId) return;
      const workItem = projectsWorkItemMap.get(workItemId);
      if (!workItem) return;
      const chatPanelWorkItem = toChatPanelWorkItem(workItem);
      activateMyStationRouteForProjectsContent();
      setProjectsSelectedMenuItemId(item.id);
      openWorkItemTab(chatPanelWorkItem);
    },
    [
      activateMyStationRouteForProjectTabContent,
      activateMyStationRouteForProjectsContent,
      getProjectsLoadMoreGroupId,
      loadProjectsLinearOrgWorkItems,
      linkedSessionIds,
      openCreateTargetInStartPage,
      openOrganizationTab,
      openProjectTab,
      openProjectsLinearOrg,
      openProjectsLinearWorkItem,
      openLinkedSession,
      openWorkItemTab,
      projectsLinearOrgMap,
      projectsLinearWorkItemMap,
      projectsLocalOrgMap,
      projectsProjectMap,
      projectsWorkItemMap,
      resetWorkManagementStateForProjectsContent,
      setProjectsGroupVisibleCounts,
      setProjectsSelectedMenuItemId,
      toChatPanelProject,
      toChatPanelWorkItem,
    ]
  );
}
