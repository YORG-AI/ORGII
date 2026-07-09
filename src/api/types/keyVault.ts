/**
 * KeyVault Status Types
 *
 * Types describing the health, quota, and verification state of a stored
 * BYOK key — surfaced in the KeyVault Accounts detail panel and the KeyVault
 * wizard's "validation results" / "quota display" steps. These apply to any
 * BYOK key (degraded health, quota snapshot, mid-verification Cursor
 * session tokens, etc.).
 *
 * Note: `QuotaSnapshot` is the flat wire format emitted by the legacy
 * `KeyValidationResponse`. The newer BYOK RPC validation path returns
 * `QuotaInfo` (see `@src/api/types/keys`) which carries a `usage_items`
 * array instead. The two shapes are not interchangeable; reconciling them
 * is deferred until the wire-format unification pass.
 */

/**
 * Environment variable extracted from a pasted API key blob.
 *
 * Some validators (Cursor, Copilot, custom proxies) emit auxiliary
 * environment overrides alongside the API key — base URLs, custom
 * headers, etc. The wizard's `useKeyValidation` hook collects these so
 * the saved key record can write them to the local key store.
 */
export interface EnvVar {
  name: string;
  value: string;
}

/** Listing publication state. Surfaced on KeyVault accounts that have been
 *  published to a marketplace listing. In the OSS build the only states a
 *  reader sees are `"draft"` (never published) and `"deleted"` (listing was
 *  removed); the intermediate provider-side states are wire-only. */
export type ListingStatus =
  | "draft"
  | "pending"
  | "approved"
  | "rejected"
  | "suspended"
  | "pending_delete"
  | "deleted";

/** Verification state for Cursor listings (stored in
 *  `verification_data.state` on a key record). */
export type VerificationState = "pending" | "in_progress" | "passed" | "failed";

/** Verification trace for Cursor credential checks. */
export interface VerificationData {
  /** Current verification state */
  state: VerificationState;
  /** Models used for verification calls */
  models?: string[];
  /** Timestamps of verification calls */
  timestamps?: string[];
  /** Whether verification calls were made */
  calls_made?: boolean;
  /** Error message if verification failed */
  error?: string;
}

/**
 * Provider quota / usage snapshot — flat wire format.
 *
 * This is the historical shape returned by the marketplace HTTP
 * `KeyValidationResponse`. The KeyVault wizard's `<QuotaDisplay />` and
 * `<ValidationResults />` consume this shape directly; do not change field
 * names without updating those callers.
 */
export interface QuotaSnapshot {
  remaining_percentage: number;
  used?: number;
  limit?: number;
  remaining?: number;
  reset_time?: string;
  billing_start?: string;
  plan_type?: string;
  limit_type?: string;
  is_unlimited?: boolean;
  updated_at?: string;
  /** Which quota type determined the percentage */
  quota_source?: string;

  // Auto/Composer + API breakdown (Cursor-specific legacy flat fields)
  auto_percent_used?: number;
  api_percent_used?: number;
  total_percent_used?: number;

  // API quota (Cursor-specific legacy on-demand fields)
  on_demand_enabled?: boolean;
  on_demand_used?: number;
  on_demand_limit?: number;
  on_demand_remaining?: number;

  // Team on-demand (enterprise)
  team_on_demand_enabled?: boolean;
  team_on_demand_used?: number;

  // Provider messages
  auto_message?: string;
  named_message?: string;
}
