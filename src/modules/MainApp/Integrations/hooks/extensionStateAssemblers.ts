/**
 * Assembler functions that build detail-panel prop objects
 * from raw hook data. Extracted from useExtensionsState for size.
 */
import type { McpConfigScope } from "@src/api/tauri/rpc/schemas/mcp";
import type { useSkillEditor } from "@src/hooks/skills/useSkillEditor";
import type { useSkillsHub } from "@src/hooks/skills/useSkillsHub";
import type {
  McpResource,
  McpServerConfig,
  McpServerStatus,
  McpToolDef,
} from "@src/modules/MainApp/AgentOrgs/config/mcp/useMcpServers";
import type { useMcpServers } from "@src/modules/MainApp/AgentOrgs/config/mcp/useMcpServers";

import type { McpDetailState } from "../Mcp/types";
import type { SkillEditorState, SkillsHubDetailState } from "../Skills/types";

export interface SkillsHubAssemblerInput {
  skillsHubRaw: ReturnType<typeof useSkillsHub>;
  onUninstallSkill: (name: string) => Promise<void>;
}

export function assembleSkillsHub(
  input: SkillsHubAssemblerInput
): SkillsHubDetailState {
  const { skillsHubRaw, onUninstallSkill } = input;
  return {
    installedSkills: skillsHubRaw.installedSkills,
    installedLoading: skillsHubRaw.installedLoading,
    onToggleSkill: skillsHubRaw.toggleSkill,
    onUninstallSkill,
    onReadSkill: skillsHubRaw.readSkill,
    skillDetail: skillsHubRaw.skillDetail,
    detailLoading: skillsHubRaw.detailLoading,
    detailError: skillsHubRaw.detailError,
    onFetchDetail: skillsHubRaw.fetchDetail,
    onClearDetail: skillsHubRaw.clearDetail,
    updates: skillsHubRaw.updates,
    updatesLoading: skillsHubRaw.updatesLoading,
    onCheckUpdates: skillsHubRaw.checkUpdates,
    onUpdateSkill: skillsHubRaw.updateSkill,
    updatingSlug: skillsHubRaw.updating,
    onRefreshInstalled: skillsHubRaw.refreshInstalled,
  };
}

export interface SkillEditorAssemblerInput {
  editorMode: boolean;
  editor: ReturnType<typeof useSkillEditor>;
  onEditorBack: () => void;
  onEditorSaved: () => void;
  onCreateClick: () => void;
  onEditClick: (skillName: string) => void;
  importMode: boolean;
  onImportClick: () => void;
  onImportCancel: () => void;
  onImportRefresh: () => Promise<void>;
}

export function assembleSkillEditor(
  input: SkillEditorAssemblerInput
): SkillEditorState {
  return {
    editorMode: input.editorMode,
    editor: input.editor,
    onEditorBack: input.onEditorBack,
    onEditorSaved: input.onEditorSaved,
    onCreateClick: input.onCreateClick,
    onEditClick: input.onEditClick,
    importMode: input.importMode,
    onImportClick: input.onImportClick,
    onImportCancel: input.onImportCancel,
    onImportRefresh: input.onImportRefresh,
  };
}

export interface McpAssemblerInput {
  addMode: boolean;
  addScope: McpConfigScope;
  onAddClose: () => void;
  editName: string | null;
  editConfig: McpServerConfig | null;
  onSave: (
    name: string,
    config: McpServerConfig,
    scope: McpConfigScope
  ) => Promise<void>;
  mcpServers: ReturnType<typeof useMcpServers>;
  tools: McpToolDef[];
  toolsLoading: boolean;
  resources: McpResource[];
  resourcesLoading: boolean;
  onEdit: (name: string) => void;
  onDelete: (
    name: string,
    scope: McpServerStatus["scope"]
  ) => Promise<boolean> | boolean;
  onFetchTools: (name: string) => void;
  onFetchResources: (name: string) => void;
}

export function assembleMcp(input: McpAssemblerInput): McpDetailState {
  return {
    addMode: input.addMode,
    addScope: input.addScope,
    onAddClose: input.onAddClose,
    editName: input.editName,
    editConfig: input.editConfig,
    onSave: input.onSave,
    onTest: input.mcpServers.testServer,
    servers: input.mcpServers.servers,
    loading: input.mcpServers.loading,
    onRefresh: input.mcpServers.refresh,
    tools: input.tools,
    toolsLoading: input.toolsLoading,
    resources: input.resources,
    resourcesLoading: input.resourcesLoading,
    onReconnect: input.mcpServers.reconnect,
    onEdit: input.onEdit,
    onDelete: input.onDelete,
    onFetchTools: input.onFetchTools,
    onFetchResources: input.onFetchResources,
    onSetDisabled: input.mcpServers.setDisabled,
    onBulkSetDisabled: input.mcpServers.bulkSetDisabled,
    onBulkReconnect: input.mcpServers.bulkReconnect,
  };
}
