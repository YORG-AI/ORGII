/**
 * Tab-type → renderer registry.
 *
 * Each entry lazy-imports a tiny wrapper file in `./renderers/`. The
 * wrapper is responsible for adapting `tab.data` into the underlying
 * view component's prop shape. The dispatcher
 * (`UnifiedTabContent.tsx`) is the only consumer of this map.
 *
 * Phase 1b: this registry is exhaustive over `WorkStationTabType` but
 * is not yet wired into AppShell. The exhaustiveness check at the
 * bottom guarantees every union member gets an entry.
 */
import { lazy } from "react";

import type { WorkStationTabType } from "@src/store/workstation/tabs/types";

import type { RendererEntry, TabContentRegistry } from "./types";

// ============================================
// Editor-family renderers
// ============================================

const FileEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/file")),
  requiresRepo: true,
  debugLabel: "file",
};

const ExplorerEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/explorer")),
  debugLabel: "explorer",
};

const DirectoryEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/directory")),
  requiresRepo: true,
  debugLabel: "directory",
};

const GitDiffEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/gitDiff")),
  requiresRepo: true,
  debugLabel: "git-diff",
};

const SourceControlEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/sourceControl")),
  requiresRepo: true,
  debugLabel: "source-control",
};

const TimelineDiffEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/timelineDiff")),
  requiresRepo: true,
  debugLabel: "timeline-diff",
};

const GitLogEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/gitLog")),
  requiresRepo: true,
  debugLabel: "git-log",
};

const GitCommitDetailEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/gitCommitDetail")),
  requiresRepo: true,
  debugLabel: "git-commit-detail",
};

const GitStashDetailEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/gitStashDetail")),
  requiresRepo: true,
  debugLabel: "git-stash-detail",
};

const TerminalContentEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/terminalContent")),
  debugLabel: "terminal-content",
};

const DomComponentPreviewEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/domComponentPreview")),
  debugLabel: "dom-component-preview",
};

const TerminalEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/terminal")),
  debugLabel: "terminal",
};

const SettingsEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/settings")),
  debugLabel: "settings",
};

const SearchEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/search")),
  requiresRepo: true,
  debugLabel: "search",
};

const AIImpactEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/aiImpact")),
  debugLabel: "ai-impact",
};

const SearchSessionsEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/searchSessions")),
  debugLabel: "search-sessions",
};

const UrlPreviewEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/urlPreview")),
  debugLabel: "url-preview",
};

const SubagentDetailEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/subagentDetail")),
  debugLabel: "subagent-detail",
};

const AgentConfigEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/agentConfig")),
  debugLabel: "agent-config",
};

const ChatSessionEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/chatSession")),
  debugLabel: "chat-session",
};

// ============================================
// Browser renderers
// ============================================

const BrowserSessionEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/browserSession")),
  debugLabel: "browser-session",
};

const DevtoolsEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/devtools")),
  debugLabel: "devtools",
};

// ============================================
// Project Manager renderers
// ============================================

const ProjectDashboardEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/projectDashboard")),
  debugLabel: "project-dashboard",
};

const ProjectWorkItemsEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/projectWorkItems")),
  debugLabel: "project-work-items",
};

const ProjectWorkitemsEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/projectWorkitemsCompat")),
  debugLabel: "project-workitems",
};

const ProjectLinearProjectsEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/projectLinearProjects")),
  debugLabel: "project-linear-projects",
};

const ProjectLinearWorkItemsEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/projectLinearWorkItems")),
  debugLabel: "project-linear-work-items",
};

const ProjectSettingsEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/projectSettings")),
  debugLabel: "project-settings",
};

const ProjectOrgEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/projectOrg")),
  debugLabel: "project-org",
};

const ProjectOrgSettingsEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/projectOrgSettings")),
  debugLabel: "project-org-settings",
};

const ProjectGitSyncReviewEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/projectGitSyncReview")),
  debugLabel: "project-git-sync-review",
};

const WorkItemDetailEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/workItemDetail")),
  debugLabel: "workItem-detail",
};

// ============================================
// Canvas Preview renderer
// ============================================

const CanvasPreviewEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/canvasPreview")),
  debugLabel: "canvas-preview",
};

// ============================================
// GitHub Issue Detail renderer
// ============================================

const GitHubIssueDetailEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/githubIssueDetail")),
  debugLabel: "github-issue-detail",
};

const GitHubPrDetailEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/githubPrDetail")),
  debugLabel: "github-pr-detail",
};

const StartEntry: RendererEntry = {
  Component: lazy(() => import("./renderers/start")),
  debugLabel: "start",
};

// ============================================
// Registry — exhaustive over WorkStationTabType
// ============================================

export const REGISTRY: TabContentRegistry = {
  // Code Editor
  file: FileEntry,
  directory: DirectoryEntry,
  explorer: ExplorerEntry,
  "git-diff": GitDiffEntry,
  "source-control": SourceControlEntry,
  "timeline-diff": TimelineDiffEntry,
  "git-log": GitLogEntry,
  "git-commit-detail": GitCommitDetailEntry,
  "git-stash-detail": GitStashDetailEntry,
  "terminal-content": TerminalContentEntry,
  "dom-component-preview": DomComponentPreviewEntry,
  terminal: TerminalEntry,
  settings: SettingsEntry,
  search: SearchEntry,
  "ai-impact": AIImpactEntry,
  "search-sessions": SearchSessionsEntry,
  "url-preview": UrlPreviewEntry,

  // Browser
  "browser-session": BrowserSessionEntry,
  devtools: DevtoolsEntry,

  // Project Manager
  "project-dashboard": ProjectDashboardEntry,
  "project-work-items": ProjectWorkItemsEntry,
  "project-linear-projects": ProjectLinearProjectsEntry,
  "project-linear-work-items": ProjectLinearWorkItemsEntry,
  "project-settings": ProjectSettingsEntry,
  "project-org": ProjectOrgEntry,
  "project-org-settings": ProjectOrgSettingsEntry,
  "project-git-sync-review": ProjectGitSyncReviewEntry,
  "project-workitems": ProjectWorkitemsEntry,
  "workItem-detail": WorkItemDetailEntry,
  "chat-session": ChatSessionEntry,

  // Subagent
  "subagent-detail": SubagentDetailEntry,

  // Agent Config (Agent Teams page → opens here)
  "agent-config": AgentConfigEntry,

  // Canvas Preview
  "canvas-preview": CanvasPreviewEntry,

  // GitHub Issue Detail
  "github-issue-detail": GitHubIssueDetailEntry,

  // GitHub PR Detail
  "github-pr-detail": GitHubPrDetailEntry,

  // Start page launcher
  start: StartEntry,
};

// Exhaustiveness check: any missing WorkStationTabType becomes a TS error.
const _exhaustive: Record<WorkStationTabType, RendererEntry> = REGISTRY;
void _exhaustive;
