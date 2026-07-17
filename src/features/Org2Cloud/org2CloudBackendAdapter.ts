/**
 * Cloud → collab backend adapter (replay/fork wiring for managed orgs).
 *
 * `importRemoteSession` / `forkTeammateSession` are backend-agnostic: they
 * only ever call `client.getSessionEventSegments(...)`. This module gives
 * the managed ORG2 Cloud backend that one capability by wrapping
 * `cloud_get_session_events` (org2CloudSyncClient) in the EXACT
 * canonical `SessionEventSegmentsSnapshot` shape:
 *
 * - cloud `seq = 0` is the mutable tail row → canonical `isTail: true`;
 * - cloud `payloadGz` (gzipped base64 event array) → decoded `events` via
 *   the SHARED `decodeSegmentEvents` codec (byte-identical wire format —
 *   both backends push through `segmentCodec`);
 * - cloud `{epoch, frozenSeq, tailHash, count}` map 1:1 to the snapshot
 *   summary fields (`cloud_get_session_events` was built as a mirror of
 *   `orgii_get_session_event_segments`);
 * - the cloud RPC has no `after_seq` parameter (always returns the full
 *   epoch), so the importer's incremental contract ("frozen segments with
 *   seq strictly greater than afterSeq; tail always included") is applied
 *   client-side by filtering.
 *
 * Errors are NOT swallowed: `Org2CloudSyncError` (notably code
 * ORG2_RETENTION_EXPIRED, raised when a replay click races past the
 * server-side retention filter) propagates to the caller so the panel can
 * show an upgrade prompt instead of a generic failure.
 */
import type {
  CollabSyncBackendClient,
  GetSessionEventSegmentsInput,
  SessionEventSegmentsSnapshot,
} from "../TeamCollaboration/sync/CollabSyncBackend";
import { decodeSegmentEvents } from "../TeamCollaboration/sync/segmentCodec";
import { getSessionEvents } from "./org2CloudSyncClient";

/** The one capability replay/fork need from a backend. */
export type CloudSessionFetchClient = Pick<
  CollabSyncBackendClient,
  "getSessionEventSegments"
>;

/**
 * The importer passes `remoteSession.id` (`${orgId}:${ownerUserId}:
 * ${sourceSessionId}`, built by `toRemoteMetadata`) as `sessionRowId`,
 * while the cloud RPC keys on the bare `session_id` (= sourceSessionId —
 * see `Org2CloudSyncEngine.upsertMetadataIfChanged`). orgId and
 * ownerUserId are UUIDs (colon-free), so the cloud key is everything after
 * the second colon; a colon-free input is already a bare session id.
 */
export function cloudSessionIdFromRowId(sessionRowId: string): string {
  const parts = sessionRowId.split(":");
  return parts.length >= 3 ? parts.slice(2).join(":") : sessionRowId;
}

/**
 * Build the segments-fetch client `importRemoteSession` / `forkSession`
 * expect, bound to one cloud access token (caller refreshes via
 * `ensureFreshSession` first — RPC wrappers do not refresh).
 *
 * `accessToken` may be null for the GUEST path (0012): `input.shareToken`
 * — threaded by the importer from `RemoteSessionFetchOptions` — then rides
 * into the RPC body and authenticates the read on its own (anon bearer).
 */
export function buildCloudSessionFetchClient(
  accessToken: string | null
): CloudSessionFetchClient {
  return {
    async getSessionEventSegments(
      input: GetSessionEventSegmentsInput
    ): Promise<SessionEventSegmentsSnapshot> {
      const snapshot = await getSessionEvents(
        accessToken,
        input.orgId,
        cloudSessionIdFromRowId(input.sessionRowId),
        input.shareToken !== undefined
          ? { shareToken: input.shareToken }
          : undefined
      );
      const afterSeq = input.afterSeq ?? 0;
      const segments = await Promise.all(
        snapshot.segments
          // Tail (seq 0) always included; frozen only past the cursor.
          .filter((segment) => {
            const seq = segment.seq ?? 0;
            return seq === 0 || seq > afterSeq;
          })
          .map(async (segment) => {
            const seq = segment.seq ?? 0;
            return {
              seq,
              isTail: seq === 0,
              events: await decodeSegmentEvents(segment.payloadGz),
              eventCount: segment.eventCount,
              segmentHash: segment.segmentHash,
            };
          })
      );
      return {
        epoch: snapshot.epoch,
        frozenSeq: snapshot.frozenSeq,
        tailHash: snapshot.tailHash,
        count: snapshot.count,
        segments,
      };
    },
  };
}
