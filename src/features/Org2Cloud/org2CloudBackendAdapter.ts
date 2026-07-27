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
 *   both backends push through `segmentCodec`); a 0006 `storagePath`
 *   segment downloads its raw gzip object from the replay bucket instead;
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
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type {
  CollabSyncBackendClient,
  GetSessionEventSegmentsInput,
  SessionEventSegmentRecord,
  SessionEventSegmentsSnapshot,
} from "../TeamCollaboration/sync/CollabSyncBackend";
import {
  decodeSegmentEvents,
  decodeSegmentEventsFromBytes,
  mapSegmentsBounded,
} from "../TeamCollaboration/sync/segmentCodec";
import type { CloudEndpoint } from "./config";
import { endpointForOrg } from "./org2CloudOrgEndpointRouter";
import {
  type GuestReplayObjectReader,
  createGuestReplayObjectReader,
  isReplayAuthorizeRpcMissing,
} from "./org2CloudReplaySignedReads";
import { downloadReplayObject } from "./org2CloudStorageClient";
import {
  type CloudSegmentWire,
  getSessionEvents,
  streamSessionEvents,
} from "./org2CloudSyncClient";

/** The one capability replay/fork need from a backend. */
export type CloudSessionFetchClient = Pick<
  CollabSyncBackendClient,
  "getSessionEventSegments" | "streamSessionEventSegments"
>;

type SegmentObjectDownload = (
  storagePath: string,
  signal?: AbortSignal
) => Promise<Uint8Array>;

async function decodeCloudSegmentEvents(
  segment: CloudSegmentWire,
  downloadObject: SegmentObjectDownload,
  signal?: AbortSignal
): Promise<SessionEvent[]> {
  if (segment.payloadGz != null) {
    return decodeSegmentEvents(segment.payloadGz);
  }
  if (segment.storagePath != null) {
    return decodeSegmentEventsFromBytes(
      await downloadObject(segment.storagePath, signal)
    );
  }
  throw new Error("cloud segment carries neither payloadGz nor storagePath");
}

async function decodeCloudSegments(
  segments: readonly CloudSegmentWire[],
  afterSeq: number,
  downloadObject: SegmentObjectDownload,
  signal?: AbortSignal
): Promise<SessionEventSegmentRecord[]> {
  return mapSegmentsBounded(
    segments.filter((segment) => {
      const seq = segment.seq ?? 0;
      return seq === 0 || seq > afterSeq;
    }),
    async (segment) => {
      const seq = segment.seq ?? 0;
      return {
        seq,
        isTail: seq === 0,
        events: await decodeCloudSegmentEvents(segment, downloadObject, signal),
        eventCount: segment.eventCount,
        segmentHash: segment.segmentHash,
      };
    },
    signal
  );
}

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
 * Link imports still require a registered user's access token. The optional
 * `input.shareToken` — threaded by the importer from
 * `RemoteSessionFetchOptions` — grants that signed-in user access without
 * requiring membership in the source org. Storage-offloaded segments then
 * read through the signed-url flow (`org2CloudReplaySignedReads`): the guest
 * JWT cannot pass the replay bucket's member RLS. The signed-url map is
 * cached per (session, share token) for this client's lifetime — one import.
 * A backend without the authorize RPC falls back to the member download so
 * the import surfaces exactly the failure it had before the signer existed.
 */
export function buildCloudSessionFetchClient(
  accessToken: string,
  endpoint?: CloudEndpoint
): CloudSessionFetchClient {
  const guestReaders = new Map<string, GuestReplayObjectReader>();
  const downloadForInput = (input: {
    orgId: string;
    sessionRowId: string;
    shareToken?: string;
  }): SegmentObjectDownload => {
    const shareToken = input.shareToken;
    if (shareToken === undefined) {
      return (storagePath, signal) =>
        downloadReplayObject(
          accessToken,
          storagePath,
          endpoint ?? endpointForOrg(input.orgId),
          signal
        );
    }
    const sessionId = cloudSessionIdFromRowId(input.sessionRowId);
    const readerKey = `${input.orgId}\u001f${sessionId}\u001f${shareToken}`;
    let reader = guestReaders.get(readerKey);
    if (!reader) {
      reader = createGuestReplayObjectReader({
        orgId: input.orgId,
        sessionId,
        shareToken,
        ...(endpoint !== undefined ? { endpoint } : {}),
      });
      guestReaders.set(readerKey, reader);
    }
    const guestReader = reader;
    return async (storagePath, signal) => {
      try {
        return await guestReader.download(storagePath, signal);
      } catch (error) {
        if (isReplayAuthorizeRpcMissing(error)) {
          return downloadReplayObject(
            accessToken,
            storagePath,
            endpoint,
            signal
          );
        }
        throw error;
      }
    };
  };
  return {
    async getSessionEventSegments(
      input: GetSessionEventSegmentsInput
    ): Promise<SessionEventSegmentsSnapshot> {
      const afterSeq = input.afterSeq ?? 0;
      const snapshot = await getSessionEvents(
        accessToken,
        input.orgId,
        cloudSessionIdFromRowId(input.sessionRowId),
        input.shareToken !== undefined ||
          endpoint !== undefined ||
          afterSeq > 0 ||
          input.signal !== undefined
          ? {
              ...(input.shareToken !== undefined
                ? { shareToken: input.shareToken }
                : {}),
              ...(endpoint !== undefined ? { endpoint } : {}),
              // Server-side range read (p_after_seq): an incremental pull
              // must not download the frozen prefix it already holds.
              ...(afterSeq > 0 ? { afterSeq } : {}),
              ...(input.signal !== undefined ? { signal: input.signal } : {}),
            }
          : undefined
      );
      const segments = await decodeCloudSegments(
        snapshot.segments,
        afterSeq,
        downloadForInput(input),
        input.signal
      );
      return {
        epoch: snapshot.epoch,
        frozenSeq: snapshot.frozenSeq,
        tailHash: snapshot.tailHash,
        count: snapshot.count,
        segments,
      };
    },
    async streamSessionEventSegments(input, onPage) {
      const afterSeq = input.afterSeq ?? 0;
      const downloadObject = downloadForInput(input);
      return streamSessionEvents(
        accessToken,
        input.orgId,
        cloudSessionIdFromRowId(input.sessionRowId),
        async (page) => {
          await onPage({
            epoch: page.epoch,
            frozenSeq: page.frozenSeq,
            tailHash: page.tailHash,
            count: page.count,
            segments: await decodeCloudSegments(
              page.segments,
              afterSeq,
              downloadObject,
              input.signal
            ),
          });
        },
        {
          ...(input.shareToken !== undefined
            ? { shareToken: input.shareToken }
            : {}),
          ...(endpoint !== undefined ? { endpoint } : {}),
          ...(afterSeq > 0 ? { afterSeq } : {}),
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        }
      );
    },
  };
}
