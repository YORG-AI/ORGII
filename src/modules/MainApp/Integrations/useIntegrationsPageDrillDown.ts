import type { TFunction } from "i18next";
import { useCallback, useMemo } from "react";

import type { ExternalSkillsetsTab } from "@src/config/mainAppPaths";

import type { useChannelState } from "./hooks/useChannelState";
import type { useConnectionsState } from "./hooks/useConnectionsState";
import type { useDatabasesState } from "./hooks/useDatabasesState";
import type { useExtensionsState } from "./hooks/useExtensionsState";
import type { useRoutinesState } from "./hooks/useRoutinesState";
import type { useRulesMemoryEvolutionState } from "./hooks/useRulesMemoryEvolutionState";
import {
  buildIntegrationsDrillDownItems,
  getIntegrationsDrillDownLoading,
  getIntegrationsDrillDownSelectedId,
  getIntegrationsDrillDownTitle,
} from "./integrationsDrillDownDerived";
import type { DrillDownItem } from "./shared/DrillDownListPanel";
import type { AddAction, IntegrationCategory } from "./types";

export interface UseIntegrationsPageDrillDownParams {
  category: IntegrationCategory;
  externalSkillsetsTab: ExternalSkillsetsTab;
  databasesState: ReturnType<typeof useDatabasesState>;
  extensions: ReturnType<typeof useExtensionsState>;
  policies: ReturnType<typeof useRulesMemoryEvolutionState>;
  routines: ReturnType<typeof useRoutinesState>;
  connections: ReturnType<typeof useConnectionsState>;
  channelState: ReturnType<typeof useChannelState>;
  tIntegrations: TFunction<"integrations">;
  handleAddAction: (action: AddAction) => void;
}

export interface UseIntegrationsPageDrillDownResult {
  drillDownItems: DrillDownItem[];
  handleDrillDownSelect: (id: string) => void;
  drillDownSelectedId: string | null;
  drillDownAddHandler: (() => void) | undefined;
  drillDownTitle: string;
  drillDownLoading: boolean;
}

export function useIntegrationsPageDrillDown(
  params: UseIntegrationsPageDrillDownParams
): UseIntegrationsPageDrillDownResult {
  const {
    category,
    externalSkillsetsTab,
    databasesState,
    extensions,
    policies,
    routines,
    connections,
    channelState,
    tIntegrations,
    handleAddAction,
  } = params;

  const drillDownItems = useMemo(
    () =>
      buildIntegrationsDrillDownItems({
        category,
        externalSkillsetsTab,
        databases: databasesState.databases,
        mcpServers: extensions.mcpServers.servers,
        markdownRules: policies.markdownRules,
        routines: routines.routines,
        projectConnections: channelState.projectConnections,
        groupedChannels: channelState.groupedChannels,
      }),
    [
      category,
      externalSkillsetsTab,
      databasesState.databases,
      extensions.mcpServers.servers,
      policies.markdownRules,
      routines.routines,
      channelState.projectConnections,
      channelState.groupedChannels,
    ]
  );

  const handleDrillDownSelect = useCallback(
    (id: string) => {
      switch (category) {
        case "databases":
          databasesState.handleSelectDatabase(id, "full");
          break;
        case "externalSkillsets":
          if (externalSkillsetsTab === "mcp") {
            extensions.handleExtensionSelect(id, "full");
          }
          break;
        case "rulesMemoryEvolution": {
          const name = id.includes(":") ? id.split(":").slice(1).join(":") : id;
          policies.handleSelectMarkdownRule(name, "full");
          break;
        }
        case "routines":
          routines.handleSelectRoutine(id, "full");
          break;
        case "git":
          connections.handleGitProviderSelect(id, "full");
          break;
        case "connections": {
          connections.handleChannelClick(id, "full");
          break;
        }
      }
    },
    [
      category,
      externalSkillsetsTab,
      databasesState,
      extensions,
      policies,
      routines,
      connections,
    ]
  );

  const drillDownSelectedId = useMemo(
    () =>
      getIntegrationsDrillDownSelectedId({
        category,
        externalSkillsetsTab,
        selectedDatabaseId: databasesState.selectedDatabase?.id,
        extensionSelectedId: extensions.extensionSelectedId,
        selectedMarkdownRule: policies.detailState.selectedMarkdownRule,
        selectedRoutineId: routines.routinesState.selectedRoutine?.id ?? null,
        selectedIntegrationKind: connections.selectedIntegrationKind,
        selectedGitProvider: connections.selectedGitProvider,
        selectedChannel: channelState.selectedChannel,
      }),
    [
      category,
      externalSkillsetsTab,
      databasesState.selectedDatabase,
      extensions.extensionSelectedId,
      policies.detailState.selectedMarkdownRule,
      routines.routinesState.selectedRoutine,
      connections.selectedIntegrationKind,
      connections.selectedGitProvider,
      channelState.selectedChannel,
    ]
  );

  const drillDownAddHandler = useMemo<(() => void) | undefined>(() => {
    switch (category) {
      case "databases":
        return databasesState.handleAddDatabase;
      case "tools":
      case "computerUse":
      case "myRoles":
      case "sessionMemoryEmbedding":
        return undefined;
      case "externalSkillsets": {
        if (externalSkillsetsTab === "mcp") {
          return extensions.triggerMcpAdd;
        }
        return extensions.triggerCreateSkill;
      }
      case "rulesMemoryEvolution":
        return policies.openNewPolicyWizard;
      case "routines":
        return routines.openNewRoutineWizard;
      case "connections":
        return () => handleAddAction("add-connection");
      case "git":
        return () => handleAddAction("add-git-connection");
      default:
        return undefined;
    }
  }, [
    category,
    externalSkillsetsTab,
    databasesState,
    extensions,
    policies,
    routines,
    handleAddAction,
  ]);

  const drillDownTitle = useMemo(
    () =>
      getIntegrationsDrillDownTitle(
        category,
        (key) => tIntegrations(key),
        externalSkillsetsTab
      ),
    [category, externalSkillsetsTab, tIntegrations]
  );

  const drillDownLoading = useMemo(
    () =>
      getIntegrationsDrillDownLoading({
        category,
        externalSkillsetsTab,
        databasesLoading: databasesState.loading,
        mcpLoading: extensions.mcpServers.loading,
        skillsInstalledLoading: extensions.skillsHubRaw.installedLoading,
        policiesMarkdownLoading: policies.policiesLoading,
        routinesLoading: routines.routinesLoading,
        channelStateLoaded: channelState.loaded,
      }),
    [
      category,
      externalSkillsetsTab,
      databasesState.loading,
      extensions,
      policies.policiesLoading,
      routines.routinesLoading,
      channelState.loaded,
    ]
  );

  return {
    drillDownItems,
    handleDrillDownSelect,
    drillDownSelectedId,
    drillDownAddHandler,
    drillDownTitle,
    drillDownLoading,
  };
}
