import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { projectApi } from "@src/api/http/project";
import type { ProjectOrg } from "@src/api/http/project";
import { projectSyncApi } from "@src/api/http/project/sync";
import { COLLAB_SYNC_PROVIDER } from "@src/features/Org2Cloud/org2CloudProjectOrgAlias";
import { createLogger } from "@src/hooks/logger";
import { useProjectDataChanged } from "@src/hooks/project";
import { useCollabOutboxPending } from "@src/hooks/project/useCollabOutboxPending";
import { cachedLinearProjectsApi } from "@src/modules/ProjectManager/LinearProjects/linearProjectsCache";
import { linearIssueToWorkItem } from "@src/modules/ProjectManager/LinearProjects/utils";
import {
  PROJECT_ORG_SURFACE_VIEW,
  STORY_ORG_SCOPE,
  createProjectLinearWorkItemsTab,
  createProjectOrgTab,
  openWorkstationTabAtom,
  presentedWorkstationWorkspaceKeyAtom,
} from "@src/store/workstation/tabs";
import { STORY_PERSONAL_ORG_FILTER_ID } from "@src/store/workstation/tabs/factories/project";

import { toChatPanelProject, toChatPanelWorkItem } from "./chatPanelMapping";
import { buildByOrgMenuItems } from "./groupingBuilders";
import {
  getProjectsLinearLoadOrgId,
  getProjectsLinearOrgGroupId,
  getProjectsLinearOrgId,
  getProjectsLinearWorkItemId,
  getProjectsLocalOrgId,
  getProjectsProjectOverviewSlug,
  getProjectsWorkItemCreateOrgId,
  getProjectsWorkItemId,
  isProjectsLinearOrgGroupId,
  isProjectsWorkItemLoadMoreId,
} from "./idHelpers";
import { getErrorMessage } from "./linearHelpers";
import { getNavigableLinkedSessions } from "./menuRows";
import type {
  LinearOrgLoadState,
  LinearOrgRecord,
  SidebarAnyWorkItem,
  SidebarLinearWorkItem,
  SidebarLocalOrgRecord,
  SidebarProject,
  SidebarWorkItem,
  UseProjectsWorkItemMenuItemsParams,
  UseProjectsWorkItemMenuItemsResult,
} from "./types";
import { toWorkItemPriority, toWorkItemStatus } from "./workItemMapping";

const logger = createLogger("ProjectsWorkItemSidebar");

export {
  getProjectsLinearLoadOrgId,
  getProjectsLinearOrgGroupId,
  getProjectsLinearOrgId,
  getProjectsLinearWorkItemId,
  getProjectsLocalOrgId,
  getProjectsProjectOverviewSlug,
  getProjectsWorkItemCreateOrgId,
  getProjectsWorkItemId,
  isProjectsLinearOrgGroupId,
  isProjectsWorkItemLoadMoreId,
};

export function useProjectsWorkItemMenuItems({
  enabled,
  groupVisibleCounts,
  searchQuery = "",
  selectedOrgId,
}: UseProjectsWorkItemMenuItemsParams): UseProjectsWorkItemMenuItemsResult {
  const { t } = useTranslation(["projects", "common", "navigation"]);
  const openWorkstationTab = useSetAtom(openWorkstationTabAtom);
  const presentedWorkspace = useAtomValue(presentedWorkstationWorkspaceKeyAtom);
  const [localOrgs, setLocalOrgs] = useState<ProjectOrg[]>([]);
  const [localProjects, setLocalProjects] = useState<SidebarProject[]>([]);
  const [workItems, setWorkItems] = useState<SidebarWorkItem[]>([]);
  const [linearOrgs] = useState<LinearOrgRecord[]>([]);
  const [linearWorkItems, setLinearWorkItems] = useState<
    SidebarLinearWorkItem[]
  >([]);
  const [linearOrgLoadStates, setLinearOrgLoadStates] = useState<
    Map<string, LinearOrgLoadState>
  >(new Map());
  const [loading, setLoading] = useState(false);
  const [
    expandedLinkedSessionWorkItemIds,
    setExpandedLinkedSessionWorkItemIds,
  ] = useState<Set<string>>(() => new Set());

  const handleToggleLinkedSessionExpansion = useCallback(
    (workItemId: string) => {
      setExpandedLinkedSessionWorkItemIds((previousIds) => {
        const nextIds = new Set(previousIds);
        if (nextIds.has(workItemId)) {
          nextIds.delete(workItemId);
        } else {
          nextIds.add(workItemId);
        }
        return nextIds;
      });
    },
    []
  );

  /** Org ids accepted by the selector filter. */
  const selectedOrgIdSet = useMemo(() => {
    if (!selectedOrgId) return null;
    return new Set([selectedOrgId]);
  }, [selectedOrgId]);

  const scopedLocalProjects = useMemo(
    () =>
      selectedOrgIdSet
        ? localProjects.filter((project) => selectedOrgIdSet.has(project.orgId))
        : localProjects,
    [localProjects, selectedOrgIdSet]
  );
  const scopedWorkItems = useMemo(
    () =>
      selectedOrgIdSet
        ? workItems.filter((workItem) => selectedOrgIdSet.has(workItem.orgId))
        : workItems,
    [selectedOrgIdSet, workItems]
  );
  const scopedLocalOrgs = useMemo(
    () =>
      selectedOrgIdSet
        ? localOrgs.filter((org) => selectedOrgIdSet.has(org.id))
        : localOrgs,
    [localOrgs, selectedOrgIdSet]
  );
  const loadLocalWorkItems = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const [orgs, projects] = await Promise.all([
        projectApi.readOrgs(),
        projectApi.readProjects(),
      ]);
      setLocalOrgs(orgs);
      const orgNameById = new Map<string, string>([
        [STORY_PERSONAL_ORG_FILTER_ID, t("projects:orgs.personalOrg")],
        ...orgs.map((org) => [org.id, org.name] as const),
      ]);
      const projectResults = await Promise.all(
        projects.map(async (project) => {
          const [viewData, labelsFile, membersFile, syncStatus] =
            await Promise.all([
              projectApi.readWorkItemsViewData(project.slug),
              projectApi.readLabels(project.slug),
              projectApi.readMembers(project.slug),
              projectSyncApi.status(project.slug).catch(() => null),
            ]);
          const labelMap = new Map(
            labelsFile.labels.map((label) => [label.id, label])
          );
          const memberMap = new Map(
            membersFile.members.map((member) => [member.id, member])
          );
          const orgId = project.meta.org_id || STORY_PERSONAL_ORG_FILTER_ID;
          const orgName =
            orgNameById.get(orgId) ||
            (orgId === STORY_PERSONAL_ORG_FILTER_ID
              ? t("projects:orgs.personalOrg")
              : t("navigation:labels.org", "Org"));
          const projectEntry: SidebarProject = {
            projectData: project,
            projectSyncAdapterId: syncStatus?.adapter_id ?? null,
            orgId,
            orgName,
            labelMap,
            memberMap,
          };
          const projectWorkItems: SidebarWorkItem[] = viewData.items
            .filter((item) => !item.deletedAt)
            .map((item) => ({
              ...item,
              projectId: project.meta.id,
              projectName: project.meta.name,
              projectSlug: project.slug,
              orgId,
              orgName,
              projectSyncAdapterId: syncStatus?.adapter_id ?? null,
              source: "local",
            }));
          return { projectEntry, projectWorkItems };
        })
      );
      setLocalProjects(
        projectResults.map((projectResult) => projectResult.projectEntry)
      );
      setWorkItems(
        projectResults.flatMap(
          (projectResult) => projectResult.projectWorkItems
        )
      );
    } catch (error) {
      logger.error("Failed to load work item sidebar items:", error);
      setLocalOrgs([]);
      setLocalProjects([]);
      setWorkItems([]);
    } finally {
      setLoading(false);
    }
  }, [enabled, t]);

  const loadLinearOrgWorkItems = useCallback(
    async (org: LinearOrgRecord) => {
      const existingState = linearOrgLoadStates.get(org.id);
      if (existingState?.loading || existingState?.loaded) return;

      setLinearOrgLoadStates((previousStates) => {
        const nextStates = new Map(previousStates);
        nextStates.set(org.id, { loading: true, loaded: false, error: null });
        return nextStates;
      });

      try {
        const projectsResult = await cachedLinearProjectsApi.listProjects(
          org.connectionId
        );
        const visibleProjects = projectsResult.projects.filter((project) =>
          project.teams.some((team) => team.id === org.teamId)
        );
        const issueResults = await Promise.all(
          visibleProjects.map(async (project) => {
            const issueResult = await cachedLinearProjectsApi.listProjectIssues(
              org.connectionId,
              project.id
            );
            return { project, issues: issueResult.issues };
          })
        );
        const nextWorkItems = issueResults.flatMap(({ project, issues }) =>
          issues.map((issue) => {
            const workItem = linearIssueToWorkItem(issue, project);
            return {
              id: `${org.connectionId}:${issue.id}`,
              title: workItem.name,
              status: toWorkItemStatus(
                workItem.workItemStatus ?? workItem.status
              ),
              priority: toWorkItemPriority(workItem.priority ?? "none"),
              projectId: project.id,
              projectName: project.name,
              connectionId: org.connectionId,
              teamId: org.teamId,
              teamName: org.teamName,
              orgId: org.id,
              orgName: org.orgName,
              source: "linear" as const,
            };
          })
        );
        setLinearWorkItems((previousItems) => {
          const remainingItems = previousItems.filter(
            (item) => item.orgId !== org.id
          );
          return [...remainingItems, ...nextWorkItems];
        });
        setLinearOrgLoadStates((previousStates) => {
          const nextStates = new Map(previousStates);
          nextStates.set(org.id, { loading: false, loaded: true, error: null });
          return nextStates;
        });
      } catch (error) {
        logger.error("Failed to load Linear sidebar work items:", error);
        setLinearOrgLoadStates((previousStates) => {
          const nextStates = new Map(previousStates);
          nextStates.set(org.id, {
            loading: false,
            loaded: false,
            error: getErrorMessage(error),
          });
          return nextStates;
        });
      }
    },
    [linearOrgLoadStates]
  );

  useEffect(() => {
    void loadLocalWorkItems();
  }, [loadLocalWorkItems]);

  const loadLinearOrgWorkItemsById = useCallback(
    (orgId: string) => {
      const org = linearOrgs.find((candidate) => candidate.id === orgId);
      if (!org) return;
      void loadLinearOrgWorkItems(org);
    },
    [linearOrgs, loadLinearOrgWorkItems]
  );

  useProjectDataChanged(
    useCallback(() => {
      if (enabled) {
        void loadLocalWorkItems();
      }
    }, [enabled, loadLocalWorkItems])
  );

  const projectMap = useMemo(() => {
    const map = new Map<string, SidebarProject>();
    for (const project of scopedLocalProjects) {
      map.set(project.projectData.slug, project);
    }
    return map;
  }, [scopedLocalProjects]);

  const workItemMap = useMemo(() => {
    const map = new Map<string, SidebarWorkItem>();
    for (const workItem of scopedWorkItems) {
      map.set(workItem.id, workItem);
    }
    return map;
  }, [scopedWorkItems]);

  const linearWorkItemMap = useMemo(() => {
    const map = new Map<string, SidebarLinearWorkItem>();
    for (const workItem of linearWorkItems) {
      map.set(workItem.id, workItem);
    }
    return map;
  }, [linearWorkItems]);

  const localOrgMap = useMemo(() => {
    const map = new Map<string, SidebarLocalOrgRecord>();
    map.set(STORY_PERSONAL_ORG_FILTER_ID, {
      id: STORY_PERSONAL_ORG_FILTER_ID,
      name: t("projects:orgs.personalOrg"),
    });
    for (const org of scopedLocalOrgs) {
      map.set(org.id, {
        id: org.id,
        name: org.name,
        sync_provider: org.sync_provider,
      });
    }
    for (const project of scopedLocalProjects) {
      if (map.has(project.orgId)) continue;
      map.set(project.orgId, {
        id: project.orgId,
        name: project.orgName,
      });
    }
    return map;
  }, [scopedLocalOrgs, scopedLocalProjects, t]);

  const linearOrgMap = useMemo(() => {
    const map = new Map<string, LinearOrgRecord>();
    for (const org of linearOrgs) {
      map.set(org.id, org);
    }
    return map;
  }, [linearOrgs]);

  const allWorkItems = useMemo<SidebarAnyWorkItem[]>(
    () => [...scopedWorkItems],
    [scopedWorkItems]
  );

  const linkedSessionIds = useMemo(
    () =>
      new Set(
        scopedWorkItems.flatMap((workItem) =>
          getNavigableLinkedSessions(workItem).map(
            (session) => session.session_id
          )
        )
      ),
    [scopedWorkItems]
  );

  const collabOrgIds = useMemo(
    () =>
      localOrgs
        .filter((org) => org.sync_provider === COLLAB_SYNC_PROVIDER)
        .map((org) => org.id)
        .sort(),
    [localOrgs]
  );
  const { pendingProjectIds, pendingWorkItemIds } =
    useCollabOutboxPending(collabOrgIds);

  const menuItems = useMemo(
    () =>
      buildByOrgMenuItems({
        allWorkItems,
        groupVisibleCounts,
        searchQuery,
        t,
        localProjects: scopedLocalProjects,
        pendingSync: {
          projectIds: pendingProjectIds,
          workItemIds: pendingWorkItemIds,
        },
        expandedLinkedSessionWorkItemIds,
        onToggleLinkedSessionExpansion: handleToggleLinkedSessionExpansion,
      }),
    [
      allWorkItems,
      groupVisibleCounts,
      searchQuery,
      t,
      scopedLocalProjects,
      pendingProjectIds,
      pendingWorkItemIds,
      expandedLinkedSessionWorkItemIds,
      handleToggleLinkedSessionExpansion,
    ]
  );

  const openLocalOrg = useCallback(
    (org: SidebarLocalOrgRecord) => {
      const orgScope =
        org.id === STORY_PERSONAL_ORG_FILTER_ID
          ? STORY_ORG_SCOPE.PERSONAL_ORG
          : STORY_ORG_SCOPE.PROJECT_ORG;
      const tab = createProjectOrgTab(
        {
          id: org.id,
          name: org.name,
          sync_provider: org.sync_provider,
        },
        PROJECT_ORG_SURFACE_VIEW.WORK_ITEMS,
        orgScope
      );
      openWorkstationTab({ workspace: presentedWorkspace, tab });
    },
    [openWorkstationTab, presentedWorkspace]
  );

  const openLinearOrg = useCallback(
    (org: LinearOrgRecord) => {
      const tab = createProjectLinearWorkItemsTab({
        connectionId: org.connectionId,
        teamId: org.teamId,
        teamName: org.teamName,
      });
      openWorkstationTab({ workspace: presentedWorkspace, tab });
    },
    [openWorkstationTab, presentedWorkspace]
  );

  const openLinearWorkItem = useCallback(
    (workItem: SidebarLinearWorkItem) => {
      const tab = createProjectLinearWorkItemsTab({
        connectionId: workItem.connectionId,
        projectId: workItem.projectId,
        projectName: workItem.projectName,
        teamId: workItem.teamId,
        teamName: workItem.teamName,
      });
      openWorkstationTab({ workspace: presentedWorkspace, tab });
    },
    [openWorkstationTab, presentedWorkspace]
  );

  return {
    menuItems,
    projectMap,
    workItemMap,
    linearWorkItemMap,
    localOrgMap,
    linearOrgMap,
    loading,
    linkedSessionIds,
    getLoadMoreGroupId: isProjectsWorkItemLoadMoreId,
    loadLinearOrgWorkItems: loadLinearOrgWorkItemsById,
    toChatPanelProject,
    toChatPanelWorkItem,
    openLocalOrg,
    openLinearOrg,
    openLinearWorkItem,
  };
}

export type { SidebarLinearWorkItem, SidebarProject, SidebarWorkItem };
