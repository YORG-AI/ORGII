/**
 * Stable identifiers for the content rendered in the chat-panel slot.
 *
 * This module intentionally contains no store or component imports so API
 * snapshot types can describe the visible surface without pulling Jotai state
 * into the transport/schema dependency graph.
 */
export const CHAT_PANEL_SURFACE_KIND = {
  SESSION: "session",
  BENCHMARK_SESSION_GROUP: "benchmarkSessionGroup",
  NEW_PROJECT: "newProject",
  NEW_GITHUB_ISSUES_PROJECT: "newGithubIssuesProject",
  NEW_WORK_ITEM: "newWorkItem",
  NEW_COLLAB_ORG: "newCollabOrg",
  PROJECT: "project",
  PROJECT_ORG: "projectOrg",
  WORK_ITEM: "workItem",
  WORKSPACE_EXPLORE: "workspaceExplore",
  WORKSPACE_OVERVIEW: "workspaceOverview",
  CLOUD_ORG: "cloudOrg",
} as const;

export type ChatPanelSurfaceKind =
  (typeof CHAT_PANEL_SURFACE_KIND)[keyof typeof CHAT_PANEL_SURFACE_KIND];
