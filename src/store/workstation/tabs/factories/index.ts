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
  explorerTabFactory,
  sourceControlTabFactory,
  terminalTabFactory,
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
  createSearchSessionsTab,
  createSearchTab,
  createUrlPreviewTab,
} from "./codeEditor";
export type { SourceControlHistorySelection } from "./codeEditor";

// Browser
export { createBrowserSessionTab } from "./browser";

// Chat
export { createChatSessionTab } from "./chat";

// Project Manager
export {
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
} from "./project";
export type {
  ProjectOrgScope,
  ProjectOrgSurfaceView,
  ProjectLinearSurfaceView,
  ProjectDetailSurfaceView,
} from "./project";

// Subagent
export { createSubagentDetailTab } from "./subagent";

// Agent Config
export { agentConfigTabFactory, createAgentConfigTab } from "./agentConfig";
export type { AgentConfigTabData, AgentConfigTabVariant } from "../types";

// Canvas Preview
export { createCanvasPreviewTab, getCanvasPreviewTabId } from "./canvasPreview";

// GitHub Issue Detail
export {
  githubIssueDetailTabFactory,
  createGitHubIssueDetailTab,
} from "./githubIssue";
export type { GitHubIssueDetailTabData } from "./githubIssue";

// GitHub PR Detail
export { githubPrDetailTabFactory, createGitHubPrDetailTab } from "./githubPr";
export type { GitHubPrDetailTabData } from "./githubPr";
