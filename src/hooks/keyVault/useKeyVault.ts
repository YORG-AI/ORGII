/**
 * useKeyVault — local key vault only (~/.orgii/credentials.json).
 *
 * The OSS build only sees BYOK accounts (own_key + hosted_key), both
 * backed by the local key store file. No marketplace listing merge.
 */
import { useCallback, useMemo } from "react";

import { CLI_AGENT } from "@src/api/tauri/rpc/schemas/validation";
import type { KeyInfo, NativeHarnessType } from "@src/api/types/keys";

import type {
  AccountStatus,
  KeyVaultAccount,
  ModelType,
  UseKeyVaultOptions,
  UseKeyVaultReturn,
} from "./types";
import { useLocalKeys } from "./useLocalKeys";

function getAccountStatus(
  agentType: ModelType,
  hasApiKey: boolean,
  hasSessionToken: boolean,
  availableModels?: string[],
  authMethod?: "api_key" | "oauth"
): AccountStatus {
  if (agentType === CLI_AGENT.CURSOR) {
    return hasSessionToken || hasApiKey ? "ready" : "needs_setup";
  }

  const oauthAgents = ["kiro", "copilot"];
  if (authMethod === "oauth" || oauthAgents.includes(agentType)) {
    return hasSessionToken ? "ready" : "needs_setup";
  }

  return hasApiKey ? "ready" : "needs_setup";
}

export function useKeyVault(
  options: UseKeyVaultOptions = {}
): UseKeyVaultReturn {
  const { autoLoad = false } = options;

  const local = useLocalKeys({ autoDetect: autoLoad });
  const refreshAgents = local.refreshAgents;
  const refreshQuota = local.refreshQuota;

  const localAccounts = useMemo((): KeyVaultAccount[] => {
    const mappedAccounts = local.allKeys
      .filter((key: KeyInfo) => key.has_local_key)
      .map((keyInfo: KeyInfo) => {
        const hasApiKey = keyInfo.has_api_key ?? false;
        const hasSessionToken = keyInfo.has_session_token ?? false;
        const authMethod = keyInfo.auth_method as
          | "api_key"
          | "oauth"
          | undefined;

        const isInvalid = keyInfo.health_status === "invalid";
        const baseStatus = getAccountStatus(
          keyInfo.agent_type as ModelType,
          hasApiKey,
          hasSessionToken,
          keyInfo.available_models,
          authMethod
        );

        return {
          id: keyInfo.id,
          hasLocalKey: keyInfo.has_local_key,
          isListed: keyInfo.is_listed,
          modelType: keyInfo.agent_type as ModelType,
          name: keyInfo.name || keyInfo.agent_type,
          status: isInvalid ? "error" : baseStatus,
          hasKey: true,
          hasApiKey,
          hasSessionToken,
          authMethod,
          supportsRustAgents: keyInfo.supports_rust_agents,
          canLaunchCli: keyInfo.can_launch_cli,
          canUseNativeHarness: keyInfo.can_use_native_harness,
          nativeHarnessType:
            (keyInfo.native_harness_type as
              | NativeHarnessType
              | null
              | undefined) ?? undefined,
          apiKeyPreview: keyInfo.api_key_preview ?? undefined,
          sessionTokenPreview: keyInfo.session_token_preview ?? undefined,
          baseUrl: keyInfo.base_url,
          availableModels: keyInfo.available_models,
          enabledModels: keyInfo.enabled_models,
          sideQueryModel: keyInfo.side_query_model ?? undefined,
          modelVariants: keyInfo.model_variants,
          defaultVariants: keyInfo.default_variants,
          enabled: keyInfo.enabled,
          quotaInfo: keyInfo.quota_info as KeyVaultAccount["quotaInfo"],
          listingId: keyInfo.listing_id ?? undefined,
          healthStatus:
            keyInfo.health_status as KeyVaultAccount["healthStatus"],
          failureCount: keyInfo.oauth_refresh_failure_count,
          lastFailureMessage: keyInfo.last_validation_error ?? undefined,
          temporaryUnavailableUntil:
            keyInfo.temporary_unavailable_until ?? undefined,
          temporaryUnavailableReason:
            keyInfo.temporary_unavailable_reason ?? undefined,
          lastUpstreamStatus: keyInfo.last_upstream_status ?? undefined,
          lastUpstreamErrorType: keyInfo.last_upstream_error_type ?? undefined,
          rateLimitResetAt: keyInfo.rate_limit_reset_at ?? undefined,
          description: keyInfo.description ?? undefined,
          accountMetadata: keyInfo.account_metadata,
          connectedAt: keyInfo.created_at
            ? new Date(keyInfo.created_at)
            : undefined,
        } as KeyVaultAccount;
      });

    // The Key Vault page reflects on-disk truth. Surfaces that need
    // native-harness defaults (rust_agent paths) apply
    // `withNativeHarnessModels` at their own derive layer (see
    // `useValidatedLastPair`, `useUnifiedModelPaletteData`).
    return mappedAccounts;
  }, [local.allKeys]);

  const accounts = useMemo(() => {
    return [...localAccounts].sort((accountA, accountB) => {
      if (accountA.status === "ready" && accountB.status !== "ready") return -1;
      if (accountA.status !== "ready" && accountB.status === "ready") return 1;
      return accountA.name.localeCompare(accountB.name);
    });
  }, [localAccounts]);

  const getAccount = useCallback(
    (id: string) => accounts.find((acc) => acc.id === id),
    [accounts]
  );

  const refresh = useCallback(
    async (_force?: boolean): Promise<void> => {
      await refreshAgents(true);
    },
    [refreshAgents]
  );

  const refreshAccount = useCallback(
    async (accountId: string, force?: boolean): Promise<boolean> => {
      const account = accounts.find((acc) => acc.id === accountId);
      if (!account) return false;
      return refreshQuota(account.modelType, accountId, force);
    },
    [accounts, refreshQuota]
  );

  return {
    accounts,
    localAccounts,
    loading: local.loading,
    error: local.error,
    refresh,
    refreshAccount,
    getAccount,
    saveKey: local.saveKey,
    deleteKey: local.deleteKey,
  };
}

export default useKeyVault;
