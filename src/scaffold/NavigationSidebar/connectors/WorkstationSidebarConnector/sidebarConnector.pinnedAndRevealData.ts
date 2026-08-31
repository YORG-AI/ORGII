/**
 * Pinned menu items, the rename modal, the currently-highlighted session id
 * (chat-panel terminal tab / active session), and
 * the merged reveal-candidate list for `WorkstationSidebarConnector`
 * (`index.tsx`).
 */
import type { TFunction } from "i18next";
import { useAtomValue } from "jotai";
import { useMemo } from "react";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import { activeChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import type { SessionCreatorDraft } from "@src/store/session";
import { toChatPanelTuiSessionId } from "@src/util/ui/terminal/chatPanelTuiSessionId";

import { useRenameSessionModal } from "../useRenameSessionModal";
import type { WorkstationSidebarViewKey } from "./WorkstationSidebarViewSwitcher";
import { isCloudScopedLocalRow } from "./cloudScopedMenuItems";
import {
  usePinnedMenuItems,
  useSessionSidebarMenuItems,
} from "./sidebarMenuCollections";
import { buildWorkItemsSidebarMenuItems } from "./workItemsSidebarMenuItems";

interface UseWorkstationSidebarPinnedAndRevealDataParams {
  activeSessionId: string;
  cloudMenuItems: NavigationMenuItem[];
  menuItems: readonly NavigationMenuItem[];
  sessionCreatorDrafts: readonly SessionCreatorDraft[];
  activeViewKey: WorkstationSidebarViewKey;
  createProjectLabel: string;
  createWorkItemLabel: string;
  importGithubIssuesLabel: string;
  newSessionLabel: string;
  runtimeLabel: string;
  teamInboxLabel: string;
  teamInboxUnreadCount: number;
  t: TFunction<"navigation">;
  tSessions: TFunction<"sessions">;
}

export function useWorkstationSidebarPinnedAndRevealData({
  activeSessionId,
  cloudMenuItems,
  menuItems,
  sessionCreatorDrafts,
  activeViewKey,
  createProjectLabel,
  createWorkItemLabel,
  importGithubIssuesLabel,
  newSessionLabel,
  runtimeLabel,
  teamInboxLabel,
  teamInboxUnreadCount,
  t,
  tSessions,
}: UseWorkstationSidebarPinnedAndRevealDataParams) {
  const rename = useRenameSessionModal();
  const activeChatPanelTab = useAtomValue(activeChatPanelTabAtom);
  const activeChatPanelTuiSessionId =
    activeChatPanelTab?.type === "terminal"
      ? toChatPanelTuiSessionId(activeChatPanelTab.id)
      : "";
  const highlightedSessionId = activeChatPanelTuiSessionId
    ? activeChatPanelTuiSessionId
    : activeSessionId;

  const workItemsSidebarMenuItems = useMemo(
    () =>
      buildWorkItemsSidebarMenuItems({
        workItems: t("labels.workItems"),
        projects: t("labels.projects"),
        githubIssues: tSessions("kanban.sidebar.githubIssues"),
        githubPrs: tSessions("kanban.sidebar.githubPrs"),
        runs: tSessions("kanban.sidebar.runs"),
      }),
    [t, tSessions]
  );

  const { pinnedMenuItems } = usePinnedMenuItems({
    activeViewKey,
    createProjectLabel,
    createWorkItemLabel,
    importGithubIssuesLabel,
    kanbanLabel: tSessions("simulator.tabs.kanban"),
    newSessionLabel,
    runtimeLabel,
    teamInboxLabel,
    teamInboxUnreadCount,
    workItemDestinations: workItemsSidebarMenuItems,
    t,
  });
  const sessionSidebarMenuItems = useSessionSidebarMenuItems({
    menuItems,
    sessionCreatorDrafts,
    t,
  });
  const loadedCloudMySessionRowCount = useMemo(
    () => sessionSidebarMenuItems.filter(isCloudScopedLocalRow).length,
    [sessionSidebarMenuItems]
  );
  const revealCandidateMenuItems = useMemo(
    () => [...cloudMenuItems, ...sessionSidebarMenuItems],
    [cloudMenuItems, sessionSidebarMenuItems]
  );

  return {
    rename,
    activeChatPanelTab,
    highlightedSessionId,
    pinnedMenuItems,
    sessionSidebarMenuItems,
    loadedCloudMySessionRowCount,
    revealCandidateMenuItems,
  };
}
