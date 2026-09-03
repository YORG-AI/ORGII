/**
 * Chat-panel surface projection: the discriminated surface state, the
 * navigate command that resets and repoints the selection atoms, and the
 * persisted "maximized" preference.
 */
import { type WritableAtom, atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { z } from "zod/v4";

import { CHAT_PANEL_SURFACE_KIND } from "@src/types/ui/chatPanel";
import { createZodJsonStorage } from "@src/util/core/storage/zodStorage";

import {
  CHAT_PANEL_CONTENT_MODE,
  CHAT_PANEL_CREATE_TARGET,
  type ChatPanelCreateProjectContext,
  type ChatPanelSelectedCloudOrg,
  type ChatPanelSelectedProject,
  type ChatPanelSelectedProjectOrg,
  type ChatPanelSelectedWorkItem,
  type ChatPanelSelectedWorkspace,
  DEFAULT_CHAT_PANEL_CREATE_TARGET,
  WORKSPACE_OVERVIEW_TAB,
  type WorkspaceOverviewTab,
  chatPanelContentModeAtom,
  chatPanelCreateProjectContextAtom,
  chatPanelCreateTargetAtom,
  chatPanelExploreOpenAtom,
  chatPanelSelectedCloudOrgAtom,
  chatPanelSelectedProjectAtom,
  chatPanelSelectedProjectOrgAtom,
  chatPanelSelectedWorkItemAtom,
  chatPanelSelectedWorkspaceAtom,
  chatPanelStartPageOpenAtom,
  chatPanelWorkspaceOverviewTabAtom,
} from "./selectionAtoms";

export type ChatPanelSurfaceState =
  | { kind: typeof CHAT_PANEL_SURFACE_KIND.SESSION }
  | { kind: typeof CHAT_PANEL_SURFACE_KIND.NEW_PROJECT }
  | { kind: typeof CHAT_PANEL_SURFACE_KIND.NEW_WORK_ITEM }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.PROJECT;
      project: ChatPanelSelectedProject;
    }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.PROJECT_ORG;
      projectOrg: ChatPanelSelectedProjectOrg;
    }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.WORK_ITEM;
      workItem: ChatPanelSelectedWorkItem;
    }
  | { kind: typeof CHAT_PANEL_SURFACE_KIND.WORKSPACE_EXPLORE }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.WORKSPACE_OVERVIEW;
      workspace: ChatPanelSelectedWorkspace;
      tab: WorkspaceOverviewTab;
    }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.CLOUD_ORG;
      cloudOrg: ChatPanelSelectedCloudOrg;
    };

export type ChatPanelNavigateCommand =
  | { kind: typeof CHAT_PANEL_SURFACE_KIND.SESSION }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.NEW_PROJECT;
      createProjectContext?: ChatPanelCreateProjectContext | null;
    }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.NEW_WORK_ITEM;
      createProjectContext?: ChatPanelCreateProjectContext | null;
    }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.PROJECT;
      project: ChatPanelSelectedProject;
    }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.PROJECT_ORG;
      projectOrg: ChatPanelSelectedProjectOrg;
    }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.WORK_ITEM;
      workItem: ChatPanelSelectedWorkItem;
    }
  | { kind: typeof CHAT_PANEL_SURFACE_KIND.WORKSPACE_EXPLORE }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.WORKSPACE_OVERVIEW;
      workspace: ChatPanelSelectedWorkspace;
      tab?: WorkspaceOverviewTab;
    }
  | {
      kind: typeof CHAT_PANEL_SURFACE_KIND.CLOUD_ORG;
      cloudOrg: ChatPanelSelectedCloudOrg;
    };

type SetAtom = <Value, Args extends unknown[], Result>(
  atomToSet: WritableAtom<Value, Args, Result>,
  ...args: Args
) => Result;

function resetChatPanelSurfaceState(set: SetAtom): void {
  set(chatPanelSelectedWorkItemAtom, null);
  set(chatPanelSelectedProjectAtom, null);
  set(chatPanelSelectedProjectOrgAtom, null);
  set(chatPanelSelectedWorkspaceAtom, null);
  set(chatPanelSelectedCloudOrgAtom, null);
  set(chatPanelExploreOpenAtom, false);
  set(chatPanelCreateProjectContextAtom, null);
  set(chatPanelCreateTargetAtom, DEFAULT_CHAT_PANEL_CREATE_TARGET);
  set(chatPanelWorkspaceOverviewTabAtom, WORKSPACE_OVERVIEW_TAB.OVERVIEW);
}

export const chatPanelNavigateAtom = atom(
  null,
  (get, set, command: ChatPanelNavigateCommand) => {
    const currentWorkspaceOverviewTab = get(chatPanelWorkspaceOverviewTabAtom);
    resetChatPanelSurfaceState(set);
    set(chatPanelStartPageOpenAtom, false);

    switch (command.kind) {
      case CHAT_PANEL_SURFACE_KIND.SESSION:
        set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.SESSION);
        return;
      case CHAT_PANEL_SURFACE_KIND.NEW_PROJECT:
        set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.NON_SESSION);
        set(chatPanelCreateTargetAtom, CHAT_PANEL_CREATE_TARGET.PROJECT);
        set(
          chatPanelCreateProjectContextAtom,
          command.createProjectContext ?? null
        );
        return;
      case CHAT_PANEL_SURFACE_KIND.NEW_WORK_ITEM:
        set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.NON_SESSION);
        set(chatPanelCreateTargetAtom, CHAT_PANEL_CREATE_TARGET.WORK_ITEM);
        set(
          chatPanelCreateProjectContextAtom,
          command.createProjectContext ?? null
        );
        return;
      case CHAT_PANEL_SURFACE_KIND.PROJECT:
        set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.NON_SESSION);
        set(chatPanelSelectedProjectAtom, command.project);
        return;
      case CHAT_PANEL_SURFACE_KIND.PROJECT_ORG:
        set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.NON_SESSION);
        set(chatPanelSelectedProjectOrgAtom, command.projectOrg);
        return;
      case CHAT_PANEL_SURFACE_KIND.WORK_ITEM:
        set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.NON_SESSION);
        set(chatPanelSelectedWorkItemAtom, command.workItem);
        return;
      case CHAT_PANEL_SURFACE_KIND.WORKSPACE_EXPLORE:
        set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.NON_SESSION);
        set(chatPanelExploreOpenAtom, true);
        return;
      case CHAT_PANEL_SURFACE_KIND.WORKSPACE_OVERVIEW:
        set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.NON_SESSION);
        set(chatPanelSelectedWorkspaceAtom, command.workspace);
        set(
          chatPanelWorkspaceOverviewTabAtom,
          command.tab ?? currentWorkspaceOverviewTab
        );
        return;
      case CHAT_PANEL_SURFACE_KIND.CLOUD_ORG:
        set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.NON_SESSION);
        set(chatPanelSelectedCloudOrgAtom, command.cloudOrg);
        return;
    }
  }
);
chatPanelNavigateAtom.debugLabel = "chatPanelNavigateAtom";

export const activeChatPanelSurfaceAtom = atom<ChatPanelSurfaceState>((get) => {
  const selectedWorkItem = get(chatPanelSelectedWorkItemAtom);
  if (selectedWorkItem) {
    return {
      kind: CHAT_PANEL_SURFACE_KIND.WORK_ITEM,
      workItem: selectedWorkItem,
    };
  }

  const selectedProject = get(chatPanelSelectedProjectAtom);
  if (selectedProject) {
    return { kind: CHAT_PANEL_SURFACE_KIND.PROJECT, project: selectedProject };
  }

  const selectedProjectOrg = get(chatPanelSelectedProjectOrgAtom);
  if (selectedProjectOrg) {
    return {
      kind: CHAT_PANEL_SURFACE_KIND.PROJECT_ORG,
      projectOrg: selectedProjectOrg,
    };
  }

  if (get(chatPanelExploreOpenAtom)) {
    return { kind: CHAT_PANEL_SURFACE_KIND.WORKSPACE_EXPLORE };
  }

  const selectedWorkspace = get(chatPanelSelectedWorkspaceAtom);
  if (selectedWorkspace) {
    return {
      kind: CHAT_PANEL_SURFACE_KIND.WORKSPACE_OVERVIEW,
      workspace: selectedWorkspace,
      tab: get(chatPanelWorkspaceOverviewTabAtom),
    };
  }

  const selectedCloudOrg = get(chatPanelSelectedCloudOrgAtom);
  if (selectedCloudOrg) {
    return {
      kind: CHAT_PANEL_SURFACE_KIND.CLOUD_ORG,
      cloudOrg: selectedCloudOrg,
    };
  }

  const contentMode = get(chatPanelContentModeAtom);
  const createTarget = get(chatPanelCreateTargetAtom);
  if (
    contentMode === CHAT_PANEL_CONTENT_MODE.NON_SESSION &&
    createTarget === CHAT_PANEL_CREATE_TARGET.PROJECT
  ) {
    return { kind: CHAT_PANEL_SURFACE_KIND.NEW_PROJECT };
  }
  if (
    contentMode === CHAT_PANEL_CONTENT_MODE.NON_SESSION &&
    createTarget === CHAT_PANEL_CREATE_TARGET.WORK_ITEM
  ) {
    return { kind: CHAT_PANEL_SURFACE_KIND.NEW_WORK_ITEM };
  }
  return { kind: CHAT_PANEL_SURFACE_KIND.SESSION };
});
activeChatPanelSurfaceAtom.debugLabel = "activeChatPanelSurfaceAtom";

/**
 * The user's persisted preference for whether the chat-panel slot covers the
 * entire main content area. The active tab and viewport may force the effective
 * layout full-screen temporarily, but that layout is derived without mutating
 * this preference or the underlying Station mode.
 */
export const chatPanelMaximizedAtom = atomWithStorage<boolean>(
  "orgii:chatPanelMaximized",
  false,
  createZodJsonStorage(z.boolean()),
  { getOnInit: true }
);
chatPanelMaximizedAtom.debugLabel = "chatPanelMaximizedAtom";

/** Write-only toggle for the maximized state. */
export const toggleChatPanelMaximizedAtom = atom(null, (get, set) => {
  set(chatPanelMaximizedAtom, !get(chatPanelMaximizedAtom));
});
toggleChatPanelMaximizedAtom.debugLabel = "toggleChatPanelMaximizedAtom";
