/**
 * Agent runtime config — the per-target slice of `AdvancedConfig`.
 *
 * `AdvancedConfig` is derived globally from `creatorDefaultModelSelectionAtom`
 * (see `useAdvancedConfig`), so any surface that needs a *per-target* model /
 * account / tier choice has to carry its own override and fold it over that
 * global base at read time. Two surfaces do: Agent Team member rows and
 * multi-runner rows.
 *
 * The override shape is `OrgMemberRuntimeConfig` — named for its first caller,
 * but structurally just "the launch-relevant fields of a model selection".
 * Both surfaces share it rather than maintaining structurally identical twins.
 */
import type { DispatchCategory } from "@src/api/tauri/session";
import { KEY_SOURCE, isHostedKey } from "@src/api/tauri/session";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import {
  getCliCompatibleAccounts,
  getRustCompatibleAccounts,
  isSourceCompatibleWithAgent,
} from "@src/hooks/models/useAgentCompatibility";
import { accountHasModel } from "@src/hooks/models/useModelAccountLookup";
import type { OrgMemberRuntimeConfig } from "@src/modules/MainApp/AgentOrgs/types";
import type { AgentRegistry } from "@src/store/session/agentRegistryAtom";

import type { AdvancedConfig } from "./types";

function cleanValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Narrow a full creator config down to the fields a per-target override owns. */
export function toAgentRuntimeConfig(
  config: AdvancedConfig
): OrgMemberRuntimeConfig {
  return {
    keySource: config.keySource,
    accountId: cleanValue(config.selectedAccountId),
    model: cleanValue(config.model),
    nativeHarnessType: config.nativeHarnessType,
    tier: cleanValue(config.tier),
    listingModel: cleanValue(config.listingModel),
    listingModelDisplay: cleanValue(config.listingModelDisplay),
    listingModelType: config.listingModelType,
    selectedSourceLabel: cleanValue(config.selectedSourceLabel),
    selectedSourceModelType: config.selectedSourceModelType,
  };
}

/** Fold a per-target override over the global creator config. */
export function applyAgentRuntimeConfig(
  base: AdvancedConfig,
  runtimeConfig: OrgMemberRuntimeConfig | undefined
): AdvancedConfig {
  if (!runtimeConfig) return base;
  return {
    ...base,
    keySource: runtimeConfig.keySource ?? base.keySource,
    selectedAccountId: runtimeConfig.accountId ?? base.selectedAccountId,
    model: runtimeConfig.model ?? base.model,
    nativeHarnessType:
      runtimeConfig.nativeHarnessType ?? base.nativeHarnessType,
    tier: runtimeConfig.tier ?? base.tier,
    listingModel: runtimeConfig.listingModel ?? base.listingModel,
    listingModelDisplay:
      runtimeConfig.listingModelDisplay ?? base.listingModelDisplay,
    listingModelType: runtimeConfig.listingModelType ?? base.listingModelType,
    selectedSourceLabel:
      runtimeConfig.selectedSourceLabel ?? base.selectedSourceLabel,
    selectedSourceModelType:
      runtimeConfig.selectedSourceModelType ?? base.selectedSourceModelType,
  };
}

/** True when the override (or the base it folds onto) names a model to run. */
export function hasResolvedModel(config: AdvancedConfig): boolean {
  return Boolean(cleanValue(config.model) || cleanValue(config.listingModel));
}

export interface AgentRuntimeSelection {
  category: DispatchCategory;
  cliAgentType?: AdvancedConfig["cliAgentType"];
}

export type AgentRuntimeSelectionResolution =
  | { status: "ready"; config: AdvancedConfig }
  | { status: "needs_model_picker" };

interface ResolveAgentRuntimeSelectionInput {
  selection: AgentRuntimeSelection;
  /** Explicit, already-selected pairs in preference order. */
  candidates: readonly AdvancedConfig[];
  registry: AgentRegistry;
  /** When present, this inventory is authoritative for account validity. */
  accounts?: readonly KeyVaultAccount[];
  allowedCliAgentTypes?: readonly string[];
  allowHosted: boolean;
  allowAmbientClaude: boolean;
}

function selectedAccountForRuntime(
  selection: AgentRuntimeSelection,
  config: AdvancedConfig,
  accounts: readonly KeyVaultAccount[],
  registry: AgentRegistry
): KeyVaultAccount | null {
  const accountId = cleanValue(config.selectedAccountId);
  const model = cleanValue(config.model);
  if (!accountId || !model) return null;
  const compatible =
    selection.category === "cli_agent" && selection.cliAgentType
      ? getCliCompatibleAccounts(registry, selection.cliAgentType, [
          ...accounts,
        ])
      : selection.category === "rust_agent"
        ? getRustCompatibleAccounts(registry, [...accounts])
        : [];
  return (
    compatible.find(
      (account) =>
        account.id === accountId &&
        account.enabled &&
        account.hasKey &&
        accountHasModel(account, model)
    ) ?? null
  );
}

/**
 * Resolve an agent/runtime change from explicit model+source pairs only.
 *
 * This is the shared New Session and continuation selection boundary. It
 * never guesses an account from list order: an existing exact pair either
 * remains executable for the selected runtime, or the existing model/source
 * palette must complete the choice. Claude's signed-in CLI is the sole
 * accountless runtime and is enabled only by callers that already support it.
 */
export function resolveAgentRuntimeSelection({
  selection,
  candidates,
  registry,
  accounts,
  allowedCliAgentTypes,
  allowHosted,
  allowAmbientClaude,
}: ResolveAgentRuntimeSelectionInput): AgentRuntimeSelectionResolution {
  if (
    selection.category === "cli_agent" &&
    (!selection.cliAgentType ||
      (allowedCliAgentTypes &&
        !allowedCliAgentTypes.includes(selection.cliAgentType)))
  ) {
    return { status: "needs_model_picker" };
  }
  if (
    selection.category !== "cli_agent" &&
    selection.category !== "rust_agent"
  ) {
    return { status: "needs_model_picker" };
  }

  for (const candidate of candidates) {
    if (isHostedKey(candidate.keySource)) {
      if (
        allowHosted &&
        selection.category === "rust_agent" &&
        hasResolvedModel(candidate)
      ) {
        return {
          status: "ready",
          config: { ...candidate, cliAgentType: undefined },
        };
      }
      continue;
    }

    const model = cleanValue(candidate.model);
    const accountId = cleanValue(candidate.selectedAccountId);
    if (!model || !accountId) continue;

    if (accounts) {
      const account = selectedAccountForRuntime(
        selection,
        candidate,
        accounts,
        registry
      );
      if (!account) continue;
      return {
        status: "ready",
        config: {
          ...candidate,
          keySource: KEY_SOURCE.OWN,
          cliAgentType:
            selection.category === "cli_agent"
              ? selection.cliAgentType
              : undefined,
          selectedAccountId: account.id,
          model,
          agent: account.modelType,
          provider: account.modelType,
          nativeHarnessType: account.nativeHarnessType,
          selectedSourceLabel: account.name,
          selectedSourceModelType: account.modelType,
        },
      };
    }

    const sourceType = candidate.selectedSourceModelType;
    if (
      !sourceType ||
      !isSourceCompatibleWithAgent(
        registry,
        selection.category,
        selection.cliAgentType,
        sourceType
      )
    ) {
      continue;
    }
    return {
      status: "ready",
      config: {
        ...candidate,
        keySource: KEY_SOURCE.OWN,
        cliAgentType:
          selection.category === "cli_agent"
            ? selection.cliAgentType
            : undefined,
        selectedAccountId: accountId,
        model,
      },
    };
  }

  if (
    allowAmbientClaude &&
    selection.category === "cli_agent" &&
    selection.cliAgentType === "claude_code"
  ) {
    const ambientCandidate = candidates.find(
      (candidate) =>
        !isHostedKey(candidate.keySource) && !candidate.selectedAccountId
    );
    const ambientModel = cleanValue(ambientCandidate?.model);
    return {
      status: "ready",
      config: {
        keySource: KEY_SOURCE.OWN,
        cliAgentType: "claude_code",
        model: ambientModel === "default" ? undefined : ambientModel,
        selectedSourceModelType: "claude_code",
      },
    };
  }

  return { status: "needs_model_picker" };
}
