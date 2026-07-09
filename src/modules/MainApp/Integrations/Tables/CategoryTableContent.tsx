import React from "react";

import type { SyncConnection } from "@src/api/http/integrations";
import type { RoutineDefinition } from "@src/api/http/project";
import type { McpConfigScope } from "@src/api/tauri/rpc/schemas/mcp";
import type { AvailableAgent } from "@src/config/cliAgents";
import type { DependencyStatus } from "@src/hooks/dependencies";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import type { CursorRepo, PolicyInfo } from "@src/hooks/policies";
import type {
  McpResource,
  McpServerStatus,
  McpToolDef,
} from "@src/modules/MainApp/AgentOrgs/config/mcp/useMcpServers";
import type { HubSkillDetail, InstalledSkill } from "@src/types/extensions";

import type { ChannelInstance } from "../Connections/Channels";
import { ConnectionsTable } from "../Connections/Table/ConnectionsTable";
import { DatabasesTable } from "../Databases/Table/DatabasesTable";
import type {
  DatabaseIntegrationEntry,
  DatabaseProbeResult,
} from "../Databases/types";
import { GitTable } from "../Git/Table/GitTable";
import { AccountsTable } from "../KeyVault/Table/AccountsTable";
import { McpTable } from "../Mcp/Table/McpTable";
import { RoutinesTable } from "../Routines/Table/RoutinesTable";
import { RulesMemoryEvolutionTable } from "../RulesMemoryEvolution/Table/RulesMemoryEvolutionTable";
import { SkillsTable } from "../Skills/Table/SkillsTable";
import type { AddAction, DetailMode, SplitViewTableCategory } from "../types";

export interface CategoryTableContentProps {
  category: SplitViewTableCategory;

  /** When true, MCP and Skills tables omit duplicate panel header / + button (Tools hub provides them). */
  extensionTablesEmbeddedChrome?: boolean;

  /** Row key of the currently-selected item (applies highlight in the active table). */
  selectedRowId?: string | null;

  accounts: KeyVaultAccount[];
  accountsLoading: boolean;
  onSelectAccount: (id: string | null, mode?: DetailMode) => void;
  onRefreshAccounts?: () => Promise<void>;
  onRefreshAccountUsage?: (accountId: string) => Promise<void>;
  onEditAccount?: (accountId: string) => void;
  onEditAccountSave?: (
    accountId: string,
    name: string,
    description: string
  ) => Promise<void>;
  onDisconnectAccount?: (
    accountId: string,
    deleteType?: "local" | "cloud"
  ) => void;
  onRevalidateAccount?: (accountId: string) => Promise<void>;
  refreshingAccountId?: string | null;
  modelsActiveTab?: string;
  onModelsTabChange?: (tab: string) => void;
  onToggleModel?: (
    model: string,
    agentType: string,
    enabled: boolean
  ) => void | Promise<void>;

  databases?: DatabaseIntegrationEntry[];
  databasesLoading?: boolean;
  onSelectDatabase?: (id: string | null) => void;
  onAddDatabase?: () => void;
  onRefreshDatabases?: () => Promise<void>;
  databasesActiveTab?: string;
  onDatabasesActiveTabChange?: (tab: string) => void;
  selectedDbClient?: DependencyStatus | null;
  onSelectDbClient?: (client: DependencyStatus | null) => void;
  onDbProbe?: () => void;
  onDbRemove?: () => void;
  dbProbeResult?: DatabaseProbeResult | null;
  dbProbing?: boolean;

  groupedChannels: Map<string, ChannelInstance[]>;
  projectConnections: SyncConnection[];
  connectionsLoading: boolean;
  onSelectGitProvider: (id: string | null, mode?: DetailMode) => void;
  onSelectChannel: (compositeId: string | null, mode?: DetailMode) => void;
  /** Trash-icon handler for a channel row. */
  onRemoveChannel?: (channelType: string, accountId: string) => Promise<void>;
  /** Trash-icon handler for a project sync (Linear / GitHub) row. */
  onRemoveProjectConnection?: (
    connectionId: string,
    label: string
  ) => Promise<void>;

  mcpServers: McpServerStatus[];
  mcpTools?: McpToolDef[];
  mcpResources?: McpResource[];
  mcpLoading: boolean;
  onSelectMcp: (name: string, mode?: DetailMode) => void;
  /** Row-level actions for the MCP table. Optional because the embedded
   * Agent-config variant uses a different UI surface. */
  onMcpAdd?: (scope: McpConfigScope) => void;
  onMcpDelete?: (
    name: string,
    scope: McpServerStatus["scope"]
  ) => Promise<boolean> | boolean;
  onMcpReconnect?: (name: string) => Promise<void> | void;
  onMcpFetchTools?: (name: string) => void;
  onMcpSetDisabled?: (name: string, disabled: boolean) => Promise<void> | void;
  onMcpBulkSetDisabled?: (
    names: string[],
    disabled: boolean
  ) => Promise<Record<string, string | null>>;
  onMcpBulkReconnect?: (
    names: string[]
  ) => Promise<Record<string, string | null>>;
  mcpCursorRepos?: CursorRepo[];
  onMcpAfterImport?: () => void | Promise<void>;

  installedSkills: InstalledSkill[];
  skillsLoading: boolean;
  onSelectSkill: (name: string, mode?: DetailMode) => void;
  skillsHubDetail?: HubSkillDetail | null;
  onToggleSkill?: (name: string, enabled: boolean) => void;
  onEditSkill?: (name: string) => void;
  onUninstallSkill?: (name: string) => Promise<void> | void;
  onRefreshSkills?: (
    workspacePaths?: string[],
    options?: { scoped?: boolean }
  ) => Promise<void> | void;
  skillsCursorRepos?: CursorRepo[];
  skillsImportExpanded?: boolean;
  onSkillsImportCompleted?: () => void;
  onSkillsAfterImport?: () => void | Promise<void>;
  onCloseSkillPreview?: () => void;

  markdownRules: PolicyInfo[];
  routines: RoutineDefinition[];
  policiesLoading: boolean;
  onSelectMarkdownRule: (name: string | null, mode?: DetailMode) => void;
  onDeleteMarkdownRule?: (rule: PolicyInfo) => void;
  onToggleMarkdownRule?: (rule: PolicyInfo, enabled: boolean) => void;
  rulesCursorRepos?: CursorRepo[];
  onRulesAfterImport?: () => void | Promise<void>;
  onSelectRoutine: (id: string | null, mode?: DetailMode) => void;
  onRoutineEdit?: () => void;
  onRoutineDelete?: () => void;
  onRoutineToggleEnabled?: (enabled: boolean) => void;
  onRoutineFire?: () => void;

  cliAgents?: {
    agents: AvailableAgent[];
    loading: boolean;
    error: string | null;
    actionMap: Record<string, "installing" | "detecting" | null>;
    fetchAgents: () => Promise<void>;
    handleInstall: (agentName: string, installCmd?: string) => Promise<void>;
    handleUninstall: (
      agentName: string,
      uninstallCmd?: string
    ) => Promise<void>;
    handleDetect: (agentName: string) => Promise<void>;
  };

  onAddAction: (action: AddAction) => void;
}

export const CategoryTableContent: React.FC<CategoryTableContentProps> = (
  props
) => {
  const { category, onAddAction } = props;
  const extensionEmbedded = props.extensionTablesEmbeddedChrome ?? false;

  switch (category) {
    case "models":
      return (
        <AccountsTable
          accounts={props.accounts}
          loading={props.accountsLoading}
          onSelect={props.onSelectAccount}
          onAdd={() => onAddAction("add-model")}
          onRefresh={props.onRefreshAccounts}
          onRefreshAccountUsage={props.onRefreshAccountUsage}
          onEditAccount={props.onEditAccount}
          onEditAccountSave={props.onEditAccountSave}
          onDisconnectAccount={props.onDisconnectAccount}
          onRevalidateAccount={props.onRevalidateAccount}
          refreshingAccountId={props.refreshingAccountId}
          selectedRowId={props.selectedRowId}
          modelsActiveTab={props.modelsActiveTab}
          onModelsTabChange={props.onModelsTabChange}
          onToggleModel={props.onToggleModel}
          cliAgents={props.cliAgents}
        />
      );
    case "databases":
      return (
        <DatabasesTable
          databases={props.databases ?? []}
          loading={props.databasesLoading ?? false}
          selectedRowId={props.selectedRowId}
          onSelect={props.onSelectDatabase ?? (() => {})}
          onAdd={props.onAddDatabase ?? (() => onAddAction("add-database"))}
          onRefresh={props.onRefreshDatabases}
          activeTab={props.databasesActiveTab}
          onActiveTabChange={props.onDatabasesActiveTabChange}
          selectedDbClient={props.selectedDbClient}
          onSelectDbClient={props.onSelectDbClient}
          onProbe={props.onDbProbe}
          onRemove={props.onDbRemove}
          probeResult={props.dbProbeResult}
          probing={props.dbProbing}
        />
      );
    case "connections":
      return (
        <ConnectionsTable
          groupedChannels={props.groupedChannels}
          projectConnections={props.projectConnections}
          loading={props.connectionsLoading}
          selectedRowId={props.selectedRowId}
          onSelectChannel={props.onSelectChannel}
          onAdd={() => onAddAction("add-connection")}
          onRemoveChannel={props.onRemoveChannel}
          onRemoveProjectConnection={props.onRemoveProjectConnection}
        />
      );
    case "git":
      return (
        <GitTable
          selectedRowId={props.selectedRowId}
          onSelectProvider={props.onSelectGitProvider}
        />
      );
    case "mcp":
      return (
        <McpTable
          servers={props.mcpServers}
          tools={props.mcpTools ?? []}
          resources={props.mcpResources ?? []}
          loading={props.mcpLoading}
          selectedRowId={props.selectedRowId}
          onSelect={props.onSelectMcp}
          onAdd={(scope) =>
            props.onMcpAdd ? props.onMcpAdd(scope) : onAddAction("add-mcp")
          }
          onDelete={props.onMcpDelete}
          onReconnect={props.onMcpReconnect}
          onFetchTools={props.onMcpFetchTools}
          onSetDisabled={props.onMcpSetDisabled}
          onBulkSetDisabled={props.onMcpBulkSetDisabled}
          onBulkReconnect={props.onMcpBulkReconnect}
          cursorRepos={props.mcpCursorRepos}
          onAfterImport={props.onMcpAfterImport}
          embedded={extensionEmbedded}
        />
      );
    case "skills":
      return (
        <SkillsTable
          skills={props.installedSkills}
          loading={props.skillsLoading}
          selectedRowId={props.selectedRowId}
          onSelect={props.onSelectSkill}
          onCreate={() => onAddAction("create-skill")}
          embedded={extensionEmbedded}
          hubDetail={props.skillsHubDetail}
          onToggleSkill={props.onToggleSkill}
          onUninstallSkill={props.onUninstallSkill}
          onRefreshSkills={props.onRefreshSkills}
          cursorRepos={props.skillsCursorRepos}
          importExpanded={props.skillsImportExpanded}
          onImportCompleted={props.onSkillsImportCompleted}
          onAfterImport={props.onSkillsAfterImport}
        />
      );
    case "rulesMemoryEvolution":
      return (
        <RulesMemoryEvolutionTable
          markdownRules={props.markdownRules}
          loading={props.policiesLoading}
          selectedRowId={props.selectedRowId}
          onSelectMarkdownRule={props.onSelectMarkdownRule}
          onDeleteMarkdownRule={props.onDeleteMarkdownRule}
          onToggleMarkdownRule={props.onToggleMarkdownRule}
          onAdd={() => onAddAction("add-rule")}
          cursorRepos={props.rulesCursorRepos}
          onAfterImport={props.onRulesAfterImport}
        />
      );
    case "routines":
      return (
        <RoutinesTable
          routines={props.routines}
          loading={props.policiesLoading}
          selectedRowId={props.selectedRowId}
          onSelectRoutine={props.onSelectRoutine}
          onAdd={() => onAddAction("add-routine")}
          onEdit={props.onRoutineEdit}
          onDelete={props.onRoutineDelete}
          onToggleEnabled={props.onRoutineToggleEnabled}
          onFire={props.onRoutineFire}
        />
      );
    case "tools":
    case "computerUse":
    case "myRoles":
    case "housekeeper":
    case "devtools":
      return null;
  }
};
