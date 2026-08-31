/**
 * Business logic hook for Key Vault (Integrations) — BYOK-only.
 *
 * Wizard open-state is read from the URL via {@link useWizardParam}:
 *
 *   ?wizard=key-add              → add a new BYOK key (CLI agent or API key)
 *
 * Renaming an existing account happens inline inside the table's expanded
 * card (Edit tab) — there is no standalone edit wizard.
 *
 * Listing / publishing is not part of the Key Vault. Keys live locally; any
 * marketplace flow is handled by separate surfaces.
 */
import { useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import { getFullKey, validateKey } from "@src/api/services/keyValidation";
import type { SaveKeyRequest as RpcSaveKeyRequest } from "@src/api/tauri/rpc/schemas/validation";
import type { ModelType, SaveKeyRequest } from "@src/api/types/keys";
import Message from "@src/components/Message";
import {
  CODEX_REAUTH_RETURN_TO_STATE_KEY,
  WIZARD_IDS,
  buildIntegrationsPath,
  parseCodexReauthIntent,
} from "@src/config/mainAppPaths";
import { useKeyVault } from "@src/hooks/keyVault";
import { createLogger } from "@src/hooks/logger";
import { useWizardParam } from "@src/hooks/navigation";
import { clearStaleAccountIdAtom } from "@src/store/session/creatorDefaultModelAtom";

import { disconnectAccount } from "./disconnectAccount";
import {
  formatRefreshSummary,
  refreshAccountModels,
  refreshAllAccountModels,
  refreshSummaryTone,
} from "./refreshAccountModels";

const log = createLogger("KeyVaultPage");

function readCodexReauthReturnTo(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const returnTo = (state as Record<string, unknown>)[
    CODEX_REAUTH_RETURN_TO_STATE_KEY
  ];
  return typeof returnTo === "string" &&
    (returnTo === "/orgii/app" || returnTo.startsWith("/orgii/app/"))
    ? returnTo
    : null;
}

export function useKeyVaultPage() {
  const { t } = useTranslation("integrations");
  const navigate = useNavigate();
  const location = useLocation();
  const {
    accounts,
    loading,
    hasLoaded,
    error,
    refresh,
    refreshAccount,
    getAccount,
    saveKey,
    deleteKey,
  } = useKeyVault();
  const clearStaleSelection = useSetAtom(clearStaleAccountIdAtom);

  // State
  const [searchQuery, setSearchQuery] = useState("");
  const [agentTypeFilter, setAgentTypeFilter] = useState<ModelType | null>(
    null
  );
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
    null
  );
  const [formLoading, setFormLoading] = useState(false);
  const [refreshLoading, setRefreshLoading] = useState(false);
  const [refreshingAccountId, setRefreshingAccountId] = useState<string | null>(
    null
  );
  const [refreshingAllModels, setRefreshingAllModels] = useState(false);

  // Wizard open-state derived from URL
  const { wizard, entityId, openWizard } = useWizardParam();
  const showAddForm = wizard === WIZARD_IDS.KEY_ADD;
  const codexReauthIntent = parseCodexReauthIntent(location.search);
  const isCodexReauth = showAddForm && codexReauthIntent.active;
  const explicitReauthAccount = entityId ? getAccount(entityId) : undefined;
  const soleCodexAccount = useMemo(() => {
    const codexAccounts = accounts.filter(
      (account) => account.modelType === "codex"
    );
    return codexAccounts.length === 1 ? codexAccounts[0] : undefined;
  }, [accounts]);
  const reauthAccount = isCodexReauth
    ? (explicitReauthAccount ?? soleCodexAccount)
    : undefined;
  const reauthAccountId =
    reauthAccount?.id ?? (isCodexReauth ? entityId : null);
  const isResolvingReauthAccount =
    isCodexReauth && !hasLoaded && !reauthAccount;
  const reauthReturnTo = isCodexReauth
    ? readCodexReauthReturnTo(location.state)
    : null;

  const closeKeyVaultWizard = useCallback(() => {
    if (reauthReturnTo) {
      navigate(reauthReturnTo, { replace: true });
      return;
    }
    navigate(buildIntegrationsPath({ category: "models" }), { replace: true });
  }, [navigate, reauthReturnTo]);

  // Initial load
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Computed
  const agentTypes = useMemo(
    () => [...new Set(accounts.map((acc) => acc.modelType))].sort(),
    [accounts]
  );

  const filteredAccounts = useMemo(() => {
    return accounts.filter((acc) => {
      if (agentTypeFilter && acc.modelType !== agentTypeFilter) return false;

      if (searchQuery) {
        const queryLower = searchQuery.toLowerCase();
        if (
          !acc.name.toLowerCase().includes(queryLower) &&
          !acc.modelType.toLowerCase().includes(queryLower)
        )
          return false;
      }

      return true;
    });
  }, [accounts, agentTypeFilter, searchQuery]);

  const selectedAccount = useMemo(
    () => getAccount(selectedAccountId || ""),
    [getAccount, selectedAccountId]
  );

  // Handlers
  const handleAccountSelect = useCallback(
    (id: string | null) => {
      setSelectedAccountId(id);
      closeKeyVaultWizard();
    },
    [closeKeyVaultWizard]
  );

  const handleRefreshAccount = useCallback(
    async (accountId: string) => {
      setRefreshingAccountId(accountId);
      setRefreshLoading(true);
      try {
        const account = getAccount(accountId);
        if (!account) return;
        const name = account.name || "Account";

        await refreshAccountModels(account);
        await refresh();
        Message.success(t("keyVault.toasts.refreshed", { name }), 5000);
      } catch (err) {
        const name = getAccount(accountId)?.name || "Account";
        const detail = err instanceof Error ? err.message : String(err);
        Message.error(
          t("keyVault.toasts.refreshError", { name, error: detail }),
          5000
        );
        log.error("[Refresh] Error:", err);
      } finally {
        setRefreshingAccountId(null);
        setRefreshLoading(false);
      }
    },
    [getAccount, refresh, t]
  );

  const handleRefreshAllModels = useCallback(async () => {
    if (accounts.length === 0) return;
    setRefreshingAllModels(true);
    setRefreshLoading(true);
    try {
      const summary = await refreshAllAccountModels(accounts);
      await refresh();
      Message[refreshSummaryTone(summary)](
        formatRefreshSummary(summary, t),
        5000
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      Message.error(
        t("keyVault.toasts.refreshError", { name: "Models", error: detail }),
        5000
      );
      log.error("[RefreshAll] Error:", err);
    } finally {
      setRefreshingAllModels(false);
      setRefreshLoading(false);
    }
  }, [accounts, refresh, t]);

  const handleRefreshAccountUsage = useCallback(
    async (accountId: string) => {
      setRefreshingAccountId(accountId);
      setRefreshLoading(true);
      try {
        const account = getAccount(accountId);
        if (!account) return;
        const name = account.name || "Account";

        const refreshed = await refreshAccount(accountId, true);
        if (!refreshed) {
          throw new Error("Usage refresh failed");
        }
        await refresh();
        Message.success(t("keyVault.toasts.refreshed", { name }), 5000);
      } catch (err) {
        const name = getAccount(accountId)?.name || "Account";
        const detail = err instanceof Error ? err.message : String(err);
        Message.error(
          t("keyVault.toasts.refreshError", { name, error: detail }),
          5000
        );
        log.error("[RefreshUsage] Error:", err);
      } finally {
        setRefreshingAccountId(null);
        setRefreshLoading(false);
      }
    },
    [getAccount, refresh, refreshAccount, t]
  );

  const handleRefresh = useCallback(async () => {
    if (!selectedAccountId) return;
    await handleRefreshAccountUsage(selectedAccountId);
  }, [handleRefreshAccountUsage, selectedAccountId]);

  // Second arg (deleteType) is ignored — OSS only deletes local keys.
  const handleDisconnect = useCallback(
    (accountId: string, _deleteType?: "local" | "cloud") =>
      disconnectAccount(accountId, {
        getAccount,
        deleteKey,
        refresh,
        selectedAccountId,
        setSelectedAccountId,
        clearStaleModelSelection: clearStaleSelection,
        t,
      }),
    [getAccount, deleteKey, refresh, selectedAccountId, clearStaleSelection, t]
  );

  const handleFormSubmit = useCallback(
    async (data: RpcSaveKeyRequest) => {
      setFormLoading(true);
      try {
        const saveRequest: SaveKeyRequest = {
          ...(data as SaveKeyRequest),
          ...(reauthAccountId ? { id: reauthAccountId } : {}),
          has_local_key: true,
          is_listed: false,
        };

        const saved = await saveKey(saveRequest);
        await refresh();
        closeKeyVaultWizard();
        if (saved?.id) setSelectedAccountId(saved.id);
      } catch (err) {
        Message.error(
          err instanceof Error ? err.message : t("common:status.saveFailed")
        );
        log.error("Submit error:", err);
      } finally {
        setFormLoading(false);
      }
    },
    [saveKey, refresh, t, closeKeyVaultWizard, reauthAccountId]
  );

  const handleEditAccountSave = useCallback(
    async (
      accountId: string,
      name: string,
      description: string,
      baseUrl?: string
    ) => {
      const account = getAccount(accountId);
      if (!account) return;
      try {
        const request: SaveKeyRequest = {
          id: account.id,
          agent_type: account.modelType,
          name,
          description,
        };

        if (baseUrl && baseUrl !== account.baseUrl) {
          const fullKey = await getFullKey(account.modelType, account.id);
          if (!fullKey?.api_key) {
            throw new Error("Account has no API key.");
          }
          const validation = await validateKey(
            account.modelType,
            fullKey.api_key,
            baseUrl,
            undefined,
            undefined,
            account.protocol ?? undefined
          );
          if (!validation.valid) {
            throw new Error(
              validation.message || "Endpoint validation failed."
            );
          }
          request.base_url = baseUrl;
          request.available_models = validation.models_available;
          request.enabled_models = validation.models_available.slice(0, 1);
          request.default_variants = [];
          request.model_variants = validation.models_available.map((model) => ({
            model,
            base_model: model,
            fast: false,
            context_window: validation.model_context_lengths?.[model],
          }));
        }

        await saveKey(request);
        await refresh();
      } catch (err) {
        Message.error(
          err instanceof Error ? err.message : t("common:status.saveFailed")
        );
        throw err;
      }
    },
    [getAccount, refresh, saveKey, t]
  );

  return {
    // Data
    accounts,
    loading: loading || refreshLoading,
    error,
    agentTypes,
    filteredAccounts,
    selectedAccount,

    // Filter state
    searchQuery,
    setSearchQuery,
    agentTypeFilter,

    // Form state
    showAddForm: showAddForm && !isResolvingReauthAccount,
    formLoading,
    selectedAccountId,
    formInitialAgentType: isCodexReauth ? ("codex" as const) : undefined,
    formInitialData: isCodexReauth
      ? {
          name: reauthAccount?.name ?? "",
          setup_method: "signin",
        }
      : undefined,
    formExistingAccountNames: accounts
      .filter((account) => account.id !== reauthAccountId)
      .map((account) => account.name),
    autoStartCodexLogin: isCodexReauth && codexReauthIntent.autoStart,

    // Handlers
    handleAccountSelect,
    handleAgentTypeFilter: setAgentTypeFilter,
    handleRefresh,
    handleRefreshAccount,
    handleRefreshAccountUsage,
    handleRefreshAllModels,
    refreshingAccountId,
    refreshingAllModels,
    handleDisconnect,
    handleAddAccount: () => {
      setSelectedAccountId(null);
      openWizard(WIZARD_IDS.KEY_ADD);
    },
    handleFormSubmit,
    handleFormCancel: closeKeyVaultWizard,
    handleEditAccountSave,
    refresh,
    saveKey,
  };
}
