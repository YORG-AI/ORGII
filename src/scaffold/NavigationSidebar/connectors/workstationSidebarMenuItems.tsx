import React from "react";

import {
  BoxIcon,
  GaugeIcon,
  GithubIcon,
  InboxIcon,
  MessageAdd02Icon,
  PencilEdit02Icon,
  TrelloIcon,
} from "@src/icons";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import { GENERAL_LAYOUT_TOUR_TARGETS } from "@src/scaffold/Tutorials/generalLayoutTourConfig";
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
  getDraftMenuItemId,
  getDraftPreviewText,
} from "./sidebarConnectorUtils";

interface BuildPinnedMenuItemsParams {
  newSessionLabel: string;
  newSessionShortcut: string;
  kanbanLabel: string;
  kanbanShortcut: string;
  runtimeLabel: string;
  teamInboxLabel: string;
  teamInboxUnreadCount?: number;
  teamInboxUnreadAriaLabel?: string;
}

interface BuildProjectsPinnedMenuItemsParams {
  browseLabel: string;
  createProjectLabel: string;
  createWorkItemLabel: string;
  importGithubIssuesLabel: string;
  teamInboxLabel: string;
  teamInboxUnreadCount?: number;
  teamInboxUnreadAriaLabel?: string;
  workItemDestinations: readonly NavigationMenuItem[];
}

interface BuildTeamInboxMenuItemParams {
  teamInboxLabel: string;
  teamInboxUnreadCount?: number;
  teamInboxUnreadAriaLabel?: string;
}

export function buildTeamInboxMenuItem({
  teamInboxLabel,
  teamInboxUnreadCount = 0,
  teamInboxUnreadAriaLabel,
}: BuildTeamInboxMenuItemParams): NavigationMenuItem {
  return {
    id: TEAM_INBOX_MENU_ITEM_ID,
    key: TEAM_INBOX_MENU_ITEM_ID,
    label: teamInboxLabel,
    icon: InboxIcon,
    iconName: "inbox",
    dataTestId: "sidebar-team-inbox",
    trailingElement:
      teamInboxUnreadCount > 0 ? (
        <span
          aria-label={
            teamInboxUnreadAriaLabel ?? `${teamInboxUnreadCount} unread`
          }
          className="min-w-5 rounded-full bg-primary-6 px-1.5 text-center text-xs font-medium text-white"
        >
          {teamInboxUnreadCount > 99 ? "99+" : teamInboxUnreadCount}
        </span>
      ) : undefined,
  };
}

export function buildPinnedMenuItems({
  newSessionLabel,
  newSessionShortcut,
  kanbanLabel,
  kanbanShortcut,
  runtimeLabel,
  teamInboxLabel,
  teamInboxUnreadCount = 0,
  teamInboxUnreadAriaLabel,
}: BuildPinnedMenuItemsParams): NavigationMenuItem[] {
  return [
    {
      id: NEW_SESSION_MENU_ITEM_ID,
      key: NEW_SESSION_MENU_ITEM_ID,
      label: newSessionLabel,
      icon: MessageAdd02Icon,
      iconName: "message-add",
      shortcut: newSessionShortcut,
      dataTestId: "sidebar-new-session",
    },
    {
      id: KANBAN_MENU_ITEM_ID,
      key: KANBAN_MENU_ITEM_ID,
      label: kanbanLabel,
      icon: TrelloIcon,
      iconName: "trello",
      shortcut: kanbanShortcut,
    },
    {
      id: RUNTIME_MENU_ITEM_ID,
      key: RUNTIME_MENU_ITEM_ID,
      label: runtimeLabel,
      icon: GaugeIcon,
      iconName: "gauge",
      dataTestId: "sidebar-runtime",
      tourTarget: GENERAL_LAYOUT_TOUR_TARGETS.runtimeNavigation,
    },
    buildTeamInboxMenuItem({
      teamInboxLabel,
      teamInboxUnreadCount,
      teamInboxUnreadAriaLabel,
    }),
  ];
}

export function buildProjectsPinnedMenuItems({
  browseLabel,
  createProjectLabel,
  createWorkItemLabel,
  importGithubIssuesLabel,
  teamInboxLabel,
  teamInboxUnreadCount,
  teamInboxUnreadAriaLabel,
  workItemDestinations,
}: BuildProjectsPinnedMenuItemsParams): NavigationMenuItem[] {
  return [
    {
      id: PROJECTS_NEW_WORK_ITEM_MENU_ITEM_ID,
      key: PROJECTS_NEW_WORK_ITEM_MENU_ITEM_ID,
      label: createWorkItemLabel,
      icon: PencilEdit02Icon,
      iconName: "square-pen",
      dataTestId: "sidebar-create-work-item",
    },
    {
      id: PROJECTS_NEW_PROJECT_MENU_ITEM_ID,
      key: PROJECTS_NEW_PROJECT_MENU_ITEM_ID,
      label: createProjectLabel,
      icon: BoxIcon,
      iconName: "box",
      dataTestId: "sidebar-create-project",
    },
    {
      id: PROJECTS_IMPORT_GITHUB_ISSUES_MENU_ITEM_ID,
      key: PROJECTS_IMPORT_GITHUB_ISSUES_MENU_ITEM_ID,
      label: importGithubIssuesLabel,
      icon: GithubIcon,
      iconName: "github",
      dataTestId: "sidebar-import-github-issues",
    },
    buildTeamInboxMenuItem({
      teamInboxLabel,
      teamInboxUnreadCount,
      teamInboxUnreadAriaLabel,
    }),
    {
      id: "separator-work-items-browse",
      key: "separator-work-items-browse",
      label: browseLabel,
    },
    ...workItemDestinations,
  ];
}

export function buildChannelsPinnedMenuItems(
  params: BuildTeamInboxMenuItemParams
): NavigationMenuItem[] {
  return [buildTeamInboxMenuItem(params)];
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
