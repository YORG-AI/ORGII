import {
  CLI_AGENT,
  NATIVE_HARNESS_TYPE,
} from "@src/api/tauri/rpc/schemas/validation";
import { LOCAL_MODEL_PROVIDER } from "@src/api/types/keys";
import { getMyKeyFallbackNativeModels } from "@src/hooks/models/nativeHarnessAccountModels";

import type { WizardData } from "../types";

export interface ApiSetupProceedOptions {
  data: WizardData;
  isCursor: boolean;
  isCodex: boolean;
  isKiro: boolean;
  isClaudeCode: boolean;
  keyValidated: boolean;
  tokenDetected: boolean;
  sessionTokenMode: "auto" | "manual";
  manualSessionToken: string;
}

export interface ApiSetupProceedState {
  hasSessionToken: boolean;
  canProceed: boolean;
}

export function getResolvedCursorSessionToken(
  cursorSessionToken: string,
  data: WizardData
): string | undefined {
  return cursorSessionToken || data.cursor_session_token || undefined;
}

export function getApiSetupProceedState({
  data,
  isCursor,
  isCodex,
  isKiro,
  isClaudeCode,
  keyValidated,
  tokenDetected,
  sessionTokenMode,
  manualSessionToken,
}: ApiSetupProceedOptions): ApiSetupProceedState {
  const hasSessionToken =
    tokenDetected ||
    Boolean(data.cursor_session_token?.trim()) ||
    (sessionTokenMode === "manual" && !!manualSessionToken);
  const apiKeyInput =
    data.extracted_api_key?.trim() || data.raw_key_input.trim();
  const hasApiKeyInput = Boolean(apiKeyInput);
  const hasClaudeCodeOAuthToken =
    data.auth_method === "oauth" &&
    data.validated &&
    (Boolean(data.oauth_session_token?.trim()) ||
      data.env_vars.some(
        (envVar) =>
          envVar.name === "CLAUDE_CODE_REFRESH_TOKEN" &&
          envVar.value.trim() !== ""
      ));
  const isOAuthConfigured = data.auth_method === "oauth" && data.validated;
  const hasLocalModelEndpoint =
    data.agent_type === LOCAL_MODEL_PROVIDER &&
    Boolean(data.extracted_base_url?.trim()) &&
    hasApiKeyInput &&
    ((data.enabled_models?.length ?? 0) > 0 ||
      (data.custom_models?.length ?? 0) > 0 ||
      (data.available_models?.length ?? 0) > 0);
  const canProceed = isClaudeCode
    ? hasClaudeCodeOAuthToken
    : isCodex
      ? (data.auth_method === "oauth" && data.validated) ||
        (keyValidated && hasApiKeyInput) ||
        (data.validated && hasApiKeyInput)
      : isKiro
        ? tokenDetected && data.validated
        : isCursor
          ? hasSessionToken
          : hasLocalModelEndpoint ||
            isOAuthConfigured ||
            (keyValidated && hasApiKeyInput) ||
            (data.validated && hasApiKeyInput);

  return { hasSessionToken, canProceed };
}

export function getEffectiveValidationModels(
  models: string[],
  agentType: string,
  agentModels: string[]
): string[] {
  if (models.length > 0) return models;
  if (agentType === CLI_AGENT.CLAUDE_CODE) return models;
  // Codex OAuth discovery (including its baked fallback) is owned by the
  // backend catalog. Reference-price rows are only a Cursor fallback.
  if (agentType === CLI_AGENT.CODEX) return models;
  if (agentType !== CLI_AGENT.CURSOR) return models;
  if (agentModels.length > 0) return agentModels;
  return getMyKeyFallbackNativeModels(NATIVE_HARNESS_TYPE.CURSOR);
}
