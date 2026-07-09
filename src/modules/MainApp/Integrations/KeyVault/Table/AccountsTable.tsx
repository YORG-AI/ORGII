import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { saveKey } from "@src/api/services/keyValidation";
import { formatModelAgentType, isApiKeyProvider } from "@src/assets/providers";
import type { SelectOption } from "@src/components/Select";
import type { SettingsTableSelectFilter } from "@src/components/SettingsTable";
import TabPill from "@src/components/TabPill";
import type { AvailableAgent } from "@src/config/cliAgents";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  InternalHeader,
  ScrollPreservation,
} from "@src/modules/shared/layouts/blocks";
import {
  accountMatchesBrandFilter,
  buildBrandProviderFilterOptions,
} from "@src/scaffold/WizardSystem/variants/KeyVault/components/providerOptions";
import { useProviderRegistry } from "@src/scaffold/WizardSystem/variants/KeyVault/config";

import {
  KeyPrivacyDisclaimer,
  ModelWikiDisclaimer,
  TrademarkDisclaimer,
} from "../../Tables/TrademarkDisclaimer";
import type { DetailMode } from "../../types";
import MyAccountsTableSection from "../Accounts/Table/MyAccountsTableSection";
import ModelWikiTableSection from "../ModelWiki/ModelWikiTableSection";
import ModelsTableSection from "../Models/Table/ModelsTableSection";

const ALL_FILTER = "all";
const MODEL_SAVE_DEBOUNCE_MS = 120;

const KEY_TYPE_FILTER = {
  ALL: "all",
  API: "api",
  SUBSCRIPTION: "subscription",
} as const;

type KeyTypeFilter = (typeof KEY_TYPE_FILTER)[keyof typeof KEY_TYPE_FILTER];

const ENABLED_FILTER = {
  ALL: "all",
  ENABLED: "enabled",
  DISABLED: "disabled",
} as const;

type EnabledFilter = (typeof ENABLED_FILTER)[keyof typeof ENABLED_FILTER];

interface AccountsTableProps {
  accounts: KeyVaultAccount[];
  loading: boolean;
  onSelect: (id: string | null, mode?: DetailMode) => void;
  onAdd: () => void;
  onRefresh?: () => Promise<void>;
  onRefreshAccountUsage?: (accountId: string) => Promise<void>;
  onEditAccount?: (accountId: string) => void;
  onEditAccountSave?: (
    accountId: string,
    name: string,
    description: string,
    baseUrl?: string
  ) => Promise<void>;
  onDisconnectAccount?: (
    accountId: string,
    deleteType?: "local" | "cloud"
  ) => void;
  onRevalidateAccount?: (accountId: string) => Promise<void>;
  refreshingAccountId?: string | null;
  selectedRowId?: string | null;
  modelsActiveTab?: string;
  onModelsTabChange?: (tab: string) => void;
  onToggleModel?: (
    model: string,
    agentType: string,
    enabled: boolean,
    accountId?: string
  ) => void | Promise<void>;
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
}

export const AccountsTable: React.FC<AccountsTableProps> = ({
  accounts,
  loading,
  onSelect,
  onAdd,
  onRefresh,
  onRefreshAccountUsage,
  onEditAccount,
  onEditAccountSave,
  onDisconnectAccount,
  onRevalidateAccount,
  refreshingAccountId,
  modelsActiveTab: modelsActiveTabProp,
  onModelsTabChange,
  onToggleModel: onToggleModelProp,
}) => {
  const { t } = useTranslation("integrations");
  const { unifiedProviders, modelTypeToProviderKey } = useProviderRegistry();
  const [searchQuery, setSearchQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState(ALL_FILTER);
  const [keyTypeFilter, setKeyTypeFilter] = useState<KeyTypeFilter>(
    KEY_TYPE_FILTER.ALL
  );
  const [enabledFilter, setEnabledFilter] = useState<EnabledFilter>(
    ENABLED_FILTER.ALL
  );

  // ── Provider filter options (derived from accounts) ───────────────────────

  const providerFilterOptions = useMemo<SelectOption[]>(
    () =>
      buildBrandProviderFilterOptions(
        accounts,
        unifiedProviders,
        modelTypeToProviderKey,
        t
      ),
    [accounts, unifiedProviders, modelTypeToProviderKey, t]
  );

  const keyTypeFilterOptions = useMemo<SelectOption[]>(
    () => [
      {
        value: KEY_TYPE_FILTER.ALL,
        label: t("keyVault.filterAllKeyTypes"),
      },
      {
        value: KEY_TYPE_FILTER.SUBSCRIPTION,
        label: t("keyVault.categorySubscription"),
      },
      {
        value: KEY_TYPE_FILTER.API,
        label: t("keyVault.categoryApi"),
      },
    ],
    [t]
  );

  const enabledFilterOptions = useMemo<SelectOption[]>(
    () => [
      {
        value: ENABLED_FILTER.ALL,
        label: t("keyVault.filterAllEnabled"),
      },
      {
        value: ENABLED_FILTER.ENABLED,
        label: t("modelsTable.statusEnabled"),
      },
      {
        value: ENABLED_FILTER.DISABLED,
        label: t("modelsTable.statusDisabled"),
      },
    ],
    [t]
  );

  const filtered = useMemo(() => {
    let rows = accounts;

    if (providerFilter !== ALL_FILTER) {
      rows = rows.filter((acc) =>
        accountMatchesBrandFilter(acc, providerFilter, modelTypeToProviderKey)
      );
    }

    if (keyTypeFilter === KEY_TYPE_FILTER.API) {
      rows = rows.filter((acc) => isApiKeyProvider(acc.modelType));
    } else if (keyTypeFilter === KEY_TYPE_FILTER.SUBSCRIPTION) {
      rows = rows.filter((acc) => !isApiKeyProvider(acc.modelType));
    }

    if (enabledFilter === ENABLED_FILTER.ENABLED) {
      rows = rows.filter((acc) => acc.enabled);
    } else if (enabledFilter === ENABLED_FILTER.DISABLED) {
      rows = rows.filter((acc) => !acc.enabled);
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      rows = rows.filter(
        (acc) =>
          acc.name.toLowerCase().includes(query) ||
          acc.modelType.toLowerCase().includes(query) ||
          formatModelAgentType(acc.modelType).toLowerCase().includes(query)
      );
    }

    return rows;
  }, [
    accounts,
    searchQuery,
    providerFilter,
    keyTypeFilter,
    enabledFilter,
    modelTypeToProviderKey,
  ]);

  const [optimisticModelEnabledByAccount, setOptimisticModelEnabledByAccount] =
    useState<Map<string, Set<string>>>(new Map());
  const optimisticModelEnabledByAccountRef = useRef<Map<string, Set<string>>>(
    new Map()
  );
  const modelSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelSaveQueueRef = useRef<Map<string, Set<string>>>(new Map());

  const flushModelSaveQueue = useCallback(() => {
    if (modelSaveTimerRef.current) {
      clearTimeout(modelSaveTimerRef.current);
      modelSaveTimerRef.current = null;
    }

    const queued = modelSaveQueueRef.current;
    if (queued.size === 0) return;
    modelSaveQueueRef.current = new Map();

    const accountById = new Map(
      accounts.map((account) => [account.id, account])
    );
    void Promise.all(
      [...queued.entries()].map(([accountId, enabledModels]) => {
        const account = accountById.get(accountId);
        if (!account) return Promise.resolve();
        return saveKey({
          id: account.id,
          agent_type: account.modelType,
          available_models: account.availableModels ?? [],
          enabled_models: [...enabledModels],
        });
      })
    )
      .then(() => onRefresh?.())
      .catch(() => {
        const empty = new Map<string, Set<string>>();
        optimisticModelEnabledByAccountRef.current = empty;
        setOptimisticModelEnabledByAccount(empty);
        void onRefresh?.();
      });
  }, [accounts, onRefresh]);

  // Keep latest flush impl in a ref so the unmount cleanup can fire any
  // pending debounced writes (e.g. user toggled a model then immediately
  // switched tabs before the 120ms debounce elapsed).
  const flushModelSaveQueueRef = useRef(flushModelSaveQueue);
  useEffect(() => {
    flushModelSaveQueueRef.current = flushModelSaveQueue;
  }, [flushModelSaveQueue]);

  useEffect(
    () => () => {
      if (modelSaveTimerRef.current) {
        clearTimeout(modelSaveTimerRef.current);
        modelSaveTimerRef.current = null;
      }
      flushModelSaveQueueRef.current();
    },
    []
  );

  const queueModelSave = useCallback(
    (accountId: string, enabledModels: Set<string>) => {
      modelSaveQueueRef.current.set(accountId, new Set(enabledModels));
      if (modelSaveTimerRef.current) {
        clearTimeout(modelSaveTimerRef.current);
      }
      modelSaveTimerRef.current = setTimeout(
        flushModelSaveQueue,
        MODEL_SAVE_DEBOUNCE_MS
      );
    },
    [flushModelSaveQueue]
  );

  const handleToggleModelInternal = useCallback(
    (
      model: string,
      agentType: string,
      nowEnabled: boolean,
      accountId?: string
    ) => {
      const targetAccounts = accounts.filter(
        (account) =>
          account.modelType === agentType &&
          (accountId ? account.id === accountId : true) &&
          (account.availableModels ?? []).includes(model)
      );

      const next = new Map(optimisticModelEnabledByAccountRef.current);
      for (const account of targetAccounts) {
        const currentEnabled = new Set(
          next.get(account.id) ?? account.enabledModels ?? []
        );
        if (nowEnabled) {
          currentEnabled.add(model);
        } else {
          currentEnabled.delete(model);
        }
        next.set(account.id, currentEnabled);
        queueModelSave(account.id, currentEnabled);
      }
      optimisticModelEnabledByAccountRef.current = next;
      setOptimisticModelEnabledByAccount(next);
    },
    [accounts, queueModelSave]
  );
  const handleToggleModel = onToggleModelProp ?? handleToggleModelInternal;

  const handleUpdateAccountEnabledModels = useCallback(
    (
      accountId: string,
      agentType: string,
      enabledModels: readonly string[]
    ) => {
      const account = accounts.find(
        (entry) => entry.id === accountId && entry.modelType === agentType
      );
      if (!account) return;

      const nextSet = new Set(enabledModels);
      const next = new Map(optimisticModelEnabledByAccountRef.current);
      next.set(accountId, nextSet);
      optimisticModelEnabledByAccountRef.current = next;
      setOptimisticModelEnabledByAccount(next);
      queueModelSave(accountId, nextSet);
    },
    [accounts, queueModelSave]
  );

  const handleUpdateAccountDefaultVariant = useCallback(
    (accountId: string, baseModel: string, model: string) => {
      const account = accounts.find((entry) => entry.id === accountId);
      if (!account) return;

      const nextDefaults = (account.defaultVariants ?? []).filter(
        (variant) => variant.base_model !== baseModel
      );
      nextDefaults.push({ base_model: baseModel, model });

      void saveKey({
        id: account.id,
        agent_type: account.modelType,
        default_variants: nextDefaults,
      })
        .then(() => onRefresh?.())
        .catch(() => onRefresh?.());
    },
    [accounts, onRefresh]
  );

  const [optimisticToggles, setOptimisticToggles] = useState<
    Map<string, boolean>
  >(new Map());
  const pendingIds = useRef<Set<string>>(new Set());

  const modelAdjustedAccounts = useMemo(() => {
    const hasModelOptimistic = optimisticModelEnabledByAccount.size > 0;
    const hasAccountOptimistic = optimisticToggles.size > 0;
    if (!hasModelOptimistic && !hasAccountOptimistic) return accounts;

    return accounts.map((account) => {
      const optimisticModels = optimisticModelEnabledByAccount.get(account.id);
      const optimisticAccountEnabled = optimisticToggles.get(account.id);
      let nextAccount = account;

      if (optimisticModels) {
        nextAccount = { ...nextAccount, enabledModels: [...optimisticModels] };
      }
      if (optimisticAccountEnabled !== undefined) {
        nextAccount = { ...nextAccount, enabled: optimisticAccountEnabled };
      }

      return nextAccount;
    });
  }, [accounts, optimisticModelEnabledByAccount, optimisticToggles]);

  const filteredAdjustedAccounts = useMemo(() => {
    const adjustedById = new Map(
      modelAdjustedAccounts.map((account) => [account.id, account])
    );
    return filtered.map((account) => adjustedById.get(account.id) ?? account);
  }, [filtered, modelAdjustedAccounts]);

  useEffect(() => {
    if (optimisticModelEnabledByAccount.size === 0) return;
    setOptimisticModelEnabledByAccount((prev) => {
      const next = new Map(prev);
      for (const account of accounts) {
        const optimisticModels = next.get(account.id);
        if (!optimisticModels) continue;
        const serverModels = new Set(account.enabledModels ?? []);
        if (
          optimisticModels.size === serverModels.size &&
          [...optimisticModels].every((model) => serverModels.has(model))
        ) {
          next.delete(account.id);
        }
      }
      if (next.size === prev.size) return prev;
      optimisticModelEnabledByAccountRef.current = next;
      return next;
    });
  }, [accounts, optimisticModelEnabledByAccount.size]);

  useEffect(() => {
    if (pendingIds.current.size === 0) return;
    setOptimisticToggles((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map(prev);
      for (const id of pendingIds.current) next.delete(id);
      pendingIds.current.clear();
      return next.size === prev.size ? prev : next;
    });
  }, [accounts]);

  const handleToggleAccount = useCallback(
    (account: KeyVaultAccount, nowEnabled: boolean) => {
      setOptimisticToggles((prev) => new Map(prev).set(account.id, nowEnabled));
      pendingIds.current.add(account.id);
      saveKey({
        id: account.id,
        agent_type: account.modelType,
        enabled: nowEnabled,
      })
        .then(() => onRefresh?.())
        .catch(() => {
          // Roll back the optimistic toggle to the original server value so
          // the switch does not stay permanently stuck in the wrong position.
          setOptimisticToggles((prev) => {
            const next = new Map(prev);
            next.delete(account.id);
            return next;
          });
          pendingIds.current.delete(account.id);
        });
    },
    [onRefresh]
  );

  const isAccountEnabled = useCallback(
    (account: KeyVaultAccount): boolean => {
      const optimistic = optimisticToggles.get(account.id);
      if (optimistic !== undefined) return optimistic;
      return account.enabled;
    },
    [optimisticToggles]
  );

  const tabs = useMemo(() => {
    return [
      { key: "models", label: t("modelsTabs.models", "Models") },
      { key: "my-accounts", label: t("modelsTabs.myAccounts", "My Keys") },
      { key: "model-wiki", label: t("modelsTabs.modelWiki", "Model Wiki") },
    ];
  }, [t]);

  const [activeTabLocal, setActiveTabLocal] = useState("models");
  const activeTabRaw = modelsActiveTabProp ?? activeTabLocal;
  const activeTab =
    activeTabRaw === "token-market" || activeTabRaw === "local-models"
      ? "models"
      : activeTabRaw;

  const setActiveTab = useCallback(
    (tab: string) => {
      onSelect?.(null);
      setActiveTabLocal(tab);
      onModelsTabChange?.(tab);
    },
    [onModelsTabChange, onSelect]
  );

  const accountSelectFilters = useMemo<SettingsTableSelectFilter[]>(
    () => [
      {
        key: "provider",
        value: providerFilter,
        defaultValue: ALL_FILTER,
        options: providerFilterOptions,
        onChange: (val) => setProviderFilter(val as string),
      },
      {
        key: "keyType",
        value: keyTypeFilter,
        defaultValue: KEY_TYPE_FILTER.ALL,
        options: keyTypeFilterOptions,
        onChange: (val) => setKeyTypeFilter(val as KeyTypeFilter),
      },
      {
        key: "enabled",
        value: enabledFilter,
        defaultValue: ENABLED_FILTER.ALL,
        options: enabledFilterOptions,
        onChange: (val) => setEnabledFilter(val as EnabledFilter),
      },
    ],
    [
      providerFilter,
      providerFilterOptions,
      keyTypeFilter,
      keyTypeFilterOptions,
      enabledFilter,
      enabledFilterOptions,
    ]
  );

  return (
    <DetailPanelContainer>
      <InternalHeader
        noPanelHeader
        contentPadding
        className={DETAIL_PANEL_TOKENS.headerWidth}
        tabs={
          <TabPill
            tabs={tabs}
            activeTab={activeTab}
            onChange={setActiveTab}
            variant="simple"
            fillWidth={false}
            size="large"
          />
        }
      />
      <ScrollPreservation className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
        <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
          <div className="flex flex-col gap-3">
            {activeTab === "models" ? (
              <ModelsTableSection
                accounts={modelAdjustedAccounts}
                loading={loading}
                onAdd={onAdd}
                onToggleModel={handleToggleModel}
                onUpdateAccountEnabledModels={handleUpdateAccountEnabledModels}
                onUpdateAccountDefaultVariant={
                  handleUpdateAccountDefaultVariant
                }
                onToggleAccount={handleToggleAccount}
                isAccountEnabled={isAccountEnabled}
                t={t}
              />
            ) : activeTab === "model-wiki" ? (
              <ModelWikiTableSection />
            ) : (
              <MyAccountsTableSection
                accounts={filteredAdjustedAccounts}
                loading={loading}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                selectFilters={accountSelectFilters}
                onAdd={onAdd}
                onEditAccount={onEditAccount}
                onDisconnectAccount={onDisconnectAccount}
                onRefreshAccounts={onRefresh}
                onRefreshAccountUsage={onRefreshAccountUsage}
                onRevalidateAccount={onRevalidateAccount}
                refreshingAccountId={refreshingAccountId}
                onToggleAccount={handleToggleAccount}
                isAccountEnabled={isAccountEnabled}
                onToggleModel={handleToggleModel}
                onUpdateAccountEnabledModels={handleUpdateAccountEnabledModels}
                onUpdateAccountDefaultVariant={
                  handleUpdateAccountDefaultVariant
                }
                onEditAccountSave={onEditAccountSave}
                t={t}
              />
            )}
            {activeTab === "my-accounts" ? (
              <KeyPrivacyDisclaimer />
            ) : activeTab === "models" ? (
              <TrademarkDisclaimer />
            ) : activeTab === "model-wiki" ? (
              <ModelWikiDisclaimer />
            ) : null}
          </div>
        </div>
      </ScrollPreservation>
    </DetailPanelContainer>
  );
};
