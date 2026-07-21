/**
 * Public compatibility surface for Chat Panel tab state.
 *
 * The implementation is split by responsibility so persistence, presentation
 * synchronization, tab creation, and lifecycle mutations remain independently
 * understandable. Keep consumers importing this module so atom identities and
 * the public API stay centralized.
 */
export {
  clearChatPanelTabCliCommandAtom,
  closeAndDestroyChatPanelTabAtom,
  closeChatPanelTabAtom,
  closeCloudOrgManagementChatPanelTabAtom,
  closeOtherChatPanelTabsAtom,
  nextChatPanelTabAtom,
  patchChatPanelWorkItemTabAtom,
  prevChatPanelTabAtom,
  reorderChatPanelTabsAtom,
  setChatPanelTabTitleAtom,
  toggleChatPanelTabTuiModeAtom,
} from "./chatPanelTabLifecycleAtoms";
export {
  addChatPanelLaunchpadTabAtom,
  addChatPanelTerminalTabAtom,
  openCloudOrgManagementInChatPanelTabAtom,
  openCreateTargetInChatPanelStartPageAtom,
  openExploreInChatPanelTabAtom,
  openWorkManagementChatPanelTabAtom,
  openOrFocusChatPanelStartPageTabAtom,
  openRuntimeInChatPanelTabAtom,
  openOrFocusSessionInChatPanelTabAtom,
  openOrReplaceSessionInChatPanelTabAtom,
  openProjectInChatPanelTabAtom,
  openProjectOrgInChatPanelTabAtom,
  openSessionInNewChatTabAtom,
  openWorkItemInChatPanelTabAtom,
  openWorkspaceOverviewInChatPanelTabAtom,
} from "./chatPanelTabOpenAtoms";
export {
  buildDefaultLaunchpadTab,
  buildInitialChatPanelTabsState,
  createCloudOrgTab,
  createLaunchpadTab,
  createRuntimeTab,
  createSessionTab,
  createTerminalTab,
  createWorkManagementTab,
  createWorkspaceTab,
} from "./chatPanelTabFactories";
export {
  defineChatPanelTabFactory,
  type ChatPanelTabFactoryConfig,
  type ChatPanelTabIdStrategy,
  type ChatPanelTabPayload,
} from "./chatPanelTabFactory";
export {
  activateChatPanelTabAtom,
  syncActiveChatPanelTabStateAtom,
} from "./chatPanelTabPresentationAtoms";
export {
  normalizePersistedChatPanelTabsState,
  type ChatPanelTab,
  type ChatPanelTabsState,
  type ChatPanelTabType,
} from "./chatPanelTabsModel";
export {
  activeChatPanelTabAtom,
  activeWorkManagementSectionAtom,
  chatPanelTabCountAtom,
  chatPanelTabsAtom,
} from "./chatPanelTabsState";
