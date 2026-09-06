import {
  type CliAgentType,
  CliAgentTypeSchema,
} from "@src/api/tauri/rpc/schemas/validation";
import { KEY_SOURCE, isHostedKey } from "@src/api/tauri/session";
import { formatAgentType } from "@src/assets/providers";
import type {
  ConversationRootLocator,
  ConversationSource,
  LocalConversationTarget,
} from "@src/engines/SessionCore/conversations/conversationTypes";
import type { SessionCommentTarget } from "@src/features/Org2Cloud/sessionCommentTarget";
import {
  type AgentRuntimeSelection,
  resolveAgentRuntimeSelection,
} from "@src/features/SessionCreator/agentRuntimeConfig";
import type { AdvancedConfig } from "@src/features/SessionCreator/types";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import type { AgentDefinition } from "@src/modules/MainApp/AgentOrgs/types";
import type { AgentSelection } from "@src/scaffold/GlobalSpotlight/palettes/DispatchCategoryPalette";
import type { AgentRegistry } from "@src/store/session/agentRegistryAtom";
import type { LastModelSelection } from "@src/store/session/creatorDefaultModelAtom";
import { SESSION_TARGET_KIND } from "@src/store/session/creatorStateAtom";

export interface ConversationTargetBinding {
  root: ConversationRootLocator;
  cloudTarget: SessionCommentTarget | null;
  selection: LastModelSelection | null;
  runtimeSelection: AgentSelection | null;
  target: LocalConversationTarget | null;
  readiness: ConversationTargetReadiness;
  nativeCliTargets: readonly CliAgentType[];
  applyRuntimePick: (selection: AgentSelection) => boolean;
  applyModelPick: (
    config: AdvancedConfig,
    pendingRuntime?: AgentSelection | null
  ) => boolean;
}

type ConversationTargetReadiness = "loading" | "ready" | "unavailable";

export function resolveConversationTargetReadiness(params: {
  accountsLoaded: boolean;
  agentDiscoverySettled: boolean;
  hasAvailableRuntime: boolean;
}): ConversationTargetReadiness {
  if (!params.accountsLoaded || !params.agentDiscoverySettled) return "loading";
  return params.hasAvailableRuntime ? "ready" : "unavailable";
}

interface DefaultConversationTargetInput {
  preferredTarget: LocalConversationTarget | null;
  initialTarget: LocalConversationTarget | null;
  sourceCliAgentType?: string;
  sourceModel?: string;
  workspaceRepoPath: string | null | undefined;
  accounts?: readonly KeyVaultAccount[];
  registry?: AgentRegistry;
  nativeCliTargets: readonly CliAgentType[];
}

interface RuntimeConversationTargetInput {
  selection: AgentSelection;
  current: LocalConversationTarget | null;
  /** Newest-first targets already used by this canonical conversation. */
  previousTargets?: readonly LocalConversationTarget[];
  workspaceRepoPath: string | null;
  preferredAccountId?: string;
  preferredModel?: string;
  accounts: readonly KeyVaultAccount[];
  registry?: AgentRegistry;
  nativeCliTargets: readonly CliAgentType[];
}

interface PickedConversationRuntimeTargetInput {
  selection: AgentSelection;
  config: AdvancedConfig;
  workspaceRepoPath: string | null;
  accounts: readonly KeyVaultAccount[];
  registry?: AgentRegistry;
  nativeCliTargets: readonly CliAgentType[];
}

const EMPTY_AGENT_REGISTRY: AgentRegistry = { agents: [], apiProviders: [] };

function selectionForTarget(
  target: LocalConversationTarget
): AgentRuntimeSelection | null {
  if (target.cliAgentType) {
    const parsed = CliAgentTypeSchema.safeParse(target.cliAgentType);
    return parsed.success
      ? { category: "cli_agent", cliAgentType: parsed.data }
      : null;
  }
  return target.agentDefinitionId ? { category: "rust_agent" } : null;
}

function configForTarget(
  target: LocalConversationTarget,
  accounts: readonly KeyVaultAccount[]
): AdvancedConfig {
  const account = target.accountId
    ? accounts.find((candidate) => candidate.id === target.accountId)
    : undefined;
  return {
    keySource: KEY_SOURCE.OWN,
    cliAgentType: target.cliAgentType as CliAgentType | undefined,
    selectedAccountId: target.accountId,
    model: target.model,
    agent: account?.modelType,
    provider: account?.modelType,
    nativeHarnessType: account?.nativeHarnessType,
    selectedSourceLabel: account?.name,
    selectedSourceModelType:
      account?.modelType ??
      (target.cliAgentType === "claude_code" ? "claude_code" : undefined),
  };
}

function targetForResolvedConfig(
  selection: AgentSelection | AgentRuntimeSelection,
  config: AdvancedConfig,
  workspaceRepoPath: string | null
): LocalConversationTarget | null {
  if (selection.category === "cli_agent" && selection.cliAgentType) {
    const accountId = config.selectedAccountId?.trim();
    const model = config.model?.trim();
    if (!accountId) {
      return selection.cliAgentType === "claude_code"
        ? {
            cliAgentType: "claude_code",
            model: model || undefined,
            workspaceRepoPath,
          }
        : null;
    }
    if (!model) return null;
    return {
      cliAgentType: selection.cliAgentType,
      accountId,
      model,
      workspaceRepoPath,
    };
  }
  if (selection.category !== "rust_agent") return null;
  const agentDefinitionId =
    "agentDefinitionId" in selection ? selection.agentDefinitionId : undefined;
  const accountId = config.selectedAccountId?.trim();
  const model = config.model?.trim();
  return agentDefinitionId && accountId && model
    ? { agentDefinitionId, accountId, model, workspaceRepoPath }
    : null;
}

function resolveTargetForSelection(params: {
  selection: AgentSelection;
  candidates: readonly AdvancedConfig[];
  workspaceRepoPath: string | null;
  accounts: readonly KeyVaultAccount[];
  registry: AgentRegistry;
  nativeCliTargets: readonly CliAgentType[];
}): LocalConversationTarget | null {
  const resolution = resolveAgentRuntimeSelection({
    selection: params.selection,
    candidates: params.candidates,
    accounts: params.accounts,
    registry: params.registry,
    allowedCliAgentTypes: params.nativeCliTargets,
    allowHosted: false,
    allowAmbientClaude: true,
  });
  return resolution.status === "ready"
    ? targetForResolvedConfig(
        params.selection,
        resolution.config,
        params.workspaceRepoPath
      )
    : null;
}

export function resolveDefaultConversationTarget({
  preferredTarget,
  initialTarget,
  sourceCliAgentType,
  sourceModel,
  workspaceRepoPath,
  accounts = [],
  registry = EMPTY_AGENT_REGISTRY,
  nativeCliTargets,
}: DefaultConversationTargetInput): LocalConversationTarget | null {
  const resolvedWorkspaceRepoPath =
    workspaceRepoPath === undefined
      ? (preferredTarget?.workspaceRepoPath ??
        initialTarget?.workspaceRepoPath ??
        null)
      : workspaceRepoPath;

  for (const candidate of [preferredTarget, initialTarget]) {
    if (!candidate) continue;
    const runtime = selectionForTarget(candidate);
    if (!runtime) continue;
    const selection: AgentSelection = candidate.cliAgentType
      ? {
          category: "cli_agent",
          targetKind: SESSION_TARGET_KIND.CLI_AGENT,
          cliAgentType: runtime.cliAgentType!,
          agentName: formatAgentType(candidate.cliAgentType),
        }
      : {
          category: "rust_agent",
          targetKind: SESSION_TARGET_KIND.AGENT,
          agentDefinitionId: candidate.agentDefinitionId!,
          agentName: candidate.agentDefinitionId!,
        };
    const resolved = resolveTargetForSelection({
      selection,
      candidates: [configForTarget(candidate, accounts)],
      workspaceRepoPath: resolvedWorkspaceRepoPath,
      accounts,
      registry,
      nativeCliTargets,
    });
    if (resolved) return resolved;
  }

  const parsedSource = CliAgentTypeSchema.safeParse(sourceCliAgentType);
  if (parsedSource.success) {
    return resolveTargetForSelection({
      selection: {
        category: "cli_agent",
        targetKind: SESSION_TARGET_KIND.CLI_AGENT,
        cliAgentType: parsedSource.data,
        agentName: formatAgentType(parsedSource.data),
      },
      candidates: [
        {
          keySource: KEY_SOURCE.OWN,
          cliAgentType: parsedSource.data,
          model: sourceModel,
        },
      ],
      workspaceRepoPath: resolvedWorkspaceRepoPath,
      accounts,
      registry,
      nativeCliTargets,
    });
  }
  return null;
}

export function resolveConversationRuntimeTarget({
  selection,
  current,
  previousTargets = [],
  workspaceRepoPath,
  preferredAccountId,
  preferredModel,
  accounts,
  registry = EMPTY_AGENT_REGISTRY,
  nativeCliTargets,
}: RuntimeConversationTargetInput): LocalConversationTarget | null {
  const candidates: AdvancedConfig[] = [];
  if (current) candidates.push(configForTarget(current, accounts));
  candidates.push(
    ...previousTargets.map((target) => configForTarget(target, accounts))
  );
  if (preferredAccountId && preferredModel) {
    candidates.push({
      keySource: KEY_SOURCE.OWN,
      selectedAccountId: preferredAccountId,
      model: preferredModel,
    });
  }
  return resolveTargetForSelection({
    selection,
    candidates,
    workspaceRepoPath,
    accounts,
    registry,
    nativeCliTargets,
  });
}

export function resolvePickedConversationRuntimeTarget({
  selection,
  config,
  workspaceRepoPath,
  accounts,
  registry = EMPTY_AGENT_REGISTRY,
  nativeCliTargets,
}: PickedConversationRuntimeTargetInput): LocalConversationTarget | null {
  if (isHostedKey(config.keySource)) return null;
  return resolveTargetForSelection({
    selection,
    candidates: [config],
    workspaceRepoPath,
    accounts,
    registry,
    nativeCliTargets,
  });
}

export function resolveConversationTargetPillPresentation(params: {
  target: LocalConversationTarget | null;
  accounts?: readonly KeyVaultAccount[];
}): Pick<ConversationTargetBinding, "selection"> {
  if (!params.target) return { selection: null };
  const config = configForTarget(params.target, params.accounts ?? []);
  return {
    selection: {
      keySource: KEY_SOURCE.OWN,
      model:
        config.model ??
        (params.target.cliAgentType === "claude_code" &&
        !params.target.accountId
          ? "default"
          : undefined),
      selectedAccountId: config.selectedAccountId,
      cliAgentType: config.cliAgentType,
      selectedSourceLabel: config.selectedSourceLabel,
      selectedSourceModelType: config.selectedSourceModelType,
    },
  };
}

export function resolveConversationRuntimeSelection(params: {
  target: LocalConversationTarget | null;
  source: ConversationSource;
  definitions: readonly AgentDefinition[];
}): AgentSelection | null {
  if (!params.target) return null;
  const parsed = CliAgentTypeSchema.safeParse(params.target.cliAgentType);
  if (parsed.success) {
    return {
      category: "cli_agent",
      targetKind: SESSION_TARGET_KIND.CLI_AGENT,
      cliAgentType: parsed.data,
      agentName: formatAgentType(parsed.data),
    };
  }
  const agentDefinitionId = params.target.agentDefinitionId;
  if (!agentDefinitionId) return null;
  const definition = params.definitions.find(
    (candidate) => candidate.id === agentDefinitionId
  );
  return {
    category: "rust_agent",
    targetKind: SESSION_TARGET_KIND.AGENT,
    agentDefinitionId,
    agentName:
      definition?.name ?? params.source.agentDisplayName ?? agentDefinitionId,
    agentIconId: definition?.iconId,
  };
}
