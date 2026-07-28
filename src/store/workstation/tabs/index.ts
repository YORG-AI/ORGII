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
  WorkstationWorkspaceId,
  WorkstationTabPartition,
  WorkstationTabRef,
  WorkstationWorkspaceState,
  WorkstationSharedState,
  WorkstationTabsStateV3,
  WorkstationTabOwnership,
  TimelineDiffCommitInfo,
  // Editor cache types
  EditorRepoCache,
  EditorCacheMap,
  FileTabType,
  ToolTabType,
} from "./types";

export {
  FILE_TAB_TYPES,
  TOOL_TAB_TYPES,
  getWorkstationTabOwnership,
} from "./types";

// ============================================
// Atoms
// ============================================
export {
  workstationLayoutAtom,
  workstationTabsStateAtom,
  workstationWorkspaceStateAtom,
  presentedWorkstationWorkspaceKeyAtom,
  GLOBAL_WORKSTATION_WORKSPACE_KEY,
  sessionWorkstationWorkspaceKey,
  claimLegacyWorkstationSeedAtom,
  disposeWorkstationWorkspaceAtom,
  openWorkstationTabAtom,
  closeWorkstationTabAtom,
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
  type PendingFileOpen,
} from "./pendingFileOpens";

export {
  queuePendingCodeEditorTab,
  consumePendingCodeEditorTab,
  clearPendingCodeEditorTabForSession,
} from "./pendingCodeEditorTab";

// ============================================
// Tab Factory System
// ============================================
export { defineTabFactory, getFileName, getFileExtension } from "./tabFactory";
export type { TabIdStrategy, TabFactoryConfig } from "./tabFactory";

// ============================================
// Tab Factories (all apps)
// ============================================
export {
  // Code Editor factories
  fileTabFactory,
  directoryTabFactory,
  explorerTabFactory,
  gitDiffTabFactory,
  sourceControlTabFactory,
  gitLogTabFactory,
  gitCommitDetailTabFactory,
  gitStashDetailTabFactory,
  terminalTabFactory,
  terminalContentTabFactory,
  domComponentPreviewTabFactory,
  outputTabFactory,
  settingsTabFactory,
  aiImpactTabFactory,
  searchSessionsTabFactory,
  benchmarkTabFactory,
  lintScanTabFactory,
  searchTabFactory,
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
  createOutputTab,
  createSettingsTab,
  createAIImpactTab,
  createSearchSessionsTab,
  createBenchmarkTab,
  createLintScanTab,
  createSearchTab,
  // Browser factories
  browserSessionTabFactory,
  createBrowserSessionTab,
  // Chat factories
  chatSessionTabFactory,
  createChatSessionTab,
  // Project Manager factories
  STORY_ORG_SCOPE,
  STORY_PERSONAL_ORG_FILTER_ID,
  STORY_PERSONAL_ORG_NAME,
  PROJECT_ORG_SURFACE_VIEW,
  PROJECT_LINEAR_SURFACE_VIEW,
  PROJECT_DETAIL_SURFACE_VIEW,
  normalizeProjectLinearSurfaceView,
  PROJECT_MANAGER_WORKSPACE_TITLE_KEY,
  resolveProjectManagerTabTitle,
  projectDashboardTabFactory,
  projectWorkItemsIndexTabFactory,
  projectLinearProjectsTabFactory,
  projectLinearWorkItemsTabFactory,
  projectSettingsTabFactory,
  projectOrgSettingsTabFactory,
  projectOrgTabFactory,
  projectGitSyncReviewTabFactory,
  projectWorkItemsTabFactory,
  workItemDetailTabFactory,
  createProjectDashboardTab,
  createProjectWorkItemsIndexTab,
  createProjectLinearProjectsTab,
  createProjectLinearWorkItemsTab,
  createProjectSettingsTab,
  createProjectOrgSettingsTab,
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
  // Subagent factories
  subagentDetailTabFactory,
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
  // Code Editor data types
  FileTabData,
  GitDiffTabData,
  SourceControlHistorySelection,
  SourceControlTabData,
  GitLogTabData,
  GitCommitDetailTabData,
  GitStashDetailTabData,
  TerminalTabData,
  TerminalContentTabData,
  DomComponentPreviewTabData,
  OutputTabData,
  SearchTabData,
  DirectoryTabData,
  // Browser data types
  BrowserSessionTabData,
  // Chat data types
  ChatSessionTabData,
  // Project Manager data types
  ProjectOrgFilterTabData,
  ProjectOrgScope,
  ProjectSettingsTabData,
  ProjectOrgSettingsTabData,
  ProjectOrgTabData,
  ProjectOrgSurfaceView,
  ProjectLinearSurfaceView,
  ProjectDetailSurfaceView,
  ProjectGitSyncReviewTabData,
  ProjectWorkItemsTabData,
  WorkItemDetailTabData,
  NewWorkItemTabData,
  // Subagent data types
  SubagentDetailTabData,
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
  switchActiveRepoAtom,
} from "./editorCache";
