/**
 * Chat panel tab atom bindings used by `WorkstationSidebarConnector`
 * (`index.tsx`): content mode / create-target / selected project+work-item
 * reads, the work-management view atom, and every "open a tab" setter the
 * sidebar dispatches into (new chat, session, organization, runtime,
 * work-management, start-page). Pure atom wiring — no params, no local
 * state of its own.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";

import {
  activateChatPanelTabAtom,
  activeWorkManagementSectionAtom,
  closeAndDestroyChatPanelTabAtom,
  openCreateTargetInChatPanelStartPageAtom,
  openOrFocusChatPanelStartPageTabAtom,
  openOrReplaceSessionInChatPanelTabAtom,
  openOrganizationInChatPanelTabAtom,
  openRuntimeInChatPanelTabAtom,
  openSessionInNewChatTabAtom,
  openTeamInboxInChatPanelTabAtom,
  openWorkManagementChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { openSessionInWorkstationAtom } from "@src/store/session/sessionTabPlacementAtom";
import {
  activeStationChatVisibleAtom,
  chatPanelContentModeAtom,
  chatPanelCreateTargetAtom,
  chatPanelNavigateAtom,
  chatPanelSelectedProjectAtom,
  chatPanelSelectedWorkItemAtom,
} from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import { workManagementProjectsViewAtom } from "@src/store/workstation";

export function useWorkstationSidebarChatPanelAtoms() {
  const chatPanelContentMode = useAtomValue(chatPanelContentModeAtom);
  const chatPanelCreateTarget = useAtomValue(chatPanelCreateTargetAtom);
  const chatPanelSelectedWorkItem = useAtomValue(chatPanelSelectedWorkItemAtom);
  const chatPanelSelectedProject = useAtomValue(chatPanelSelectedProjectAtom);
  const setChatPanelCreateTarget = useSetAtom(chatPanelCreateTargetAtom);
  const navigateChatPanel = useSetAtom(chatPanelNavigateAtom);
  const setStationChatVisible = useSetAtom(activeStationChatVisibleAtom);
  const setStationMode = useSetAtom(stationModeAtom);
  const activeWorkManagementSection = useAtomValue(
    activeWorkManagementSectionAtom
  );
  const [workManagementProjectsView, setWorkManagementProjectsView] = useAtom(
    workManagementProjectsViewAtom
  );
  const openWorkManagementTab = useSetAtom(openWorkManagementChatPanelTabAtom);
  const openOrganizationTab = useSetAtom(openOrganizationInChatPanelTabAtom);
  const openSessionInNewChatTab = useSetAtom(openSessionInNewChatTabAtom);
  const openSessionInWorkstation = useSetAtom(openSessionInWorkstationAtom);
  const openOrReplaceSessionInChatPanelTab = useSetAtom(
    openOrReplaceSessionInChatPanelTabAtom
  );
  const activateChatPanelTab = useSetAtom(activateChatPanelTabAtom);
  const openStartPageTab = useSetAtom(openOrFocusChatPanelStartPageTabAtom);
  const openCreateTargetInStartPage = useSetAtom(
    openCreateTargetInChatPanelStartPageAtom
  );
  const openRuntimeTab = useSetAtom(openRuntimeInChatPanelTabAtom);
  const openTeamInboxTab = useSetAtom(openTeamInboxInChatPanelTabAtom);
  const closeAndDestroyChatPanelTab = useSetAtom(
    closeAndDestroyChatPanelTabAtom
  );

  return {
    chatPanelContentMode,
    chatPanelCreateTarget,
    chatPanelSelectedWorkItem,
    chatPanelSelectedProject,
    setChatPanelCreateTarget,
    navigateChatPanel,
    setStationChatVisible,
    setStationMode,
    activeWorkManagementSection,
    workManagementProjectsView,
    setWorkManagementProjectsView,
    openWorkManagementTab,
    openOrganizationTab,
    openSessionInNewChatTab,
    openSessionInWorkstation,
    openOrReplaceSessionInChatPanelTab,
    activateChatPanelTab,
    openStartPageTab,
    openCreateTargetInStartPage,
    openRuntimeTab,
    openTeamInboxTab,
    closeAndDestroyChatPanelTab,
  };
}
