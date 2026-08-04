import type { TFunction } from "i18next";
import type { Dispatch } from "react";
import { useCallback, useMemo, useRef } from "react";

import {
  autoDetectKey,
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
import {
  type CredentialDetectionEvent,
  getCredentialDetectionErrorMessage,
  withCredentialDetectionTimeout,
} from "./credentialDetectionState";
import { applyKey } from "./keyHelpers";
import { useProviderConfig } from "./useProviderConfig";

const log = createLogger("ApiSetup");

/** Matches the `zen` entry of `OPENCODE_ENDPOINTS` in `provider_config.rs`. */
const OPENCODE_ZEN_ENDPOINT_ID = "zen";
const OAUTH_MODEL_CATALOG_TIMEOUT_MS = 30_000;

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
  detectedKeys: DetectedKey[];
  selectedCredentialIndex: number;
  setDetectingToken: (value: boolean) => void;
  setTokenDetected: (value: boolean) => void;
  setTokenError: (value: string | null) => void;
  setCursorSessionToken: (value: string) => void;
  setShowKeySelection: (value: boolean) => void;
  setDetectedKeys: (value: DetectedKey[]) => void;
  setSelectedCredentialIndex: (value: number) => void;
  dispatchCredentialDetection: Dispatch<CredentialDetectionEvent>;
}

export function useApiSetupTokenDetection({
  data,
  onChange,
  t,
  isCursor,
  isOAuthAgent,
  isClaudeCode,
  isCodex,
  detectedKeys,
  selectedCredentialIndex,
  setDetectingToken,
  setTokenDetected,
  setTokenError,
  setCursorSessionToken,
  setShowKeySelection,
  setDetectedKeys,
  setSelectedCredentialIndex,
  dispatchCredentialDetection,
}: UseApiSetupTokenDetectionOptions) {
  const detectionInFlightRef = useRef(false);
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
        const result = applyKey(cred, {
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
        dispatchCredentialDetection(
          result.applied
            ? { type: "succeeded", modelCount: result.modelCount }
            : {
                type: "failed",
                message:
                  result.error ??
                  t("keyVault.quickActions.keyValidationFailed"),
              }
        );
        return result;
      }

      if (isClaudeCode || isCodex) {
        dispatchCredentialDetection({ type: "catalog_requested" });
      }
      const catalog =
        isClaudeCode || isCodex
          ? await withCredentialDetectionTimeout(
              getOAuthModelCatalog(
                isClaudeCode ? CLI_AGENT.CLAUDE_CODE : CLI_AGENT.CODEX,
                {
                  accessToken: cred.session_token ?? cred.api_key ?? undefined,
                  refreshToken: isClaudeCode
                    ? cred.env_vars?.CLAUDE_CODE_REFRESH_TOKEN
                    : cred.env_vars?.OPENAI_REFRESH_TOKEN,
                  idToken: cred.env_vars?.OPENAI_ID_TOKEN,
                }
              ),
              OAUTH_MODEL_CATALOG_TIMEOUT_MS,
              t("common:errors.api.messages.timeout")
            )
          : undefined;
      const result = applyKey(cred, {
        onChange,
        setTokenDetected,
        setCursorSessionToken,
        setTokenError,
        setShowKeySelection,
        isCursor,
        isOAuthAgent,
        oauthCatalog: catalog,
        noValidTokenMsg: t("keyVault.noValidTokenFound"),
        validationFailedMsg: t("keyVault.quickActions.keyValidationFailed"),
      });
      dispatchCredentialDetection(
        result.applied
          ? { type: "succeeded", modelCount: result.modelCount }
          : {
              type: "failed",
              message:
                result.error ?? t("keyVault.quickActions.keyValidationFailed"),
            }
      );
      return result;
    },
    [
      data.agent_type,
      dispatchCredentialDetection,
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
    if (detectionInFlightRef.current) return;
    detectionInFlightRef.current = true;
    setDetectingToken(true);
    setTokenError(null);
    setTokenDetected(false);
    dispatchCredentialDetection({ type: "begin" });

    try {
      const result = await autoDetectKey(data.agent_type);

      if (!result.success) {
        const message = result.message || t("keyVault.couldNotDetectKeys");
        setTokenError(message);
        dispatchCredentialDetection({ type: "failed", message });
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
        const message = t("keyVault.couldNotDetectKeys");
        setTokenError(message);
        dispatchCredentialDetection({ type: "failed", message });
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
        dispatchCredentialDetection({
          type: "credentials_found",
          count: candidateKeys.length,
        });
        return;
      }

      await applySelectedKey(candidateKeys[0]);
    } catch (err) {
      log.error("[ApiSetup] Failed to auto-detect credentials:", err);
      const message = getCredentialDetectionErrorMessage(
        err,
        t("keyVault.failedToDetectKeys")
      );
      setTokenError(message);
      dispatchCredentialDetection({ type: "failed", message });
    } finally {
      detectionInFlightRef.current = false;
      setDetectingToken(false);
    }
  }, [
    data.agent_type,
    data.extracted_base_url,
    openCodeEndpoints,
    applySelectedKey,
    dispatchCredentialDetection,
    isClaudeCode,
    setDetectedKeys,
    setDetectingToken,
    setSelectedCredentialIndex,
    setShowKeySelection,
    setTokenDetected,
    setTokenError,
    t,
  ]);

  const handleConfirmKeySelection = useCallback(async () => {
    if (detectionInFlightRef.current) return;
    const selected = detectedKeys[selectedCredentialIndex];
    if (!selected) {
      const message = t("keyVault.quickActions.noValidKeys");
      setTokenError(message);
      setShowKeySelection(false);
      dispatchCredentialDetection({ type: "failed", message });
      return;
    }

    detectionInFlightRef.current = true;
    setShowKeySelection(false);
    setDetectingToken(true);
    setTokenError(null);
    try {
      await applySelectedKey(selected);
    } catch (err) {
      log.error("[ApiSetup] Failed to apply detected credential:", err);
      const message = getCredentialDetectionErrorMessage(
        err,
        t("keyVault.failedToDetectKeys")
      );
      setTokenError(message);
      dispatchCredentialDetection({ type: "failed", message });
    } finally {
      detectionInFlightRef.current = false;
      setDetectingToken(false);
    }
  }, [
    applySelectedKey,
    detectedKeys,
    dispatchCredentialDetection,
    selectedCredentialIndex,
    setDetectingToken,
    setShowKeySelection,
    setTokenError,
    t,
  ]);

  return { handleAutoDetectToken, handleConfirmKeySelection };
}
