/**
 * Zod schemas for key validation Tauri commands.
 *
 * Single source of truth for both runtime validation and static types.
 * Mirrors Rust types in src-tauri/src/key_vault/commands/.
 */
import { z } from "zod/v4";

// ============================================================================
// Shared enums / literals
// ============================================================================

/** CLI agent type constants for type-safe usage */
export const CLI_AGENT = {
  CURSOR: "cursor_cli",
  CLAUDE_CODE: "claude_code",
  CODEX: "codex",
  GEMINI: "gemini_cli",
  COPILOT: "copilot",
  KIRO: "kiro",
  KIMI: "kimi_cli",
  OPENCODE: "opencode",
  AIDER: "aider",
  GOOSE: "goose",
  AMP: "amp",
  CLINE: "cline",
  KILO: "kilo",
  GROK: "grok_cli",
  DEVIN: "devin",
  ROVO: "rovo",
  HERMES: "hermes",
  OPENCLAW: "openclaw",
  AUG: "aug",
  CODEBUFF: "codebuff",
  QWEN_CODE: "qwen_code",
  MIMO_CODE: "mimo_code",
  ANTIGRAVITY: "antigravity",
  CONTINUE: "continue_cli",
  DROID: "droid",
  MISTRAL_VIBE: "mistral_vibe",
  AUTOHAND: "autohand",
  OMP: "omp",
  PI: "pi",
} as const;

/** CLI-based coding agents (external processes managed by the app). */
export const CliAgentTypeSchema = z.union([
  z.literal("cursor_cli"),
  z.literal("claude_code"),
  z.literal("codex"),
  z.literal("gemini_cli"),
  z.literal("copilot"),
  z.literal("kiro"),
  z.literal("kimi_cli"),
  z.literal("opencode"),
  z.literal("aider"),
  z.literal("goose"),
  z.literal("amp"),
  z.literal("cline"),
  z.literal("kilo"),
  z.literal("grok_cli"),
  z.literal("devin"),
  z.literal("rovo"),
  z.literal("hermes"),
  z.literal("openclaw"),
  z.literal("aug"),
  z.literal("codebuff"),
  z.literal("qwen_code"),
  z.literal("mimo_code"),
  z.literal("antigravity"),
  z.literal("continue_cli"),
  z.literal("droid"),
  z.literal("mistral_vibe"),
  z.literal("autohand"),
  z.literal("omp"),
  z.literal("pi"),
]);

/** Direct API key providers (REST API, no child process). */
export const ApiProviderTypeSchema = z.union([
  z.literal("anthropic_api"),
  z.literal("openai_api"),
  z.literal("deepseek_api"),
  z.literal("gemini_api"),
  z.literal("groq_api"),
  z.literal("xai_api"),
  z.literal("zhipu_api"),
  z.literal("dashscope_api"),
  z.literal("moonshot_api"),
  z.literal("openrouter_api"),
  z.literal("zenmux_api"),
  z.literal("minimax_api"),
  z.literal("longcat_api"),
  z.literal("siliconflow_api"),
  z.literal("modelscope_api"),
  z.literal("aihubmix_api"),
  z.literal("cherryin_api"),
  z.literal("bedrock_api"),
  z.literal("custom_api"),
  z.literal("embedding_api"),
  z.literal("vllm_api"),
  z.literal("azure_openai_api"),
  z.literal("azure_anthropic_api"),
  z.literal("orgii_orchestrator"),
]);

/**
 * Unified model type — CLI agents + API providers + short aliases.
 * Use `CliAgentType` or `ApiProviderType` when the domain is known.
 */
export const ModelTypeSchema = z.union([
  CliAgentTypeSchema,
  ApiProviderTypeSchema,
  // Short aliases (backend accepts these; used by validation convenience functions)
  z.literal("openai"),
  z.literal("anthropic"),
  z.literal("google"),
]);

export const AuthMethodSchema = z.union([
  z.literal("api_key"),
  z.literal("oauth"),
]);

export const NATIVE_HARNESS_TYPE = {
  CURSOR: "cursor_native",
} as const;

export const NativeHarnessTypeSchema = z.union([
  z.literal(NATIVE_HARNESS_TYPE.CURSOR),
]);

export const HealthStatusSchema = z.union([
  z.literal("valid"),
  z.literal("degraded"),
  z.literal("invalid"),
  z.literal("unknown"),
]);

// ============================================================================
// Session enums
// ============================================================================

/** Merge status for worktree sessions */
export const MergeStatusSchema = z.enum([
  "pending",
  "merged",
  "conflict",
  "skipped",
  "failed",
]);

/** Price tier for market sessions */
export const PriceTierSchema = z.enum(["basic", "standard", "premium", "vip"]);

// ============================================================================
// Shared value objects
// ============================================================================

export const UsageItemSchema = z.object({
  usage_type: z.string(),
  enabled: z.boolean(),
  used: z.number().nullable(),
  limit: z.number().nullable(),
  remaining: z.number().nullable(),
  remaining_percentage: z.number(),
  reset_time: z.string().nullable().optional(),
});

export const QuotaInfoSchema = z.object({
  remaining_percentage: z.number(),
  used: z.number().nullable(),
  limit: z.number().nullable(),
  remaining: z.number().nullable(),
  reset_time: z.string().nullable(),
  billing_start: z.string().nullable(),
  plan_type: z.string().nullable(),
  limit_type: z.string().nullable(),
  is_unlimited: z.boolean(),
  quota_source: z.string().nullable(),
  usage_items: z.array(UsageItemSchema),
  auto_message: z.string().nullable(),
  named_message: z.string().nullable(),
});

export const ModelContextLengthsSchema = z.record(
  z.string(),
  z.number().int().positive()
);

export const ValidationResultSchema = z.object({
  valid: z.boolean(),
  message: z.string(),
  models_available: z.array(z.string()),
  model_context_lengths: ModelContextLengthsSchema.default({}),
  disabled_models: z.array(z.string()),
  is_degraded: z.boolean(),
  quota_info: QuotaInfoSchema.nullable(),
  provider_response: z.string(),
});

export const ModelAliasInfoSchema = z.object({
  display_name: z.string().default(""),
  alias: z.string(),
  icon: z.string().nullable().optional(),
});

export const ModelVariantInfoSchema = z.object({
  model: z.string(),
  base_model: z.string(),
  reasoning: z.string().nullable().optional(),
  fast: z.boolean().default(false),
  context_window: z.number().int().positive().nullable().optional(),
});

export const DefaultVariantInfoSchema = z.object({
  base_model: z.string(),
  model: z.string(),
});

export const ProviderProtocolSchema = z.enum(["openai", "anthropic"]);

export const KeyInfoSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  description: z.string().nullable().optional(),
  agent_type: ModelTypeSchema,
  has_api_key: z.boolean(),
  has_session_token: z.boolean(),
  has_base_url: z.boolean(),
  api_key_preview: z.string().nullable(),
  session_token_preview: z.string().nullable(),
  base_url: z.string().nullable(),
  protocol: ProviderProtocolSchema.nullable().optional(),
  env_vars: z.array(z.string()),
  env_vars_masked: z.record(z.string(), z.string()),
  account_metadata: z.record(z.string(), z.string()).optional().default({}),
  available_models: z.array(z.string()),
  enabled_models: z.array(z.string()),
  side_query_model: z.string().nullable().optional(),
  model_aliases: z.array(ModelAliasInfoSchema).optional(),
  model_variants: z.array(ModelVariantInfoSchema).optional(),
  default_variants: z.array(DefaultVariantInfoSchema).optional(),
  quota_info: z.unknown().nullable(),
  has_local_key: z.boolean(),
  is_listed: z.boolean(),
  auth_method: AuthMethodSchema,
  listing_id: z.string().nullable(),
  health_status: HealthStatusSchema,
  last_validation_error: z.string().nullable(),
  last_validated_at: z.string().nullable(),
  oauth_refresh_failure_count: z.number().int().nonnegative(),
  last_oauth_refresh_failed_at: z.string().nullable(),
  temporary_unavailable_until: z.string().nullable().optional(),
  temporary_unavailable_reason: z.string().nullable().optional(),
  last_upstream_status: z.number().int().nullable().optional(),
  last_upstream_error_type: z.string().nullable().optional(),
  rate_limit_reset_at: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  enabled: z.boolean(),
  supports_rust_agents: z.boolean(),
  can_launch_cli: z.boolean(),
  can_use_native_harness: z.boolean(),
  native_harness_type: NativeHarnessTypeSchema.nullable(),
});

export const FullKeyResponseSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  agent_type: ModelTypeSchema,
  api_key: z.string().nullable(),
  session_token: z.string().nullable(),
  base_url: z.string().nullable(),
  protocol: ProviderProtocolSchema.nullable().optional(),
  env_vars: z.record(z.string(), z.string()),
  account_metadata: z.record(z.string(), z.string()).optional().default({}),
  available_models: z.array(z.string()),
  model_aliases: z.array(ModelAliasInfoSchema).optional(),
  model_variants: z.array(ModelVariantInfoSchema).optional(),
  default_variants: z.array(DefaultVariantInfoSchema).optional(),
  auth_method: AuthMethodSchema,
});

export const SaveKeyRequestSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  agent_type: ModelTypeSchema,
  api_key: z.string().optional(),
  session_token: z.string().optional(),
  base_url: z.string().optional(),
  protocol: ProviderProtocolSchema.optional(),
  env_vars: z.record(z.string(), z.string()).optional(),
  account_metadata: z.record(z.string(), z.string()).optional(),
  available_models: z.array(z.string()).optional(),
  enabled_models: z.array(z.string()).optional(),
  side_query_model: z.string().optional(),
  model_aliases: z.array(ModelAliasInfoSchema).optional(),
  model_variants: z.array(ModelVariantInfoSchema).optional(),
  default_variants: z.array(DefaultVariantInfoSchema).optional(),
  quota_info: z.record(z.string(), z.unknown()).optional(),
  has_local_key: z.boolean().optional(),
  is_listed: z.boolean().optional(),
  auth_method: AuthMethodSchema.optional(),
  listing_id: z.string().optional(),
  enabled: z.boolean().optional(),
});

// ============================================================================
// Auto-detection
// ============================================================================

export const DetectedQuotaInfoSchema = z.object({
  remaining_percentage: z.number().nullable().optional(),
  used: z.number().nullable().optional(),
  limit: z.number().nullable().optional(),
  remaining: z.number().nullable().optional(),
  reset_time: z.string().nullable().optional(),
  plan_type: z.string().nullable().optional(),
  quota_source: z.string().nullable().optional(),
  is_unlimited: z.boolean().nullable().optional(),
  usage_items: z.array(UsageItemSchema).optional(),
  auto_message: z.string().nullable().optional(),
  named_message: z.string().nullable().optional(),
});

export const DetectedKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  auth_method: AuthMethodSchema,
  api_key: z.string().nullable().optional(),
  session_token: z.string().nullable().optional(),
  base_url: z.string().nullable().optional(),
  env_vars: z.record(z.string(), z.string()).nullable().optional(),
  account_metadata: z.record(z.string(), z.string()).nullable().optional(),
  available_models: z.array(z.string()).nullable().optional(),
  quota_info: DetectedQuotaInfoSchema.nullable().optional(),
  validated: z.boolean().nullable().optional(),
  validation_message: z.string().nullable().optional(),
});

export const AutoDetectResultSchema = z.object({
  success: z.boolean(),
  agent_type: z.string(),
  message: z.string(),
  keys: z.array(DetectedKeySchema),
});

export const CliInstallMethodSchema = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
});

export const AgentEnvConfigSchema = z.object({
  apiKeyEnvVar: z.string(),
  baseUrlEnvVar: z.string().optional(),
  supportsBaseUrl: z.boolean(),
  apiKeyPlaceholderKey: z.string(),
  baseUrlPlaceholder: z.string().optional(),
});

export const AcpSupportSchema = z.enum([
  "native",
  "adapter_backed",
  "planned",
  "partial",
  "unavailable",
]);

export const CliConfigFileFormatSchema = z.enum([
  "json",
  "jsonc",
  "toml",
  "yaml",
  "text",
]);

export const CliConfigFileSchema = z.object({
  id: z.string(),
  label: z.string(),
  path: z.string(),
  format: CliConfigFileFormatSchema,
  secretBearing: z.boolean(),
});

/** Matches `AvailableAgent` in `src-tauri/.../discovery.rs` (camelCase JSON). */
export const AvailableAgentSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  installed: z.boolean(),
  hasKeys: z.boolean(),
  installedVia: z.string().optional(),
  description: z.string(),
  brandColor: z.string(),
  docsUrl: z.string().optional(),
  hasSubscriptionPlan: z.boolean(),
  nativeSubscriptionLabels: z.array(z.string()),
  compatibleApiProviders: z.array(z.string()),
  supportedProtocols: z.array(z.string()),
  configFiles: z.array(CliConfigFileSchema),
  installMethods: z.array(CliInstallMethodSchema),
  uninstallMethods: z.array(CliInstallMethodSchema),
  envConfig: AgentEnvConfigSchema.optional(),
  isComplexSetup: z.boolean(),
  defaultSetupMethod: z.string().optional(),
  supportedSetupMethods: z.array(z.string()),
  popular: z.boolean(),
  /** Icon provider key for ModelIcon lookup (e.g., "cursor", "claude_code") */
  iconProvider: z.string(),
  /** Paired API provider for brand grouping (e.g., "anthropic_api" for claude_code) */
  pairedApiProvider: z.string().optional(),
  /** Bare binary name to launch in a PTY shell (e.g. "claude", "gemini"). Source of truth from Rust registry. */
  command: z.string(),
  /** Whether ORGII Rust agents can use this CLI's credentials */
  supportsRustAgents: z.boolean(),
  acpSupport: AcpSupportSchema,
  /** Whether this agent can use ORGII Pool (Token Market) billing. Always false for CLI agents. */
  supportsOrgiiPool: z.boolean(),
  /** Whether this CLI agent accepts an initial prompt from ORGII's GUI composer.
   *  When false the session creator shows a Start button (pure-TUI mode). */
  supportsGui: z.boolean(),
});

/** Matches `AvailableApiProvider` in `src-tauri/.../discovery.rs` (camelCase JSON). */
export const AvailableApiProviderSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  hasKeys: z.boolean(),
  description: z.string(),
  brandColor: z.string(),
  docsUrl: z.string().optional(),
  /** Icon provider key for ModelIcon lookup (e.g., "openai", "claude") */
  iconProvider: z.string(),
  /** Paired CLI agent for brand grouping (e.g., "codex" for openai_api) */
  pairedCliAgent: z.string().optional(),
  popular: z.boolean(),
  // From provider_config:
  apiKeyEnvVar: z.string(),
  supportsBaseUrl: z.boolean(),
  defaultBaseUrl: z.string().optional(),
  supportedProtocols: z.array(ProviderProtocolSchema),
  defaultProtocol: ProviderProtocolSchema,
  // Agent compatibility:
  /** CLI agents that can use this API provider (e.g., ["codex"] for openai_api) */
  compatibleCliAgents: z.array(z.string()),
  /** Whether ORGII Rust agents (OS Agent, SDE Agent) can use this provider */
  supportsRustAgents: z.boolean(),
});

/**
 * Matches `ProviderEndpoint` in `src-tauri/.../provider_config.rs`.
 *
 * A selectable endpoint — a regional split (Zhipu's China vs Global hosts), a
 * product tier (OpenCode Zen vs Go), or an AWS region. `anthropic_base_url` is
 * null when the endpoint has no dedicated Anthropic-protocol host.
 */
export const ProviderEndpointSchema = z.object({
  id: z.string(),
  label: z.string(),
  base_url: z.string(),
  anthropic_base_url: z.string().nullable(),
});

/** Matches `ProviderConfig` in `src-tauri/.../provider_config.rs`. */
export const ProviderConfigSchema = z.object({
  api_key_env_var: z.string(),
  base_url_env_var: z.string().nullable(),
  supports_base_url: z.boolean(),
  default_base_url: z.string().nullable(),
  supported_protocols: z.array(ProviderProtocolSchema),
  default_protocol: ProviderProtocolSchema,
  /** Empty when the provider has a single implicit endpoint. */
  endpoints: z.array(ProviderEndpointSchema),
});

// ============================================================================
// Procedure input schemas
// ============================================================================

export const ValidateKeyInput = z.object({
  agentType: ModelTypeSchema,
  apiKey: z.string(),
  baseUrl: z.string().nullable().optional(),
  sessionToken: z.string().nullable().optional(),
  testModel: z.string().nullable().optional(),
  protocol: ProviderProtocolSchema.nullable().optional(),
});

export const TestModelAvailabilityInput = z.object({
  apiKey: z.string(),
  baseUrl: z.string(),
  model: z.string(),
  agentType: ModelTypeSchema,
});

export const TestModelResultSchema = z.object({
  available: z.boolean(),
  message: z.string(),
});

export const FetchKeyQuotaInput = z.object({
  agentType: ModelTypeSchema,
  apiKey: z.string(),
});

export const RefreshKeyQuotaInput = z.object({
  keyId: z.string(),
});

export const GetKeyInput = z.object({
  agentType: ModelTypeSchema,
  keyId: z.string().nullable().optional(),
});

export const GetKeyByIdInput = z.object({
  keyId: z.string(),
});

export const SaveKeyInput = z.object({
  request: SaveKeyRequestSchema,
});

export const DeleteKeyInput = z.object({
  agentType: ModelTypeSchema,
  keyId: z.string().nullable().optional(),
});

export const DeleteKeyByIdInput = z.object({
  keyId: z.string(),
});

export const UpdateKeyHealthInput = z.object({
  keyId: z.string(),
  healthStatus: HealthStatusSchema,
  errorMessage: z.string().nullable().optional(),
  availableModels: z.array(z.string()).nullable().optional(),
  enabledModels: z.array(z.string()).nullable().optional(),
  sideQueryModel: z.string().nullable().optional(),
  quotaInfo: z.record(z.string(), z.unknown()).nullable().optional(),
  modelContextLengths: ModelContextLengthsSchema.nullable().optional(),
});

export const PromptPolishRequestSchema = z.object({
  text: z.string(),
  accountId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});

export const PromptPolishInput = z.object({
  request: PromptPolishRequestSchema,
});

export const PromptPolishResponseSchema = z.object({
  polishedText: z.string(),
  model: z.string(),
  accountId: z.string(),
});

export const SessionStepExplainRequestSchema = z.object({
  eventId: z.string(),
  functionName: z.string().nullable().optional(),
  actionType: z.string().nullable().optional(),
  displayText: z.string().nullable().optional(),
  displayStatus: z.string().nullable().optional(),
  displayVariant: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  filePath: z.string().nullable().optional(),
  command: z.string().nullable().optional(),
  args: z.unknown().nullable().optional(),
  result: z.unknown().nullable().optional(),
  accountId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});

export const SessionStepExplainInput = z.object({
  request: SessionStepExplainRequestSchema,
});

export const SessionStepExplainResponseSchema = z.object({
  explanation: z.string(),
  model: z.string(),
  accountId: z.string(),
});

export const HousekeeperHealthCheckRequestSchema = z.object({
  accountId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});

export const HousekeeperHealthCheckInput = z.object({
  request: HousekeeperHealthCheckRequestSchema,
});

export const HousekeeperHealthCheckResponseSchema = z.object({
  ok: z.boolean(),
  accountId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  baseUrl: z.string().nullable().optional(),
  maxModelLen: z.number().int().positive().nullable().optional(),
  contextLimitTokens: z.number().int().positive(),
  error: z.string().nullable().optional(),
});

export const HousekeeperTokenBenchmarkRequestSchema = z.object({
  accountId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});

export const HousekeeperTokenBenchmarkInput = z.object({
  request: HousekeeperTokenBenchmarkRequestSchema,
});

export const HousekeeperTokenBenchmarkResponseSchema = z.object({
  accountId: z.string(),
  model: z.string(),
  baseUrl: z.string(),
  elapsedMs: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative().nullable().optional(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative().nullable().optional(),
  tokensPerSecond: z.number(),
  sampleText: z.string(),
});

export const HousekeeperUiContextSchema = z.object({
  route: z.string().nullable().optional(),
  activePanel: z.string().nullable().optional(),
});

export const HousekeeperUiIntentRequestSchema = z.object({
  text: z.string(),
  accountId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  allowedActionIds: z.array(z.string()).default([]),
  uiContext: HousekeeperUiContextSchema.nullable().optional(),
});

export const HousekeeperUiIntentInput = z.object({
  request: HousekeeperUiIntentRequestSchema,
});

export const HousekeeperUiIntentResponseSchema = z.object({
  actionId: z.string().nullable(),
  params: z.record(z.string(), z.unknown()),
  confidence: z.number(),
  reason: z.string().nullable().optional(),
  model: z.string(),
  accountId: z.string(),
});

export const GetEnvForAgentInput = z.object({
  agentType: ModelTypeSchema,
  keyId: z.string().nullable().optional(),
});

export const GetAllKeysForAgentInput = z.object({
  agentType: ModelTypeSchema,
});

export const AutoDetectKeyInput = z.object({
  agentType: ModelTypeSchema,
});

export const ExtractKeysFromTextInput = z.object({
  input: z.string(),
  agentType: z.string().nullable().optional(),
});

export const AutoInstallCliInput = z.object({
  agent: z.string(),
});

export const GetCursorCliModelsInput = z.object({
  apiKey: z.string(),
});

export const CursorListModelsNativeInput = z.object({
  sessionToken: z.string(),
});

export const ClaudeCodeOauthListModelsInput = z.object({
  accessToken: z.string(),
});

export const OAuthModelCatalogInput = z.object({
  request: z.object({
    agent_type: z.string(),
  }),
});

export const OAuthModelCatalogResponseSchema = z.object({
  models: z.array(z.string()),
  default_enabled_models: z.array(z.string()),
});

export const CodexOauthListModelsInput = z.object({
  request: z.object({
    access_token: z.string(),
    id_token: z.string().nullable().optional(),
  }),
});

export const GeminiOauthListModelsInput = z.object({
  accessToken: z.string(),
  projectId: z.string().nullable().optional(),
});

export const RefreshOauthTokenInput = z.object({
  keyId: z.string(),
});

export const CursorNativeModelSchema = z.object({
  modelId: z.string(),
  displayModelId: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  displayNameShort: z.string().nullable().optional(),
  aliases: z.array(z.string()).optional().default([]),
  maxMode: z.boolean().optional().default(false),
});
export type CursorNativeModel = z.infer<typeof CursorNativeModelSchema>;

export const CursorNativeOauthStartResponseSchema = z.object({
  loginUrl: z.string(),
  uuid: z.string(),
  verifier: z.string(),
});

export const CursorNativeOauthPollInput = z.object({
  uuid: z.string(),
  verifier: z.string(),
});

export const CursorNativeOauthPollResponseSchema = z.object({
  accessToken: z.string(),
});

export const ClaudeCodeOauthStartResponseSchema = z.object({
  authUrl: z.string(),
  state: z.string(),
  codeVerifier: z.string(),
});

export const ClaudeCodeOauthExchangeInput = z.object({
  code: z.string(),
  state: z.string(),
  expectedState: z.string(),
  codeVerifier: z.string(),
});

export const ClaudeCodeAccountMetadataSchema = z.object({
  email: z.string().nullable().optional(),
  organizationUuid: z.string().nullable().optional(),
  organizationName: z.string().nullable().optional(),
  organizationType: z.string().nullable().optional(),
  rateLimitTier: z.string().nullable().optional(),
});

export const ClaudeCodeOauthExchangeResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().nullable().optional(),
  expiresIn: z.number().nullable().optional(),
  tokenType: z.string().nullable().optional(),
  scope: z.string().nullable().optional(),
  accountMetadata: ClaudeCodeAccountMetadataSchema.nullable().optional(),
});

export const CodexOauthStartResponseSchema = z.object({
  authUrl: z.string(),
  state: z.string(),
  codeVerifier: z.string(),
  redirectUri: z.string(),
});

export const CodexOauthExchangeInput = z.object({
  code: z.string(),
  state: z.string(),
  expectedState: z.string(),
  codeVerifier: z.string(),
  redirectUri: z.string(),
});

export const CodexOauthExchangeResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  idToken: z.string(),
  expiresIn: z.number().nullable().optional(),
  tokenType: z.string().nullable().optional(),
  scope: z.string().nullable().optional(),
});

export const GeminiOauthStartResponseSchema = z.object({
  authUrl: z.string(),
  state: z.string(),
  codeVerifier: z.string(),
  redirectUri: z.string(),
});

export const GeminiOauthExchangeInput = z.object({
  code: z.string(),
  state: z.string(),
  expectedState: z.string(),
  codeVerifier: z.string(),
  redirectUri: z.string(),
});

export const GeminiOauthExchangeResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().nullable().optional(),
  tokenType: z.string().nullable().optional(),
  scope: z.string().nullable().optional(),
  projectId: z.string(),
  expiresAt: z.string(),
  availableModels: z.array(z.string()),
});

export const GetProviderConfigInput = z.object({
  modelType: z.string(),
});

// ============================================================================
// Static types inferred from schemas
// ============================================================================

export type CliAgentType = z.infer<typeof CliAgentTypeSchema>;
export type ApiProviderType = z.infer<typeof ApiProviderTypeSchema>;
export type ModelType = z.infer<typeof ModelTypeSchema>;
export type AuthMethod = z.infer<typeof AuthMethodSchema>;
export type NativeHarnessType = z.infer<typeof NativeHarnessTypeSchema>;
export type HealthStatus = z.infer<typeof HealthStatusSchema>;
export type MergeStatus = z.infer<typeof MergeStatusSchema>;
export type PriceTier = z.infer<typeof PriceTierSchema>;
export type UsageItem = z.infer<typeof UsageItemSchema>;
export type QuotaInfo = z.infer<typeof QuotaInfoSchema>;
export type ModelContextLengths = z.infer<typeof ModelContextLengthsSchema>;
export type ValidationResult = z.infer<typeof ValidationResultSchema>;
export type ProviderProtocol = z.infer<typeof ProviderProtocolSchema>;
export type KeyInfo = z.infer<typeof KeyInfoSchema>;
export type FullKeyResponse = z.infer<typeof FullKeyResponseSchema>;
export type SaveKeyRequest = z.infer<typeof SaveKeyRequestSchema>;
export type DetectedKey = z.infer<typeof DetectedKeySchema>;
export type AutoDetectResult = z.infer<typeof AutoDetectResultSchema>;
export type AvailableAgent = z.infer<typeof AvailableAgentSchema>;
export type AvailableApiProvider = z.infer<typeof AvailableApiProviderSchema>;
export type CliInstallMethod = z.infer<typeof CliInstallMethodSchema>;
export type AgentEnvConfig = z.infer<typeof AgentEnvConfigSchema>;
export type ModelAliasInfo = z.infer<typeof ModelAliasInfoSchema>;
export type ModelVariantInfo = z.infer<typeof ModelVariantInfoSchema>;
export type DefaultVariantInfo = z.infer<typeof DefaultVariantInfoSchema>;
export type DetectedQuotaInfo = z.infer<typeof DetectedQuotaInfoSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProviderEndpoint = z.infer<typeof ProviderEndpointSchema>;
export type PromptPolishRequest = z.infer<typeof PromptPolishRequestSchema>;
export type PromptPolishResponse = z.infer<typeof PromptPolishResponseSchema>;
export type SessionStepExplainRequest = z.infer<
  typeof SessionStepExplainRequestSchema
>;
export type SessionStepExplainResponse = z.infer<
  typeof SessionStepExplainResponseSchema
>;
export type HousekeeperHealthCheckRequest = z.infer<
  typeof HousekeeperHealthCheckRequestSchema
>;
export type HousekeeperHealthCheckResponse = z.infer<
  typeof HousekeeperHealthCheckResponseSchema
>;
export type HousekeeperTokenBenchmarkRequest = z.infer<
  typeof HousekeeperTokenBenchmarkRequestSchema
>;
export type HousekeeperTokenBenchmarkResponse = z.infer<
  typeof HousekeeperTokenBenchmarkResponseSchema
>;
export type HousekeeperUiContext = z.infer<typeof HousekeeperUiContextSchema>;
export type HousekeeperUiIntentRequest = z.infer<
  typeof HousekeeperUiIntentRequestSchema
>;
export type HousekeeperUiIntentResponse = z.infer<
  typeof HousekeeperUiIntentResponseSchema
>;
export type CursorNativeOauthStartResponse = z.infer<
  typeof CursorNativeOauthStartResponseSchema
>;
export type CursorNativeOauthPollResponse = z.infer<
  typeof CursorNativeOauthPollResponseSchema
>;
export type ClaudeCodeOauthStartResponse = z.infer<
  typeof ClaudeCodeOauthStartResponseSchema
>;
export type ClaudeCodeOauthExchangeResponse = z.infer<
  typeof ClaudeCodeOauthExchangeResponseSchema
>;
export type CodexOauthStartResponse = z.infer<
  typeof CodexOauthStartResponseSchema
>;
export type CodexOauthExchangeResponse = z.infer<
  typeof CodexOauthExchangeResponseSchema
>;
export type GeminiOauthStartResponse = z.infer<
  typeof GeminiOauthStartResponseSchema
>;
export type GeminiOauthExchangeResponse = z.infer<
  typeof GeminiOauthExchangeResponseSchema
>;
