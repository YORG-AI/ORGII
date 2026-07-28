import type { ChatPanelTabType } from "@src/store/chatPanel/chatPanelTabsAtom";
import type { SessionCreatorDraft } from "@src/store/session";
import {
  CHAT_PANEL_CONTENT_MODE,
  CHAT_PANEL_CREATE_TARGET,
  type ChatPanelContentMode,
  type ChatPanelCreateTarget,
  type ChatPanelSelectedProject,
  type ChatPanelSelectedWorkItem,
} from "@src/store/ui/chatPanelAtom";

import {
  COLLAB_ADD_ORG_MENU_ITEM_ID,
  KANBAN_MENU_ITEM_ID,
  RUNTIME_MENU_ITEM_ID,
} from "../sidebarConnectorUtils";
import {
  getSelectedDraftMenuItemId,
  getSelectedMenuItemId,
} from "../workstationSidebarData";
import type { WorkstationSidebarKey } from "./types";

interface ResolveSelectedMenuItemIdParams {
  activeSessionCreatorDraftId: string | null | undefined;
  activeSessionId: string;
  activeSidebarKey: WorkstationSidebarKey;
  activeChatPanelTabType: ChatPanelTabType | null;
  chatPanelContentMode: ChatPanelContentMode;
  chatPanelCreateTarget: ChatPanelCreateTarget;
  chatPanelSelectedProject: ChatPanelSelectedProject | null;
  chatPanelSelectedWorkItem: ChatPanelSelectedWorkItem | null;
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
  activeChatPanelTabType,
  chatPanelContentMode,
  chatPanelCreateTarget,
  chatPanelSelectedProject,
  chatPanelSelectedWorkItem,
  projectsSelectedMenuItemId,
  sessionCreatorDrafts,
}: ResolveSelectedMenuItemIdParams): ResolvedSelectedMenuItemIds {
  const selectedDraftMenuItemId = getSelectedDraftMenuItemId(
    activeSessionCreatorDraftId ?? null,
    sessionCreatorDrafts
  );
  const selectedPinnedMenuItemId =
    activeChatPanelTabType === "work-management"
      ? KANBAN_MENU_ITEM_ID
      : activeChatPanelTabType === "runtime"
        ? RUNTIME_MENU_ITEM_ID
        : "";
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
  const selectedMenuItemId =
    activeSidebarKey === "projects"
      ? resolvedProjectsSelectedMenuItemId || projectsSelectedMenuItemId
      : sessionSelectedMenuItemId;

  return { selectedMenuItemId, sessionSelectedMenuItemId };
}
