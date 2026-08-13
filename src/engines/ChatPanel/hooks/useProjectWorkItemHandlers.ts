import { useSetAtom } from "jotai";
import { useCallback } from "react";

import { workItemDataToUI } from "@src/api/http/project";
import type { CreatedProjectResult } from "@src/modules/ProjectManager/Projects/components/CreateProjectView";
import type { CreatedWorkItemResult } from "@src/modules/ProjectManager/WorkItems/components/CreateWorkItemView";
import {
  openProjectInChatPanelTabAtom,
  openWorkItemInChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import {
  CHAT_PANEL_CREATE_TARGET,
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
  handleReturnToSessionCreator: () => void;
  sessionCreatorAvailable: boolean;
  setActiveSessionId: (sessionId: string | null) => void;
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
  handleReturnToSessionCreator,
  sessionCreatorAvailable,
  setActiveSessionId,
  setCreateTarget,
  setSelectedProject,
  setSelectedWorkItem,
  setShowProjectAgentCreator,
  setShowWorkItemAgentCreator,
  setWorkItemCreateDraft,
  setWorkstationActiveSessionId,
}: UseProjectWorkItemHandlersOptions) {
  const openProjectTab = useSetAtom(openProjectInChatPanelTabAtom);
  const openWorkItemTab = useSetAtom(openWorkItemInChatPanelTabAtom);
  const handleChatPanelProjectCreated = useCallback(
    (result?: CreatedProjectResult) => {
      bumpProjectListRefresh((previous) => previous + 1);
      if (result) {
        setShowProjectAgentCreator(sessionCreatorAvailable);
        setCreateTarget(CHAT_PANEL_CREATE_TARGET.AGENT_SESSION);
        dispatchClearSession();
        setWorkstationActiveSessionId(null);
        setActiveSessionId(null);
        openProjectTab(result);
        return;
      }
      setCreateTarget(CHAT_PANEL_CREATE_TARGET.AGENT_SESSION);
      handleReturnToSessionCreator();
    },
    [
      bumpProjectListRefresh,
      dispatchClearSession,
      handleReturnToSessionCreator,
      openProjectTab,
      sessionCreatorAvailable,
      setActiveSessionId,
      setCreateTarget,
      setShowProjectAgentCreator,
      setWorkstationActiveSessionId,
    ]
  );

  const handleCancelWorkItemCreate = useCallback(() => {
    setWorkItemCreateDraft(null);
    setShowWorkItemAgentCreator(sessionCreatorAvailable);
    setCreateTarget(CHAT_PANEL_CREATE_TARGET.AGENT_SESSION);
    handleReturnToSessionCreator();
  }, [
    handleReturnToSessionCreator,
    sessionCreatorAvailable,
    setCreateTarget,
    setShowWorkItemAgentCreator,
    setWorkItemCreateDraft,
  ]);

  const handleCancelCollabOrgCreate = useCallback(() => {
    setCreateTarget(CHAT_PANEL_CREATE_TARGET.AGENT_SESSION);
    handleReturnToSessionCreator();
  }, [handleReturnToSessionCreator, setCreateTarget]);

  const handleCancelProjectCreate = useCallback(() => {
    setShowProjectAgentCreator(sessionCreatorAvailable);
    setCreateTarget(CHAT_PANEL_CREATE_TARGET.AGENT_SESSION);
    handleReturnToSessionCreator();
  }, [
    handleReturnToSessionCreator,
    sessionCreatorAvailable,
    setCreateTarget,
    setShowProjectAgentCreator,
  ]);

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
      const createdWorkItem: ChatPanelSelectedWorkItem = {
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
      };
      setSelectedProject(null);
      if (result.keepOpen) {
        // "Create another" intentionally stays on the creator. Preserve the
        // last-created payload for existing draft flows without changing the
        // active tab.
        setSelectedWorkItem(createdWorkItem);
        return;
      }
      setWorkItemCreateDraft(null);
      setShowWorkItemAgentCreator(sessionCreatorAvailable);
      setCreateTarget(CHAT_PANEL_CREATE_TARGET.AGENT_SESSION);
      dispatchClearSession();
      setWorkstationActiveSessionId(null);
      setActiveSessionId(null);
      // Work-item surfaces are tab-owned. Opening the canonical keyed tab is
      // the only transition that updates both its durable payload and the
      // legacy selected-work-item mirror used by existing panel hooks.
      openWorkItemTab(createdWorkItem);
    },
    [
      createProjectContext,
      dispatchClearSession,
      openWorkItemTab,
      sessionCreatorAvailable,
      setActiveSessionId,
      setCreateTarget,
      setSelectedProject,
      setSelectedWorkItem,
      setShowWorkItemAgentCreator,
      setWorkItemCreateDraft,
      setWorkstationActiveSessionId,
    ]
  );

  return {
    handleCancelCollabOrgCreate,
    handleCancelProjectCreate,
    handleCancelWorkItemCreate,
    handleChatPanelProjectCreated,
    handleChatPanelWorkItemCreated,
    handleProjectAgentCreatorToggle,
    handleWorkItemAgentCreatorToggle,
  };
}
