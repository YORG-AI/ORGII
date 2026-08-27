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
import type { OrgMemberRuntimeConfig } from "@src/modules/MainApp/AgentOrgs/types";

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
