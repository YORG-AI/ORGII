/**
 * Type definitions for Key Vault integration views
 */

export type SourceFilter = "all" | "local" | "pooling";

export interface PublishCredentialData {
  name?: string;
  api_key?: string;
  session_token?: string;
  base_url?: string;
  env_vars?: Record<string, string>;
  auth_method: "api_key" | "oauth";
}
