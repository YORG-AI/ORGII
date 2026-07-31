import type { TFunction } from "i18next";
import { useAtomValue } from "jotai";
import { TerminalSquare } from "lucide-react";
import { type MouseEvent, useMemo } from "react";

import type { WorkspaceRecord } from "@src/api/tauri/workspace";
import type { AvailableAgent } from "@src/config/cliAgents";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { ROUTES } from "@src/config/routes";
import { getTerminalDisplayTitle } from "@src/engines/TerminalCore/types";
import type { KeyVaultAccount } from "@src/hooks/keyVault/types";
import type {
  AgentDefinition,
  OrgMember,
} from "@src/modules/MainApp/AgentOrgs/types";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import { chatPanelTabsAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { terminalSessionsAtom } from "@src/store/chatPanel/chatPanelTerminalAtom";
import type { Repo } from "@src/store/repo";
import type { Session, SessionCreatorDraft } from "@src/store/session";
import { toChatPanelTuiSessionId } from "@src/util/ui/terminal/chatPanelTuiSessionId";

import { separator } from "../useSessionMenuItems/menuItemBuilders";
import {
  buildDraftMenuItems,
  buildFoldersPinnedMenuItems,
  buildPinnedMenuItems,
  buildProjectsPinnedMenuItems,
} from "../workstationSidebarMenuItems";
import {
  FOLDERS_DASHBOARD_ITEM_ID,
  FOLDERS_EXPLORE_ITEM_ID,
  buildFoldersSidebarMenuItems,
} from "./foldersSidebarMenuItems";
import type { WorkstationSidebarKey } from "./types";

type TCommon = (key: string, defaultValue?: string) => string;

interface UsePinnedMenuItemsParams {
  activeSidebarKey: WorkstationSidebarKey;
  createProjectLabel: string;
  createWorkItemLabel: string;
  importGithubIssuesLabel: string;
  newSessionLabel: string;
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
  newSessionLabel,
  t,
}: UsePinnedMenuItemsParams): UsePinnedMenuItemsResult {
  const sessionPinnedMenuItems = useMemo<NavigationMenuItem[]>(
    () =>
      buildPinnedMenuItems({
        newSessionLabel,
        newSessionShortcut: getShortcutKeys("new_session"),
        opsControlLabel: t("routes.opsControl"),
        opsControlRoutePath: ROUTES.workStation.opsControl.path,
        opsControlShortcut: getShortcutKeys("open_ops_control"),
        journeyLabel: t("routes.journey", { defaultValue: "Journey" }),
        journeyRoutePath: ROUTES.workStation.journey.path,
        journeyShortcut: getShortcutKeys("open_journey"),
      }),
    [newSessionLabel, t]
  );
  const projectsPinnedMenuItems = useMemo<NavigationMenuItem[]>(
    () =>
      buildProjectsPinnedMenuItems({
        createProjectLabel,
        createWorkItemLabel,
        importGithubIssuesLabel,
      }),
    [createProjectLabel, createWorkItemLabel, importGithubIssuesLabel]
  );
  const foldersPinnedMenuItems = useMemo<NavigationMenuItem[]>(
    () =>
      buildFoldersPinnedMenuItems({
        dashboardItemId: FOLDERS_DASHBOARD_ITEM_ID,
        dashboardLabel: t("launchpad.dashboard"),
        exploreItemId: FOLDERS_EXPLORE_ITEM_ID,
        exploreLabel: t("explore.title", { defaultValue: "Explore" }),
      }),
    [t]
  );
  const pinnedMenuItems =
    activeSidebarKey === "projects"
      ? projectsPinnedMenuItems
      : activeSidebarKey === "folders"
        ? foldersPinnedMenuItems
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

interface UseFoldersSidebarMenuItemsParams {
  builtInRustAgents: readonly AgentDefinition[];
  customRustAgents: readonly AgentDefinition[];
  agentOrgs: readonly OrgMember[];
  installedCliAgents: readonly AvailableAgent[];
  localAccounts: readonly KeyVaultAccount[];
  repos: readonly Repo[];
  savedWorkspaces: readonly WorkspaceRecord[];
  t: TFunction<"navigation">;
  tCommon: TCommon;
  onAddWorkspaceFolder: () => void;
  onCreateMultiRepoWorkspace: () => void;
  onOpenWorkspace: (workspace: WorkspaceRecord) => void;
  onOpenRepo: (repo: Repo) => void;
  onMoreActionsForWorkspace: (
    event: MouseEvent<HTMLButtonElement>,
    workspace: WorkspaceRecord
  ) => void;
  onMoreActionsForRepo: (
    event: MouseEvent<HTMLButtonElement>,
    repo: Repo
  ) => void;
  activeMoreMenuId: string;
}

export function useFoldersSidebarMenuItems({
  builtInRustAgents,
  customRustAgents,
  agentOrgs,
  installedCliAgents,
  localAccounts,
  repos,
  savedWorkspaces,
  t,
  tCommon,
  onAddWorkspaceFolder,
  onCreateMultiRepoWorkspace,
  onOpenWorkspace,
  onOpenRepo,
  onMoreActionsForWorkspace,
  onMoreActionsForRepo,
  activeMoreMenuId,
}: UseFoldersSidebarMenuItemsParams): NavigationMenuItem[] {
  const totalAgentsCount =
    installedCliAgents.length +
    builtInRustAgents.length +
    customRustAgents.length;
  const totalAgentOrgsCount = agentOrgs.length;

  return useMemo<NavigationMenuItem[]>(
    () =>
      buildFoldersSidebarMenuItems({
        savedWorkspaces,
        repos,
        localAccounts,
        installedCliAgents,
        builtInRustAgents,
        customRustAgents,
        agentOrgs,
        multiRepoWorkspaceCountLabel: (count) =>
          t("sidebar.folderCounts.multiRepoWorkspace", { count }),
        repoCountLabel: (count) => t("sidebar.folderCounts.repo", { count }),
        myKeysLabel: t("sessions:controlTower.myApiKeys", {
          count: localAccounts.length,
        }),
        myAgentsLabel: t("sessions:controlTower.myAgents", {
          count: totalAgentsCount,
        }),
        myAgentOrgsLabel: t("sessions:controlTower.myAgentOrgs", {
          count: totalAgentOrgsCount,
        }),
        onAddWorkspaceFolder,
        onCreateMultiRepoWorkspace,
        onOpenWorkspace,
        onOpenRepo,
        onMoreActionsForWorkspace,
        onMoreActionsForRepo,
        openFolderLabel: tCommon("common:openFolder", "Open Folder"),
        moreActionLabel: tCommon("actions.more"),
        addWorkspaceFolderLabel: tCommon(
          "ellipsisMenu.addWorkspace",
          "Add workspace..."
        ),
        createMultiRepoWorkspaceLabel: tCommon(
          "workspaceForm.createWorkspace",
          "Create Multi-repo Workspace"
        ),
        activeMoreMenuId,
      }),
    [
      totalAgentsCount,
      totalAgentOrgsCount,
      activeMoreMenuId,
      agentOrgs,
      builtInRustAgents,
      customRustAgents,
      installedCliAgents,
      localAccounts,
      onAddWorkspaceFolder,
      onCreateMultiRepoWorkspace,
      onMoreActionsForRepo,
      onMoreActionsForWorkspace,
      onOpenRepo,
      onOpenWorkspace,
      repos,
      savedWorkspaces,
      t,
      tCommon,
    ]
  );
}
