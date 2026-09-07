import type {
  ModelContextLengths,
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
export { CLI_AGENT } from "@src/api/tauri/rpc/schemas/validation";

export const LOCAL_MODEL_PROVIDER =
  "vllm_api" as const satisfies import("@src/api/tauri/rpc/schemas/validation").ApiProviderType;

export type {
  CliAgentType,
  ApiProviderType,
  ModelType,
  AuthMethod,
  NativeHarnessType,
  ProviderProtocol,
  AvailableAgent,
  DetectedKey,
  HealthStatus,
  KeyInfo,
  QuotaInfo,
  SaveKeyRequest,
  UsageItem,
  ValidationResult,
  ModelContextLengths,
  ModelVariantInfo,
  DefaultVariantInfo,
} from "@src/api/tauri/rpc/schemas/validation";

/**
 * HTTP validation response (shape used by hosted-service API helpers).
 * Differs slightly from RPC `ValidationResult`.
 */
export interface ValidateKeyResponse {
  valid: boolean;
  message: string;
  available_models: string[];
  model_context_lengths?: ModelContextLengths;
  extracted_api_key_preview?: string;
  extracted_api_key?: string;
  extracted_base_url?: string;
  extracted_env_vars?: { name: string; value: string }[];
  quota_info?: QuotaInfo;
}
