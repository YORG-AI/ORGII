import { useCallback, useEffect, useMemo, useState } from "react";

import { KEY_SOURCE } from "@src/api/tauri/session";
import type { AdvancedConfig } from "@src/features/SessionCreator/types";
import type { KeyVaultAccount } from "@src/hooks/keyVault/types";
import { accountHasModel } from "@src/hooks/models/useModelAccountLookup";
import type { RecentModelEntry } from "@src/store/session/recentModelEntriesAtom";
import { resolveDefaultVariant } from "@src/util/defaultModelVariant";
import {
  parseModelVariant,
  resolveModelVariantFields,
} from "@src/util/modelVariants";

import { buildSourceOptions, toSourceOption } from "./sourceItems";
import type { SourceOption } from "./types";
import { resolveVariantReselection } from "./variantReselect";

type ActiveColumn = "models" | "sources";

interface UseUnifiedModelPaletteSelectionParams {
  isOpen: boolean;
  isCliAgent: boolean;
  /**
   * "Key first" mode: the left column lists keys and the right column the
   * focused key's models (see `spotlightModelKeyFirstAtom`).
   */
  keyFirst: boolean;
  accountLookupSize: number;
  accounts: KeyVaultAccount[];
  advancedConfig: AdvancedConfig;
  onConfigChange: (config: AdvancedConfig) => void;
  onClose: () => void;
  recordRecent: (entry: RecentModelEntry) => void;
}

export function useUnifiedModelPaletteSelection({
  isOpen,
  isCliAgent,
  keyFirst,
  accountLookupSize,
  accounts,
  advancedConfig,
  onConfigChange,
  onClose,
  recordRecent,
}: UseUnifiedModelPaletteSelectionParams) {
  const [activeColumn, setActiveColumn] = useState<ActiveColumn>("models");
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [selectedModelLabel, setSelectedModelLabel] = useState("");
  const [selectedGroupModelIds, setSelectedGroupModelIds] = useState<string[]>(
    []
  );
  const [selectedSourceIndex, setSelectedSourceIndex] = useState(-1);
  /** Key-first mode: the account previewed/focused in the left column. */
  const [selectedKeyAccountId, setSelectedKeyAccountId] = useState<
    string | null
  >(null);

  const sourceOptions = useMemo(() => {
    if (selectedModelId === null) return [];
    const modelIds =
      selectedGroupModelIds.length > 0
        ? selectedGroupModelIds
        : [selectedModelId];
    return buildSourceOptions(modelIds, accounts, isCliAgent);
  }, [accounts, isCliAgent, selectedModelId, selectedGroupModelIds]);

  useEffect(() => {
    if (!isOpen) return;

    const frameId = requestAnimationFrame(() => {
      setSelectedSourceIndex(-1);
      setSelectedKeyAccountId(null);
      // Model-first only: a CLI agent with no model listing skips straight
      // to the key column. In key-first mode the key column IS the first
      // column, so the normal reset applies.
      if (!keyFirst && isCliAgent && accountLookupSize === 0) {
        setActiveColumn("sources");
        setSelectedModelId("");
        setSelectedModelLabel("");
        setSelectedGroupModelIds([]);
      } else {
        setActiveColumn("models");
        setSelectedModelId(null);
        setSelectedModelLabel("");
        setSelectedGroupModelIds([]);
      }
    });
    return () => cancelAnimationFrame(frameId);
  }, [isOpen, isCliAgent, keyFirst, accountLookupSize]);

  const applySourceSelection = useCallback(
    (modelId: string, _modelLabel: string, source: SourceOption) => {
      const resolvedModelId = modelId || advancedConfig.model || "";
      onConfigChange({
        ...advancedConfig,
        keySource: KEY_SOURCE.OWN,
        selectedAccountId: source.accountId,
        agent: source.modelType,
        provider: source.modelType,
        model: resolvedModelId,
        nativeHarnessType: source.nativeHarnessType,
        selectedSourceLabel: source.label,
        selectedSourceModelType: source.modelType,
      });
      recordRecent({
        modelId: resolvedModelId,
        sourceType: source.type,
        accountId: source.accountId,
        accountName: source.label,
        modelType: source.modelType,
      });
      onClose();
    },
    [advancedConfig, onConfigChange, onClose, recordRecent]
  );

  const previewModel = useCallback(
    (modelId: string | null, modelLabel: string, groupModelIds: string[]) => {
      setSelectedModelId(modelId);
      setSelectedModelLabel(modelId ? modelLabel : "");
      setSelectedGroupModelIds(modelId ? groupModelIds : []);
      setSelectedSourceIndex(-1);
    },
    []
  );

  const handleModelPreview = useCallback(
    (modelId: string, modelLabel: string, groupModelIds: string[]) => {
      previewModel(modelId, modelLabel, groupModelIds);
    },
    [previewModel]
  );

  const handleModelSelect = useCallback(
    (modelId: string, modelLabel: string, groupModelIds: string[]) => {
      previewModel(modelId, modelLabel, groupModelIds);
      setActiveColumn("sources");
    },
    [previewModel]
  );

  const resolveLaunchModelForSource = useCallback(
    (source: SourceOption): string | null => {
      if (!selectedModelId) return null;
      const sourceAccount = source.accountId
        ? accounts.find((account) => account.id === source.accountId)
        : undefined;
      const candidateModelIds =
        selectedGroupModelIds.length > 0
          ? selectedGroupModelIds
          : [selectedModelId];
      const accountModelIds = sourceAccount
        ? candidateModelIds.filter((modelId) =>
            accountHasModel(sourceAccount, modelId)
          )
        : [];
      if (accountModelIds.length === 0) return selectedModelId;

      const selectedVariant = parseModelVariant(selectedModelId);
      const baseModel = selectedVariant?.baseModel ?? selectedModelId;
      const persisted = (sourceAccount?.defaultVariants ?? []).find(
        (entry) =>
          entry.base_model === baseModel &&
          accountModelIds.includes(entry.model)
      )?.model;
      const variantInfos = accountModelIds.map((modelId) =>
        resolveModelVariantFields(modelId)
      );
      return (
        resolveDefaultVariant(baseModel, variantInfos, persisted) ??
        accountModelIds[0]
      );
    },
    [accounts, selectedModelId, selectedGroupModelIds]
  );

  const handleSourceSelect = useCallback(
    (source: SourceOption) => {
      const launchModelId = resolveLaunchModelForSource(source);
      if (!launchModelId) return;
      applySourceSelection(launchModelId, selectedModelLabel, source);
    },
    [selectedModelLabel, applySourceSelection, resolveLaunchModelForSource]
  );

  // ── Key-first mode ────────────────────────────────────────────────────
  const previewKey = useCallback((accountId: string | null) => {
    setSelectedKeyAccountId(accountId);
    setSelectedSourceIndex(-1);
  }, []);

  const handleKeySelect = useCallback(
    (accountId: string) => {
      previewKey(accountId);
      setActiveColumn("sources");
    },
    [previewKey]
  );

  // `modelId` is "" for a CLI key without a model listing; the apply path
  // then falls back to the config's current model.
  const handleKeyModelSelect = useCallback(
    (account: KeyVaultAccount, modelId: string) => {
      applySourceSelection(modelId, "", toSourceOption(account));
    },
    [applySourceSelection]
  );

  // Core apply path shared by an explicit recent pick and an in-place
  // variant re-select. Rebinds the entry's account (by id, then by
  // name+type), pushes the selection through `onConfigChange` +
  // `recordRecent`, and closes the palette unless `close: false` is passed
  // (the variant-edit case keeps the palette open so the user can keep
  // tweaking after the properties dropdown closes itself).
  const applyRecentEntry = useCallback(
    (entry: RecentModelEntry, options?: { close?: boolean }) => {
      const currentAccount = accounts.find(
        (account) =>
          account.id === entry.accountId &&
          account.status === "ready" &&
          account.hasKey &&
          accountHasModel(account, entry.modelId)
      );
      const reboundAccount =
        currentAccount ??
        accounts.find(
          (account) =>
            account.name === entry.accountName &&
            account.modelType === entry.modelType &&
            account.status === "ready" &&
            account.hasKey &&
            accountHasModel(account, entry.modelId)
        );

      if (!reboundAccount) {
        return;
      }

      const reboundEntry: RecentModelEntry = {
        ...entry,
        accountId: reboundAccount.id,
        accountName: reboundAccount.name,
        modelType: reboundAccount.modelType,
      };

      onConfigChange({
        ...advancedConfig,
        keySource: KEY_SOURCE.OWN,
        selectedAccountId: reboundAccount.id,
        agent: reboundAccount.modelType,
        provider: reboundAccount.modelType,
        model: reboundEntry.modelId,
        nativeHarnessType: reboundAccount.nativeHarnessType,
        selectedSourceLabel: reboundAccount.name,
        selectedSourceModelType: reboundAccount.modelType,
      });

      recordRecent(reboundEntry);
      if (options?.close !== false) onClose();
    },
    [accounts, advancedConfig, onConfigChange, onClose, recordRecent]
  );

  const handleRecentSelect = useCallback(
    (entry: RecentModelEntry) => applyRecentEntry(entry),
    [applyRecentEntry]
  );

  // Editing the effort/variant of the *currently selected* model should make
  // the selected model become that variant — updating both the displayed
  // pill and the model the session actually launches with (the dispatch path
  // uses the stored concrete model id, not the per-key default variant). We
  // reuse the select path with the new model id and keep the palette open.
  const reselectVariant = useCallback(
    (entry: RecentModelEntry, nextModelId: string) => {
      const resolved = resolveVariantReselection(entry.modelId, nextModelId);
      if (!resolved) return;
      applyRecentEntry({ ...entry, modelId: resolved }, { close: false });
    },
    [applyRecentEntry]
  );

  const handleBack = useCallback(() => {
    setActiveColumn("models");
  }, []);

  return {
    activeColumn,
    setActiveColumn,
    selectedModelId,
    selectedGroupModelIds,
    selectedSourceIndex,
    setSelectedSourceIndex,
    sourceOptions,
    previewModel,
    handleModelPreview,
    handleModelSelect,
    handleSourceSelect,
    handleRecentSelect,
    reselectVariant,
    handleBack,
    selectedKeyAccountId,
    previewKey,
    handleKeySelect,
    handleKeyModelSelect,
  };
}
