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
  closeOrganizationChatPanelTabAtom,
  closeOtherChatPanelTabsAtom,
  closeOtherThanActiveChatPanelTabsAtom,
  closeProjectOrgChatPanelTabsAtom,
  closeRevokedCloudChannelChatPanelTabsAtom,
  closeWorkItemChatPanelTabAtom,
  nextChatPanelTabAtom,
  patchChatPanelWorkItemTabAtom,
  prevChatPanelTabAtom,
  reconcileDiscussionChannelTabsAtom,
  reorderChatPanelTabsAtom,
  setActiveWorkManagementSectionAtom,
  setChatPanelTabTitleAtom,
  toggleChatPanelTabTuiModeAtom,
  type ReconcileDiscussionChannelTabsInput,
} from "./chatPanelTabLifecycleAtoms";
export {
  addChatPanelLaunchpadTabAtom,
  addChatPanelTerminalTabAtom,
  openChannelInChatPanelTabAtom,
  openOrganizationInChatPanelTabAtom,
  openCreateTargetInChatPanelStartPageAtom,
  openExploreInChatPanelTabAtom,
  openGitHubIssueInChatPanelTabAtom,
  openGitHubPrInChatPanelTabAtom,
  openWorkManagementChatPanelTabAtom,
  openOrFocusChatPanelStartPageTabAtom,
  openRuntimeInChatPanelTabAtom,
  openTeamInboxInChatPanelTabAtom,
  openOrFocusSessionInChatPanelTabAtom,
  openOrReplaceSessionInChatPanelTabAtom,
  openProjectInChatPanelTabAtom,
  openRunGroupInChatPanelTabAtom,
  openSessionInNewChatTabAtom,
  openWorkItemInChatPanelTabAtom,
  openWorkspaceOverviewInChatPanelTabAtom,
} from "./chatPanelTabOpenAtoms";
export {
  buildChannelTabKey,
  buildDefaultLaunchpadTab,
  buildInitialChatPanelTabsState,
  createChannelTab,
  createGitHubIssueTab,
  createGitHubPrTab,
  createOrganizationTab,
  createLaunchpadTab,
  createRuntimeTab,
  createSessionTab,
  createTeamInboxTab,
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
  toggleActiveChatPanelMaximizedAtom,
} from "./chatPanelTabPresentationAtoms";
export {
  isChatPanelTabStationAvailable,
  normalizePersistedChatPanelTabsState,
  resolveChatPanelMaximizedForLayout,
  type ChatPanelSelectedChannel,
  type ChatPanelTab,
  type ChatPanelTabsState,
  type ChatPanelTabType,
} from "./chatPanelTabsModel";
export {
  activeChatPanelTabAtom,
  activeChatPanelTabTypeAtom,
  activeWorkManagementSectionAtom,
  chatPanelTabCountAtom,
  chatPanelTabsAtom,
} from "./chatPanelTabsState";
export {
  canMoveChatPanelTabToWorkstation,
  canMoveWorkstationPrTabToChatPanel,
  moveChatPanelTabToWorkstationAtom,
  moveWorkstationPrTabToChatPanelAtom,
} from "./chatPanelTabPlacementAtom";
