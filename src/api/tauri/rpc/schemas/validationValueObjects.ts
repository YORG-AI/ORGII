/**
 * Shared value-object schemas for key validation Tauri commands.
 *
 * Quota/usage info, key info/response/request shapes, and model
 * alias/variant metadata shared across multiple procedures. Split out
 * of `validation.ts` — see that file for the full export surface.
 */
import { z } from "zod/v4";

import {
  AuthMethodSchema,
  HealthStatusSchema,
  ModelTypeSchema,
  NativeHarnessTypeSchema,
} from "./validationEnums";

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

export const ProviderProtocolSchema = z.enum(["openai", "anthropic", "gemini"]);

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
