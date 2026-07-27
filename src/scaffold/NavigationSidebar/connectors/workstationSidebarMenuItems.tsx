import {
  Box,
  Columns3,
  Gauge,
  Github,
  Inbox,
  ListTodo,
  Plus,
  SquarePen,
} from "lucide-react";
import React from "react";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { SessionCreatorDraft } from "@src/store/session";
import { resolveSessionRowIcon } from "@src/util/session/sessionSidebarRow";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import {
  KANBAN_MENU_ITEM_ID,
  NEW_SESSION_MENU_ITEM_ID,
  PROJECTS_IMPORT_GITHUB_ISSUES_MENU_ITEM_ID,
  PROJECTS_NEW_PROJECT_MENU_ITEM_ID,
  PROJECTS_NEW_WORK_ITEM_MENU_ITEM_ID,
  RUNTIME_MENU_ITEM_ID,
  TEAM_INBOX_MENU_ITEM_ID,
  WORK_ITEMS_MENU_ITEM_ID,
  getDraftMenuItemId,
  getDraftPreviewText,
} from "./sidebarConnectorUtils";

interface BuildPinnedMenuItemsParams {
  newSessionLabel: string;
  newSessionShortcut: string;
  workItemsLabel: string;
  workItemDestinations: NavigationMenuItem[];
  kanbanLabel: string;
  kanbanShortcut: string;
  runtimeLabel: string;
  teamInboxLabel: string;
  teamInboxUnreadCount?: number;
}

interface BuildProjectsPinnedMenuItemsParams {
  createProjectLabel: string;
  createWorkItemLabel: string;
  importGithubIssuesLabel: string;
  workItemDestinations: readonly NavigationMenuItem[];
}

export function buildPinnedMenuItems({
  newSessionLabel,
  newSessionShortcut,
  workItemsLabel,
  workItemDestinations,
  kanbanLabel,
  kanbanShortcut,
  runtimeLabel,
  teamInboxLabel,
  teamInboxUnreadCount = 0,
}: BuildPinnedMenuItemsParams): NavigationMenuItem[] {
  return [
    {
      id: NEW_SESSION_MENU_ITEM_ID,
      key: NEW_SESSION_MENU_ITEM_ID,
      label: newSessionLabel,
      icon: Plus,
      iconName: "plus",
      shortcut: newSessionShortcut,
      dataTestId: "sidebar-new-session",
    },
    {
      id: KANBAN_MENU_ITEM_ID,
      key: KANBAN_MENU_ITEM_ID,
      label: kanbanLabel,
      icon: Columns3,
      iconName: "columns-3",
      shortcut: kanbanShortcut,
    },
    {
      id: RUNTIME_MENU_ITEM_ID,
      key: RUNTIME_MENU_ITEM_ID,
      label: runtimeLabel,
      icon: Gauge,
      iconName: "gauge",
      dataTestId: "sidebar-runtime",
    },
    {
      id: TEAM_INBOX_MENU_ITEM_ID,
      key: TEAM_INBOX_MENU_ITEM_ID,
      label: teamInboxLabel,
      icon: Inbox,
      iconName: "inbox",
      dataTestId: "sidebar-team-inbox",
      trailingElement:
        teamInboxUnreadCount > 0 ? (
          <span
            aria-label={`${teamInboxUnreadCount} unread`}
            className="min-w-5 rounded-full bg-primary-6 px-1.5 text-center text-xs font-medium text-white"
          >
            {teamInboxUnreadCount > 99 ? "99+" : teamInboxUnreadCount}
          </span>
        ) : undefined,
    },
    {
      id: WORK_ITEMS_MENU_ITEM_ID,
      key: WORK_ITEMS_MENU_ITEM_ID,
      label: workItemsLabel,
      icon: ListTodo,
      iconName: "list-todo",
      children: workItemDestinations,
      dataTestId: "sidebar-toggle-work-items",
    },
  ];
}

export function buildProjectsPinnedMenuItems({
  createProjectLabel,
  createWorkItemLabel,
  importGithubIssuesLabel,
  workItemDestinations,
}: BuildProjectsPinnedMenuItemsParams): NavigationMenuItem[] {
  return [
    {
      id: PROJECTS_NEW_WORK_ITEM_MENU_ITEM_ID,
      key: PROJECTS_NEW_WORK_ITEM_MENU_ITEM_ID,
      label: createWorkItemLabel,
      icon: SquarePen,
      iconName: "square-pen",
      dataTestId: "sidebar-create-work-item",
    },
    {
      id: PROJECTS_NEW_PROJECT_MENU_ITEM_ID,
      key: PROJECTS_NEW_PROJECT_MENU_ITEM_ID,
      label: createProjectLabel,
      icon: Box,
      iconName: "box",
      dataTestId: "sidebar-create-project",
    },
    {
      id: PROJECTS_IMPORT_GITHUB_ISSUES_MENU_ITEM_ID,
      key: PROJECTS_IMPORT_GITHUB_ISSUES_MENU_ITEM_ID,
      label: importGithubIssuesLabel,
      icon: Github,
      iconName: "github",
      dataTestId: "sidebar-import-github-issues",
    },
    ...workItemDestinations,
  ];
}

interface BuildDraftMenuItemsParams {
  sessionCreatorDrafts: readonly SessionCreatorDraft[];
  draftsLabel: string;
}

export function buildDraftMenuItems({
  sessionCreatorDrafts,
  draftsLabel,
}: BuildDraftMenuItemsParams): NavigationMenuItem[] {
  if (sessionCreatorDrafts.length === 0) return [];
  return [
    {
      id: "separator-drafts",
      key: "separator-drafts",
      label: draftsLabel,
    },
    ...sessionCreatorDrafts.map((draft) => {
      const menuItemId = getDraftMenuItemId(draft.id);
      return {
        id: menuItemId,
        key: menuItemId,
        label: getDraftPreviewText(draft),
        icon: resolveSessionRowIcon({
          session_id: draft.id,
          agentIconId: draft.agentIconId ?? undefined,
          cliAgentType: draft.cliAgentType ?? undefined,
        }),
        shortcut: formatRelativeTime(draft.createdAt, "nano"),
        openContextMenuOnSelectedClick: true,
        trailingElement: (
          <span className="h-1.5 w-1.5 rounded-full border border-border-3 bg-transparent" />
        ),
      } satisfies NavigationMenuItem;
    }),
  ];
}
