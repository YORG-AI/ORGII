/**
 * Zod schemas for key validation Tauri commands.
 *
 * Single source of truth for both runtime validation and static types.
 * Mirrors Rust types in src-tauri/src/key_vault/commands/.
 *
 * Implementation lives in sibling `validation*.ts` modules, grouped by
 * concern (enums, shared value objects, discovery, procedure schemas).
 * This file re-exports the full surface so `./validation` keeps working
 * as the single import path, plus the schema-inferred static types.
 */
import { z } from "zod/v4";

import {
  AgentEnvConfigSchema,
  AutoDetectResultSchema,
  AvailableAgentSchema,
  AvailableApiProviderSchema,
  CliInstallMethodSchema,
  CliVersionSnapshotSchema,
  DetectedKeySchema,
  DetectedQuotaInfoSchema,
  ProviderConfigSchema,
  ProviderEndpointSchema,
} from "./validationDiscovery";
import {
  ApiProviderTypeSchema,
  AuthMethodSchema,
  CliAgentTypeSchema,
  HealthStatusSchema,
  MergeStatusSchema,
  ModelTypeSchema,
  NativeHarnessTypeSchema,
  PriceTierSchema,
} from "./validationEnums";
import {
  ClaudeCodeOauthExchangeResponseSchema,
  ClaudeCodeOauthStartResponseSchema,
  CodexOauthExchangeResponseSchema,
  CodexOauthStartResponseSchema,
  CursorNativeOauthPollResponseSchema,
  CursorNativeOauthStartResponseSchema,
  HousekeeperHealthCheckRequestSchema,
  HousekeeperHealthCheckResponseSchema,
  HousekeeperTokenBenchmarkRequestSchema,
  HousekeeperTokenBenchmarkResponseSchema,
  HousekeeperUiContextSchema,
  HousekeeperUiIntentRequestSchema,
  HousekeeperUiIntentResponseSchema,
  PromptPolishRequestSchema,
  PromptPolishResponseSchema,
  SessionStepExplainRequestSchema,
  SessionStepExplainResponseSchema,
} from "./validationProcedures";
import {
  DefaultVariantInfoSchema,
  FullKeyResponseSchema,
  KeyInfoSchema,
  ModelAliasInfoSchema,
  ModelContextLengthsSchema,
  ModelVariantInfoSchema,
  ProviderProtocolSchema,
  QuotaInfoSchema,
  SaveKeyRequestSchema,
  UsageItemSchema,
  ValidationResultSchema,
} from "./validationValueObjects";

export * from "./validationEnums";
export * from "./validationValueObjects";
export * from "./validationDiscovery";
export * from "./validationProcedures";

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
export type CliVersionSnapshot = z.infer<typeof CliVersionSnapshotSchema>;
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
