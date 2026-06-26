/**
 * useKeyValidation — BYOK API key validation.
 *
 * Validates a pasted API key (or Cursor session token) against the local
 * Tauri validators in `@src/api/services/keyValidation`. Returns a
 * normalized `ExtractedConfig` plus the list of available models so the
 * KeyVault Wizard can advance to Step 2. Only the `"direct"` input mode is
 * supported — the wizard accepts clean API key input only.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchKeyQuota,
  getCodexOAuthModels,
  getCursorNativeModels,
  validateKey,
} from "@src/api/services/keyValidation";
import type { ModelType as ValidationAgentType } from "@src/api/services/keyValidation";
import {
  CLI_AGENT,
  NATIVE_HARNESS_TYPE,
} from "@src/api/tauri/rpc/schemas/validation";
import type { EnvVar, QuotaSnapshot } from "@src/api/types/keyVault";
import {
  LOCAL_MODEL_PROVIDER,
  type ModelType,
  type ProviderProtocol,
  type QuotaInfo,
  type ValidateKeyResponse,
} from "@src/api/types/keys";
import { createLogger } from "@src/hooks/logger";
import { getMyKeyFallbackNativeModels } from "@src/hooks/models/nativeHarnessAccountModels";

const logger = createLogger("useKeyValidation");

const VALIDATE_KEY_FIRST_MESSAGE = "Please enter an API key first";

function cleanInput(value?: string): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

/**
 * Quota shape carried back to the wizard. Either the strict-null Tauri
 * `QuotaInfo` or the legacy flat `QuotaSnapshot`.
 */
export type ListingQuotaInfo = QuotaInfo | QuotaSnapshot;

/**
 * Configuration extracted from a successful validation pass — surfaced to
 * the wizard so it can pre-fill base URL, env vars, and quota panels.
 */
export interface ExtractedConfig {
  apiKeyPreview?: string;
  baseUrl?: string;
  envVars?: EnvVar[];
  quotaInfo?: ListingQuotaInfo;
  /** The actual extracted API key (full value). */
  actualApiKey?: string;
}

export interface UseKeyValidationOptions {
  /** Current agent type */
  agentType: ModelType;
  /** Raw API key input */
  rawKeyInput: string;
  /** Session token for OAuth-capable CLI providers. */
  cursorSessionToken?: string;
  /** Base URL for proxy services (OpenRouter, custom API endpoints, ...) */
  baseUrl?: string;
  protocol?: ProviderProtocol;
  /**
   * Input mode. Only `"direct"` is supported; values other than `"direct"`
   * log a warning and are treated as `"direct"`.
   */
  inputMode?: "direct" | "natural";
  /** Model name for auth verification when /v1/models is unavailable. */
  testModel?: string;
  /** Callback when validation succeeds. */
  onValidationSuccess?: (data: {
    models: string[];
    envVars: EnvVar[];
    extractedConfig: ExtractedConfig | null;
  }) => void;
}

export interface UseKeyValidationReturn {
  keyValidated: boolean;
  validatingKey: boolean;
  validationError: string | null;
  fetchedModels: string[] | null;
  extractedConfig: ExtractedConfig | null;
  /** Validate the API key. Pass overrideTestModel to use a specific model for auth check. */
  validateKey: (overrideTestModel?: unknown) => Promise<void>;
  resetValidation: () => void;
}

async function validateKeyDirect(request: {
  agent_type: ModelType;
  api_key: string;
  session_token?: string;
  base_url?: string;
  protocol?: ProviderProtocol;
  test_model?: string;
}): Promise<ValidateKeyResponse> {
  try {
    const result = await validateKey(
      request.agent_type as ValidationAgentType,
      request.api_key,
      request.base_url,
      request.session_token,
      request.test_model,
      request.protocol
    );

    let quotaInfo: QuotaInfo | undefined;
    if (
      result.valid &&
      request.session_token &&
      request.agent_type === CLI_AGENT.CURSOR
    ) {
      try {
        const quota = await fetchKeyQuota(
          request.agent_type as ValidationAgentType,
          request.session_token
        );
        quotaInfo = quota;
      } catch {
        // Quota fetch is best-effort.
      }
    }

    const apiKeyPreview =
      request.api_key.length > 12
        ? `${request.api_key.slice(0, 8)}...${request.api_key.slice(-4)}`
        : request.api_key;

    return {
      valid: result.valid,
      message: result.message,
      available_models: result.models_available,
      extracted_api_key_preview: apiKeyPreview,
      extracted_api_key: request.api_key,
      extracted_base_url: request.base_url,
      quota_info: quotaInfo,
    };
  } catch (err) {
    return {
      valid: false,
      message:
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Validation failed",
      available_models: [],
    };
  }
}

export function useKeyValidation(
  options: UseKeyValidationOptions
): UseKeyValidationReturn {
  const {
    agentType,
    rawKeyInput,
    cursorSessionToken,
    baseUrl,
    protocol,
    inputMode = "direct",
    testModel,
    onValidationSuccess,
  } = options;

  const [keyValidated, setKeyValidated] = useState(false);
  const [validatingKey, setValidatingKey] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null);
  const [extractedConfig, setExtractedConfig] =
    useState<ExtractedConfig | null>(null);

  const lastValidatedKeyRef = useRef<string | null>(null);

  const resetValidation = useCallback(() => {
    setKeyValidated(false);
    setFetchedModels(null);
    setExtractedConfig(null);
    setValidationError(null);
  }, []);

  useEffect(() => {
    if (lastValidatedKeyRef.current === null && !keyValidated) return;
    if (keyValidated && rawKeyInput.trim() !== lastValidatedKeyRef.current) {
      resetValidation();
    }
  }, [rawKeyInput, keyValidated, resetValidation]);

  const validateKeyCb = useCallback(
    async (overrideTestModel?: unknown) => {
      // Only direct validation is supported; warn but degrade gracefully if
      // a caller still passes "natural" so we don't crash mid-wizard.
      if (inputMode !== "direct") {
        logger.warn("Only inputMode='direct' is supported.");
      }

      const effectiveTestModel =
        typeof overrideTestModel === "string" ? overrideTestModel : undefined;

      const cleanRawKeyInput = rawKeyInput.trim();
      const cleanBaseUrl = cleanInput(baseUrl);
      const cleanCursorSessionToken = cleanInput(cursorSessionToken);

      if (!cleanRawKeyInput) {
        if (agentType === LOCAL_MODEL_PROVIDER && cleanBaseUrl) {
          setValidationError(
            "Please enter a local API key placeholder for this endpoint."
          );
        } else {
          setValidationError(VALIDATE_KEY_FIRST_MESSAGE);
        }
        return;
      }

      setValidatingKey(true);
      setValidationError(null);
      setKeyValidated(false);
      setFetchedModels(null);
      setExtractedConfig(null);

      try {
        let result: ValidateKeyResponse;
        try {
          result = await validateKeyDirect({
            agent_type: agentType,
            api_key: cleanRawKeyInput,
            base_url: cleanBaseUrl,
            protocol,
            session_token:
              agentType === CLI_AGENT.CURSOR || agentType === CLI_AGENT.CODEX
                ? cleanCursorSessionToken
                : undefined,
            test_model: effectiveTestModel ?? testModel,
          });
        } catch (backendError) {
          logger.error("Backend not available:", backendError);
          setValidationError(
            "Validation service unavailable. Please ensure the backend is running."
          );
          setValidatingKey(false);
          return;
        }

        if (result.valid) {
          lastValidatedKeyRef.current = cleanRawKeyInput;

          const envVars =
            (result as { extracted_env_vars?: EnvVar[] }).extracted_env_vars ??
            [];
          const config: ExtractedConfig = {
            apiKeyPreview: result.extracted_api_key_preview,
            baseUrl: result.extracted_base_url,
            envVars,
            quotaInfo: result.quota_info,
            actualApiKey: result.extracted_api_key,
          };

          // Cursor-specific: native discovery to fill in the model list when
          // the Rust validator only verified the key but didn't enumerate.
          let finalModels = result.available_models;
          if (
            agentType === CLI_AGENT.CURSOR &&
            cursorSessionToken &&
            finalModels.length === 0
          ) {
            try {
              logger.info("Cursor native discovery starting");
              const native = await getCursorNativeModels(cursorSessionToken);
              logger.info(
                "Cursor native discovery returned models:",
                native.length
              );
              if (native.length > 0) {
                finalModels = native;
              }
            } catch (nativeErr) {
              logger.warn("Cursor native discovery failed:", nativeErr);
            }
          }

          if (agentType === CLI_AGENT.CURSOR && finalModels.length === 0) {
            finalModels = getMyKeyFallbackNativeModels(
              NATIVE_HARNESS_TYPE.CURSOR
            );
          }

          if (
            agentType === CLI_AGENT.CODEX &&
            cursorSessionToken &&
            finalModels.length === 0
          ) {
            try {
              const native = await getCodexOAuthModels(cursorSessionToken);
              if (native.length > 0) {
                finalModels = native;
              }
            } catch (nativeErr) {
              logger.warn("Codex OAuth model discovery failed:", nativeErr);
            }
          }

          setExtractedConfig(config);
          setFetchedModels(finalModels);
          setKeyValidated(true);

          onValidationSuccess?.({
            models: finalModels,
            envVars,
            extractedConfig: config,
          });
        } else {
          setValidationError(result.message);
        }
      } catch (err) {
        logger.error("Validation failed:", err);
        setValidationError(
          err instanceof Error ? err.message : "Validation failed"
        );
      } finally {
        setValidatingKey(false);
      }
    },
    [
      rawKeyInput,
      agentType,
      cursorSessionToken,
      baseUrl,
      protocol,
      inputMode,
      testModel,
      onValidationSuccess,
    ]
  );

  return {
    keyValidated,
    validatingKey,
    validationError,
    fetchedModels,
    extractedConfig,
    validateKey: validateKeyCb,
    resetValidation,
  };
}

export default useKeyValidation;
