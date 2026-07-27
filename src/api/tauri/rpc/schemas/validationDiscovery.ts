/**
 * Auto-detection, CLI/agent discovery, and provider-config schemas for
 * key validation Tauri commands.
 *
 * Covers detected-key auto-detection results, CLI version snapshots,
 * install/config-file metadata, the `AvailableAgent` / `AvailableApiProvider`
 * discovery shapes (mirroring `discovery.rs`), and `ProviderConfig` /
 * `ProviderEndpoint` (mirroring `provider_config.rs`). Split out of
 * `validation.ts` — see that file for the full export surface.
 */
import { z } from "zod/v4";

import { AuthMethodSchema, CliAgentTypeSchema } from "./validationEnums";
import {
  ProviderProtocolSchema,
  UsageItemSchema,
} from "./validationValueObjects";

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

export const CliVersionSnapshotSchema = z.object({
  agent_type: CliAgentTypeSchema,
  installed_version: z.string().nullable(),
  latest_version: z.string().nullable(),
  installed_version_error: z.string().nullable(),
  latest_version_error: z.string().nullable(),
  status: z.enum(["current", "outdated", "unknown"]),
  scanned_at: z.string(),
  stale: z.boolean(),
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
 * A selectable endpoint — sometimes combining dimensions (Zhipu region and
 * credential type), or representing a product tier or AWS region.
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
