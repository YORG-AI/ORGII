/**
 * Workstation Tabs Store
 *
 * Unified tab system for every Workstation app — Code Editor, Database
 * Explorer, Browser, Project Manager, Launchpad — all sharing a single
 * flat tab pool (`WorkStationLayoutState.mainPane`).
 *
 * This is the main entry point - re-exports all public APIs.
 */

// ============================================
// Types
// ============================================
export type {
  WorkStationTab,
  WorkStationTabType,
  WorkStationTabCategory,
  PanelState,
  WorkStationLayoutState,
  WorkstationWorkspaceKey,
  // Editor cache types
  EditorRepoCache,
} from "./types";

export { FILE_TAB_TYPES } from "./types";

// ============================================
// Atoms
// ============================================
export {
  workstationLayoutAtom,
  workstationTabsStateAtom,
  workstationWorkspaceStateAtom,
  recentWorkstationTabsAtom,
  presentedWorkstationWorkspaceKeyAtom,
  sessionWorkstationWorkspaceKey,
  claimLegacyWorkstationSeedAtom,
  disposeWorkstationWorkspaceAtom,
  openWorkstationTabAtom,
  closeWorkstationTabsAtom,
  closeWorkstationTabAtom,
  removeSharedWorkstationTabsAtom,
  removeSharedWorkstationTabAtom,
  focusWorkstationTabAtom,
  updateWorkstationTabDataAtom,
  reorderWorkstationTabsAtom,
  selectWorkstationPanel,
  mainPaneStateAtom,
  mainPaneTabsAtom,
  mainPaneActiveTabIdAtom,
  activeWorkStationTabAtom,
  activeWorkStationFilePathAtom,
  openEditorFilePathsAtom,
  tabScrollRevealAtom,
  requestTabScrollRevealAtom,
} from "./atoms";

export { workstationWorkspaceId } from "./storage";

export {
  queueFileOpens,
  consumePendingFileOpens,
  clearPendingFileOpensForSession,
} from "./pendingFileOpens";

export {
  queuePendingCodeEditorTab,
  consumePendingCodeEditorTab,
} from "./pendingCodeEditorTab";

export { deleteTabViewState } from "./tabViewState";

// ============================================
// Tab Factory System
// ============================================
export { defineTabFactory, getFileName, getFileExtension } from "./tabFactory";

// ============================================
// Tab Factories (all apps)
// ============================================
export {
  explorerTabFactory,
  sourceControlTabFactory,
  terminalTabFactory,
  // Code Editor creator functions
  SOURCE_CONTROL_CHANGES_TAB_ID,
  CODE_EDITOR_MAIN_TERMINAL_SESSION_ID,
  CODE_EDITOR_MAIN_TERMINAL_TAB_ID,
  createFileTab,
  createDirectoryTab,
  createExplorerTab,
  createStartTab,
  createGitDiffTab,
  createTimelineDiffTab,
  createSourceControlTab,
  createGitLogTab,
  createGitCommitDetailTab,
  createStashDetailTab,
  createTerminalTab,
  createTerminalContentTab,
  createDomComponentPreviewTab,
  createSearchSessionsTab,
  createSearchTab,
  createBrowserSessionTab,
  createChatSessionTab,
  // Project Manager factories
  STORY_ORG_SCOPE,
  STORY_PERSONAL_ORG_FILTER_ID,
  STORY_PERSONAL_ORG_NAME,
  PROJECT_ORG_SURFACE_VIEW,
  PROJECT_LINEAR_SURFACE_VIEW,
  PROJECT_DETAIL_SURFACE_VIEW,
  normalizeProjectLinearSurfaceView,
  resolveProjectManagerTabTitle,
  createProjectDashboardTab,
  createProjectWorkItemsIndexTab,
  createProjectLinearProjectsTab,
  createProjectLinearWorkItemsTab,
  createProjectSettingsTab,
  createProjectOrgTab,
  normalizeProjectOrgSurfaceView,
  normalizeProjectDetailSurfaceView,
  createProjectGitSyncReviewTab,
  createProjectWorkItemsTab,
  createWorkItemDetailTab,
  getProjectLinearProjectsTabChrome,
  getProjectLinearWorkItemsTabChrome,
  getProjectWorkItemsTabChrome,
  getWorkItemDetailTabChrome,
  createSubagentDetailTab,
  // Agent Config factories
  agentConfigTabFactory,
  createAgentConfigTab,
  // GitHub Issue Detail factories
  githubIssueDetailTabFactory,
  createGitHubIssueDetailTab,
  // GitHub PR Detail factories
  githubPrDetailTabFactory,
  createGitHubPrDetailTab,
} from "./factories";

export type {
  SourceControlHistorySelection,
  ProjectOrgScope,
  ProjectOrgSurfaceView,
  ProjectLinearSurfaceView,
  ProjectDetailSurfaceView,
  // Agent Config data types
  AgentConfigTabData,
  AgentConfigTabVariant,
  // GitHub Issue Detail data types
  GitHubIssueDetailTabData,
  // GitHub PR Detail data types
  GitHubPrDetailTabData,
} from "./factories";

// ============================================
// Tab Mutations
// ============================================
export {
  openTab,
  closeTab,
  switchTab,
  reorderTabs,
  updateTabData,
  closeAllTabs,
  closeOtherTabs,
  closeSavedTabs,
} from "./tabMutations";

// ============================================
// Editor Cache (Per-Repo File Tab Caching)
// ============================================
export {
  // Constants
  MAX_EDITOR_CACHE_REPOS,
  MAX_FILE_TABS_PER_REPO,
  // State atoms
  editorCacheAtom,
  activeEditorRepoAtom,
  // Derived atoms
  getRepoCacheAtom,
  activeRepoCacheAtom,
  editorCacheSizeAtom,
  // Action atoms
  saveRepoCacheAtom,
  clearRepoCacheAtom,
  clearAllEditorCacheAtom,
  disposeEditorCacheForSessionAtom,
  switchActiveRepoAtom,
} from "./editorCache";
