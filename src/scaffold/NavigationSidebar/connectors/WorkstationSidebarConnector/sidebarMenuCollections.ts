import type { TFunction } from "i18next";
import { useAtomValue } from "jotai";
import { TerminalSquare } from "lucide-react";
import { useMemo } from "react";

import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { getTerminalDisplayTitle } from "@src/engines/TerminalCore/types";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import { chatPanelTabsAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { terminalSessionsAtom } from "@src/store/chatPanel/chatPanelTerminalAtom";
import type { Session, SessionCreatorDraft } from "@src/store/session";
import { toChatPanelTuiSessionId } from "@src/util/ui/terminal/chatPanelTuiSessionId";

import { separator } from "../useSessionMenuItems/menuItemBuilders";
import {
  buildDraftMenuItems,
  buildPinnedMenuItems,
  buildProjectsPinnedMenuItems,
} from "../workstationSidebarMenuItems";
import type { WorkstationSidebarKey } from "./types";

interface UsePinnedMenuItemsParams {
  activeSidebarKey: WorkstationSidebarKey;
  createProjectLabel: string;
  createWorkItemLabel: string;
  importGithubIssuesLabel: string;
  kanbanLabel: string;
  newSessionLabel: string;
  runtimeLabel: string;
  workItemDestinations: NavigationMenuItem[];
  t: TFunction<"navigation">;
}

interface UsePinnedMenuItemsResult {
  pinnedMenuItems: NavigationMenuItem[];
  sessionPinnedMenuItems: NavigationMenuItem[];
}

export function usePinnedMenuItems({
  activeSidebarKey,
  createProjectLabel,
  createWorkItemLabel,
  importGithubIssuesLabel,
  kanbanLabel,
  newSessionLabel,
  runtimeLabel,
  workItemDestinations,
  t,
}: UsePinnedMenuItemsParams): UsePinnedMenuItemsResult {
  const sessionPinnedMenuItems = useMemo<NavigationMenuItem[]>(
    () =>
      buildPinnedMenuItems({
        newSessionLabel,
        newSessionShortcut: getShortcutKeys("new_session"),
        workItemsLabel: t("labels.workItems"),
        workItemDestinations,
        kanbanLabel,
        kanbanShortcut: getShortcutKeys("open_kanban"),
        runtimeLabel,
      }),
    [kanbanLabel, newSessionLabel, runtimeLabel, workItemDestinations, t]
  );
  const projectsPinnedMenuItems = useMemo<NavigationMenuItem[]>(
    () =>
      buildProjectsPinnedMenuItems({
        createProjectLabel,
        createWorkItemLabel,
        importGithubIssuesLabel,
        workItemDestinations,
      }),
    [
      createProjectLabel,
      createWorkItemLabel,
      importGithubIssuesLabel,
      workItemDestinations,
    ]
  );
  const pinnedMenuItems =
    activeSidebarKey === "projects"
      ? projectsPinnedMenuItems
      : sessionPinnedMenuItems;

  return { pinnedMenuItems, sessionPinnedMenuItems };
}

export function useSessionSidebarMenuItems({
  menuItems,
  sessionCreatorDrafts,
  t,
}: {
  menuItems: readonly NavigationMenuItem[];
  sessionCreatorDrafts: readonly SessionCreatorDraft[];
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
        icon: TerminalSquare,
      });
    }
    return items;
  }, [terminalTabs, t]);

  return useMemo(
    () => [...draftMenuItems, ...terminalMenuItems, ...menuItems],
    [draftMenuItems, terminalMenuItems, menuItems]
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
