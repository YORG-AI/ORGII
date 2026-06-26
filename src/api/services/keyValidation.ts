/**
 * Key Validation Service
 *
 * Typed wrappers around the Rust validation backend via RPC.
 * All logic lives in Rust — this module is a thin TypeScript API surface.
 *
 * Supported providers:
 * - Copilot: GitHub PAT validation + quota fetching
 * - Cursor: CLI-based validation + quota fetching
 * - OpenAI: API key validation + model listing
 * - Anthropic: API key validation + model listing
 * - Google/Gemini: API key validation (native + proxy)
 */
import { rpc } from "@src/api/tauri/rpc";
import type {
  AutoDetectResult,
  ClaudeCodeOauthExchangeResponse,
  ClaudeCodeOauthStartResponse,
  CodexOauthExchangeResponse,
  CodexOauthStartResponse,
  FullKeyResponse,
  GeminiOauthExchangeResponse,
  GeminiOauthStartResponse,
  HealthStatus,
  KeyInfo,
  ModelType,
  ProviderProtocol,
  QuotaInfo,
  SaveKeyRequest,
  ValidationResult,
} from "@src/api/tauri/rpc/schemas/validation";

export type {
  ModelType,
  AuthMethod,
  AutoDetectResult,
  ClaudeCodeOauthExchangeResponse,
  ClaudeCodeOauthStartResponse,
  CodexOauthExchangeResponse,
  CodexOauthStartResponse,
  DetectedKey,
  DetectedQuotaInfo,
  FullKeyResponse,
  GeminiOauthExchangeResponse,
  GeminiOauthStartResponse,
  HealthStatus,
  KeyInfo,
  ProviderProtocol,
  QuotaInfo,
  SaveKeyRequest,
  UsageItem,
  ValidationResult,
} from "@src/api/tauri/rpc/schemas/validation";

export type { ModelAliasInfo } from "@src/api/types/keys";

function cleanOptionalString(value?: string): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a key for a given agent type.
 *
 * @param testModel - Fallback model for proxies that don't support /v1/models.
 *   The validator falls back to a minimal /v1/messages call using this model.
 */
export async function validateKey(
  agentType: ModelType,
  apiKey: string,
  baseUrl?: string,
  sessionToken?: string,
  testModel?: string,
  protocol?: ProviderProtocol
): Promise<ValidationResult> {
  return rpc.validation.validateKey({
    agentType,
    apiKey: apiKey.trim(),
    baseUrl: cleanOptionalString(baseUrl),
    sessionToken: cleanOptionalString(sessionToken),
    testModel: cleanOptionalString(testModel),
    protocol: protocol ?? null,
  });
}

/**
 * Test whether a specific model is available on an endpoint.
 * Sends a minimal completion request (max_tokens=1) to verify.
 */
export async function testModelAvailability(
  apiKey: string,
  baseUrl: string,
  model: string,
  agentType: ModelType
): Promise<{ available: boolean; message: string }> {
  return rpc.validation.testModelAvailability({
    // Trim all incoming string parameters
    apiKey: apiKey.trim(),
    baseUrl: baseUrl.trim(),
    model: model.trim(),
    agentType,
  });
}

/** Fetch quota for a validated key (supports Copilot and Cursor). */
export async function fetchKeyQuota(
  agentType: ModelType,
  apiKey: string
): Promise<QuotaInfo> {
  return rpc.validation.fetchKeyQuota({
    agentType,
    apiKey: apiKey.trim(),
  });
}

/**
 * Get available models for Cursor CLI via local CLI command.
 * Used when listing on market to get real model list instead of defaults.
 */
export async function getCursorCliModels(apiKey: string): Promise<string[]> {
  return rpc.validation.getCursorCliModels({ apiKey });
}

/**
 * Get available models by calling Cursor's native discovery API directly.
 * Preferred over `getCursorCliModels` when a session token is available —
 * no local `cursor` CLI install required, and the list reflects the account's
 * full Cursor catalog. Returns model IDs only (metadata like context length
 * must still be enriched from tunables/reference prices).
 *
 * @param sessionToken - Cursor session token (either `userId::JWT` cookie
 *   format or bare JWT from `cursorAuth/accessToken`).
 */
export async function getCursorNativeModels(
  sessionToken: string
): Promise<string[]> {
  const models = await rpc.validation.cursorListModelsNative({ sessionToken });
  return models.map((m) => m.modelId);
}

export async function getClaudeCodeOAuthModels(
  accessToken: string
): Promise<string[]> {
  return rpc.validation.claudeCodeOauthListModels({ accessToken });
}

export async function getCodexOAuthModels(
  accessToken: string,
  idToken?: string
): Promise<string[]> {
  return rpc.validation.codexOauthListModels({
    request: {
      access_token: accessToken,
      id_token: idToken ?? null,
    },
  });
}

export async function getGeminiOAuthModels(
  accessToken: string,
  projectId?: string | null
): Promise<string[]> {
  return rpc.validation.geminiOauthListModels({ accessToken, projectId });
}

/**
 * Force-refresh an OAuth account's access token after a list-models call
 * was rejected (e.g. HTTP 401). Backend takes a per-key lock so callers
 * never double-fire. Throws if refresh fails (e.g. refresh_token revoked).
 */
export async function refreshOauthToken(keyId: string): Promise<void> {
  await rpc.validation.refreshOauthToken({ keyId });
}

export async function startClaudeCodeOauthLogin(): Promise<ClaudeCodeOauthStartResponse> {
  return rpc.validation.startClaudeCodeOauthLogin();
}

export async function exchangeClaudeCodeOauthCode(
  code: string,
  state: string,
  expectedState: string,
  codeVerifier: string
): Promise<ClaudeCodeOauthExchangeResponse> {
  return rpc.validation.exchangeClaudeCodeOauthCode({
    code,
    state,
    expectedState,
    codeVerifier,
  });
}

export async function startCodexOauthLogin(): Promise<CodexOauthStartResponse> {
  return rpc.validation.startCodexOauthLogin();
}

export async function exchangeCodexOauthCode(
  code: string,
  state: string,
  expectedState: string,
  codeVerifier: string,
  redirectUri: string
): Promise<CodexOauthExchangeResponse> {
  return rpc.validation.exchangeCodexOauthCode({
    code,
    state,
    expectedState,
    codeVerifier,
    redirectUri,
  });
}

export async function startGeminiOauthLogin(): Promise<GeminiOauthStartResponse> {
  return rpc.validation.startGeminiOauthLogin();
}

export async function exchangeGeminiOauthCode(
  code: string,
  state: string,
  expectedState: string,
  codeVerifier: string,
  redirectUri: string
): Promise<GeminiOauthExchangeResponse> {
  return rpc.validation.exchangeGeminiOauthCode({
    code,
    state,
    expectedState,
    codeVerifier,
    redirectUri,
  });
}

// ============================================================================
// Key storage (CRUD)
// ============================================================================

/** List all stored keys (masked). */
export async function listKeys(): Promise<KeyInfo[]> {
  return rpc.validation.listKeys();
}

/** Get key by agent type (masked). */
export async function getKey(
  agentType: ModelType,
  keyId?: string
): Promise<KeyInfo | null> {
  return rpc.validation.getKey({
    agentType,
    keyId: keyId ?? null,
  });
}

/** Get key by ID (masked). */
export async function getKeyById(keyId: string): Promise<KeyInfo | null> {
  return rpc.validation.getKeyById({ keyId });
}

/** Get full (unmasked) key — for internal use like publishing. */
export async function getFullKey(
  agentType: ModelType,
  keyId?: string
): Promise<FullKeyResponse | null> {
  return rpc.validation.getFullKey({
    agentType,
    keyId: keyId ?? null,
  });
}

/** Save or update a key. */
export async function saveKey(request: SaveKeyRequest): Promise<KeyInfo> {
  return rpc.validation.saveKey({ request });
}

/** Delete a key by agent type and optional ID. */
export async function deleteKey(
  agentType: ModelType,
  keyId?: string
): Promise<boolean> {
  return rpc.validation.deleteKey({
    agentType,
    keyId: keyId ?? null,
  });
}

/** Delete a key by ID only. */
export async function deleteKeyById(keyId: string): Promise<boolean> {
  return rpc.validation.deleteKeyById({ keyId });
}

/** Update key health status after validation. */
export async function updateKeyHealth(
  keyId: string,
  healthStatus: HealthStatus,
  errorMessage?: string,
  availableModels?: string[],
  enabledModels?: string[],
  quotaInfo?: QuotaInfo
): Promise<KeyInfo | null> {
  return rpc.validation.updateKeyHealth({
    keyId,
    healthStatus,
    errorMessage: errorMessage ?? null,
    availableModels: availableModels ?? null,
    enabledModels: enabledModels ?? null,
    quotaInfo: quotaInfo ?? null,
  });
}

/** Get environment variables for running an agent. */
export async function getEnvForAgent(
  agentType: ModelType,
  keyId?: string
): Promise<Record<string, string>> {
  return rpc.validation.getEnvForAgent({
    agentType,
    keyId: keyId ?? null,
  });
}

/** Get all keys for an agent type (masked). Useful for multi-account support. */
export async function getAllKeysForAgent(
  agentType: ModelType
): Promise<KeyInfo[]> {
  return rpc.validation.getAllKeysForAgent({
    agentType,
  });
}

// ============================================================================
// Auto-detection
// ============================================================================

/**
 * Auto-detect keys from local config files and environment variables.
 *
 * Scans common locations:
 * - Environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
 * - Config files (~/.claude/config.json, ~/.config/openai/, etc.)
 */
export async function autoDetectKey(
  agentType: ModelType
): Promise<AutoDetectResult> {
  return rpc.validation.autoDetectKey({ agentType });
}
