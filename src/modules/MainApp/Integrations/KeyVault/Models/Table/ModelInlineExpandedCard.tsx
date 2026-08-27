import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { ORGII_ORCHESTRATOR } from "@src/assets/providers/types";
import Switch from "@src/components/Switch";
import { isOrgiiTierModel } from "@src/config/orgiiCategories";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import {
  accountHasModel,
  accountModelIds,
} from "@src/hooks/models/useModelAccountLookup";
import ModelVariantInlineCard from "@src/modules/MainApp/Integrations/KeyVault/shared/ModelTable/ModelVariantInlineCard";
import type { ModelTableVariantInfo } from "@src/types/modelTable";
import { formatModelNameFull } from "@src/util/formatModelName";
import { groupHasParsedModelVariants } from "@src/util/modelVariants";

import { InlineCardSplit } from "../../shared/InlineCardPrimitives";
import {
  InlineSplitAddKeyRow,
  InlineSplitDefaultVersionHeaderRow,
  InlineSplitHeaderRow,
  InlineSplitSelectableRow,
} from "../../shared/InlineSplitRows";
import { AccountSourceBreadcrumb } from "./AccountSourceBreadcrumb";
import {
  type IntegrationsModelGroupRow,
  applyModelGroupToEnabledSet,
} from "./integrationsModelGroups";

interface ExpandedAccountEntry {
  key: string;
  account: KeyVaultAccount;
  groupModels: string[];
}

function accountHasAllEnabled(
  entry: ExpandedAccountEntry,
  optimisticToggles: Map<string, boolean>
): boolean {
  return entry.groupModels.every((model) =>
    isModelEnabledOnAccount(entry.account, model, optimisticToggles)
  );
}

function getAccountEnableSummary(
  entry: ExpandedAccountEntry,
  optimisticToggles: Map<string, boolean>
): { allEnabled: boolean; anyEnabled: boolean; mixed: boolean } {
  const allEnabled = accountHasAllEnabled(entry, optimisticToggles);
  const anyEnabled = accountHasAnyEnabled(entry, optimisticToggles);
  return {
    allEnabled,
    anyEnabled,
    mixed: anyEnabled && !allEnabled,
  };
}

function syncAccountEnabledForAccountModels(
  account: KeyVaultAccount,
  enabledModels: readonly string[],
  isAccountEnabled: (account: KeyVaultAccount) => boolean,
  onToggleAccount: (account: KeyVaultAccount, enabled: boolean) => void
): void {
  // Only react to the account-wide enabled-models set. A group-scoped toggle
  // (e.g. disabling Cursor for GPT 5.4) must not turn the account off when
  // other models on that account are still enabled.
  const anyModelEnabled = enabledModels.length > 0;
  const accountEnabled = isAccountEnabled(account);

  if (!anyModelEnabled && accountEnabled) {
    onToggleAccount(account, false);
  } else if (anyModelEnabled && !accountEnabled) {
    onToggleAccount(account, true);
  }
}

interface ModelInlineExpandedCardProps {
  group: IntegrationsModelGroupRow;
  accounts: KeyVaultAccount[];
  variantsByModel: Map<string, ModelTableVariantInfo>;
  onToggleModel: (
    model: string,
    agentType: string,
    enabled: boolean,
    accountId?: string
  ) => void;
  onUpdateAccountEnabledModels: (
    accountId: string,
    agentType: string,
    enabledModels: readonly string[]
  ) => void;
  onUpdateAccountDefaultVariant?: (
    accountId: string,
    baseModel: string,
    model: string
  ) => void;
  onToggleAccount: (account: KeyVaultAccount, enabled: boolean) => void;
  isAccountEnabled?: (account: KeyVaultAccount) => boolean;
  /** Opens the KeyVault wizard to add a new key. Renders the
   * "+ Add new key" row at the bottom of the left pane when provided. */
  onAddKey?: () => void;
}

function getAccountModelToggleKey(
  account: KeyVaultAccount,
  model: string
): string {
  return `${model}|${account.modelType}|${account.id}`;
}

function isModelEnabledOnAccount(
  account: KeyVaultAccount,
  model: string,
  optimisticToggles: Map<string, boolean>
): boolean {
  const toggleKey = getAccountModelToggleKey(account, model);
  return optimisticToggles.get(toggleKey) ?? accountHasModel(account, model);
}

function buildExpandedAccountEntries(
  group: IntegrationsModelGroupRow,
  accounts: KeyVaultAccount[],
  tokenMarketLabel: string
): ExpandedAccountEntry[] {
  if (group.isOrgiiGroup) {
    const tokenMarketAccount: KeyVaultAccount = {
      id: "token-market",
      hasLocalKey: false,
      isListed: false,
      modelType: ORGII_ORCHESTRATOR,
      name: tokenMarketLabel,
      status: "ready",
      hasKey: false,
      hasApiKey: false,
      hasSessionToken: false,
      enabled: true,
      availableModels: [],
      enabledModels: [],
    };
    return [
      {
        key: tokenMarketAccount.id,
        account: tokenMarketAccount,
        groupModels: group.models.map((row) => row.model),
      },
    ];
  }

  const entryByAccountId = new Map<string, ExpandedAccountEntry>();
  for (const row of group.models) {
    if (isOrgiiTierModel(row.model)) continue;

    for (const account of accounts) {
      if (!accountModelIds(account).includes(row.model)) continue;

      const existing = entryByAccountId.get(account.id);
      if (existing) {
        existing.groupModels.push(row.model);
        continue;
      }

      entryByAccountId.set(account.id, {
        key: account.id,
        account,
        groupModels: [row.model],
      });
    }
  }

  return [...entryByAccountId.values()]
    .map((entry) => ({
      ...entry,
      groupModels: [...new Set(entry.groupModels)].sort((modelA, modelB) =>
        modelA.localeCompare(modelB)
      ),
    }))
    .sort((entryA, entryB) =>
      entryA.account.name.localeCompare(entryB.account.name, undefined, {
        sensitivity: "base",
      })
    );
}

function accountHasAnyEnabled(
  entry: ExpandedAccountEntry,
  optimisticToggles: Map<string, boolean>
): boolean {
  return entry.groupModels.some((model) =>
    isModelEnabledOnAccount(entry.account, model, optimisticToggles)
  );
}

const ModelInlineExpandedCard: React.FC<ModelInlineExpandedCardProps> = ({
  group,
  accounts,
  variantsByModel,
  onToggleModel: _onToggleModel,
  onUpdateAccountEnabledModels,
  onUpdateAccountDefaultVariant,
  onToggleAccount,
  isAccountEnabled = (account) => account.enabled,
  onAddKey,
}) => {
  const { t } = useTranslation("integrations");

  const [optimisticToggles, setOptimisticToggles] = useState<
    Map<string, boolean>
  >(new Map());
  const pendingRef = useRef<Set<string>>(new Set());
  const [selectedAccountKey, setSelectedAccountKey] = useState<string | null>(
    null
  );

  const tokenMarketLabel = t("common:filters.tokenMarket");

  const accountEntries = useMemo(
    () => buildExpandedAccountEntries(group, accounts, tokenMarketLabel),
    [accounts, group, tokenMarketLabel]
  );

  const effectiveSelectedAccountKey =
    selectedAccountKey &&
    accountEntries.some((entry) => entry.key === selectedAccountKey)
      ? selectedAccountKey
      : (accountEntries[0]?.key ?? null);

  useEffect(() => {
    if (pendingRef.current.size === 0) return;
    // Keep pending optimistic toggles whose desired state has not yet been
    // reflected by the server. The debounced save queue may still be in
    // flight; dropping all pending entries here would roll back UI for the
    // models that haven't yet been persisted.
    setOptimisticToggles((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map(prev);
      const resolvedKeys: string[] = [];
      for (const entry of accountEntries) {
        for (const model of entry.groupModels) {
          const key = getAccountModelToggleKey(entry.account, model);
          if (!pendingRef.current.has(key)) continue;
          const desired = prev.get(key);
          if (desired === undefined) {
            resolvedKeys.push(key);
            continue;
          }
          if (desired === accountHasModel(entry.account, model)) {
            next.delete(key);
            resolvedKeys.push(key);
          }
        }
      }
      for (const key of resolvedKeys) pendingRef.current.delete(key);
      return next.size === prev.size ? prev : next;
    });
  }, [accountEntries, accounts]);

  const toggleAccountModels = useCallback(
    (entry: ExpandedAccountEntry, checked: boolean) => {
      const targetModels = [
        ...new Set(
          entry.groupModels.map(
            (model) => variantsByModel.get(model)?.base_model ?? model
          )
        ),
      ];
      const nextEnabledModels = applyModelGroupToEnabledSet(
        entry.account.enabledModels ?? [],
        targetModels,
        entry.account.availableModels ?? [],
        checked
      );

      setOptimisticToggles((prev) => {
        const next = new Map(prev);
        for (const model of entry.groupModels) {
          const key = getAccountModelToggleKey(entry.account, model);
          next.set(key, checked);
          pendingRef.current.add(key);
        }
        return next;
      });

      onUpdateAccountEnabledModels(
        entry.account.id,
        entry.account.modelType,
        nextEnabledModels
      );

      syncAccountEnabledForAccountModels(
        entry.account,
        nextEnabledModels,
        isAccountEnabled,
        onToggleAccount
      );
    },
    [
      isAccountEnabled,
      onToggleAccount,
      onUpdateAccountEnabledModels,
      variantsByModel,
    ]
  );

  const handleToggleKeyGroup = useCallback(
    (entry: ExpandedAccountEntry, checked: boolean) => {
      toggleAccountModels(entry, checked);
    },
    [toggleAccountModels]
  );

  const toggleAllAccounts = useCallback(
    (checked: boolean) => {
      for (const entry of accountEntries) {
        toggleAccountModels(entry, checked);
      }
    },
    [accountEntries, toggleAccountModels]
  );

  const selectedEntry = useMemo(
    () =>
      accountEntries.find((entry) => entry.key === effectiveSelectedAccountKey),
    [accountEntries, effectiveSelectedAccountKey]
  );

  const selectedDefaultVariantByBaseModel = useMemo(() => {
    const map = new Map<string, string>();
    for (const variant of selectedEntry?.account.defaultVariants ?? []) {
      map.set(variant.base_model, variant.model);
    }
    return map;
  }, [selectedEntry]);

  const handleChangeDefaultVariant = useCallback(
    (baseModel: string, model: string) => {
      if (!selectedEntry || !onUpdateAccountDefaultVariant) return;
      onUpdateAccountDefaultVariant(selectedEntry.account.id, baseModel, model);
    },
    [onUpdateAccountDefaultVariant, selectedEntry]
  );

  const rightPaneContent = useMemo(() => {
    if (!selectedEntry) {
      return (
        <span className="text-xs text-text-3">
          {t("modelPreview.noSources")}
        </span>
      );
    }

    const versionInfos = selectedEntry.groupModels.map(
      (model) =>
        variantsByModel.get(model) ?? {
          model,
          base_model: model,
          fast: false,
        }
    );
    const hasParsedVariants = groupHasParsedModelVariants(
      selectedEntry.groupModels
    );
    const showVersionPicker =
      selectedEntry.groupModels.length > 1 || hasParsedVariants;

    if (!showVersionPicker && selectedEntry.groupModels.length === 1) {
      const model = selectedEntry.groupModels[0];

      return (
        <InlineSplitDefaultVersionHeaderRow
          label={t("modelsTable.keyDefaultVersionOnly", {
            model: formatModelNameFull(model),
          })}
          pillLabel={t("modelsTable.variantDefault")}
        />
      );
    }

    return (
      <ModelVariantInlineCard
        variants={versionInfos}
        forceModelList={!hasParsedVariants}
        defaultVariantByBaseModel={selectedDefaultVariantByBaseModel}
        onChangeDefaultVariant={
          onUpdateAccountDefaultVariant ? handleChangeDefaultVariant : undefined
        }
        defaultRowLabel={() => t("modelsTable.currentKeySelectedVersion")}
        embedded
      />
    );
  }, [
    handleChangeDefaultVariant,
    onUpdateAccountDefaultVariant,
    selectedDefaultVariantByBaseModel,
    selectedEntry,
    t,
    variantsByModel,
  ]);

  // Left pane uses any-enabled semantics: a key is considered ON for this
  // family as long as at least one of its variants is enabled. There is no
  // mixed state — the per-variant breakdown lives in the right pane.
  const accountSummaries = accountEntries.map((entry) =>
    getAccountEnableSummary(entry, optimisticToggles)
  );
  const anyEnabledAccountCount = accountSummaries.filter(
    (summary) => summary.anyEnabled
  ).length;
  const anyAccountEnabled =
    accountEntries.length > 0 && anyEnabledAccountCount > 0;

  const renderAllSourcesRow = () => (
    <InlineSplitHeaderRow
      withSeparator
      label={t("modelsTable.availableKeys", {
        enabled: anyEnabledAccountCount,
        total: accountEntries.length,
      })}
      trailing={
        <Switch
          size="small"
          checked={anyAccountEnabled}
          onCheckedChange={toggleAllAccounts}
        />
      }
    />
  );

  const renderAccountRow = (entry: ExpandedAccountEntry) => {
    const isSelected = entry.key === effectiveSelectedAccountKey;
    const enableSummary = getAccountEnableSummary(entry, optimisticToggles);
    const switchTooltip = t(
      enableSummary.anyEnabled
        ? "modelsTable.turnOffKeyFor"
        : "modelsTable.turnOnKeyFor",
      { model: group.label }
    );

    return (
      <InlineSplitSelectableRow
        key={entry.key}
        selected={isSelected}
        onSelect={() => setSelectedAccountKey(entry.key)}
        label={
          <AccountSourceBreadcrumb
            modelType={entry.account.modelType}
            accountName={entry.account.name}
          />
        }
        switchChecked={enableSummary.anyEnabled}
        switchTooltip={switchTooltip}
        onToggle={(nextChecked) => handleToggleKeyGroup(entry, nextChecked)}
      />
    );
  };

  return (
    <InlineCardSplit
      left={
        <>
          {accountEntries.length > 0 ? renderAllSourcesRow() : null}
          {accountEntries.map((entry) => renderAccountRow(entry))}
          {accountEntries.length === 0 ? (
            <span className="px-1 text-xs text-text-3">
              {t("modelPreview.noSources")}
            </span>
          ) : null}
          {onAddKey ? (
            <InlineSplitAddKeyRow
              label={t("modelsTable.addNewKey")}
              onClick={onAddKey}
            />
          ) : null}
        </>
      }
      right={
        <div className="flex min-w-0 flex-col gap-0.5">{rightPaneContent}</div>
      }
      wrapInCard
    />
  );
};

export default ModelInlineExpandedCard;
