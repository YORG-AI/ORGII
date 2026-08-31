/**
 * Managed-cloud session sync client (Phase 6, design §8).
 *
 * Typed wrappers for the `org2_cloud` session-sync RPCs. Same raw-fetch
 * idiom as `org2CloudClient` (JWT Bearer + `Content-Profile: org2_cloud`,
 * no supabase-js), but UNLIKE that client these wrappers THROW on failure —
 * the sync engine needs the server's error codes (ORG2_CONFLICT,
 * ORG2_QUOTA_EXCEEDED, ORG2_SYNC_DISABLED, ORG2_FORBIDDEN,
 * ORG2_RETENTION_EXPIRED, ORG2_SCOPE_COOLDOWN) to drive its OCC re-anchor
 * and backoff paths.
 *
 * Segment bodies are built by the SHARED codec
 * (`TeamCollaboration/sync/segmentCodec`) so managed and self-hosted pushes
 * ship byte-identical `SegmentWirePayload` wire shapes.
 *
 * This module is the stable import path; the implementation lives in the
 * `org2CloudSyncClient.*` siblings:
 * - `.rpc`         error model + `callSyncRpc` plumbing
 * - `.schemas`     zod wire parsers and the shapes they produce
 * - `.listing`     `cloud_list_org_sessions` (+ keyset pagination fallback)
 * - `.events`      segment writes and paged segment reads
 * - `.orgSettings` repo scopes, sharing floors, metadata upsert, tombstone
 * - `.turnIndex`   0012 per-round index publish/read
 */
export {
  ORG2_SYNC_ERROR_CODES,
  Org2CloudSyncError,
  isOrg2SyncErrorCode,
} from "./org2CloudSyncClient.rpc";
export type { Org2SyncErrorCode } from "./org2CloudSyncClient.rpc";

export type {
  CloudOrgScopeState,
  CloudOrgSessions,
  CloudSegmentWire,
  CloudSessionEventsSnapshot,
  CloudSessionEventsSummary,
} from "./org2CloudSyncClient.schemas";

export {
  SESSION_LISTING_PAGE_SIZE,
  __SESSION_LISTING_INTERNALS,
  listOrgSessions,
} from "./org2CloudSyncClient.listing";

export {
  __STORAGE_SEGMENTS_INTERNALS,
  appendSessionEvents,
  getSessionEvents,
  rewriteSessionEvents,
  streamSessionEvents,
} from "./org2CloudSyncClient.events";
export type {
  CloudAppendSessionEventsInput,
  CloudRewriteSessionEventsInput,
  GetSessionEventsOptions,
} from "./org2CloudSyncClient.events";

export {
  deleteSession,
  getOrgRepoScopes,
  setMemberSharingFloor,
  setOrgBackgroundUpload,
  setOrgRepoScopes,
  setOrgSharingFloor,
  upsertSessionMetadata,
} from "./org2CloudSyncClient.orgSettings";

export {
  __TURN_INDEX_INTERNALS,
  getSessionTurnIndex,
  upsertSessionTurnIndex,
} from "./org2CloudSyncClient.turnIndex";
export type {
  CloudSessionTurnIndex,
  CloudSessionTurnSummary,
} from "./org2CloudSyncClient.turnIndex";
