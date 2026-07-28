/**
 * Procedure input/output schemas for key validation Tauri commands.
 *
 * Request/response shapes for key CRUD, quota refresh, model probing,
 * the Housekeeper assistant endpoints, and the CLI/OAuth flows (Cursor
 * native, Claude Code, Codex). Split out of `validation.ts` — see that
 * file for the full export surface.
 */
import { z } from "zod/v4";

import {
  CliAgentTypeSchema,
  HealthStatusSchema,
  ModelTypeSchema,
} from "./validationEnums";
import {
  ModelContextLengthsSchema,
  ProviderProtocolSchema,
  SaveKeyRequestSchema,
} from "./validationValueObjects";

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

export const ScanCliVersionInput = z.object({
  agentType: CliAgentTypeSchema,
  force: z.boolean().nullable().optional(),
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

export const GetProviderConfigInput = z.object({
  modelType: z.string(),
});
