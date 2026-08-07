import { emit } from "@tauri-apps/api/event";
import { useCallback } from "react";

import {
  enrichedWorkItemToUI,
  projectApi,
  workItemDataToUI,
} from "@src/api/http/project";
import type { CreatedWorkItemResult } from "@src/modules/ProjectManager/WorkItems/components/CreateWorkItemView";
import {
  CHAT_PANEL_CONTENT_MODE,
  CHAT_PANEL_CREATE_TARGET,
  type ChatPanelContentMode,
  type ChatPanelCreateProjectContext,
  type ChatPanelCreateTarget,
  type ChatPanelSelectedProject,
  type ChatPanelSelectedWorkItem,
} from "@src/store/ui/chatPanelAtom";
import type { WorkItemDraft } from "@src/store/workstation/projectManager";

type StateSetter<T> = (value: T | ((previous: T) => T)) => void;

interface UseProjectWorkItemHandlersOptions {
  bumpProjectListRefresh: (updater: (previous: number) => number) => void;
  /**
   * Org context of the create surface (NEW_WORK_ITEM navigation from an
   * org hub). Used to label the created item's org — the create result
   * only carries the org id.
   */
  createProjectContext: ChatPanelCreateProjectContext | null;
  dispatchClearSession: () => void;
  handleNewSession: () => void;
  selectedProject: ChatPanelSelectedProject | null;
  selectedWorkItem: ChatPanelSelectedWorkItem | null;
  sessionCreatorAvailable: boolean;
  setActiveSessionId: (sessionId: string | null) => void;
  setContentMode: (mode: ChatPanelContentMode) => void;
  setCreateTarget: (target: ChatPanelCreateTarget) => void;
  setSelectedProject: StateSetter<ChatPanelSelectedProject | null>;
  setSelectedWorkItem: StateSetter<ChatPanelSelectedWorkItem | null>;
  setShowProjectAgentCreator: (enabled: boolean) => void;
  setShowWorkItemAgentCreator: (enabled: boolean) => void;
  setWorkItemCreateDraft: (draft: WorkItemDraft | null) => void;
  setWorkstationActiveSessionId: (sessionId: string | null) => void;
}

export function useProjectWorkItemHandlers({
  bumpProjectListRefresh,
  createProjectContext,
  dispatchClearSession,
  handleNewSession,
  selectedProject,
  selectedWorkItem,
  sessionCreatorAvailable,
  setActiveSessionId,
  setContentMode,
  setCreateTarget,
  setSelectedProject,
  setSelectedWorkItem,
  setShowProjectAgentCreator,
  setShowWorkItemAgentCreator,
  setWorkItemCreateDraft,
  setWorkstationActiveSessionId,
}: UseProjectWorkItemHandlersOptions) {
  const handleChatPanelProjectCreated = useCallback(
    (options?: { keepOpen?: boolean }) => {
      bumpProjectListRefresh((previous) => previous + 1);
      if (options?.keepOpen) return;
      setCreateTarget(CHAT_PANEL_CREATE_TARGET.AGENT_SESSION);
      handleNewSession();
    },
    [bumpProjectListRefresh, handleNewSession, setCreateTarget]
  );

  const handleCancelWorkItemCreate = useCallback(() => {
    setWorkItemCreateDraft(null);
    setShowWorkItemAgentCreator(sessionCreatorAvailable);
    setCreateTarget(CHAT_PANEL_CREATE_TARGET.AGENT_SESSION);
    handleNewSession();
  }, [
    handleNewSession,
    sessionCreatorAvailable,
    setCreateTarget,
    setShowWorkItemAgentCreator,
    setWorkItemCreateDraft,
  ]);

  const handleCancelCollabOrgCreate = useCallback(() => {
    setCreateTarget(CHAT_PANEL_CREATE_TARGET.AGENT_SESSION);
    handleNewSession();
  }, [handleNewSession, setCreateTarget]);

  const handleWorkItemAgentCreatorToggle = useCallback(
    (enabled: boolean) => {
      setShowWorkItemAgentCreator(sessionCreatorAvailable && enabled);
    },
    [sessionCreatorAvailable, setShowWorkItemAgentCreator]
  );

  const handleProjectAgentCreatorToggle = useCallback(
    (enabled: boolean) => {
      setShowProjectAgentCreator(sessionCreatorAvailable && enabled);
    },
    [sessionCreatorAvailable, setShowProjectAgentCreator]
  );

  const handleChatPanelWorkItemCreated = useCallback(
    (result?: CreatedWorkItemResult) => {
      if (!result) return;
      const workItem =
        result.workItem ??
        (result.item
          ? workItemDataToUI(result.item, {
              labelMap: new Map(),
              memberMap: new Map(),
            })
          : null);
      if (!workItem) return;
      setSelectedProject(null);
      setSelectedWorkItem({
        shortId: result.shortId,
        projectSlug: result.projectSlug ?? "",
        projectId:
          result.item?.frontmatter.project ?? workItem.project?.id ?? "",
        projectName: workItem.project?.name ?? "",
        // Standalone items keep their creating org: WorkItemPanelView's
        // standalone writes are org-scoped and would otherwise re-home
        // the row to personal-org. The org NAME comes from the surface
        // context — without it the panel breadcrumb falls back to
        // "My Personal Org" even though the row is org-scoped.
        orgId: result.orgId,
        orgName:
          result.orgId && result.orgId === createProjectContext?.orgId
            ? createProjectContext?.scopeBreadcrumbLabel
            : undefined,
        workItem,
      });
      if (!result.keepOpen) {
        setWorkItemCreateDraft(null);
        setShowWorkItemAgentCreator(sessionCreatorAvailable);
        setCreateTarget(CHAT_PANEL_CREATE_TARGET.AGENT_SESSION);
        setContentMode(CHAT_PANEL_CONTENT_MODE.NON_SESSION);
        dispatchClearSession();
        setWorkstationActiveSessionId(null);
        setActiveSessionId(null);
      }
    },
    [
      createProjectContext,
      dispatchClearSession,
      sessionCreatorAvailable,
      setActiveSessionId,
      setContentMode,
      setCreateTarget,
      setSelectedProject,
      setSelectedWorkItem,
      setShowWorkItemAgentCreator,
      setWorkItemCreateDraft,
      setWorkstationActiveSessionId,
    ]
  );

  const handleWorkItemTitleChange = useCallback(
    (title: string) => {
      if (!selectedWorkItem || title === selectedWorkItem.workItem.name) {
        return;
      }

      const previousSelectedWorkItem = selectedWorkItem;
      setSelectedWorkItem({
        ...selectedWorkItem,
        workItem: {
          ...selectedWorkItem.workItem,
          name: title,
        },
      });

      projectApi
        .updateWorkItemPartial(
          selectedWorkItem.projectSlug,
          selectedWorkItem.shortId,
          { title }
        )
        .then((updatedWorkItem) => {
          setSelectedWorkItem((currentSelectedWorkItem) => {
            if (
              !currentSelectedWorkItem ||
              currentSelectedWorkItem.projectSlug !==
                selectedWorkItem.projectSlug ||
              currentSelectedWorkItem.shortId !== selectedWorkItem.shortId
            ) {
              return currentSelectedWorkItem;
            }

            return {
              ...currentSelectedWorkItem,
              workItem: enrichedWorkItemToUI(updatedWorkItem),
            };
          });
          return emit("orgii-data-changed");
        })
        .catch(() => {
          setSelectedWorkItem((currentSelectedWorkItem) => {
            if (
              !currentSelectedWorkItem ||
              currentSelectedWorkItem.projectSlug !==
                previousSelectedWorkItem.projectSlug ||
              currentSelectedWorkItem.shortId !==
                previousSelectedWorkItem.shortId
            ) {
              return currentSelectedWorkItem;
            }
            return previousSelectedWorkItem;
          });
        });
    },
    [selectedWorkItem, setSelectedWorkItem]
  );

  const handleProjectTitleChange = useCallback(
    (title: string) => {
      if (!selectedProject || title === selectedProject.project.name) {
        return;
      }

      const projectSlug =
        selectedProject.projectSlug || selectedProject.project.slug;
      if (!projectSlug) return;

      const previousSelectedProject = selectedProject;
      const previousDescription = selectedProject.project.description;
      setSelectedProject({
        ...selectedProject,
        project: {
          ...selectedProject.project,
          name: title,
          description:
            previousDescription === selectedProject.project.name
              ? title
              : previousDescription,
        },
      });

      projectApi
        .readProject(projectSlug)
        .then((currentProject) =>
          projectApi.writeProject(
            projectSlug,
            {
              ...currentProject.meta,
              name: title,
              updated_at: new Date().toISOString(),
            },
            currentProject.description
          )
        )
        .then(() => {
          bumpProjectListRefresh((previous) => previous + 1);
          return emit("orgii-data-changed");
        })
        .catch(() => {
          setSelectedProject((currentSelectedProject) => {
            if (
              !currentSelectedProject ||
              currentSelectedProject.project.id !==
                previousSelectedProject.project.id
            ) {
              return currentSelectedProject;
            }
            return previousSelectedProject;
          });
        });
    },
    [bumpProjectListRefresh, selectedProject, setSelectedProject]
  );

  return {
    handleCancelCollabOrgCreate,
    handleCancelWorkItemCreate,
    handleChatPanelProjectCreated,
    handleChatPanelWorkItemCreated,
    handleProjectAgentCreatorToggle,
    handleProjectTitleChange,
    handleWorkItemAgentCreatorToggle,
    handleWorkItemTitleChange,
  };
}
