import type { TFunction } from "i18next";
import { type MutableRefObject, useCallback, useMemo } from "react";

import {
  autoDetectKey,
  getCodexOAuthModels as fetchCodexOAuthModels,
  getOAuthModelCatalog,
  validateKey,
} from "@src/api/services/keyValidation";
import { CLI_AGENT } from "@src/api/tauri/rpc/schemas/validation";
import type { ProviderEndpoint } from "@src/api/tauri/rpc/schemas/validation";
import type { DetectedKey } from "@src/api/types/keys";
import { createLogger } from "@src/hooks/logger";

import {
  findEndpointByBaseUrl,
  resolveSelectedEndpoint,
} from "../config/providerEndpoints";
import type { WizardData } from "../types";
import { applyKey } from "./keyHelpers";
import { useProviderConfig } from "./useProviderConfig";

const log = createLogger("ApiSetup");

/** Matches the `zen` entry of `OPENCODE_ENDPOINTS` in `provider_config.rs`. */
const OPENCODE_ZEN_ENDPOINT_ID = "zen";

/**
 * A Zen key authenticates against both OpenCode endpoints, but a Go key is
 * workspace-scoped and Zen rejects it. A detected key's origin endpoint
 * therefore constrains which endpoint it can be reused for.
 */
function canUseDetectedOpenCodeKeyForEndpoint(
  endpoints: readonly ProviderEndpoint[],
  key: DetectedKey,
  selectedEndpointId: string
): boolean {
  const keyEndpoint = findEndpointByBaseUrl(endpoints, key.base_url);
  if (!keyEndpoint) return false;
  if (selectedEndpointId === OPENCODE_ZEN_ENDPOINT_ID) {
    return keyEndpoint.id === OPENCODE_ZEN_ENDPOINT_ID;
  }
  return true;
}

async function validateDetectedOpenCodeKeyForEndpoint(
  key: DetectedKey,
  baseUrl: string
): Promise<DetectedKey> {
  if (!key.api_key) return key;
  const validation = await validateKey("opencode", key.api_key, baseUrl);
  return {
    ...key,
    base_url: baseUrl,
    validated: validation.valid,
    validation_message: validation.message,
    available_models: validation.models_available ?? [],
  };
}

interface UseApiSetupTokenDetectionOptions {
  data: WizardData;
  onChange: (updates: Partial<WizardData>) => void;
  t: TFunction<"integrations">;
  isCursor: boolean;
  isOAuthAgent: boolean;
  isClaudeCode: boolean;
  isCodex: boolean;
  agentModelsRef: MutableRefObject<string[]>;
  detectedKeys: DetectedKey[];
  selectedCredentialIndex: number;
  setDetectingToken: (value: boolean) => void;
  setTokenDetected: (value: boolean) => void;
  setTokenError: (value: string | null) => void;
  setCursorSessionToken: (value: string) => void;
  setShowKeySelection: (value: boolean) => void;
  setDetectedKeys: (value: DetectedKey[]) => void;
  setSelectedCredentialIndex: (value: number) => void;
}

export function useApiSetupTokenDetection({
  data,
  onChange,
  t,
  isCursor,
  isOAuthAgent,
  isClaudeCode,
  isCodex,
  agentModelsRef,
  detectedKeys,
  selectedCredentialIndex,
  setDetectingToken,
  setTokenDetected,
  setTokenError,
  setCursorSessionToken,
  setShowKeySelection,
  setDetectedKeys,
  setSelectedCredentialIndex,
}: UseApiSetupTokenDetectionOptions) {
  // OpenCode's Zen/Go endpoints come from the Rust provider registry, same as
  // every other provider's — autodetect must not re-hardcode their URLs.
  const { config: openCodeConfig } = useProviderConfig(CLI_AGENT.OPENCODE);
  const openCodeEndpoints = useMemo(
    () => openCodeConfig?.endpoints ?? [],
    [openCodeConfig?.endpoints]
  );

  const applySelectedKey = useCallback(
    async (cred: DetectedKey) => {
      if (data.agent_type === "opencode" && cred.api_key) {
        const models = cred.available_models ?? [];
        applyKey(cred, {
          onChange,
          setTokenDetected,
          setCursorSessionToken,
          setTokenError,
          setShowKeySelection,
          isCursor,
          isOAuthAgent,
          fallbackModels: models,
          noValidTokenMsg: t("keyVault.noValidTokenFound"),
          validationFailedMsg: t("keyVault.quickActions.keyValidationFailed"),
        });
        return;
      }

      const catalog = isClaudeCode
        ? await getOAuthModelCatalog(CLI_AGENT.CLAUDE_CODE)
        : isCodex
          ? await getOAuthModelCatalog(CLI_AGENT.CODEX)
          : { models: [], defaultEnabledModels: [] };
      let fallbackModels =
        isCodex && agentModelsRef.current.length > 0
          ? agentModelsRef.current
          : catalog.models;
      if (isCodex && cred.session_token) {
        const idToken = cred.env_vars?.OPENAI_ID_TOKEN;
        try {
          const discovered = await fetchCodexOAuthModels(
            cred.session_token,
            idToken
          );
          if (discovered.length > 0) fallbackModels = discovered;
        } catch (err) {
          log.warn(
            "[ApiSetup] Codex OAuth model discovery failed during auto-detect; using fallback models:",
            err
          );
        }
      }
      const defaultEnabledModels = catalog.defaultEnabledModels.filter(
        (modelId) => fallbackModels.includes(modelId)
      );
      applyKey(cred, {
        onChange,
        setTokenDetected,
        setCursorSessionToken,
        setTokenError,
        setShowKeySelection,
        isCursor,
        isOAuthAgent,
        fallbackModels,
        defaultEnabledModels:
          isClaudeCode || isCodex
            ? defaultEnabledModels.length > 0
              ? defaultEnabledModels
              : fallbackModels.slice(0, 1)
            : undefined,
        noValidTokenMsg: t("keyVault.noValidTokenFound"),
        validationFailedMsg: t("keyVault.quickActions.keyValidationFailed"),
      });
    },
    [
      data.agent_type,
      agentModelsRef,
      isClaudeCode,
      isCodex,
      isOAuthAgent,
      isCursor,
      onChange,
      setCursorSessionToken,
      setShowKeySelection,
      setTokenDetected,
      setTokenError,
      t,
    ]
  );

  const handleAutoDetectToken = useCallback(async () => {
    setDetectingToken(true);
    setTokenError(null);
    setTokenDetected(false);

    try {
      const result = await autoDetectKey(data.agent_type);

      if (!result.success) {
        setTokenError(result.message || t("keyVault.couldNotDetectKeys"));
        return;
      }

      const keys = result.keys || [];
      const selectedOpenCodeEndpoint =
        data.agent_type === CLI_AGENT.OPENCODE
          ? resolveSelectedEndpoint(openCodeEndpoints, data.extracted_base_url)
          : undefined;
      const candidateKeys = selectedOpenCodeEndpoint
        ? await Promise.all(
            keys
              .filter((key) =>
                canUseDetectedOpenCodeKeyForEndpoint(
                  openCodeEndpoints,
                  key,
                  selectedOpenCodeEndpoint.id
                )
              )
              .map((key) =>
                validateDetectedOpenCodeKeyForEndpoint(
                  key,
                  selectedOpenCodeEndpoint.base_url
                )
              )
          )
        : keys;

      if (candidateKeys.length === 0) {
        setTokenError(t("keyVault.couldNotDetectKeys"));
        return;
      }

      if (candidateKeys.length > 1) {
        setDetectedKeys(candidateKeys);
        const validOAuthIndex = candidateKeys.findIndex(
          (cred) => cred.auth_method === "oauth" && cred.validated
        );
        const validApiKeyIndex = candidateKeys.findIndex(
          (cred) => cred.auth_method === "api_key" && cred.validated
        );
        const firstValidIndex = candidateKeys.findIndex(
          (cred) => cred.validated
        );
        setSelectedCredentialIndex(
          isClaudeCode && validOAuthIndex >= 0
            ? validOAuthIndex
            : validApiKeyIndex >= 0
              ? validApiKeyIndex
              : firstValidIndex >= 0
                ? firstValidIndex
                : 0
        );
        setShowKeySelection(true);
        return;
      }

      applySelectedKey(candidateKeys[0]);
    } catch (err) {
      log.error("[ApiSetup] Failed to auto-detect credentials:", err);
      setTokenError(t("keyVault.failedToDetectKeys"));
    } finally {
      setDetectingToken(false);
    }
  }, [
    data.agent_type,
    data.extracted_base_url,
    openCodeEndpoints,
    applySelectedKey,
    isClaudeCode,
    setDetectedKeys,
    setDetectingToken,
    setSelectedCredentialIndex,
    setShowKeySelection,
    setTokenDetected,
    setTokenError,
    t,
  ]);

  const handleConfirmKeySelection = useCallback(() => {
    const selected = detectedKeys[selectedCredentialIndex];
    if (selected) {
      applySelectedKey(selected);
    }
  }, [detectedKeys, selectedCredentialIndex, applySelectedKey]);

  return { handleAutoDetectToken, handleConfirmKeySelection };
}
