import type { TFunction } from "i18next";
import { useAtomValue } from "jotai";
import { useMemo } from "react";

import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { getTerminalDisplayTitle } from "@src/engines/TerminalCore/types";
import { Refresh04Icon, Search01Icon, SquareTerminalIcon } from "@src/icons";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import { chatPanelTabsAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { terminalSessionsAtom } from "@src/store/chatPanel/chatPanelTerminalAtom";
import type { Session, SessionCreatorDraft } from "@src/store/session";
import { toChatPanelTuiSessionId } from "@src/util/ui/terminal/chatPanelTuiSessionId";

import { separator } from "../useSessionMenuItems/menuItemBuilders";
import {
  buildChannelsPinnedMenuItems,
  buildDraftMenuItems,
  buildPinnedMenuItems,
  buildProjectsPinnedMenuItems,
} from "../workstationSidebarMenuItems";
import type { WorkstationSidebarViewKey } from "./WorkstationSidebarViewSwitcher";

const PINNED_SESSION_SEPARATOR_ID = "separator-pinned";

interface UsePinnedMenuItemsParams {
  activeViewKey: WorkstationSidebarViewKey;
  createProjectLabel: string;
  createWorkItemLabel: string;
  importGithubIssuesLabel: string;
  kanbanLabel: string;
  newSessionLabel: string;
  runtimeLabel: string;
  teamInboxLabel: string;
  teamInboxUnreadCount?: number;
  workItemDestinations: NavigationMenuItem[];
  t: TFunction<"navigation">;
}

interface UsePinnedMenuItemsResult {
  pinnedMenuItems: NavigationMenuItem[];
}

export function usePinnedMenuItems({
  activeViewKey,
  createProjectLabel,
  createWorkItemLabel,
  importGithubIssuesLabel,
  kanbanLabel,
  newSessionLabel,
  runtimeLabel,
  teamInboxLabel,
  teamInboxUnreadCount,
  workItemDestinations,
  t,
}: UsePinnedMenuItemsParams): UsePinnedMenuItemsResult {
  const teamInboxUnreadAriaLabel = useMemo(
    () =>
      teamInboxUnreadCount
        ? t("common:teamInbox.unreadCount", { count: teamInboxUnreadCount })
        : undefined,
    [t, teamInboxUnreadCount]
  );
  const sessionPinnedMenuItems = useMemo<NavigationMenuItem[]>(
    () =>
      buildPinnedMenuItems({
        newSessionLabel,
        newSessionShortcut: getShortcutKeys("new_session"),
        kanbanLabel,
        kanbanShortcut: getShortcutKeys("open_kanban"),
        runtimeLabel,
        teamInboxLabel,
        teamInboxUnreadCount,
        teamInboxUnreadAriaLabel,
      }),
    [
      kanbanLabel,
      newSessionLabel,
      runtimeLabel,
      teamInboxLabel,
      teamInboxUnreadCount,
      teamInboxUnreadAriaLabel,
    ]
  );
  const projectsPinnedMenuItems = useMemo<NavigationMenuItem[]>(
    () =>
      buildProjectsPinnedMenuItems({
        browseLabel: t("common:actions.browse"),
        createProjectLabel,
        createWorkItemLabel,
        importGithubIssuesLabel,
        teamInboxLabel,
        teamInboxUnreadCount,
        teamInboxUnreadAriaLabel,
        workItemDestinations,
      }),
    [
      createProjectLabel,
      createWorkItemLabel,
      importGithubIssuesLabel,
      teamInboxLabel,
      teamInboxUnreadCount,
      teamInboxUnreadAriaLabel,
      t,
      workItemDestinations,
    ]
  );
  const channelsPinnedMenuItems = useMemo(
    () =>
      buildChannelsPinnedMenuItems({
        teamInboxLabel,
        teamInboxUnreadCount,
        teamInboxUnreadAriaLabel,
      }),
    [teamInboxLabel, teamInboxUnreadAriaLabel, teamInboxUnreadCount]
  );
  const pinnedMenuItems =
    activeViewKey === "work-items"
      ? projectsPinnedMenuItems
      : activeViewKey === "channels"
        ? channelsPinnedMenuItems
        : sessionPinnedMenuItems;

  return { pinnedMenuItems };
}

export function addActionsToFirstSessionSection({
  menuItems,
  searchLabel,
  refreshLabel,
  refreshIconClassName,
  onSearch,
  onRefresh,
}: {
  menuItems: readonly NavigationMenuItem[];
  searchLabel: string;
  refreshLabel: string;
  refreshIconClassName?: string;
  onSearch: () => void;
  onRefresh: () => void;
}): readonly NavigationMenuItem[] {
  const sectionIndex = menuItems.findIndex(
    (item) =>
      item.id.startsWith("separator-") &&
      item.id !== PINNED_SESSION_SEPARATOR_ID &&
      item.label.length > 0
  );
  if (sectionIndex < 0) return menuItems;

  const section = menuItems[sectionIndex];
  const sectionWithActions: NavigationMenuItem = {
    ...section,
    rowActions: [
      {
        icon: Search01Icon,
        dataIcon: "search",
        label: searchLabel,
        dataTestId: "sidebar-sessions-search",
        onClick: onSearch,
      },
      {
        icon: Refresh04Icon,
        dataIcon: "refresh-cw",
        iconClassName: refreshIconClassName,
        label: refreshLabel,
        dataTestId: "sidebar-sessions-refresh",
        onClick: onRefresh,
      },
      ...(section.rowActions ?? []),
    ],
  };

  return [
    ...menuItems.slice(0, sectionIndex),
    sectionWithActions,
    ...menuItems.slice(sectionIndex + 1),
  ];
}

export function useSessionSidebarMenuItems({
  menuItems,
  sessionCreatorDrafts,
  searchLabel,
  refreshLabel,
  refreshIconClassName,
  onSearch,
  onRefresh,
  t,
}: {
  menuItems: readonly NavigationMenuItem[];
  sessionCreatorDrafts: readonly SessionCreatorDraft[];
  searchLabel: string;
  refreshLabel: string;
  refreshIconClassName?: string;
  onSearch: () => void;
  onRefresh: () => void;
  t: TFunction<"navigation">;
}): NavigationMenuItem[] {
  const draftMenuItems = useMemo<NavigationMenuItem[]>(
    () =>
      buildDraftMenuItems({
        sessionCreatorDrafts,
        draftsLabel: t("labels.drafts"),
      }),
    [sessionCreatorDrafts, t]
  );

  const tabsState = useAtomValue(chatPanelTabsAtom);
  const terminalSessions = useAtomValue(terminalSessionsAtom);

  const terminalAgentSessionIds = useMemo(
    () =>
      new Set(
        terminalSessions
          .filter((session) => session.agentCommand)
          .map((session) => session.id)
      ),
    [terminalSessions]
  );

  const terminalTabs = useMemo(
    () =>
      tabsState.tabs.filter(
        (tab) =>
          tab.type === "terminal" &&
          (!tab.terminalSessionId ||
            !terminalAgentSessionIds.has(tab.terminalSessionId))
      ),
    [tabsState.tabs, terminalAgentSessionIds]
  );

  const terminalMenuItems = useMemo<NavigationMenuItem[]>(() => {
    if (terminalTabs.length === 0) return [];
    const terminalsLabel = t("labels.terminals");
    const items: NavigationMenuItem[] = [
      separator("terminals", terminalsLabel),
    ];
    for (const tab of terminalTabs) {
      items.push({
        id: `chat-terminal-${tab.id}`,
        key: `chat-terminal-${tab.id}`,
        label: tab.title || "Terminal",
        icon: SquareTerminalIcon,
      });
    }
    return items;
  }, [terminalTabs, t]);

  const sessionMenuItems = useMemo(
    () =>
      addActionsToFirstSessionSection({
        menuItems,
        searchLabel,
        refreshLabel,
        refreshIconClassName,
        onSearch,
        onRefresh,
      }),
    [
      menuItems,
      onRefresh,
      onSearch,
      refreshIconClassName,
      refreshLabel,
      searchLabel,
    ]
  );

  return useMemo(
    () => [...draftMenuItems, ...terminalMenuItems, ...sessionMenuItems],
    [draftMenuItems, terminalMenuItems, sessionMenuItems]
  );
}

export function useChatPanelTuiSidebarSessions(): Session[] {
  const tabsState = useAtomValue(chatPanelTabsAtom);
  const terminalSessions = useAtomValue(terminalSessionsAtom);

  return useMemo(() => {
    const terminalById = new Map(
      terminalSessions.map((session) => [session.id, session])
    );
    return tabsState.tabs.flatMap((tab): Session[] => {
      if (tab.type !== "terminal" || !tab.terminalSessionId) return [];
      const terminal = terminalById.get(tab.terminalSessionId);
      if (!terminal?.agentCommand || !terminal.cliAgentType) return [];
      // TUI terminals backed by a managed code_sessions row are already in
      // the real session list; a synthetic row would be a duplicate.
      if (terminal.agentSessionId) return [];
      const fallbackTimestamp = new Date().toISOString();
      const status =
        terminal.agentStatus === "done"
          ? "completed"
          : terminal.agentStatus === "waiting"
            ? "idle"
            : "running";
      const title = getTerminalDisplayTitle(terminal) || tab.title;
      return [
        {
          session_id: toChatPanelTuiSessionId(tab.id),
          status,
          created_at: tab.createdAt ?? fallbackTimestamp,
          updated_at: tab.updatedAt ?? tab.createdAt ?? fallbackTimestamp,
          name: title,
          user_input: terminal.agentCommand,
          repoPath: terminal.liveCwd || terminal.cwd,
          category: "cli_agent",
          cliAgentType: terminal.cliAgentType,
          pid: terminal.pid ?? null,
        },
      ];
    });
  }, [tabsState.tabs, terminalSessions]);
}

/** Returns the handler for terminal sidebar items — consumed by the connector's click handler */
export function isChatTerminalSidebarItem(id: string): boolean {
  return id.startsWith("chat-terminal-");
}

export function getChatTerminalTabId(id: string): string {
  return id.replace("chat-terminal-", "");
}
