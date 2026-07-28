/**
 * Pinned menu items, the rename modal, the currently-highlighted session id
 * (chat-panel terminal tab / benchmark master row / active session), and
 * the merged reveal-candidate list for `WorkstationSidebarConnector`
 * (`index.tsx`).
 */
import type { TFunction } from "i18next";
import { useAtomValue } from "jotai";
import { useMemo } from "react";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import { benchmarkAgentBatchStatusAtom } from "@src/store/benchmark";
import { activeChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import type { SessionCreatorDraft } from "@src/store/session";
import { toChatPanelTuiSessionId } from "@src/util/ui/terminal/chatPanelTuiSessionId";

import { useRenameSessionModal } from "../useRenameSessionModal";
import { isCloudScopedLocalRow } from "./cloudScopedMenuItems";
import {
  usePinnedMenuItems,
  useSessionSidebarMenuItems,
} from "./sidebarMenuCollections";
import type { WorkstationSidebarKey } from "./types";
import { buildWorkItemsSidebarMenuItems } from "./workItemsSidebarMenuItems";

interface UseWorkstationSidebarPinnedAndRevealDataParams {
  activeSessionId: string;
  cloudMenuItems: NavigationMenuItem[];
  menuItems: readonly NavigationMenuItem[];
  sessionCreatorDrafts: readonly SessionCreatorDraft[];
  projectsSidebarVisible: boolean;
  activeSidebarKey: WorkstationSidebarKey;
  createProjectLabel: string;
  createWorkItemLabel: string;
  importGithubIssuesLabel: string;
  newSessionLabel: string;
  runtimeLabel: string;
  t: TFunction<"navigation">;
  tSessions: TFunction<"sessions">;
}

export function useWorkstationSidebarPinnedAndRevealData({
  activeSessionId,
  cloudMenuItems,
  menuItems,
  sessionCreatorDrafts,
  projectsSidebarVisible,
  activeSidebarKey,
  createProjectLabel,
  createWorkItemLabel,
  importGithubIssuesLabel,
  newSessionLabel,
  runtimeLabel,
  t,
  tSessions,
}: UseWorkstationSidebarPinnedAndRevealDataParams) {
  const rename = useRenameSessionModal();
  const activeChatPanelTab = useAtomValue(activeChatPanelTabAtom);
  const benchmarkBatchStatus = useAtomValue(benchmarkAgentBatchStatusAtom);
  const activeChatPanelTuiSessionId =
    activeChatPanelTab?.type === "terminal"
      ? toChatPanelTuiSessionId(activeChatPanelTab.id)
      : "";
  const highlightedSessionId = activeChatPanelTuiSessionId
    ? activeChatPanelTuiSessionId
    : benchmarkBatchStatus?.items.some(
          (item) => item.sessionId === activeSessionId
        )
      ? benchmarkBatchStatus.masterSessionId
      : activeSessionId;

  const workItemsSidebarMenuItems = useMemo(
    () =>
      buildWorkItemsSidebarMenuItems({
        projects: t("labels.projects"),
        githubIssues: tSessions("kanban.sidebar.githubIssues"),
        githubPrs: tSessions("kanban.sidebar.githubPrs"),
      }),
    [t, tSessions]
  );

  const { pinnedMenuItems } = usePinnedMenuItems({
    activeSidebarKey: projectsSidebarVisible ? "projects" : activeSidebarKey,
    createProjectLabel,
    createWorkItemLabel,
    importGithubIssuesLabel,
    kanbanLabel: tSessions("simulator.tabs.kanban"),
    newSessionLabel,
    runtimeLabel,
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
