/**
 * Wire types for the project sync API (project_sync_* Tauri commands).
 * Imported by sync.ts (implementation) and all UI consumers.
 */

/**
 * Authentication method advertised by an adapter. Matches the Rust
 * `AuthMethod` enum (snake_case wire format).
 */
export type AdapterAuthMethod = "api_key" | "oauth";

/**
 * Identifier card for a registered adapter — what `list_adapters`
 * returns and what the UI shows in the "attach" picker.
 */
export interface AdapterDescriptor {
  id: string;
  label: string;
  requires_auth: boolean;
  auth_methods: AdapterAuthMethod[];
  supports_webhook: boolean;
  supports_import: boolean;
}

/**
 * Phase 4.9 — flow-kind discriminator for `OAuthFlowStart`.
 */
export const OAUTH_FLOW_KIND = {
  DEVICE: "device",
  REDIRECT: "redirect",
} as const;

export interface OAuthDeviceFlow {
  kind: typeof OAUTH_FLOW_KIND.DEVICE;
  user_code: string;
  verification_uri: string;
  interval_secs: number;
  expires_at_unix: number;
}

export interface OAuthRedirectFlow {
  kind: typeof OAUTH_FLOW_KIND.REDIRECT;
  authorize_url: string;
  expires_at_unix: number;
}

export type OAuthFlowStart = OAuthDeviceFlow | OAuthRedirectFlow;

/**
 * Per-project sync snapshot returned by `status`.
 */
export interface SyncStatusReport {
  adapter_id: string | null;
  sync_connection_id: string | null;
  last_pull_at: number | null;
  pending_count: number;
  failed_count: number;
  abandoned_count: number;
  last_error: string | null;
}

export type SyncEventTrigger =
  | "push_cycle"
  | "pull_cycle"
  | "merge_cycle"
  | "manual";

/**
 * Live outbox-state delta pushed by the Rust worker.
 * Event channel: `orgii-project-sync-status`.
 */
export interface SyncStatusEvent {
  project_slug: string;
  adapter_id: string | null;
  sync_connection_id: string | null;
  last_pull_at: number | null;
  pending_count: number;
  failed_count: number;
  abandoned_count: number;
  last_error: string | null;
  trigger: SyncEventTrigger;
}

/** Outbox entity classes mirroring the Rust `EntityType` enum. */
export type EntityType =
  | "work_item"
  | "project"
  | "label"
  | "milestone"
  | "member";

/** Outbox operation kind mirroring the Rust `OutboxOp` enum. */
export type OutboxOp = "create" | "update" | "delete" | "merge_external";

/** Outbox row lifecycle status mirroring the Rust `OutboxStatus` enum. */
export type OutboxStatus =
  | "pending"
  | "in_flight"
  | "succeeded"
  | "failed"
  | "abandoned";

/**
 * One row in the "Failed entries" UI section, returned by `listProblems`.
 */
export interface OutboxProblemRow {
  id: number;
  entity_type: EntityType;
  entity_id: string;
  op: OutboxOp;
  field_path: string | null;
  created_at: number;
  last_attempted_at: number | null;
  retry_count: number;
  last_error: string | null;
  status: OutboxStatus;
  payload_json: string;
}

/**
 * One row from `~/.orgii/sync-metrics.jsonl`, returned by `metricsTail()`.
 */
export interface SyncMetric {
  ts: string;
  slug: string;
  adapter_id: string;
  kind: SyncMetricKind;
  outcome: SyncMetricOutcome;
  duration_ms: number;
  count: number;
  note?: string;
}

export type SyncMetricKind =
  | "push"
  | "pull"
  | "webhook"
  | "import"
  | "conflict_resolve";

export type SyncMetricOutcome =
  | "ok"
  | "empty"
  | "transient"
  | "permanent"
  | "auth"
  | "rate_limited"
  | "cancelled";

/**
 * Phase 5 — Webhook install descriptor.
 */
export interface WebhookInstallInfo {
  url_path: string;
  secret_hex: string;
  last_rotated_at: number;
}

/**
 * Phase 5 — Webhook state snapshot, returned by `webhookStatus`.
 */
export interface WebhookStatusInfo {
  adapter_id: string;
  installed: boolean;
  url_path: string | null;
  last_rotated_at: number | null;
  last_webhook_at: number | null;
}

/** Phase 6 — import progress lifecycle state. */
export type ImportState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Phase 6 — snapshot of the bulk-import progress for one (slug, adapter_id) pair.
 */
export interface ImportProgressInfo {
  project_slug: string;
  adapter_id: string;
  state: ImportState;
  page_cursor: string | null;
  imported_count: number;
  total_hint: number | null;
  started_at: number;
  updated_at: number;
  last_error: string | null;
}

/** Which side of the conflict is currently materialized in the local DB. */
export const APPLIED_SIDE = {
  LOCAL: "local",
  REMOTE: "remote",
} as const;

export type AppliedSide = (typeof APPLIED_SIDE)[keyof typeof APPLIED_SIDE];

/** Resolution choice the user picked when closing a conflict row. */
export const CONFLICT_RESOLUTION = {
  USE_LOCAL: "use_local",
  USE_REMOTE: "use_remote",
  DISMISSED: "dismissed",
} as const;

export type ConflictResolution =
  (typeof CONFLICT_RESOLUTION)[keyof typeof CONFLICT_RESOLUTION];

/**
 * One field's snapshot at the moment the conflict was detected.
 */
export interface ConflictFieldDelta {
  local_value: unknown;
  remote_value: unknown;
  local_mtime: number;
  remote_mtime: number;
  local_source: string;
  remote_source: string;
  applied: AppliedSide;
}

/** Field-level conflict map. Keyed by local field name. */
export interface ConflictFieldsPayload {
  fields: Record<string, ConflictFieldDelta>;
}

/**
 * One row in the Phase-7 Conflicts panel, returned by `conflictsList`.
 */
export interface ConflictRow {
  id: number;
  project_slug: string;
  adapter_id: string;
  entity_type: EntityType;
  entity_id: string;
  external_id: string;
  fields: ConflictFieldsPayload;
  detected_at: number;
  resolved_at: number | null;
  resolution: ConflictResolution | null;
  source_outbox_id: number | null;
}
