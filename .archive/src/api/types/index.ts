/**
 * API Types
 *
 * Shared type definitions for API layer.
 */

// Key / CLI account types
export type {
  ModelType,
  AuthMethod,
  HealthStatus,
  KeyInfo,
  SaveKeyRequest,
  FullKeyResponse,
  KeysListResponse,
  DetectedKey,
  AutoDetectResponse,
  QuotaInfo,
  ValidateKeyResponse,
} from "./keys";

// KeyVault status / quota / verification (hoisted from the archived
// market types in Phase 1.5 of the OSS carve-out)
export type {
  ListingStatus,
  VerificationState,
  VerificationData,
  QuotaSnapshot,
} from "./keyVault";

// Inbox domain types
export type {
  InboxMessage,
  InboxCategory,
  MessagePriority,
  MessageStatus,
  DateGroup,
} from "./inbox";

// Integrations domain types
export {
  CATEGORY_KEYS,
  type IntegrationCategory,
  type SplitViewTableCategory,
  type DetailMode,
  type AddAction,
  type WizardKind,
} from "./integrations";
