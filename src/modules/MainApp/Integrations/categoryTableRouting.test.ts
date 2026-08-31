import { PassThrough } from "node:stream";
import {
  type ComponentProps,
  type ComponentType,
  type ReactNode,
  createElement,
} from "react";
import { renderToPipeableStream } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectionsCategoryView } from "./Connections/ConnectionsCategoryView";
import { getConnectionsCategoryTableProps } from "./Connections/categoryTableProps";
import { DatabasesCategoryView } from "./Databases/DatabasesCategoryView";
import { getDatabasesCategoryTableProps } from "./Databases/categoryTableProps";
import { ExternalSkillsetsCategoryView } from "./ExternalSkillsets/ExternalSkillsetsCategoryView";
import { AccountCategoryView } from "./KeyVault/AccountCategoryView";
import { getAccountsCategoryTableProps } from "./KeyVault/categoryTableProps";
import { McpCategoryView } from "./Mcp/McpCategoryView";
import { getMcpCategoryTableProps } from "./Mcp/categoryTableProps";
import { RoutinesCategoryView } from "./Routines/RoutinesCategoryView";
import { getRoutinesCategoryTableProps } from "./Routines/categoryTableProps";
import { RulesMemoryEvolutionCategoryView } from "./RulesMemoryEvolution/RulesMemoryEvolutionCategoryView";
import { getRulesMemoryEvolutionCategoryTableProps } from "./RulesMemoryEvolution/categoryTableProps";
import { SkillsCategoryView } from "./Skills/SkillsCategoryView";
import { getSkillsCategoryTableProps } from "./Skills/categoryTableProps";

const { seen, leaf, repos, saveConnection, loadConnections, openFile } =
  vi.hoisted(() => {
    const seen = new Map<string, Record<string, unknown>>();
    return {
      seen,
      leaf: (name: string) => (props: Record<string, unknown>) => {
        seen.set(name, props);
        return null;
      },
      repos: [
        { name: "workspace", path: "/workspace" },
        { name: "unavailable", path: null },
      ],
      saveConnection: vi.fn(),
      loadConnections: vi.fn(() => [{ name: "existing" }]),
      openFile: vi.fn(),
    };
  });

vi.mock("jotai", () => ({ useAtomValue: () => repos }));
vi.mock("@src/store/repo", () => ({ reposAtom: {} }));
vi.mock("@src/store/workstation/database", () => ({
  addConnectionConfig: saveConnection,
  loadConnectionConfigs: loadConnections,
}));
vi.mock("@src/util/ui/openFileInWorkStation", () => ({
  openFileInWorkStation: openFile,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@src/modules/shared/layouts/blocks", () => ({
  DETAIL_PANEL_TOKENS: { headerWidth: "header-width" },
  DetailPanelContainer: ({ children }: { children: ReactNode }) => children,
  InternalHeader: leaf("header"),
}));
vi.mock("@src/components/TabPill", () => ({ default: leaf("tabs") }));
vi.mock("./KeyVault/Table/AccountsTable", () => ({
  AccountsTable: leaf("accounts"),
}));
vi.mock("./Connections/Table/ConnectionsTable", () => ({
  ConnectionsTable: leaf("connections"),
}));
vi.mock("./Databases/Table/DatabasesTable", () => ({
  DatabasesTable: leaf("databases"),
}));
vi.mock("./Mcp/Table/McpTable", () => ({ McpTable: leaf("mcp") }));
vi.mock("./Routines/Table/RoutinesTable", () => ({
  RoutinesTable: leaf("routines"),
}));
vi.mock("./RulesMemoryEvolution/Table/RulesMemoryEvolutionTable", () => ({
  RulesMemoryEvolutionTable: leaf("rules"),
}));
vi.mock("./Skills/Table/SkillsTable", () => ({ SkillsTable: leaf("skills") }));
vi.mock("@src/scaffold/WizardSystem/variants/KeyVault", () => ({
  KeyVaultWizard: leaf("accountWizard"),
}));
vi.mock(
  "@src/scaffold/WizardSystem/variants/Database/AddConnectionWizard",
  () => ({ default: leaf("databaseWizard") })
);
vi.mock("@src/scaffold/WizardSystem/variants/Mcp/McpAddWizard", () => ({
  default: leaf("mcpWizard"),
}));
vi.mock("@src/scaffold/WizardSystem/variants/Policy/RoutineWizard", () => ({
  default: leaf("routineWizard"),
}));
vi.mock("@src/scaffold/WizardSystem/variants/Policy/PolicyRuleWizard", () => ({
  default: leaf("ruleWizard"),
}));
vi.mock("@src/scaffold/WizardSystem/variants/Skill/SkillEditorPanel", () => ({
  default: leaf("skillEditor"),
}));
vi.mock("./Connections/Channels/ChannelPreviewPanel", () => ({
  default: leaf("channelPreview"),
}));
vi.mock("./Mcp/Detail/McpDetailView", () => ({
  McpDetailView: leaf("mcpDetail"),
}));
vi.mock("./RulesMemoryEvolution/Detail/MarkdownRuleDetailView", () => ({
  default: leaf("ruleDetail"),
}));
vi.mock("./ExternalSkillsets/CursorPluginsTab", () => ({
  default: leaf("plugins"),
}));

// Fixtures supply only fields read by the category boundary; the real table,
// wizard and persistence implementations are outside this refactor's scope.
function fixture<T>(value: Partial<T>): T {
  return value as T;
}

async function render<P extends object>(View: ComponentType<P>, props: P) {
  seen.clear();
  await new Promise<void>((resolve, reject) => {
    const sink = new PassThrough();
    sink.resume();
    sink.on("finish", resolve);
    const stream = renderToPipeableStream(createElement(View, props), {
      onAllReady: () => stream.pipe(sink),
      onError: reject,
    });
  });
}

const chrome = { fullPage: false, onBack: vi.fn(), onClosePreview: vi.fn() };

beforeEach(() => {
  seen.clear();
  vi.clearAllMocks();
});

describe("integration category table contracts", () => {
  it("keeps account rows, model tab precedence, CLI errors and account mutations", async () => {
    const accounts = fixture<
      Parameters<typeof getAccountsCategoryTableProps>[0]["accounts"]
    >({
      filteredAccounts: [],
      loading: true,
      showAddForm: false,
      handleEditAccountSave: vi.fn(),
      handleDisconnect: vi.fn(),
      handleRefreshAccount: vi.fn(),
      handleRefreshAllModels: vi.fn(),
      handleRefreshAccountUsage: vi.fn(),
      refresh: vi.fn(),
      refreshingAccountId: "account",
      refreshingAllModels: true,
    });
    const cliAgents = fixture<
      Parameters<typeof getAccountsCategoryTableProps>[0]["cliAgents"]
    >({
      agents: [],
      loading: true,
      error: "unavailable",
      actionMap: {},
      fetchAgents: vi.fn(),
      handleInstall: vi.fn(),
      handleUninstall: vi.fn(),
      handleDetect: vi.fn(),
    });
    const onAddAction = vi.fn();
    const onSelect = vi.fn();
    const params = {
      accounts,
      onSelect,
      models: { modelsActiveTab: "models", handleToggleModel: vi.fn() },
      onModelsTabChange: vi.fn(),
      cliAgents,
      onAddAction,
    };
    expect(getAccountsCategoryTableProps(params).modelsActiveTab).toBe(
      "models"
    );
    const table = getAccountsCategoryTableProps({
      ...params,
      modelsActiveTab: "accounts",
    });
    await render(AccountCategoryView, {
      ...chrome,
      accounts,
      tableProps: table,
    });
    expect(seen.get("accounts")).toEqual(table);
    expect(table.modelsActiveTab).toBe("accounts");
    expect(table.cliAgents).toEqual(cliAgents);
    expect(table.onEditAccountSave).toBe(accounts.handleEditAccountSave);
    expect(table.onDisconnectAccount).toBe(accounts.handleDisconnect);
    expect(table.onRevalidateAccount).toBe(accounts.handleRefreshAccount);
    expect(table.onRefresh).toBe(accounts.refresh);
    table.onSelect("account", "full");
    expect(onSelect).toHaveBeenCalledWith("account", "full");
    table.onAdd();
    expect(onAddAction).toHaveBeenCalledWith("add-model");
  });

  it("keeps account login wizard priority and every form input", async () => {
    type Props = ComponentProps<typeof AccountCategoryView>;
    const accounts = fixture<Props["accounts"]>({
      showAddForm: true,
      formLoading: true,
      formInitialAgentType: "codex",
      autoStartCodexLogin: true,
      formExistingAccountNames: ["existing"],
      handleFormSubmit: vi.fn(),
      handleFormCancel: vi.fn(),
    });
    await render(AccountCategoryView, {
      ...chrome,
      fullPage: true,
      accounts,
      tableProps: fixture<Props["tableProps"]>({}),
    });
    expect([...seen.keys()]).toEqual(["accountWizard"]);
    expect(seen.get("accountWizard")).toEqual({
      onSubmit: accounts.handleFormSubmit,
      onCancel: accounts.handleFormCancel,
      loading: true,
      initialAgentType: "codex",
      initialData: undefined,
      autoStartCodexLogin: true,
      existingAccountNames: ["existing"],
    });
  });

  it.each([
    [false, false, true],
    [true, true, true],
    [true, false, false],
  ])(
    "keeps connection loading and row selection (%s, %s)",
    async (loaded, projectConnectionsLoading, loading) => {
      type Params = Parameters<typeof getConnectionsCategoryTableProps>[0];
      const channels = fixture<Params["channels"]>({
        groupedChannels: new Map(),
        projectConnections: [],
        loaded,
        projectConnectionsLoading,
        channelWizardMode: false,
        selectedChannel: { type: "telegram", accountId: "bot" },
        handleRemoveChannelRow: vi.fn(),
        handleRemoveProjectConnection: vi.fn(),
      });
      const onAddAction = vi.fn();
      const onSelectChannel = vi.fn();
      const table = getConnectionsCategoryTableProps({
        channels,
        onSelectChannel,
        onAddAction,
      });
      await render(ConnectionsCategoryView, {
        ...chrome,
        channel: channels,
        selectedIntegrationKind: "channel",
        selectedGitProvider: null,
        tableProps: table,
      });
      expect(seen.get("connections")).toEqual({
        ...table,
        selectedRowId: "telegram:bot",
      });
      expect(table.loading).toBe(loading);
      expect(table.onRemoveChannel).toBe(channels.handleRemoveChannelRow);
      expect(table.onRemoveProjectConnection).toBe(
        channels.handleRemoveProjectConnection
      );
      table.onSelectChannel("telegram:bot", "full");
      expect(onSelectChannel).toHaveBeenCalledWith("telegram:bot", "full");
      table.onAdd();
      expect(onAddAction).toHaveBeenCalledWith("add-connection");
    }
  );

  it("keeps connection wizard priority, preview close behavior and Git row identity", async () => {
    type Props = ComponentProps<typeof ConnectionsCategoryView>;
    const base: Props = {
      ...chrome,
      selectedIntegrationKind: "git",
      selectedGitProvider: "github",
      channel: fixture<Props["channel"]>({ channelWizardMode: true }),
      tableProps: fixture<Props["tableProps"]>({}),
      onGitConnected: vi.fn(),
    };
    await render(ConnectionsCategoryView, { ...base, fullPage: true });
    expect([...seen.keys()]).toEqual(["channelPreview"]);
    expect(seen.get("channelPreview")).toEqual({
      channel: base.channel,
      onGitConnected: base.onGitConnected,
      onClose: chrome.onClosePreview,
    });
    base.channel.channelWizardMode = false;
    await render(ConnectionsCategoryView, base);
    expect(seen.get("connections")?.selectedRowId).toBe("git:github");
    await render(ConnectionsCategoryView, {
      ...base,
      fullPage: true,
      selectedIntegrationKind: "channel",
    });
    expect(seen.get("channelPreview")?.onClose).toBe(chrome.onBack);
  });

  it("requires database actions and preserves probe state and client selection", async () => {
    type Params = Parameters<typeof getDatabasesCategoryTableProps>[0];
    const databases = fixture<Params["databases"]>({
      databases: [],
      loading: true,
      handleSelectDatabase: vi.fn(),
      handleAddDatabase: vi.fn(),
      refreshDatabases: vi.fn(),
    });
    const table = getDatabasesCategoryTableProps({
      databases,
      activeTab: "clients",
      onActiveTabChange: vi.fn(),
      selectedDbClient: null,
      onSelectDbClient: vi.fn(),
    });
    type Props = ComponentProps<typeof DatabasesCategoryView>;
    const props: Props = {
      tableProps: table,
      selectedDatabase: fixture<NonNullable<Props["selectedDatabase"]>>({
        id: "db",
      }),
      probeResult: fixture<NonNullable<Props["probeResult"]>>({}),
      probing: true,
      onProbe: vi.fn(),
      onRemove: vi.fn(),
      addWizardOpen: false,
      onCloseAddWizard: vi.fn(),
    };
    await render(DatabasesCategoryView, props);
    expect(seen.get("databases")).toEqual({
      ...table,
      selectedRowId: "db",
      onProbe: props.onProbe,
      onRemove: props.onRemove,
      probeResult: props.probeResult,
      probing: true,
    });
    expect(table.onSelect).toBe(databases.handleSelectDatabase);
    expect(table.onAdd).toBe(databases.handleAddDatabase);
    expect(table.onRefresh).toBe(databases.refreshDatabases);
    await render(DatabasesCategoryView, { ...props, addWizardOpen: true });
    expect([...seen.keys()]).toEqual(["databaseWizard"]);
    expect(seen.get("databaseWizard")?.existingConnectionNames).toEqual([
      "existing",
    ]);
    const config = { name: "new connection" };
    (seen.get("databaseWizard")?.onSave as (config: unknown) => void)(config);
    expect(saveConnection).toHaveBeenCalledWith(config);
    expect(props.onCloseAddWizard).toHaveBeenCalledOnce();
    expect(saveConnection.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(props.onCloseAddWizard).mock.invocationCallOrder[0]
    );
  });

  it("keeps MCP tools, resources, scoped add and bulk action callbacks", async () => {
    type Props = ComponentProps<typeof McpCategoryView>;
    const mcp = fixture<Props["mcp"]>({
      addMode: false,
      tools: [],
      resources: [],
      onFetchTools: vi.fn(),
      onRefresh: vi.fn(),
      onDelete: vi.fn(),
      onReconnect: vi.fn(),
      onSetDisabled: vi.fn(),
      onBulkSetDisabled: vi.fn(),
      onBulkReconnect: vi.fn(),
    });
    const triggerMcpAdd = vi.fn();
    const extensions = fixture<
      Parameters<typeof getMcpCategoryTableProps>[0]["extensions"]
    >({
      mcp,
      mcpServers: fixture<
        Parameters<
          typeof getMcpCategoryTableProps
        >[0]["extensions"]["mcpServers"]
      >({ servers: [], loading: true }),
      handleExtensionSelect: vi.fn(),
      triggerMcpAdd,
    });
    const table = getMcpCategoryTableProps({ extensions });
    await render(McpCategoryView, {
      ...chrome,
      selectedId: "server",
      mcp,
      tableProps: table,
    });
    expect(seen.get("mcp")).toEqual({
      ...table,
      tools: mcp.tools,
      resources: mcp.resources,
      onFetchTools: mcp.onFetchTools,
      cursorRepos: [{ name: "workspace", path: "/workspace" }],
      onAfterImport: mcp.onRefresh,
      selectedRowId: "server",
      embedded: false,
    });
    expect(table.onDelete).toBe(mcp.onDelete);
    expect(table.onBulkSetDisabled).toBe(mcp.onBulkSetDisabled);
    expect(table.onBulkReconnect).toBe(mcp.onBulkReconnect);
    table.onAdd("workspace");
    expect(triggerMcpAdd).toHaveBeenCalledWith("workspace");
  });

  it("keeps MCP add/edit wizard ahead of full detail, then list without selection", async () => {
    type Props = ComponentProps<typeof McpCategoryView>;
    const mcp = fixture<Props["mcp"]>({
      addMode: true,
      addScope: "workspace",
      editName: null,
      editConfig: null,
      onSave: vi.fn(),
      onTest: vi.fn(),
      onAddClose: vi.fn(),
    });
    const props: Props = {
      ...chrome,
      fullPage: true,
      selectedId: "server",
      mcp,
      tableProps: fixture<Props["tableProps"]>({}),
    };
    await render(McpCategoryView, props);
    expect([...seen.keys()]).toEqual(["mcpWizard"]);
    expect(seen.get("mcpWizard")).toEqual({
      onSave: mcp.onSave,
      onTest: mcp.onTest,
      onCancel: mcp.onAddClose,
      editName: undefined,
      editConfig: undefined,
      initialScope: "workspace",
    });
    await render(McpCategoryView, {
      ...props,
      mcp: { ...mcp, editName: "edit" },
    });
    expect(seen.get("mcpWizard")?.initialScope).toBeUndefined();
    await render(McpCategoryView, {
      ...props,
      mcp: { ...mcp, addMode: false },
    });
    expect([...seen.keys()]).toEqual(["mcpDetail"]);
    await render(McpCategoryView, {
      ...props,
      selectedId: null,
      mcp: { ...mcp, addMode: false },
    });
    expect([...seen.keys()]).toEqual(["mcp"]);
    expect(seen.get("mcp")).toMatchObject({
      tools: [],
      resources: [],
      embedded: false,
    });
  });

  it("keeps skills embedded chrome, import, refresh and detail callback precedence", async () => {
    type Props = ComponentProps<typeof SkillsCategoryView>;
    const skillsHub = fixture<Props["skillsHub"]>({
      skillDetail: null,
      onToggleSkill: vi.fn(),
      onUninstallSkill: vi.fn(),
    });
    const skillEditor = fixture<Props["skillEditor"]>({
      editorMode: false,
      importMode: true,
      onImportCancel: vi.fn(),
      onImportRefresh: vi.fn(),
      onEditClick: vi.fn(),
    });
    const onAddAction = vi.fn();
    const extensions = fixture<
      Parameters<typeof getSkillsCategoryTableProps>[0]["extensions"]
    >({
      skillsHubRaw: fixture<
        Parameters<
          typeof getSkillsCategoryTableProps
        >[0]["extensions"]["skillsHubRaw"]
      >({ installedSkills: [], installedLoading: true }),
      skillsHub: { ...skillsHub, onRefreshInstalled: vi.fn() },
      handleExtensionSelect: vi.fn(),
    });
    const table = getSkillsCategoryTableProps({ extensions, onAddAction });
    await render(SkillsCategoryView, {
      ...chrome,
      selectedId: "skill",
      skillsHub,
      skillEditor,
      tableProps: table,
    });
    expect(seen.get("skills")).toEqual({
      ...table,
      selectedRowId: "skill",
      embedded: true,
      hubDetail: null,
      onToggleSkill: skillsHub.onToggleSkill,
      onUninstallSkill: skillsHub.onUninstallSkill,
      cursorRepos: [{ name: "workspace", path: "/workspace" }],
      importExpanded: true,
      onImportCompleted: skillEditor.onImportCancel,
      onAfterImport: skillEditor.onImportRefresh,
    });
    expect(seen.get("skills")).not.toHaveProperty("onEditSkill");
    expect(seen.get("skills")).not.toHaveProperty("onCloseSkillPreview");
    expect(table.onRefreshSkills).toBe(extensions.skillsHub.onRefreshInstalled);
    table.onCreate();
    expect(onAddAction).toHaveBeenCalledWith("create-skill");
    await render(SkillsCategoryView, {
      ...chrome,
      selectedId: "skill",
      skillsHub,
      skillEditor: { ...skillEditor, editorMode: true },
      tableProps: table,
    });
    expect([...seen.keys()]).toEqual(["skillEditor"]);
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
  ])(
    "keeps rule loading, namespaced selection and full-page editor action (%s, %s)",
    async (policiesLoading, allRepoPoliciesLoading) => {
      type Props = ComponentProps<typeof RulesMemoryEvolutionCategoryView>;
      const rule = fixture<
        NonNullable<Props["policies"]["selectedMarkdownRule"]>
      >({ name: "rule", source: "workspace", path: "/workspace/rule.md" });
      const policies = fixture<Props["policies"]>({
        selectedMarkdownRule: rule,
        cursorRepos: [],
        wizardMode: false,
        onAfterImport: vi.fn(),
      });
      const state = fixture<
        Parameters<
          typeof getRulesMemoryEvolutionCategoryTableProps
        >[0]["policies"]
      >({
        markdownRules: [rule],
        policiesLoading,
        allRepoPoliciesLoading,
        handleSelectMarkdownRule: vi.fn(),
        handleDeleteMarkdownRuleForRow: vi.fn(),
        handleToggleMarkdownRuleForRow: vi.fn(),
      });
      const onAddAction = vi.fn();
      const table = getRulesMemoryEvolutionCategoryTableProps({
        policies: state,
        onAddAction,
      });
      await render(RulesMemoryEvolutionCategoryView, {
        ...chrome,
        policies,
        tableProps: table,
      });
      expect(seen.get("rules")).toEqual({
        ...table,
        selectedRowId: "workspace:rule",
        cursorRepos: policies.cursorRepos,
        onAfterImport: policies.onAfterImport,
      });
      expect(table.loading).toBe(policiesLoading || allRepoPoliciesLoading);
      expect(table.onDeleteMarkdownRule).toBe(
        state.handleDeleteMarkdownRuleForRow
      );
      expect(table.onToggleMarkdownRule).toBe(
        state.handleToggleMarkdownRuleForRow
      );
      table.onAdd();
      expect(onAddAction).toHaveBeenCalledWith("add-rule");
      await render(RulesMemoryEvolutionCategoryView, {
        ...chrome,
        fullPage: true,
        policies,
        tableProps: table,
      });
      (seen.get("ruleDetail")?.onEdit as () => void)();
      expect(openFile).toHaveBeenCalledWith("/workspace/rule.md", {
        defaultPreviewMode: true,
      });
      await render(RulesMemoryEvolutionCategoryView, {
        ...chrome,
        fullPage: true,
        policies: { ...policies, wizardMode: true },
        tableProps: table,
      });
      expect([...seen.keys()]).toEqual(["ruleWizard"]);
    }
  );

  it("keeps routines loading independent of policies, selected actions and wizard priority", async () => {
    type Props = ComponentProps<typeof RoutinesCategoryView>;
    const selectedRoutine = fixture<
      NonNullable<Props["routines"]["selectedRoutine"]>
    >({ id: "routine" });
    const routines = fixture<Props["routines"]>({
      selectedRoutine,
      wizardMode: false,
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onToggleEnabled: vi.fn(),
      onFire: vi.fn(),
    });
    const state = fixture<
      Parameters<typeof getRoutinesCategoryTableProps>[0]["routines"]
    >({
      routines: [selectedRoutine],
      routinesLoading: true,
      handleSelectRoutine: vi.fn(),
    });
    const onAddAction = vi.fn();
    const table = getRoutinesCategoryTableProps({
      routines: state,
      onAddAction,
    });
    await render(RoutinesCategoryView, {
      ...chrome,
      routines,
      tableProps: table,
    });
    expect(seen.get("routines")).toEqual({
      ...table,
      selectedRowId: "routine",
      onEdit: routines.onEdit,
      onDelete: routines.onDelete,
      onToggleEnabled: routines.onToggleEnabled,
      onFire: routines.onFire,
    });
    expect(table.loading).toBe(true);
    table.onAdd();
    expect(onAddAction).toHaveBeenCalledWith("add-routine");
    await render(RoutinesCategoryView, {
      ...chrome,
      fullPage: true,
      routines: { ...routines, wizardMode: true },
      tableProps: table,
    });
    expect([...seen.keys()]).toEqual(["routineWizard"]);
  });

  it.each(["skills", "mcp", "cursor-plugins"] as const)(
    "keeps external skillset tab routing and chrome for %s",
    async (activeTab) => {
      type Props = ComponentProps<typeof ExternalSkillsetsCategoryView>;
      const props: Props = {
        ...chrome,
        activeTab,
        onTabChange: vi.fn(),
        selectedExtensionId: null,
        onEnterFullPage: vi.fn(),
        mcp: fixture<Props["mcp"]>({
          addMode: false,
          tools: [],
          resources: [],
        }),
        skillsHub: fixture<Props["skillsHub"]>({}),
        skillEditor: fixture<Props["skillEditor"]>({ editorMode: false }),
        mcpTableProps: fixture<Props["mcpTableProps"]>({}),
        skillsTableProps: fixture<Props["skillsTableProps"]>({}),
      };
      await render(ExternalSkillsetsCategoryView, props);
      expect(seen.has("header")).toBe(true);
      expect(
        seen.has(activeTab === "cursor-plugins" ? "plugins" : activeTab)
      ).toBe(true);
      if (activeTab !== "cursor-plugins")
        expect(seen.get(activeTab)?.embedded).toBe(true);
      await render(ExternalSkillsetsCategoryView, {
        ...props,
        mcp: { ...props.mcp, addMode: true },
      });
      expect(seen.has("header")).toBe(false);
    }
  );
});
