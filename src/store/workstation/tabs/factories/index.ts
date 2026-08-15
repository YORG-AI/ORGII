/**
 * Tab Factories Index
 *
 * Re-exports all tab factories using defineTabFactory pattern.
 * These are the new, unified implementations.
 */

// Code Editor
export {
  // Factories
  fileTabFactory,
  directoryTabFactory,
  explorerTabFactory,
  startTabFactory,
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
  lintScanTabFactory,
  searchTabFactory,
  SOURCE_CONTROL_CHANGES_TAB_ID,
  CODE_EDITOR_MAIN_TERMINAL_SESSION_ID,
  CODE_EDITOR_MAIN_TERMINAL_TAB_ID,
  // Creator functions
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
  createLintScanTab,
  createSearchTab,
  urlPreviewTabFactory,
  createUrlPreviewTab,
} from "./codeEditor";
export type {
  FileTabData,
  DirectoryTabData,
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
  UrlPreviewTabData,
} from "./codeEditor";

// Browser
export { browserSessionTabFactory, createBrowserSessionTab } from "./browser";
export type { BrowserSessionTabData } from "./browser";

// Chat
export { chatSessionTabFactory, createChatSessionTab } from "./chat";
export type { ChatSessionTabData } from "./chat";

// Project Manager
export {
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
} from "./project";
export type {
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
} from "./project";
export type { NewWorkItemTabData } from "../types";

// Subagent
export { subagentDetailTabFactory, createSubagentDetailTab } from "./subagent";
export type { SubagentDetailTabData } from "../types";

// Agent Config
export { agentConfigTabFactory, createAgentConfigTab } from "./agentConfig";
export type { AgentConfigTabData, AgentConfigTabVariant } from "../types";

// Canvas Preview
export {
  CANVAS_PREVIEW_TAB_ID_PREFIX,
  canvasPreviewTabFactory,
  createCanvasPreviewTab,
  getCanvasPreviewTabId,
} from "./canvasPreview";
export type { CanvasPreviewTabData } from "./canvasPreview";

// GitHub Issue Detail
export {
  githubIssueDetailTabFactory,
  createGitHubIssueDetailTab,
} from "./githubIssue";
export type { GitHubIssueDetailTabData } from "./githubIssue";

// GitHub PR Detail
export { githubPrDetailTabFactory, createGitHubPrDetailTab } from "./githubPr";
export type { GitHubPrDetailTabData } from "./githubPr";
