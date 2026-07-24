/**
 * Cloud → collaboration backend adapter for bounded replay and fork reads.
 *
 * The collaboration importer consumes opaque, byte-bounded physical rows.
 * Inline cloud rows already contain base64 gzip payloads. Storage-offloaded
 * rows are downloaded as raw gzip bytes and base64-encoded without decoding
 * their event arrays in the renderer.
 */
import type {
  CollabSyncBackendClient,
  GetSessionEventWirePageInput,
  SessionEventSegmentWireRecord,
  SessionEventWirePage,
} from "../TeamCollaboration/sync/CollabSyncBackend";
import { SESSION_EVENT_WIRE_MAX_SEGMENT_BYTES } from "../TeamCollaboration/sync/CollabSyncBackend";
import { bytesToBase64 } from "../TeamCollaboration/sync/collabGzip";
import type { CloudEndpoint } from "./config";
import { downloadReplayObject } from "./org2CloudStorageClient";
import {
  type CloudSegmentWire,
  type CloudSessionEventWirePage,
  CloudSessionWirePageContractError,
  getSessionEvents,
} from "./org2CloudSyncClient";

/** Raw bounded client used by the Rust-backed import path. */
export type CloudSessionWirePageClient = Pick<
  CollabSyncBackendClient,
  "getSessionEventWirePage"
>;

const wireEncoder = new TextEncoder();

function segmentWireBytes(segment: SessionEventSegmentWireRecord): number {
  return wireEncoder.encode(JSON.stringify(segment)).byteLength;
}

async function materializeCloudSegment(
  segment: CloudSegmentWire,
  accessToken: string,
  endpoint: CloudEndpoint | undefined,
  signal: AbortSignal | undefined
): Promise<SessionEventSegmentWireRecord> {
  const seq = segment.seq ?? 0;
  const payloadGz =
    segment.payloadGz ??
    (segment.storagePath
      ? bytesToBase64(
          await downloadReplayObject(
            accessToken,
            segment.storagePath,
            endpoint,
            signal
          )
        )
      : null);
  if (payloadGz === null) {
    throw new CloudSessionWirePageContractError(
      `cloud segment ${seq} carries neither payloadGz nor storagePath`
    );
  }
  return {
    seq,
    payloadGz,
    eventCount: segment.eventCount,
    segmentHash: segment.segmentHash,
  };
}

async function materializeCloudPage(
  page: CloudSessionEventWirePage,
  input: GetSessionEventWirePageInput,
  accessToken: string,
  endpoint: CloudEndpoint | undefined
): Promise<SessionEventWirePage> {
  const segments: SessionEventSegmentWireRecord[] = [];
  let returnedWireBytes = 0;
  for (const segment of page.segments) {
    if (input.signal?.aborted) {
      throw input.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const materialized = await materializeCloudSegment(
      segment,
      accessToken,
      endpoint,
      input.signal
    );
    const bytes = segmentWireBytes(materialized);
    if (bytes > SESSION_EVENT_WIRE_MAX_SEGMENT_BYTES) {
      throw new CloudSessionWirePageContractError(
        `materialized cloud segment ${materialized.seq} is ${bytes} bytes ` +
          `(limit ${SESSION_EVENT_WIRE_MAX_SEGMENT_BYTES})`
      );
    }
    returnedWireBytes += bytes;
    if (returnedWireBytes > input.maxWireBytes) {
      throw new CloudSessionWirePageContractError(
        `materialized cloud page is ${returnedWireBytes} bytes ` +
          `(requested at most ${input.maxWireBytes})`
      );
    }
    segments.push(materialized);
  }
  return {
    epoch: page.epoch,
    frozenSeq: page.frozenSeq,
    tailHash: page.tailHash,
    count: page.count,
    segments,
    tailIncluded: page.tailIncluded,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    returnedWireBytes,
  };
}

/**
 * The importer passes `${orgId}:${ownerUserId}:${sourceSessionId}` while the
 * cloud RPC keys on the bare source session id. UUID org/user prefixes are
 * colon-free, so everything after the second colon is the cloud session id.
 */
export function cloudSessionIdFromRowId(sessionRowId: string): string {
  const parts = sessionRowId.split(":");
  return parts.length >= 3 ? parts.slice(2).join(":") : sessionRowId;
}

/** Build the only replay/fork read capability: bounded opaque wire pages. */
export function buildCloudSessionWirePageClient(
  accessToken: string,
  endpoint?: CloudEndpoint
): CloudSessionWirePageClient {
  return {
    async getSessionEventWirePage(
      input: GetSessionEventWirePageInput
    ): Promise<SessionEventWirePage> {
      const page = await getSessionEvents(
        accessToken,
        input.orgId,
        cloudSessionIdFromRowId(input.sessionRowId),
        {
          boundedWirePage: true,
          cursor: input.cursor,
          includeTail: input.includeTail,
          maxSegments: input.maxSegments,
          maxWireBytes: input.maxWireBytes,
          ...(input.shareToken !== undefined
            ? { shareToken: input.shareToken }
            : {}),
          ...(endpoint !== undefined ? { endpoint } : {}),
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        }
      );
      return materializeCloudPage(page, input, accessToken, endpoint);
    },
  };
}
