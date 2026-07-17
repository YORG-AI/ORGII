import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { CLI_AGENT } from "@src/api/types/keys";
import InlineAlert from "@src/components/InlineAlert";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import { AccountInlineDetails } from "@src/modules/shared/keyVault/AccountInlineDetails";

import {
  buildVariantsByModelFromAccounts,
  syncAccountEnabledForEnabledModels,
} from "../../Models/Table/integrationsModelGroups";
import {
  InlineCardBody,
  InlineCardShell,
  InlineCardTabs,
} from "../../shared/InlineCardPrimitives";
import { AccountInlineActionsBar } from "./AccountInlineActionsBar";
import { AccountInlineDeploymentSection } from "./AccountInlineDeploymentSection";
import {
  AccountInlineEditBody,
  AccountInlineEditFooter,
  useAccountInlineEditState,
} from "./AccountInlineEditSection";
import AccountModelsInlineSplit from "./AccountModelsInlineSplit";
import { isGatewayWithNoModels } from "./accountInlineGatewayTypes";

export const ACCOUNT_INLINE_TAB = {
  STATUS: "status",
  MODELS: "models",
  EDIT: "edit",
} as const;

export type AccountInlineTab =
  (typeof ACCOUNT_INLINE_TAB)[keyof typeof ACCOUNT_INLINE_TAB];

function getAccountModelToggleKey(accountId: string, model: string): string {
  return `${accountId}|${model}`;
}

const ACCOUNT_AUTH_METHOD = {
  OAUTH: "oauth",
} as const;

function supportsQuotaRefresh(account: KeyVaultAccount): boolean {
  switch (account.modelType) {
    case CLI_AGENT.CURSOR:
      return account.hasSessionToken;
    case CLI_AGENT.COPILOT:
      return account.hasApiKey;
    case CLI_AGENT.CLAUDE_CODE:
    case CLI_AGENT.CODEX:
      return (
        account.authMethod === ACCOUNT_AUTH_METHOD.OAUTH &&
        account.hasSessionToken
      );
    case CLI_AGENT.OPENCODE:
      return account.hasKey;
    // Zhipu (GLM Coding Plan) exposes a quota API; pay-as-you-go keys still
    // resolve to a "Pay-as-you-go" QuotaInfo (no bar) rather than an error.
    case "zhipu_api":
      return account.hasApiKey;
    default:
      return false;
  }
}

interface AccountInlineExpandedCardProps {
  account: KeyVaultAccount;
  activeTab: AccountInlineTab;
  onActiveTabChange: (tab: AccountInlineTab) => void;
  isAccountEnabled: boolean;
  onToggleAccount?: (account: KeyVaultAccount, enabled: boolean) => void;
  onToggleModel?: (
    model: string,
    agentType: string,
    enabled: boolean,
    accountId?: string
  ) => void;
  onUpdateAccountEnabledModels?: (
    accountId: string,
    agentType: string,
    enabledModels: readonly string[]
  ) => void;
  onUpdateAccountDefaultVariant?: (
    accountId: string,
    baseModel: string,
    model: string
  ) => void;
  onRefresh?: () => Promise<void>;
  onRevalidateAccount?: (accountId: string) => Promise<void>;
  refreshing?: boolean;
  onEditSave?: (
    accountId: string,
    name: string,
    description: string,
    baseUrl?: string
  ) => Promise<void>;
  /** When true, the Edit tab is shown and auto-activated. Driven by the
   *  parent table — set by clicking the row's pencil button, cleared when
   *  the user clicks Cancel / Save (via onEditCancel) or collapses the row. */
  editRequested?: boolean;
  onEditCancel?: () => void;
}

const AccountInlineExpandedCard: React.FC<AccountInlineExpandedCardProps> = ({
  account,
  activeTab,
  onActiveTabChange,
  isAccountEnabled,
  onToggleAccount,
  onToggleModel,
  onUpdateAccountEnabledModels,
  onUpdateAccountDefaultVariant,
  onRefresh,
  onRevalidateAccount,
  refreshing = false,
  onEditSave,
  editRequested = false,
  onEditCancel,
}) => {
  const { t } = useTranslation("integrations");
  const { t: tCommon } = useTranslation();
  const [optimisticToggles, setOptimisticToggles] = useState<
    Map<string, boolean>
  >(new Map());
  const pendingRef = useRef<Set<string>>(new Set());
  const [refreshModelsError, setRefreshModelsError] = useState<string | null>(
    null
  );

  const canEditAccount =
    !account.listingId && account.hasLocalKey && Boolean(onEditSave);
  const showEditTab = canEditAccount && editRequested;

  const tabs = useMemo(
    () => [
      {
        key: ACCOUNT_INLINE_TAB.STATUS,
        label: t("keyVault.inlineCard.tabStatus"),
      },
      {
        key: ACCOUNT_INLINE_TAB.MODELS,
        label: t("keyVault.inlineCard.tabModels"),
      },
      ...(showEditTab
        ? [
            {
              key: ACCOUNT_INLINE_TAB.EDIT,
              label: t("keyVault.edit.title"),
            },
          ]
        : []),
    ],
    [showEditTab, t]
  );

  const effectiveActiveTab = useMemo(() => {
    if (tabs.some((tab) => tab.key === activeTab)) return activeTab;
    return ACCOUNT_INLINE_TAB.STATUS;
  }, [activeTab, tabs]);

  const variantsByModel = useMemo(
    () => buildVariantsByModelFromAccounts([account]),
    [account]
  );

  const availableModels = useMemo(
    () => account.availableModels ?? [],
    [account.availableModels]
  );
  const showModels = account.status === "ready" && availableModels.length > 0;
  const showGatewayDeployment = isGatewayWithNoModels(account);

  const handleRefreshModels = useCallback(async () => {
    if (!onRevalidateAccount) return;
    setRefreshModelsError(null);
    try {
      await onRevalidateAccount(account.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRefreshModelsError(t("keyVault.refreshModels.failed", { error: msg }));
    }
  }, [account.id, onRevalidateAccount, t]);

  const handleRefreshUsage = useCallback(async () => {
    if (!onRefresh) return;
    await onRefresh();
  }, [onRefresh]);

  const showQuotaRefresh = onRefresh && supportsQuotaRefresh(account);
  const showModelRefresh = Boolean(onRevalidateAccount);

  const handleEditFormSave = useCallback(
    async (nextName: string, nextDescription: string, endpoint?: string) => {
      if (!onEditSave) return;
      await onEditSave(account.id, nextName, nextDescription, endpoint);
      onEditCancel?.();
    },
    [account.id, onEditCancel, onEditSave]
  );

  const editState = useAccountInlineEditState(account, handleEditFormSave);

  const handleEditCancel = useCallback(() => {
    onEditCancel?.();
  }, [onEditCancel]);

  const enabledSet = useMemo(() => {
    const set = new Set(account.enabledModels ?? []);
    for (const model of availableModels) {
      const key = getAccountModelToggleKey(account.id, model);
      const optimistic = optimisticToggles.get(key);
      if (optimistic !== undefined) {
        if (optimistic) {
          set.add(model);
        } else {
          set.delete(model);
        }
      }
    }
    return set;
  }, [account.enabledModels, account.id, availableModels, optimisticToggles]);

  const handleSetModelEnabled = useCallback(
    (model: string, nextEnabled: boolean) => {
      if (!onToggleModel) return;
      const key = getAccountModelToggleKey(account.id, model);
      setOptimisticToggles((prev) => new Map(prev).set(key, nextEnabled));
      pendingRef.current.add(key);
      onToggleModel(model, account.modelType, nextEnabled, account.id);

      const nextEnabledModels = new Set(account.enabledModels ?? []);
      for (const availableModel of availableModels) {
        const optimistic = optimisticToggles.get(
          getAccountModelToggleKey(account.id, availableModel)
        );
        const enabled =
          availableModel === model
            ? nextEnabled
            : optimistic !== undefined
              ? optimistic
              : nextEnabledModels.has(availableModel);
        if (enabled) {
          nextEnabledModels.add(availableModel);
        } else {
          nextEnabledModels.delete(availableModel);
        }
      }

      syncAccountEnabledForEnabledModels(
        account,
        [...nextEnabledModels],
        () => isAccountEnabled,
        onToggleAccount
      );
    },
    [
      account,
      availableModels,
      isAccountEnabled,
      onToggleAccount,
      onToggleModel,
      optimisticToggles,
    ]
  );

  const handleUpdateEnabledModels = useCallback(
    (enabledModels: readonly string[]) => {
      const nextSet = new Set(enabledModels);
      setOptimisticToggles((prev) => {
        const next = new Map(prev);
        for (const model of availableModels) {
          const key = getAccountModelToggleKey(account.id, model);
          const modelEnabled = nextSet.has(model);
          next.set(key, modelEnabled);
          pendingRef.current.add(key);
        }
        return next;
      });

      onUpdateAccountEnabledModels?.(
        account.id,
        account.modelType,
        enabledModels
      );

      syncAccountEnabledForEnabledModels(
        account,
        enabledModels,
        () => isAccountEnabled,
        onToggleAccount
      );
    },
    [
      account,
      availableModels,
      isAccountEnabled,
      onToggleAccount,
      onUpdateAccountEnabledModels,
    ]
  );

  useEffect(() => {
    if (pendingRef.current.size === 0) return;
    // Only drop optimistic entries whose desired state matches what the server
    // now reports. Pending writes still in flight (e.g. inside the debounced
    // save queue) keep their optimistic value so a refresh in the middle of a
    // group toggle doesn't roll the UI back to a half-applied state.
    const serverEnabled = new Set(account.enabledModels ?? []);
    setOptimisticToggles((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map(prev);
      const resolvedKeys: string[] = [];
      for (const model of availableModels) {
        const key = getAccountModelToggleKey(account.id, model);
        if (!pendingRef.current.has(key)) continue;
        const desired = prev.get(key);
        if (desired === undefined) {
          resolvedKeys.push(key);
          continue;
        }
        if (desired === serverEnabled.has(model)) {
          next.delete(key);
          resolvedKeys.push(key);
        }
      }
      for (const key of resolvedKeys) pendingRef.current.delete(key);
      return next.size === prev.size ? prev : next;
    });
  }, [account.enabledModels, account.id, availableModels]);

  const tabContent = useMemo(() => {
    switch (effectiveActiveTab) {
      case ACCOUNT_INLINE_TAB.STATUS:
        return <AccountInlineDetails account={account} />;
      case ACCOUNT_INLINE_TAB.EDIT:
        if (!showEditTab) return null;
        return <AccountInlineEditBody state={editState} />;
      case ACCOUNT_INLINE_TAB.MODELS:
        if (showGatewayDeployment && onRefresh) {
          return (
            <AccountInlineDeploymentSection
              account={account}
              onRefresh={onRefresh}
            />
          );
        }
        if (!showModels) {
          return (
            <span className="text-xs text-text-3">
              {t("keyVault.info.noModelsConfigured")}
            </span>
          );
        }
        return (
          <>
            {refreshModelsError ? (
              <InlineAlert
                type="danger"
                onClose={() => setRefreshModelsError(null)}
                closeAriaLabel={tCommon("actions.close")}
              >
                {refreshModelsError}
              </InlineAlert>
            ) : null}
            <AccountModelsInlineSplit
              account={account}
              enabledSet={enabledSet}
              isAccountEnabled={isAccountEnabled}
              variantsByModel={variantsByModel}
              onSetModelEnabled={
                onToggleModel ? handleSetModelEnabled : () => {}
              }
              onUpdateEnabledModels={
                onUpdateAccountEnabledModels
                  ? handleUpdateEnabledModels
                  : () => {}
              }
              onUpdateAccountDefaultVariant={onUpdateAccountDefaultVariant}
            />
          </>
        );
      default:
        return null;
    }
  }, [
    account,
    refreshModelsError,
    editState,
    effectiveActiveTab,
    enabledSet,
    handleSetModelEnabled,
    handleUpdateEnabledModels,
    isAccountEnabled,
    onRefresh,
    onToggleModel,
    onUpdateAccountEnabledModels,
    onUpdateAccountDefaultVariant,
    showEditTab,
    showGatewayDeployment,
    showModels,
    t,
    tCommon,
    variantsByModel,
  ]);

  return (
    <InlineCardShell gap="small">
      <InlineCardTabs
        tabs={tabs}
        activeTab={effectiveActiveTab}
        onChange={onActiveTabChange}
      />
      <InlineCardBody>{tabContent}</InlineCardBody>
      {effectiveActiveTab === ACCOUNT_INLINE_TAB.EDIT ? (
        <AccountInlineEditFooter
          state={editState}
          onCancel={handleEditCancel}
        />
      ) : effectiveActiveTab === ACCOUNT_INLINE_TAB.STATUS ? (
        <AccountInlineActionsBar
          account={account}
          refreshLabel={t("keyVault.quota.refreshUsage")}
          onRefresh={showQuotaRefresh ? handleRefreshUsage : undefined}
          refreshing={refreshing}
          onRefreshModels={showModelRefresh ? handleRefreshModels : undefined}
          refreshingModels={refreshing}
        />
      ) : onRevalidateAccount && showModels ? (
        <AccountInlineActionsBar
          account={account}
          onRefreshModels={handleRefreshModels}
          refreshingModels={refreshing}
        />
      ) : null}
    </InlineCardShell>
  );
};

export default AccountInlineExpandedCard;
