import type {
  DetectedKey,
  KeyInfo,
  QuotaInfo,
} from "@src/api/tauri/rpc/schemas/validation";

/**
 * Key Types
 *
 * Re-exports credential and key-store types from the RPC Zod schemas
 * (`@src/api/tauri/rpc/schemas/validation.ts`) — single source of truth.
 *
 * For RPC operations, prefer `@src/api/services/keyValidation`.
 */
export {
  CLI_AGENT,
  NATIVE_HARNESS_TYPE,
} from "@src/api/tauri/rpc/schemas/validation";

export const LOCAL_MODEL_PROVIDER =
  "vllm_api" as const satisfies import("@src/api/tauri/rpc/schemas/validation").ApiProviderType;

export type {
  CliAgentType,
  ApiProviderType,
  ModelType,
  AuthMethod,
  NativeHarnessType,
  ProviderProtocol,
  AutoDetectResult,
  AvailableAgent,
  DetectedKey,
  DetectedQuotaInfo,
  FullKeyResponse,
  HealthStatus,
  KeyInfo,
  QuotaInfo,
  SaveKeyRequest,
  UsageItem,
  ValidationResult,
  ModelAliasInfo,
  ModelVariantInfo,
  DefaultVariantInfo,
} from "@src/api/tauri/rpc/schemas/validation";

/** Response from list keys */
export interface KeysListResponse {
  keys: KeyInfo[];
}

/**
 * HTTP validation response (shape used by hosted-service API helpers).
 * Differs slightly from RPC `ValidationResult`.
 */
export interface ValidateKeyResponse {
  valid: boolean;
  message: string;
  available_models: string[];
  extracted_api_key_preview?: string;
  extracted_api_key?: string;
  extracted_base_url?: string;
  extracted_env_vars?: { name: string; value: string }[];
  quota_info?: QuotaInfo;
}

/**
 * Auto-detect HTTP response (extends RPC result with optional session / quota fields).
 */
export interface AutoDetectResponse {
  success: boolean;
  agent_type: string;
  message: string;
  keys: DetectedKey[];
  session_token?: string;
  quota_info?: QuotaInfo;
}
