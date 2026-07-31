import type { SessionCreatorDraft } from "@src/store/session";
import {
  CHAT_PANEL_CONTENT_MODE,
  CHAT_PANEL_CREATE_TARGET,
  type ChatPanelContentMode,
  type ChatPanelCreateTarget,
  type ChatPanelSelectedProject,
  type ChatPanelSelectedWorkItem,
  type ChatPanelSelectedWorkspace,
} from "@src/store/ui/chatPanelAtom";

import { COLLAB_ADD_ORG_MENU_ITEM_ID } from "../sidebarConnectorUtils";
import {
  getSelectedDraftMenuItemId,
  getSelectedMenuItemId,
  getSelectedPinnedMenuItemId,
} from "../workstationSidebarData";
import {
  FOLDERS_DASHBOARD_ITEM_ID,
  FOLDERS_EXPLORE_ITEM_ID,
  getFolderItemId,
} from "./foldersSidebarMenuItems";
import type { WorkstationSidebarKey } from "./types";

interface ResolveSelectedMenuItemIdParams {
  activeSessionCreatorDraftId: string | null | undefined;
  activeSessionId: string;
  activeSidebarKey: WorkstationSidebarKey;
  chatPanelContentMode: ChatPanelContentMode;
  chatPanelCreateTarget: ChatPanelCreateTarget;
  chatPanelSelectedProject: ChatPanelSelectedProject | null;
  chatPanelSelectedWorkItem: ChatPanelSelectedWorkItem | null;
  chatPanelSelectedWorkspace: ChatPanelSelectedWorkspace | null;
  chatPanelWorkspaceDashboardOpen: boolean;
  chatPanelExploreOpen: boolean;
  opsControlRoutePath: string;
  journeyRoutePath?: string;
  pathname: string;
  projectsSelectedMenuItemId: string;
  sessionCreatorDrafts: readonly SessionCreatorDraft[];
}

interface ResolvedSelectedMenuItemIds {
  selectedMenuItemId: string;
  sessionSelectedMenuItemId: string;
}

export function resolveSelectedMenuItemIds({
  activeSessionCreatorDraftId,
  activeSessionId,
  activeSidebarKey,
  chatPanelContentMode,
  chatPanelCreateTarget,
  chatPanelSelectedProject,
  chatPanelSelectedWorkItem,
  chatPanelSelectedWorkspace,
  chatPanelWorkspaceDashboardOpen,
  chatPanelExploreOpen,
  opsControlRoutePath,
  journeyRoutePath,
  pathname,
  projectsSelectedMenuItemId,
  sessionCreatorDrafts,
}: ResolveSelectedMenuItemIdParams): ResolvedSelectedMenuItemIds {
  const selectedDraftMenuItemId = getSelectedDraftMenuItemId(
    activeSessionCreatorDraftId ?? null,
    sessionCreatorDrafts
  );
  const selectedPinnedMenuItemId = getSelectedPinnedMenuItemId(
    pathname,
    opsControlRoutePath,
    journeyRoutePath
  );
  const isChatPanelProjectsContentSelected =
    chatPanelContentMode === CHAT_PANEL_CONTENT_MODE.NON_SESSION ||
    Boolean(chatPanelSelectedWorkItem) ||
    Boolean(chatPanelSelectedProject);
  const sessionSelectedMenuItemId =
    chatPanelCreateTarget === CHAT_PANEL_CREATE_TARGET.PROJECT ||
    chatPanelCreateTarget === CHAT_PANEL_CREATE_TARGET.WORK_ITEM ||
    chatPanelCreateTarget === CHAT_PANEL_CREATE_TARGET.COLLAB_ORG ||
    isChatPanelProjectsContentSelected
      ? ""
      : getSelectedMenuItemId({
          selectedPinnedMenuItemId,
          activeSessionId,
          selectedDraftMenuItemId,
        });
  const resolvedProjectsSelectedMenuItemId =
    chatPanelCreateTarget === CHAT_PANEL_CREATE_TARGET.COLLAB_ORG
      ? COLLAB_ADD_ORG_MENU_ITEM_ID
      : chatPanelCreateTarget === CHAT_PANEL_CREATE_TARGET.PROJECT ||
          chatPanelCreateTarget === CHAT_PANEL_CREATE_TARGET.WORK_ITEM ||
          chatPanelSelectedWorkItem ||
          chatPanelSelectedProject
        ? projectsSelectedMenuItemId
        : "";
  const foldersSelectedMenuItemId = chatPanelSelectedWorkspace
    ? getFolderItemId(chatPanelSelectedWorkspace)
    : chatPanelExploreOpen
      ? FOLDERS_EXPLORE_ITEM_ID
      : chatPanelWorkspaceDashboardOpen
        ? FOLDERS_DASHBOARD_ITEM_ID
        : "";
  const selectedMenuItemId =
    activeSidebarKey === "projects"
      ? resolvedProjectsSelectedMenuItemId || projectsSelectedMenuItemId
      : activeSidebarKey === "folders"
        ? foldersSelectedMenuItemId
        : sessionSelectedMenuItemId;

  return { selectedMenuItemId, sessionSelectedMenuItemId };
}
