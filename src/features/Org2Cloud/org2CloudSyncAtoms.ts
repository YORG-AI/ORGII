/**
 * Persisted state for the managed-cloud session sync engine (Phase 6).
 *
 * Same zod-validated localStorage idiom as the rest of the store. Five
 * pieces:
 *
 * - `org2CloudRepoScopesAtom` — repo scopes per cloud org. A local MIRROR of
 *   the server truth (`cloud_get_org_repo_scopes`): hydrated by the sync
 *   engine (TTL'd, per pass) and by CloudOrgPanelView on org load, updated
 *   optimistically on a successful save. Offline it serves the last-known
 *   scopes so the push engine keeps working.
 * - `org2CloudSyncEnabledAtom` — per-org local toggle; ABSENT means enabled
 *   (default ON once scopes are set), explicit `false` disables.
 * - `org2CloudPushCursorsAtom` — per (orgId, sessionId) segments push
 *   cursor, the exact shape the self-hosted engine persists
 *   (`CollabSessionPushCursor`): losing one is safe — the next push
 *   re-anchors through the server OCC check.
 * - `org2CloudCollabStateCursorsAtom` — per-org delta cursor for the
 *   projects/work-items listing (cloud-parity Phase B).
 */
import { atomWithStorage } from "jotai/utils";
import { z } from "zod/v4";

import {
  createZodJsonStorage,
  tolerantRecordSchema,
} from "@src/util/core/storage/zodStorage";

import { MERKLE_FRONTIER_MAX_HEIGHT } from "./org2CloudMerkleFrontier";

function cloudStorageKey(name: string): string {
  return `orgii:org2-cloud-v1:${name}`;
}

/**
 * Owner-side segments push cursor, per (orgId, sessionId) — design §7.3.
 * The per-event hash vector itself is NOT persisted: `frozenChainHash` is a
 * compact commitment over the frozen region's per-event hashes, which detects
 * frozen-region mutation without retaining the transcript. Losing a cursor (reinstall,
 * cleared storage) is safe — the next push re-anchors through the server
 * OCC check (rewrite at server epoch + 1). Inherited verbatim from the
 * retired self-hosted engine (cloud-parity Phase E moved the type here).
 */
export interface CollabSessionPushCursor {
  orgId: string;
  sessionId: string;
  /** Segments epoch last acknowledged by the server. */
  epoch: number;
  /** Highest frozen segment seq pushed in this epoch. */
  frozenSeq: number;
  /** Total events (frozen + tail) covered by the last push. */
  pushedCount: number;
  /** Events covered by the frozen region (local frozen-line position). */
  frozenEventCount: number;
  /** Integrity commitment over the per-event hashes of the frozen region. */
  frozenChainHash: string;
  /** segment_hash of the last pushed tail (null = tail was empty). */
  tailHash: string | null;
  /**
   * Revision of the durable native event cache covered by this cursor.
   * Unlike Session.updated_at, this changes only when transcript rows change.
   */
  localContentRevision?: number;
  /**
   * Local session content version covered by this cursor. On restart, a
   * matching remote summary plus this stamp proves that neither the native
   * EventStore nor an imported transcript needs to be materialized again.
   * Optional for upgrade safety: legacy cursors pay one authoritative read
   * and are stamped after that successful pass.
   */
  localContentUpdatedAt?: string;
  /**
   * Source-local checkpoint for bounded imported-history refreshes. It is
   * optional so existing/native cursors retain their current wire behavior;
   * losing or invalidating it only forces one authoritative full re-anchor.
   */
  importedReplay?: ImportedReplayCheckpoint;
}

export interface ImportedReplayCheckpoint {
  version: 1;
  /** Last user turn, reloaded because it may have been the mutable tail. */
  reloadTurnId: string;
  /** Hash of every ordered turn id strictly before reloadTurnId. */
  prefixTurnIdsHash: string;
  /** Absolute normalized-event count before reloadTurnId. */
  retainedEventCount: number;
  /** Absolute provider chunk sequence before reloadTurnId. */
  retainedChunkCount: number;
  /** Frozen events inside reloadTurnId covered by the current cloud cursor. */
  frozenOverlapCount: number;
  /** Hash aggregate of those overlap events. */
  frozenOverlapHash: string;
  /** Binary Merkle frontier for exactly `frozenEventCount` event hashes. */
  frozenHashFrontier: Array<string | null>;
  /**
   * Bounded incremental passes since the last full authoritative read. A
   * historical rewrite that preserves every provider turn id outside the
   * reread overlap is invisible to the compact checkpoint; forcing one full
   * reread every `IMPORTED_INCREMENTAL_REANCHOR_EVERY` passes turns that
   * blind spot from unbounded into a bounded window. Absent on checkpoints
   * written before this field existed — read as 0.
   */
  incrementalPassCount?: number;
}

const RepoScopesSchema = tolerantRecordSchema(
  "repo scope",
  z.array(z.string())
);

/** Cloud orgId → locally-known repo scopes (normalized remote keys). */
export const org2CloudRepoScopesAtom = atomWithStorage<
  Record<string, string[]>
>(cloudStorageKey("repoScopes"), {}, createZodJsonStorage(RepoScopesSchema), {
  getOnInit: true,
});
org2CloudRepoScopesAtom.debugLabel = "org2CloudRepoScopesAtom";

const SyncEnabledSchema = tolerantRecordSchema(
  "sync-enabled flag",
  z.boolean()
);

/** Cloud orgId → sync toggle; missing key = enabled (default ON). */
export const org2CloudSyncEnabledAtom = atomWithStorage<
  Record<string, boolean>
>(cloudStorageKey("syncEnabled"), {}, createZodJsonStorage(SyncEnabledSchema), {
  getOnInit: true,
});
org2CloudSyncEnabledAtom.debugLabel = "org2CloudSyncEnabledAtom";

const CloudPushCursorSchema = z.object({
  orgId: z.string(),
  sessionId: z.string(),
  epoch: z.number(),
  frozenSeq: z.number(),
  pushedCount: z.number(),
  frozenEventCount: z.number(),
  frozenChainHash: z.string(),
  tailHash: z.string().nullable(),
  localContentRevision: z.number().int().nonnegative().optional(),
  localContentUpdatedAt: z.string().optional(),
  importedReplay: z
    .object({
      version: z.literal(1),
      reloadTurnId: z.string(),
      prefixTurnIdsHash: z.string(),
      retainedEventCount: z.number().int().nonnegative(),
      retainedChunkCount: z.number().int().nonnegative(),
      frozenOverlapCount: z.number().int().nonnegative(),
      frozenOverlapHash: z.string(),
      frozenHashFrontier: z
        .array(z.string().nullable())
        .max(MERKLE_FRONTIER_MAX_HEIGHT),
      incrementalPassCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
}) satisfies z.ZodType<CollabSessionPushCursor>;

/**
 * Per-entry tolerant: a whole-store reset would re-anchor every pushed
 * session through an epoch rewrite (fleet-wide churn in the #608 shape);
 * dropping one cursor re-anchors one session, the designed recovery.
 */
export const CloudPushCursorsSchema = tolerantRecordSchema(
  "push cursor",
  CloudPushCursorSchema
);

/** Keyed by `${orgId}:${sessionId}` (cloud org ids, no collision risk). */
export const org2CloudPushCursorsAtom = atomWithStorage<
  Record<string, CollabSessionPushCursor>
>(
  cloudStorageKey("pushCursors"),
  {},
  createZodJsonStorage(CloudPushCursorsSchema),
  { getOnInit: true }
);
org2CloudPushCursorsAtom.debugLabel = "org2CloudPushCursorsAtom";

const PushedMetadataSchema = tolerantRecordSchema(
  "pushed-metadata marker",
  z.literal(true)
);

/**
 * Persisted "we put a live metadata row on the server" marker, keyed
 * `${orgId}:${sessionId}`. The full_replay retract path survives restarts
 * via the persisted segments cursor; a metadata_only push leaves NO cursor,
 * so without this marker a downgrade-to-Off in a LATER app run cannot tell
 * the session was ever pushed and never retracts. Set on every successful
 * metadata upsert, dropped on retract — the exact restart-safe analogue of
 * `org2CloudPushCursorsAtom` for the metadata-only rung.
 */
export const org2CloudPushedMetadataAtom = atomWithStorage<
  Record<string, true>
>(
  cloudStorageKey("pushedMetadata"),
  {},
  createZodJsonStorage(PushedMetadataSchema),
  { getOnInit: true }
);
org2CloudPushedMetadataAtom.debugLabel = "org2CloudPushedMetadataAtom";

const CollabStateCursorsSchema = tolerantRecordSchema(
  "collab state cursor",
  z.string()
);

/**
 * Cloud orgId → ISO delta cursor for `cloud_list_org_collab_state`
 * (projects/work-items plane, cloud-parity Phase B). The engine anchors it
 * on the RPC's serverTime minus a 2s safety overlap; losing one merely
 * widens the next delta — every consumer is idempotent.
 */
export const org2CloudCollabStateCursorsAtom = atomWithStorage<
  Record<string, string>
>(
  cloudStorageKey("collabStateCursors"),
  {},
  createZodJsonStorage(CollabStateCursorsSchema),
  { getOnInit: true }
);
org2CloudCollabStateCursorsAtom.debugLabel = "org2CloudCollabStateCursorsAtom";
