/**
 * E2EBootstrap
 *
 * Dev-only helper that exposes Tauri commands to WebDriver-driven tests.
 * Mounted at app root; renders nothing; no-op until a spec calls into it.
 *
 * Public API on `window.__e2e`:
 *
 *   addAccount({ openaiApiKey, model, baseUrl?, accountName? })
 *     → creates (or updates) an `openai_api` BYOK account via `save_key` with
 *       `enabled_models`/`available_models` pre-populated so downstream
 *       validation (`isPairCompatible`) accepts the pair. Returns the masked
 *       KeyInfo.
 *
 *   listAccounts()
 *     → passthrough to `list_keys`. Useful for add-account spec assertions.
 *
 *   removeAccount(id)
 *     → passthrough to `delete_key_by_id`. Used to keep CI idempotent.
 *
 *   pinSession({ accountId, model, accountName?, category?, cliAgentType? })
 *     → sets `sessionCreatorStateAtom`, picks a repo (waits up to 15s for
 *       `reposAtom` to populate), and writes `creatorDefaultModelSelectionAtom`.
 *       Returns the chosen repo id.
 *
 *   configure({ openaiApiKey, model, ... })
 *     → convenience: addAccount then pinSession. Used by agent-chat spec.
 *
 *   configureWithExistingKey({ accountName, model?, baseUrl?, agentType? })
 *     → reuses a key already present in the user's keyvault (typed via the
 *       app UI — no `OPENAI_API_KEY` in `.env` needed). Locates the account
 *       by `agent_type` + `name`, picks a model that is `enabled` on it
 *       (preferring `model` if requested), then pins the session. Returns
 *       the chosen `accountId` / `modelId` / `repoId`.
 *
 * All methods return `{ ok: true, ... } | { ok: false, error }` so failures
 * surface with a structured message instead of rejecting.
 */
import { useStore } from "jotai";
import { type FC, useEffect } from "react";

import { INTERNAL_AGENT_IDS } from "@src/modules/MainApp/AgentOrgs/config/agentConstants";
import {
  agentDefsLoadErrorAtom,
  agentDefsLoadedAtom,
  allAgentDefsAtom,
  builtInAgentsAtom,
  customAgentsAtom,
} from "@src/modules/MainApp/AgentOrgs/store/builtInAgentsAtom";
import type { AgentDefinition } from "@src/modules/MainApp/AgentOrgs/types";

import {
  addAccount,
  addClaudeCodeAccount,
  addCodexAccount,
  addCursorNativeAccount,
  autoDetectKeyForE2E,
  cloneCursorNativeAccountWithoutApiKey,
  inspectProviderMatrix,
  listAccounts,
  removeAccount,
} from "./e2e/helpers/accounts";
import { createAgentOrgHelpers } from "./e2e/helpers/agentOrgs";
import { createBenchmarkE2EHelpers } from "./e2e/helpers/benchmark";
import { createCloudHelpers } from "./e2e/helpers/cloud";
import { createConfigHelpers } from "./e2e/helpers/config";
import { createDebugEndpointHelpers } from "./e2e/helpers/debugEndpoints";
import { createExternalToolHelpers } from "./e2e/helpers/externalTools";
import { createMcpHelpers } from "./e2e/helpers/mcp";
import { createMemoryHelpers } from "./e2e/helpers/memory";
import { createNavigationHelpers } from "./e2e/helpers/navigation";
import { createPolicyHelpers } from "./e2e/helpers/policies";
import { createProjectHelpers } from "./e2e/helpers/projects";
import { createRuntimeDebugHelpers } from "./e2e/helpers/runtimeDebug";
import { createSessionConfigHelpers } from "./e2e/helpers/sessionConfig";
import { createSessionHelpers } from "./e2e/helpers/sessions";
import { createUserPresenceHelpers } from "./e2e/helpers/userPresence";
import { createWorkspaceHelpers } from "./e2e/helpers/workspace";
import { registerE2EHelpers } from "./e2e/registerE2EHelpers";
import { asError } from "./e2e/result";
import type { E2EHelpers, Json, Result } from "./e2e/types";

export const E2EBootstrap: FC = () => {
  const store = useStore();

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Defense-in-depth: callers should already gate this component behind
    // `process.env.NODE_ENV !== "production"` in AppBootstrap, but refuse to
    // install `window.__e2e` here too so a missed gate cannot leak the helper.
    if (process.env.NODE_ENV === "production") return;

    const {
      pinSession,
      configure,
      configureWithExistingKey,
      inspectCreatorSelection,
      setAgentOrgMemberDraftConfig,
      createCliPatchSession,
      patchSessionModel,
    } = createSessionConfigHelpers({ store });

    const {
      getAgentDef,
      updateAgentDefPatch,
      addAgentDef,
      updateAgentDef,
      resetAgentDefBuiltin,
      removeAgentDef,
      listAgentDefs,
      listAllTools,
      getIntegrations,
      updateIntegrationsPatch,
      getAgentConfigBlob,
      updateAgentConfigBlob,
      readSettings,
      writeSettingsPartial,
      getSettingsRegistryKeys,
      getDesktopConfig,
      setDesktopConfig,
    } = createConfigHelpers();

    const refreshAgentDefs = async (): Promise<Result<{ defs: Json[] }>> => {
      try {
        const result = await listAgentDefs();
        if (!result.ok) return result;
        const defs = result.defs as unknown as AgentDefinition[];
        store.set(allAgentDefsAtom, defs);
        store.set(
          builtInAgentsAtom,
          defs.filter(
            (agent) => agent.builtIn && !INTERNAL_AGENT_IDS.has(agent.id)
          )
        );
        store.set(
          customAgentsAtom,
          defs.filter((agent) => !agent.builtIn)
        );
        store.set(agentDefsLoadedAtom, true);
        store.set(agentDefsLoadErrorAtom, null);
        return result;
      } catch (err) {
        return asError(err);
      }
    };

    const {
      getOrgiiRoot,
      getSelectedRepoPath,
      ensureRepoSelected,
      seedMultiRootWorkspace,
      clearWorkspaceRepos,
      setActiveWorkspaceFolderForTest,
      readSessionWorkspaceFromDb,
      getGitStatusForPath,
      pinFolderWorkspace,
    } = createWorkspaceHelpers(store);

    const { readSessionPromptEnvironmentBlock, readSdeTranscript } =
      createDebugEndpointHelpers();

    const {
      writeProject,
      deleteProject,
      listRoutines,
      upsertRoutine,
      deleteRoutine,
      fireRoutine,
      listRoutineFires,
      readWorkItem,
      writeWorkItem,
      allocateStandaloneWorkItemId,
      readStandaloneWorkItems,
      readProjectOrgs,
      readStandaloneWorkItem,
      writeStandaloneWorkItem,
      deleteWorkItem,
      updateWorkItemPartial,
      readWorkItemsEnriched,
      testWorkItemScheduleLookup,
      runWorkItemSchedulerOnce,
      launchWorkItemRuntimeProbe,
    } = createProjectHelpers(store);

    const {
      listPolicies,
      createPolicy,
      readPolicy,
      updatePolicy,
      setPolicyAgents,
      setPolicyScope,
      togglePolicy,
      deletePolicy,
    } = createPolicyHelpers();

    const {
      listWorkspaceMemory,
      readWorkspaceMemory,
      writeWorkspaceMemory,
      deleteWorkspaceMemory,
      clearWorkspaceMemory,
      workspaceMemoryStatus,
      workspaceMemoryIndex,
      debugMemoryPrefetchSection,
      learningsList,
      learningsUpdateBody,
      learningsSetStatus,
      learningsDelete,
      learningsGetStatus,
      learningsTriggerReflection,
      learningsDeprecate,
      debugSeedLearning,
      lspGetWorkspaceConfig,
      lspSetServerEnabled,
      lintGetWorkspaceConfig,
      lintSetToolEnabled,
    } = createMemoryHelpers();

    const {
      promptDump: promptDumpHelper,
      getActiveSessionId,
      openWorkstationFile,
      inspectOrgtrackFileSessionHistory,
      inspectCliSessionStatus,
      inspectCliHistoryMutation,
      resetToNewSession,
      openSession,
      reloadSessionList,
      primeSidebarEntityCache,
      inspectSidebarPagination,
      launchSession,
      getSessionAggregateRow,
      getSessionAggregateRowFromList,
      findSessionAggregateByWorkItem,
      seedChatEvents,
      seedPersistedCachedSession,
      seedSidebarSession,
      openWorkManagementTab,
      seedSessionContextUsage,
      seedModeSwitchSession,
      seedPlanCard,
      seedShellProcess,
      seedSubagentJob,
      debugSeedSubagentJobWire,
      debugSeedCommitLinkWire,
      debugSeedFinalDiffWire,
      debugReadFinalDiffCountWire,
      killSubagentJobWire,
      listRunningSubagentJobsWire,
      debugSeedChildSessionWire,
      debugSeedSidebarCodingSessionWire,
      debugSeedPendingPlanWire,
      deleteSessionWire,
      patchSessionExecModeWire,
      getPendingPlanApprovalWire,
      respondPlanApprovalWire,
      inspectChatState,
    } = createSessionHelpers(store);

    const {
      debugSessionSecuritySnapshot,
      debugSessionValidateCommand,
      debugSessionSubagentSnapshot,
      debugSessionModelSnapshot,
      debugSessionToolsSnapshot,
      listEffectiveToolsForSession,
      debugSessionSkillsSnapshot,
      debugSessionGeneralSnapshot,
    } = createRuntimeDebugHelpers();

    const agentOrgHelpers = createAgentOrgHelpers();

    const {
      importDetect,
      importApply,
      listSkills,
      readSkill,
      createSkill,
      validateSkillName,
      toggleSkill,
      moveSkill,
      readSkillFiles,
      writeSkillFiles,
    } = createExternalToolHelpers();

    const {
      mcpListServers,
      mcpGetConfig,
      mcpUpdateServers,
      mcpTestServer,
      mcpListServerTools,
      mcpReconnectServer,
      mcpSetServerDisabled,
    } = createMcpHelpers();

    const {
      navigateTo,
      getLocationPathname,
      openWorkspaceWorkItemsTab,
      openProjectWorkItemsTab,
      openChatPanelWorkItem,
      openAgentTab,
      openOrgTab,
      inspectWorkstationSurface,
      openAgentStationDiff,
    } = createNavigationHelpers(store);

    const {
      seedBenchmarkRun,
      inspectBenchmarkRun,
      startLocalDockerBenchmarkRun,
      getBenchmarkRunStatus,
    } = createBenchmarkE2EHelpers(store);

    const {
      cloudSeedAuthState,
      cloudClearAuthState,
      cloudReadAuthState,
      cloudSeedProjectOrgAlias,
      cloudSeedOrgs,
      cloudListOrgs,
      cloudInspectMemberRoster,
      cloudInspectRosterState,
      cloudInspectProjectState,
      cloudSeedRepoScopes,
      cloudResolveRepoScopeKeys,
      cloudSeedRemoteSessions,
      cloudInspectDebugState,
      cloudInspectPresence,
      cloudPublishSeededSessionEvents,
      cloudRunSyncPass,
      cloudSeedPendingInvite,
      cloudSeedPendingShare,
      cloudTagSessionToOrg,
      cloudOpenSyncLevelDialog,
      cloudCloseSyncLevelDialog,
    } = createCloudHelpers({ store });

    const { seedUserPresence } = createUserPresenceHelpers({ store });

    const helpers: E2EHelpers = {
      addAccount,
      addCursorNativeAccount,
      addClaudeCodeAccount,
      addCodexAccount,
      cloneCursorNativeAccountWithoutApiKey,
      listAccounts,
      inspectProviderMatrix,
      autoDetectKeyForE2E,
      removeAccount,
      createCliPatchSession,
      patchSessionModel,
      pinSession,
      configure,
      configureWithExistingKey,
      inspectCreatorSelection,
      setAgentOrgMemberDraftConfig,
      getAgentDef,
      updateAgentDefPatch,
      addAgentDef,
      updateAgentDef,
      resetAgentDefBuiltin,
      removeAgentDef,
      listAgentDefs,
      refreshAgentDefs,
      listAllTools,
      getIntegrations,
      updateIntegrationsPatch,
      getAgentConfigBlob,
      updateAgentConfigBlob,
      readSettings,
      writeSettingsPartial,
      getSettingsRegistryKeys,
      getOrgiiRoot,
      getSelectedRepoPath,
      ensureRepoSelected,
      seedMultiRootWorkspace,
      clearWorkspaceRepos,
      setActiveWorkspaceFolderForTest,
      readSessionWorkspaceFromDb,
      getGitStatusForPath,
      pinFolderWorkspace,
      readSessionPromptEnvironmentBlock,
      readSdeTranscript,
      writeProject,
      deleteProject,
      listRoutines,
      upsertRoutine,
      deleteRoutine,
      fireRoutine,
      listRoutineFires,
      projects: {
        listRoutines,
        upsertRoutine,
        deleteRoutine,
        fireRoutine,
        listRoutineFires,
      },
      readWorkItem,
      writeWorkItem,
      allocateStandaloneWorkItemId,
      readStandaloneWorkItems,
      readProjectOrgs,
      readStandaloneWorkItem,
      writeStandaloneWorkItem,
      deleteWorkItem,
      updateWorkItemPartial,
      readWorkItemsEnriched,
      testWorkItemScheduleLookup,
      runWorkItemSchedulerOnce,
      getDesktopConfig,
      setDesktopConfig,
      listPolicies,
      createPolicy,
      readPolicy,
      updatePolicy,
      setPolicyAgents,
      setPolicyScope,
      togglePolicy,
      deletePolicy,
      listWorkspaceMemory,
      readWorkspaceMemory,
      writeWorkspaceMemory,
      deleteWorkspaceMemory,
      clearWorkspaceMemory,
      workspaceMemoryStatus,
      workspaceMemoryIndex,
      debugMemoryPrefetchSection,
      learningsList,
      learningsUpdateBody,
      learningsSetStatus,
      learningsDelete,
      learningsGetStatus,
      learningsTriggerReflection,
      learningsDeprecate,
      debugSeedLearning,
      lspGetWorkspaceConfig,
      lspSetServerEnabled,
      lintGetWorkspaceConfig,
      lintSetToolEnabled,
      promptDump: promptDumpHelper,
      getActiveSessionId,
      openWorkstationFile,
      inspectOrgtrackFileSessionHistory,
      inspectCliSessionStatus,
      inspectCliHistoryMutation,
      resetToNewSession,
      openSession,
      reloadSessionList,
      primeSidebarEntityCache,
      inspectSidebarPagination,
      debugSessionSecuritySnapshot,
      debugSessionValidateCommand,
      debugSessionSubagentSnapshot,
      debugSessionModelSnapshot,
      debugSessionToolsSnapshot,
      listEffectiveToolsForSession,
      launchWorkItemRuntimeProbe,
      ...agentOrgHelpers,
      launchSession,
      getSessionAggregateRow,
      getSessionAggregateRowFromList,
      findSessionAggregateByWorkItem,
      seedChatEvents,
      seedPersistedCachedSession,
      seedSidebarSession,
      openWorkManagementTab,
      seedSessionContextUsage,
      seedModeSwitchSession,
      seedPlanCard,
      seedShellProcess,
      seedSubagentJob,
      debugSeedSubagentJobWire,
      debugSeedCommitLinkWire,
      debugSeedFinalDiffWire,
      debugReadFinalDiffCountWire,
      killSubagentJobWire,
      listRunningSubagentJobsWire,
      debugSeedChildSessionWire,
      debugSeedSidebarCodingSessionWire,
      debugSeedPendingPlanWire,
      deleteSessionWire,
      patchSessionExecModeWire,
      getPendingPlanApprovalWire,
      respondPlanApprovalWire,
      inspectChatState,
      debugSessionSkillsSnapshot,
      debugSessionGeneralSnapshot,
      importDetect,
      importApply,
      listSkills,
      readSkill,
      createSkill,
      validateSkillName,
      toggleSkill,
      moveSkill,
      readSkillFiles,
      writeSkillFiles,
      mcpListServers,
      mcpGetConfig,
      mcpUpdateServers,
      mcpTestServer,
      mcpListServerTools,
      mcpReconnectServer,
      mcpSetServerDisabled,
      navigateTo,
      getLocationPathname,
      openAgentStationDiff,
      openWorkspaceWorkItemsTab,
      openProjectWorkItemsTab,
      openChatPanelWorkItem,
      openAgentTab,
      openOrgTab,
      inspectWorkstationSurface,
      seedBenchmarkRun,
      inspectBenchmarkRun,
      startLocalDockerBenchmarkRun,
      getBenchmarkRunStatus,
      cloudSeedAuthState,
      cloudClearAuthState,
      cloudReadAuthState,
      cloudSeedProjectOrgAlias,
      cloudSeedOrgs,
      cloudListOrgs,
      cloudInspectMemberRoster,
      cloudInspectRosterState,
      cloudInspectProjectState,
      cloudSeedRepoScopes,
      cloudResolveRepoScopeKeys,
      cloudSeedRemoteSessions,
      cloudInspectDebugState,
      cloudInspectPresence,
      cloudPublishSeededSessionEvents,
      cloudRunSyncPass,
      cloudSeedPendingInvite,
      cloudSeedPendingShare,
      cloudTagSessionToOrg,
      cloudOpenSyncLevelDialog,
      cloudCloseSyncLevelDialog,
      seedUserPresence,
    };

    registerE2EHelpers(helpers);
  }, [store]);

  return null;
};

export default E2EBootstrap;
