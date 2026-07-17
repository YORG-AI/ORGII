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
 * - `org2CloudCommentTaskCursorsAtom` — per-org delta cursor for the
 *   comment agent-task listing (migration 0002).
 */
import { atomWithStorage } from "jotai/utils";
import { z } from "zod/v4";

import { createZodJsonStorage } from "@src/util/core/storage/zodStorage";

function cloudStorageKey(name: string): string {
  return `orgii:org2-cloud-v1:${name}`;
}

/**
 * Owner-side segments push cursor, per (orgId, sessionId) — design §7.3.
 * The per-event hash vector itself is NOT persisted: `frozenChainHash` is a
 * sha256 chain over the frozen region's per-event hashes, which detects
 * frozen-region mutation with O(1) storage. Losing a cursor (reinstall,
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
  /** sha256 over the concatenated per-event hashes of the frozen region. */
  frozenChainHash: string;
  /** segment_hash of the last pushed tail (null = tail was empty). */
  tailHash: string | null;
}

const RepoScopesSchema = z.record(z.string(), z.array(z.string()));

/** Cloud orgId → locally-known repo scopes (normalized remote keys). */
export const org2CloudRepoScopesAtom = atomWithStorage<
  Record<string, string[]>
>(cloudStorageKey("repoScopes"), {}, createZodJsonStorage(RepoScopesSchema), {
  getOnInit: true,
});
org2CloudRepoScopesAtom.debugLabel = "org2CloudRepoScopesAtom";

const SyncEnabledSchema = z.record(z.string(), z.boolean());

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
}) satisfies z.ZodType<CollabSessionPushCursor>;

const CloudPushCursorsSchema = z.record(z.string(), CloudPushCursorSchema);

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

const PushedMetadataSchema = z.record(z.string(), z.literal(true));

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

const CollabStateCursorsSchema = z.record(z.string(), z.string());

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

const CommentTaskCursorsSchema = z.record(z.string(), z.string());

/**
 * Cloud orgId → ISO delta cursor for `cloud_list_comment_tasks` (comment
 * agent tasks, migration 0002). Same discipline as the collab-state cursor
 * above: anchored on the RPC's serverTime minus the 2s safety overlap,
 * full listing once per engine start; losing one merely widens the next
 * delta — the task-map merge is an idempotent `updated_at` LWW.
 */
export const org2CloudCommentTaskCursorsAtom = atomWithStorage<
  Record<string, string>
>(
  cloudStorageKey("commentTaskCursors"),
  {},
  createZodJsonStorage(CommentTaskCursorsSchema),
  { getOnInit: true }
);
org2CloudCommentTaskCursorsAtom.debugLabel = "org2CloudCommentTaskCursorsAtom";
