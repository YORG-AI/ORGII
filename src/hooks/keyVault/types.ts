/**
 * Code Accounts Types - Simplified
 */
import type { QuotaSnapshot, VerificationData } from "@src/api/types/keyVault";
import type {
  DefaultVariantInfo,
  KeyInfo,
  ModelType,
  ModelVariantInfo,
  NativeHarnessType,
  QuotaInfo,
  SaveKeyRequest,
} from "@src/api/types/keys";

export type { ModelType, KeyInfo, SaveKeyRequest };

/** Account status */
export type AccountStatus =
  | "ready"
  | "needs_setup"
  | "expired"
  | "error"
  | "pending_approval";

/**
 * Unified KeyVaultAccount — single source of truth from the local key store
 * file (~/.orgii/credentials.json on disk; logical name is "keys" in UI and
 * APIs). OSS is BYOK-only: every account has `hasLocalKey = true` and
 * `isListed = false`. The listing-related fields are retained on the type
 * so the on-disk `KeyInfo` shape and the in-memory `KeyVaultAccount` shape
 * stay structurally aligned; they remain undefined in the OSS build.
 */
export interface KeyVaultAccount {
  id: string;
  /** Key material exists in the local credentials file. Always true in OSS. */
  hasLocalKey: boolean;
  /** This key is published as a market listing. Always false in OSS. */
  isListed: boolean;
  modelType: ModelType;
  name: string;
  status: AccountStatus;

  /** True when this row represents a saved key entry (API key and/or session token). */
  hasKey: boolean;
  hasApiKey: boolean;
  hasSessionToken: boolean;
  authMethod?: "api_key" | "oauth";
  supportsRustAgents?: boolean;
  canLaunchCli?: boolean;
  canUseNativeHarness?: boolean;
  nativeHarnessType?: NativeHarnessType;

  // Previews
  apiKeyPreview?: string;
  sessionTokenPreview?: string;
  baseUrl?: string | null;
  protocol?: "openai" | "anthropic" | null;

  // Validation results
  /** Full list of models from validation (for UI display) */
  availableModels?: string[];
  /** User-enabled models (subset of availableModels, persisted) */
  enabledModels?: string[];
  /** Parsed GPT/Claude suffix variants, keyed by original model id. */
  modelVariants?: ModelVariantInfo[];
  /** User-chosen default variant per base model family (persisted). */
  defaultVariants?: DefaultVariantInfo[];
  /** Master switch — when false the key is disabled without clearing enabledModels. */
  enabled: boolean;
  quotaInfo?: QuotaSnapshot | QuotaInfo | null;

  // Local key health
  healthStatus?: "valid" | "degraded" | "invalid";
  failureCount?: number;
  lastFailureMessage?: string;
  temporaryUnavailableUntil?: string;
  temporaryUnavailableReason?: string;
  lastUpstreamStatus?: number;
  lastUpstreamErrorType?: string;
  rateLimitResetAt?: string;
  modelFailures?: Record<
    string,
    { count: number; last_error?: string; last_at?: string }
  >;

  // Market listing — always undefined in OSS.
  listingId?: string;
  listingStatus?: "draft" | "pending" | "approved" | "rejected" | "suspended";
  marketHealthStatus?: "valid" | "degraded" | "invalid";
  marketFailureMessage?: string;
  marketQuotaInfo?: QuotaSnapshot | null;
  /** Verification data for Cursor listings (market only) */
  verificationData?: VerificationData;
  /** Reason for rejection (market only) */
  rejectionReason?: string;

  // Optional metadata
  description?: string | null;
  connectedAt?: Date;
}

/** Options for `useKeyVault` — local key store only. */
export interface UseKeyVaultOptions {
  /** Auto-detect agents on mount (default: false). Set to true when the
   *  caller needs accounts immediately (e.g. ModelPill). */
  autoLoad?: boolean;
}

export interface UseKeyVaultReturn {
  accounts: KeyVaultAccount[];
  localAccounts: KeyVaultAccount[];
  loading: boolean;
  error: string | null;
  /** Refresh everything: accounts list + quotas + validation (all in parallel) */
  refresh: (force?: boolean) => Promise<void>;
  /** Validate or refresh a single non-OAuth account. OAuth token refresh is runtime-owned. */
  refreshAccount: (accountId: string, force?: boolean) => Promise<boolean>;
  getAccount: (id: string) => KeyVaultAccount | undefined;
  /** Save or update a key entry (delegates to internal useLocalKeys, updates state) */
  saveKey: (request: SaveKeyRequest) => Promise<KeyInfo | null>;
  /** Delete a key entry (delegates to internal useLocalKeys, updates state) */
  deleteKey: (agentType: ModelType, keyId?: string) => Promise<boolean>;
}
