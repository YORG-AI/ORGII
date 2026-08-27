/**
 * Resolve a model selection to display + tooltip labels, reactive to the
 * model-alias registry.
 *
 * Wraps `resolveModelDisplayLabel` / `resolveModelFullLabel` and subscribes
 * to `useModelAliasRegistryVersion` so the label refreshes whenever the user
 * edits a model alias in Key Vault. Use this from any pill/label that should
 * show the user-chosen alias instead of the raw model id.
 */
import { useMemo } from "react";

import {
  type ModelPillDisplayParts,
  resolveModelDisplayLabel,
  resolveModelFullLabel,
  resolveModelPillAccountName,
  resolveModelPillDisplayParts,
} from "@src/util/formatModelName";

import { useModelAliasRegistryVersion } from "./modelAliasRegistry";

interface ModelSelectionInput {
  model?: string;
  provider?: string;
  listingModel?: string;
  listingModelDisplay?: string;
  listingName?: string;
  selectedSourceLabel?: string;
  selectedSourceModelType?: string;
}

interface ProviderWithModels {
  provider_name: string;
  models: { id: string; display_name: string }[];
}

interface ResolvedModelLabel {
  /** Label for the pill body (alias > listing display > formatted id). */
  label: string;
  /** Full label for hover tooltips (alias > listing display > formatted id with date). */
  title: string;
  /** Key vault account or hosted listing name for breadcrumb tooltips. */
  accountName?: string;
}

interface ResolvedModelPillLabel extends ResolvedModelLabel {
  displayParts: ModelPillDisplayParts;
}

export function useResolvedModelLabel(
  selection: ModelSelectionInput | null | undefined,
  providers: ProviderWithModels[],
  fallback: string = "Model"
): ResolvedModelLabel {
  const aliasVersion = useModelAliasRegistryVersion();

  return useMemo(() => {
    const sel = selection ?? {};
    return {
      label: resolveModelDisplayLabel(sel, providers, fallback),
      title: resolveModelFullLabel(sel, fallback),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- aliasVersion invalidates the module-scoped alias registry read performed inside the resolver helpers
  }, [selection, providers, fallback, aliasVersion]);
}

export function useModelPillLabel(
  selection: ModelSelectionInput | null | undefined,
  fallback: string = "Model"
): ResolvedModelPillLabel {
  const aliasVersion = useModelAliasRegistryVersion();

  return useMemo(() => {
    const sel = selection ?? {};
    const displayParts = resolveModelPillDisplayParts(sel, fallback);
    return {
      label: displayParts.label,
      title: resolveModelFullLabel(sel, fallback),
      accountName: resolveModelPillAccountName(sel),
      displayParts,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- aliasVersion invalidates the module-scoped alias registry read performed inside the resolver helpers
  }, [selection, fallback, aliasVersion]);
}
