import { enrichedWorkItemToUI, projectApi } from "@src/api/http/project";
import { rpc } from "@src/api/tauri/rpc";
import { buildAgentOrgsPath } from "@src/config/mainAppPaths";
import { replayModeAtom } from "@src/engines/SessionCore";
import { AppType } from "@src/engines/Simulator/types/appTypes";
import { agentOrgsActiveTabAtom } from "@src/modules/MainApp/AgentOrgs/store/agentOrgsActiveTabAtom";
import { allAgentDefsAtom } from "@src/modules/MainApp/AgentOrgs/store/builtInAgentsAtom";
import { router } from "@src/router";
import { reposAtom, selectedRepoIdAtom } from "@src/store/repo/atoms";
import {
  CHAT_PANEL_CONTENT_MODE,
  activeStationChatVisibleAtom,
  chatPanelContentModeAtom,
  chatPanelMaximizedAtom,
  chatPanelSelectedWorkItemAtom,
  chatWidthAtom,
} from "@src/store/ui/chatPanelAtom";
import {
  simulatorSelectedAppAtom,
  stationModeAtom,
} from "@src/store/ui/simulatorAtom";
import {
  editorPanelPositionPersistAtom,
  workStationEditorSecondaryCollapsedPersistAtom,
} from "@src/store/ui/workStationAtom";
import { activeHostAtom } from "@src/store/workstation";
import type { AgentConfigTabVariant } from "@src/store/workstation/tabs";
import {
  PROJECT_DETAIL_SURFACE_VIEW,
  activeWorkStationTabAtom,
  createAgentConfigTab,
  createProjectWorkItemsIndexTab,
  createProjectWorkItemsTab,
  openWorkstationTabAtom,
  presentedWorkstationWorkspaceKeyAtom,
  workstationLayoutAtom,
} from "@src/store/workstation/tabs";
import { getRustAgentType } from "@src/util/session/sessionDispatch";

import { asError } from "../result";
import type { E2EStore, Err } from "../types";

export function createNavigationHelpers(store: E2EStore) {
  const navigateTo = async (path: string): Promise<{ ok: true } | Err> => {
    try {
      await router.navigate(path);
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  const getLocationPathname = (): string => window.location.pathname;

  const openWorkspaceWorkItemsTab = async (): Promise<
    | {
        ok: true;
        activeTabId: string | null;
        tabIds: string[];
        pathname: string;
      }
    | Err
  > => {
    try {
      store.set(stationModeAtom, "my-station");
      store.set(chatPanelMaximizedAtom, false);
      const tab = createProjectWorkItemsIndexTab();
      const workspace = store.get(presentedWorkstationWorkspaceKeyAtom);
      store.set(openWorkstationTabAtom, { workspace, tab });
      void router.navigate("/orgii/workstation/project").catch(() => undefined);
      const layout = store.get(workstationLayoutAtom);
      return {
        ok: true,
        activeTabId: layout?.mainPane?.activeTabId ?? null,
        tabIds: layout?.mainPane?.tabs.map((tabItem) => tabItem.id) ?? [],
        pathname: window.location.pathname,
      };
    } catch (err) {
      return asError(err);
    }
  };

  const openProjectWorkItemsTab = async (
    projectId: string,
    projectName: string,
    projectSlug?: string
  ): Promise<
    | {
        ok: true;
        activeTabId: string | null;
        tabIds: string[];
        pathname: string;
      }
    | Err
  > => {
    try {
      store.set(stationModeAtom, "my-station");
      store.set(chatPanelMaximizedAtom, false);
      const tab = createProjectWorkItemsTab(
        projectId,
        projectName,
        projectSlug,
        PROJECT_DETAIL_SURFACE_VIEW.WORK_ITEMS
      );
      const workspace = store.get(presentedWorkstationWorkspaceKeyAtom);
      store.set(openWorkstationTabAtom, { workspace, tab });
      void router.navigate("/orgii/workstation/project").catch(() => undefined);
      const layout = store.get(workstationLayoutAtom);
      return {
        ok: true,
        activeTabId: layout?.mainPane?.activeTabId ?? null,
        tabIds: layout?.mainPane?.tabs.map((tabItem) => tabItem.id) ?? [],
        pathname: window.location.pathname,
      };
    } catch (err) {
      return asError(err);
    }
  };

  const openAgentTab = async (
    agentId: string,
    tab: string
  ): Promise<
    | {
        ok: true;
        activeTabId: string | null;
        tabIds: string[];
        stationMode: string;
        pathname: string;
      }
    | Err
  > => {
    try {
      await router.navigate(buildAgentOrgsPath({ tab: "agents" }));
      store.set(stationModeAtom, "my-station");
      store.set(chatPanelMaximizedAtom, false);
      store.set(activeStationChatVisibleAtom, "my-station", false);
      store.set(workStationEditorSecondaryCollapsedPersistAtom, false);
      store.set(editorPanelPositionPersistAtom, "bottom");
      const rustAgentType = getRustAgentType(agentId);
      const variant: AgentConfigTabVariant =
        rustAgentType === "os"
          ? "builtin-os"
          : rustAgentType === "sde"
            ? "builtin-sde"
            : rustAgentType === "wingman"
              ? "wingman"
              : "custom";
      const agentSnapshot = store
        .get(allAgentDefsAtom)
        .find((agent) => agent.id === agentId);
      const agentConfigTab = createAgentConfigTab({
        variant,
        entityId: agentId,
        displayName: agentSnapshot?.name ?? agentId,
        entitySnapshot: agentSnapshot,
      });
      const workspace = store.get(presentedWorkstationWorkspaceKeyAtom);
      store.set(openWorkstationTabAtom, { workspace, tab: agentConfigTab });
      store.set(agentOrgsActiveTabAtom, tab);
      await router.navigate("/orgii/workstation/code");
      store.set(openWorkstationTabAtom, { workspace, tab: agentConfigTab });
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 50));
        store.set(chatPanelMaximizedAtom, false);
        store.set(activeStationChatVisibleAtom, "my-station", false);
        if (localStorage.getItem("orgii:chatPanelMaximized") === "false") {
          break;
        }
      }
      const finalLayout = store.get(workstationLayoutAtom);
      return {
        ok: true,
        activeTabId: finalLayout?.mainPane?.activeTabId ?? null,
        tabIds: finalLayout?.mainPane?.tabs.map((tabItem) => tabItem.id) ?? [],
        stationMode: store.get(stationModeAtom),
        pathname: window.location.pathname,
      };
    } catch (err) {
      return asError(err);
    }
  };

  const openOrgTab = async (
    orgId: string,
    displayName?: string
  ): Promise<{ ok: true } | Err> => {
    try {
      await router.navigate(buildAgentOrgsPath({ tab: "orgs" }));
      store.set(stationModeAtom, "my-station");
      store.set(chatPanelMaximizedAtom, false);
      store.set(activeStationChatVisibleAtom, "my-station", false);
      store.set(workStationEditorSecondaryCollapsedPersistAtom, false);
      store.set(editorPanelPositionPersistAtom, "bottom");
      const orgs = await rpc.agentOrgs.orgs.list();
      const orgSnapshot = orgs.find((org) => org.id === orgId);
      const tab = createAgentConfigTab({
        variant: "org",
        entityId: orgId,
        displayName: displayName ?? orgSnapshot?.name ?? orgId,
        entitySnapshot: orgSnapshot,
      });
      const workspace = store.get(presentedWorkstationWorkspaceKeyAtom);
      store.set(openWorkstationTabAtom, { workspace, tab });
      store.set(agentOrgsActiveTabAtom, "orgs");
      await router.navigate("/orgii/workstation/code");
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 50));
        store.set(chatPanelMaximizedAtom, false);
        store.set(activeStationChatVisibleAtom, "my-station", false);
        if (localStorage.getItem("orgii:chatPanelMaximized") === "false") {
          break;
        }
      }
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  const openChatPanelWorkItem = async (
    projectSlug: string,
    shortId: string
  ): Promise<{ ok: true } | Err> => {
    try {
      const projects = await projectApi.readProjects();
      const project = projects.find(
        (candidate) => candidate.slug === projectSlug
      );
      const enrichedItems = await projectApi.readWorkItemsEnriched(projectSlug);
      const workItem = enrichedItems.find((item) => item.shortId === shortId);
      if (!workItem) {
        return {
          ok: false,
          error: `openChatPanelWorkItem: Work Item not found ${projectSlug}/${shortId}`,
        };
      }
      store.set(stationModeAtom, "my-station");
      store.set(chatPanelMaximizedAtom, true);
      store.set(chatWidthAtom, 560);
      store.set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.NON_SESSION);
      store.set(chatPanelSelectedWorkItemAtom, {
        workItem: enrichedWorkItemToUI(workItem),
        projectId: project?.slug ?? projectSlug,
        projectName: project?.meta?.name ?? projectSlug,
        projectSlug,
        shortId,
      });
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  const inspectWorkstationSurface = async (): Promise<
    | {
        ok: true;
        pathname: string;
        stationMode: string;
        activeHost: string;
        activeTabId: string | null;
        activeTabType: string | null;
        activeTabCategory: string | null;
        selectedRepoId: string;
        selectedRepoPath: string | null;
        codeEditorPresent: boolean;
        agentConfigRootCount: number;
      }
    | Err
  > => {
    try {
      const activeTab = store.get(activeWorkStationTabAtom);
      const selectedRepoId = store.get(selectedRepoIdAtom);
      const selectedRepo = store
        .get(reposAtom)
        .find((repo) => repo.id === selectedRepoId);
      return {
        ok: true,
        pathname: window.location.pathname,
        stationMode: store.get(stationModeAtom),
        activeHost: store.get(activeHostAtom),
        activeTabId: activeTab?.id ?? null,
        activeTabType: activeTab?.type ?? null,
        activeTabCategory: activeTab?.category ?? null,
        selectedRepoId,
        selectedRepoPath: selectedRepo?.path ?? null,
        codeEditorPresent: Boolean(
          document.querySelector(".code-editor-right-panel")
        ),
        agentConfigRootCount: document.querySelectorAll(
          '[data-testid^="agent-config-tab-"]'
        ).length,
      };
    } catch (err) {
      return asError(err);
    }
  };

  const openAgentStationDiff = async (): Promise<{ ok: true } | Err> => {
    try {
      // Un-maximize the chat panel so ActivitySimulator is not suppressed
      // (AppShellContent only renders ActivitySimulator when !chatPanelFocused,
      // which requires chatPanelMaximized to be false).
      store.set(chatPanelMaximizedAtom, false);
      store.set(stationModeAtom, "agent-station");
      store.set(simulatorSelectedAppAtom, AppType.DIFF);
      store.set(replayModeAtom, "replay");
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  return {
    navigateTo,
    getLocationPathname,
    openWorkspaceWorkItemsTab,
    openProjectWorkItemsTab,
    openChatPanelWorkItem,
    openAgentTab,
    openOrgTab,
    inspectWorkstationSurface,
    openAgentStationDiff,
  };
}
