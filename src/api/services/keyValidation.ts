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
  CliVersionSnapshot,
  CodexOauthExchangeResponse,
  CodexOauthStartResponse,
  CursorBillingUsagePage,
  CursorBillingUsageSnapshot,
  DefaultVariantInfo,
  FullKeyResponse,
  HealthStatus,
  HousekeeperHealthCheckResponse,
  HousekeeperTokenBenchmarkResponse,
  HousekeeperUiContext,
  HousekeeperUiIntentResponse,
  KeyInfo,
  KeyQuotaRefreshStatusInfo,
  ModelContextLengths,
  ModelType,
  ModelVariantInfo,
  PromptPolishResponse,
  ProviderProtocol,
  QuotaInfo,
  SaveKeyRequest,
  SessionStepExplainRequest,
  SessionStepExplainResponse,
  ValidationResult,
} from "@src/api/tauri/rpc/schemas/validation";

export type {
  ModelType,
  AuthMethod,
  AutoDetectResult,
  CliVersionSnapshot,
  ClaudeCodeOauthExchangeResponse,
  ClaudeCodeOauthStartResponse,
  CodexOauthExchangeResponse,
  CodexOauthStartResponse,
  CursorBillingUsagePage,
  CursorBillingUsageSnapshot,
  DetectedKey,
  DetectedQuotaInfo,
  FullKeyResponse,
  HealthStatus,
  HousekeeperHealthCheckRequest,
  HousekeeperHealthCheckResponse,
  HousekeeperTokenBenchmarkRequest,
  HousekeeperTokenBenchmarkResponse,
  HousekeeperUiContext,
  HousekeeperUiIntentRequest,
  HousekeeperUiIntentResponse,
  KeyInfo,
  KeyQuotaRefreshStatusInfo,
  ModelContextLengths,
  ProviderProtocol,
  PromptPolishRequest,
  PromptPolishResponse,
  QuotaInfo,
  SaveKeyRequest,
  SessionStepExplainRequest,
  SessionStepExplainResponse,
  UsageItem,
  ValidationResult,
} from "@src/api/tauri/rpc/schemas/validation";

export type { ModelAliasInfo } from "@src/api/types/keys";

function cleanOptionalString(value?: string | null): string | null {
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
 * Refresh quota for a stored key without exposing secrets to the frontend.
 * `force` bypasses the backend freshness TTL, but not an already-running
 * single-flight refresh for the same account.
 */
export async function refreshKeyQuota(
  keyId: string,
  force = false
): Promise<KeyInfo | null> {
  return rpc.validation.refreshKeyQuota({ keyId, force });
}

/** Read quota freshness/last-good diagnostics without provider I/O. */
export async function getKeyQuotaRefreshStatus(
  keyId: string
): Promise<KeyQuotaRefreshStatusInfo | null> {
  return rpc.validation.getKeyQuotaRefreshStatus({ keyId });
}

/**
 * Sync Cursor's exact account-level billing export and return its bounded
 * aggregate summary. Event rows remain in the private raw cache and must be
 * read through `readCursorBillingUsagePage`.
 *
 * This source is intentionally separate from local Cursor session context
 * history so callers cannot accidentally double-count both datasets.
 */
export async function syncCursorBillingUsage(
  accountId: string,
  force = false
): Promise<CursorBillingUsageSnapshot> {
  return rpc.validation.cursorSyncBillingUsage({ accountId, force });
}

/**
 * Read one bounded page from the current Cursor billing last-good cache.
 *
 * `cursor` is opaque and only valid for the same account/credential snapshot.
 * The backend enforces a hard maximum of 200 events per IPC response.
 */
export async function readCursorBillingUsagePage(
  accountId: string,
  cursor: string | null = null,
  limit = 100
): Promise<CursorBillingUsagePage> {
  return rpc.validation.cursorReadBillingUsagePage({
    accountId,
    cursor,
    limit: Math.min(200, Math.max(1, Math.trunc(limit))),
  });
}

/** Archive the active account cache during logout/removal. */
export async function archiveCursorBillingUsageCache(
  accountId: string
): Promise<{
  archivedLastGood: boolean;
  archivedAttemptMarker: boolean;
}> {
  return rpc.validation.cursorArchiveBillingUsageCache({ accountId });
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

export interface OAuthModelCatalog {
  models: string[];
  defaultEnabledModels: string[];
  modelContextLengths: ModelContextLengths;
  modelVariants: ModelVariantInfo[];
  defaultVariants: DefaultVariantInfo[];
  source: "live" | "fallback";
}

export interface OAuthModelCatalogCredentials {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
}

export async function getOAuthModelCatalog(
  agentType: string,
  credentials: OAuthModelCatalogCredentials = {}
): Promise<OAuthModelCatalog> {
  const catalog = await rpc.validation.oauthModelCatalog({
    request: {
      agent_type: agentType,
      access_token: credentials.accessToken ?? null,
      refresh_token: credentials.refreshToken ?? null,
      id_token: credentials.idToken ?? null,
    },
  });
  return {
    models: catalog.models,
    defaultEnabledModels: catalog.default_enabled_models,
    modelContextLengths: catalog.model_context_lengths,
    modelVariants: catalog.model_variants,
    defaultVariants: catalog.default_variants,
    source: catalog.source,
  };
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
  quotaInfo?: QuotaInfo,
  modelContextLengths?: ModelContextLengths
): Promise<KeyInfo | null> {
  return rpc.validation.updateKeyHealth({
    keyId,
    healthStatus,
    errorMessage: errorMessage ?? null,
    availableModels: availableModels ?? null,
    enabledModels: enabledModels ?? null,
    quotaInfo: quotaInfo ?? null,
    modelContextLengths: modelContextLengths ?? null,
  });
}

/** Polish a chat draft through the configured local MiniCPM vLLM account. */
export async function promptPolish(
  text: string,
  options: { accountId?: string; model?: string } = {}
): Promise<PromptPolishResponse> {
  return rpc.validation.promptPolish({
    request: {
      text,
      accountId: cleanOptionalString(options.accountId),
      model: cleanOptionalString(options.model),
    },
  });
}

/** Explain a replay step through the configured local MiniCPM vLLM account. */
export async function sessionStepExplain(
  request: SessionStepExplainRequest,
  options: { accountId?: string; model?: string } = {}
): Promise<SessionStepExplainResponse> {
  return rpc.validation.sessionStepExplain({
    request: {
      ...request,
      accountId: cleanOptionalString(options.accountId ?? request.accountId),
      model: cleanOptionalString(options.model ?? request.model),
    },
  });
}

/** Check the configured MiniCPM housekeeper vLLM endpoint. */
export async function housekeeperHealthCheck(
  options: {
    accountId?: string;
    model?: string;
  } = {}
): Promise<HousekeeperHealthCheckResponse> {
  return rpc.validation.housekeeperHealthCheck({
    request: {
      accountId: cleanOptionalString(options.accountId),
      model: cleanOptionalString(options.model),
    },
  });
}

/** Measure MiniCPM output throughput through the configured vLLM endpoint. */
export async function housekeeperTokenBenchmark(
  options: {
    accountId?: string;
    model?: string;
  } = {}
): Promise<HousekeeperTokenBenchmarkResponse> {
  return rpc.validation.housekeeperTokenBenchmark({
    request: {
      accountId: cleanOptionalString(options.accountId),
      model: cleanOptionalString(options.model),
    },
  });
}

/** Ask MiniCPM to classify a lightweight UI instruction into a safe action. */
export async function housekeeperUiIntent(
  text: string,
  options: {
    accountId?: string;
    model?: string;
    allowedActionIds?: string[];
    uiContext?: HousekeeperUiContext | null;
  } = {}
): Promise<HousekeeperUiIntentResponse> {
  return rpc.validation.housekeeperUiIntent({
    request: {
      text,
      accountId: cleanOptionalString(options.accountId),
      model: cleanOptionalString(options.model),
      allowedActionIds: options.allowedActionIds ?? [],
      uiContext: options.uiContext ?? null,
    },
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

/** Scan the installed/latest version of one explicitly selected CLI. */
export async function scanCliVersion(
  agentType: import("@src/api/tauri/rpc/schemas/validation").CliAgentType,
  force = false
): Promise<CliVersionSnapshot> {
  return rpc.validation.scanCliVersion({ agentType, force });
}
