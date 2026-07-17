/**
 * Wire types for the orgii_collab outbox TS-bridge (design §16.8).
 * Mirrors `project_management::sync::collab_bridge` (serde camelCase).
 */

export const COLLAB_ENTITY_KIND = {
  PROJECT: "project",
  WORK_ITEM: "work_item",
} as const;
export type CollabEntityKind =
  (typeof COLLAB_ENTITY_KIND)[keyof typeof COLLAB_ENTITY_KIND];

export const COLLAB_PUSH_OP = {
  UPSERT: "upsert",
  DELETE: "delete",
} as const;
export type CollabPushOp = (typeof COLLAB_PUSH_OP)[keyof typeof COLLAB_PUSH_OP];

/** One coalesced push unit returned by `project_collab_outbox_drain`. */
export interface CollabOutboxPushItem {
  /** Outbox rows folded into this push; ack echoes them back. */
  entryIds: number[];
  orgId: string;
  kind: CollabEntityKind;
  /** `projects.id` / `workitems.id` — also the server row id. */
  entityId: string;
  /** Derived from CURRENT local state at drain time. */
  op: CollabPushOp;
  /** Full wire snapshot for upserts; null/absent for deletes. */
  payload?: Record<string, unknown> | null;
  /** Last acknowledged server version (OCC base); null = never synced. */
  baseVersion?: number | null;
  fieldPaths: string[];
}

export interface CollabPendingEntity {
  kind: CollabEntityKind;
  entityId: string;
}

/** Push outcome fed to `project_collab_outbox_ack`. */
export interface CollabOutboxAckResult {
  entryIds: number[];
  kind: CollabEntityKind;
  entityId: string;
  ok: boolean;
  /** Server row version after a successful push. */
  remoteVersion?: number | null;
  /** ORGII_CONFLICT requeues immediately; anything else backs off. */
  error?: string | null;
}

/** One pulled server row for `project_collab_apply_remote`. */
export interface CollabRemoteEntity {
  kind: CollabEntityKind;
  /** The server row as pulled (payload merged with version/deletedAt). */
  payload: Record<string, unknown>;
  version: number;
  updatedBy?: string | null;
  deletedAt?: string | null;
}
