/**
 * Session-events plane: owner writes (`cloud_rewrite_session_events` /
 * `cloud_append_session_events`, with 0006 storage offload) and viewer reads
 * (`cloud_get_session_events_page`, with the pre-page compatibility fallback).
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type { SessionEventsSegmentInput } from "../TeamCollaboration/sync/CollabSyncBackend";
import {
  mapSegmentsBounded,
  toFrozenSegmentStorage,
  toFrozenSegmentWire,
  toTailWire,
} from "../TeamCollaboration/sync/segmentCodec";
import type { CloudEndpoint } from "./config";
import { getCloudCapabilities } from "./org2CloudCapabilities";
import { endpointForOrg } from "./org2CloudOrgEndpointRouter";
import {
  buildReplayObjectPath,
  uploadReplayObject,
} from "./org2CloudStorageClient";
import {
  Org2CloudSyncError,
  callSyncRpc,
  isRpcSignatureUnsupported,
} from "./org2CloudSyncClient.rpc";
import type {
  CloudSegmentWire,
  CloudSessionEventsSnapshot,
  CloudSessionEventsSummary,
} from "./org2CloudSyncClient.schemas";
import {
  CloudSessionEventsPageSchema,
  CloudSessionEventsSchema,
  MAX_SESSION_EVENT_PAGES,
  SESSION_EVENTS_PAGE_SIZE,
} from "./org2CloudSyncClient.schemas";

/** supabaseUrl set of backends that rejected the storage segment wire (pre-0006). */
const storageSegmentsUnsupportedEndpoints = new Set<string>();

export const __STORAGE_SEGMENTS_INTERNALS = {
  resetStorageSupport: () => storageSegmentsUnsupportedEndpoints.clear(),
};

async function shouldUseStorageSegments(
  accessToken: string,
  endpoint: CloudEndpoint
): Promise<boolean> {
  if (storageSegmentsUnsupportedEndpoints.has(endpoint.supabaseUrl)) {
    return false;
  }
  return (await getCloudCapabilities(accessToken)).storageSegments;
}

interface CloudStorageSegmentWire {
  seq: number;
  storagePath: string;
  eventCount: number;
  segmentHash: string;
}

/** Upload each frozen segment's raw gzip bytes, then describe it by path. */
async function uploadFrozenSegmentsToStorage(
  accessToken: string,
  endpoint: CloudEndpoint,
  orgId: string,
  sessionId: string,
  epoch: number,
  segments: SessionEventsSegmentInput[]
): Promise<CloudStorageSegmentWire[]> {
  return mapSegmentsBounded(segments, async (segment) => {
    const encoded = await toFrozenSegmentStorage(segment);
    const storagePath = buildReplayObjectPath(
      orgId,
      sessionId,
      epoch,
      encoded.seq,
      encoded.segmentHash
    );
    await uploadReplayObject(accessToken, storagePath, encoded.bytes, endpoint);
    return {
      seq: encoded.seq,
      storagePath,
      eventCount: encoded.eventCount,
      segmentHash: encoded.segmentHash,
    };
  });
}

export interface CloudRewriteSessionEventsInput {
  orgId: string;
  sessionId: string;
  newEpoch: number;
  frozenSegments: SessionEventsSegmentInput[];
  tail: SessionEvent[] | null;
  totalCount: number;
}

/** Owner: epoch-bumped full rewrite of the session's segments. */
export async function rewriteSessionEvents(
  accessToken: string,
  input: CloudRewriteSessionEventsInput
): Promise<void> {
  const endpoint = endpointForOrg(input.orgId);
  const baseBody = {
    p_org_id: input.orgId,
    p_session_id: input.sessionId,
    new_epoch: input.newEpoch,
    tail: await toTailWire(input.tail),
    total_count: input.totalCount,
  };
  if (
    input.frozenSegments.length > 0 &&
    (await shouldUseStorageSegments(accessToken, endpoint))
  ) {
    const frozenSegments = await uploadFrozenSegmentsToStorage(
      accessToken,
      endpoint,
      input.orgId,
      input.sessionId,
      input.newEpoch,
      input.frozenSegments
    );
    try {
      await callSyncRpc(
        "cloud_rewrite_session_events",
        accessToken,
        { ...baseBody, frozen_segments: frozenSegments },
        endpoint
      );
      return;
    } catch (error) {
      if (!isRpcSignatureUnsupported(error)) throw error;
      storageSegmentsUnsupportedEndpoints.add(endpoint.supabaseUrl);
    }
  }
  await callSyncRpc(
    "cloud_rewrite_session_events",
    accessToken,
    {
      ...baseBody,
      // Bounded encode: `Promise.all` over every segment materializes all
      // canonical/gzip/base64 buffers simultaneously and multiplies RSS.
      frozen_segments: await mapSegmentsBounded(
        input.frozenSegments,
        toFrozenSegmentWire
      ),
    },
    endpoint
  );
}

export interface CloudAppendSessionEventsInput {
  orgId: string;
  sessionId: string;
  /** OCC anchors: mismatch raises ORG2_CONFLICT. */
  expectedEpoch: number;
  expectedFrozenSeq: number;
  expectedTailHash: string | null;
  newFrozenSegments: SessionEventsSegmentInput[];
  tail: SessionEvent[] | null;
  totalCount: number;
}

/** Owner: incremental append (new frozen segments + tail replace). */
export async function appendSessionEvents(
  accessToken: string,
  input: CloudAppendSessionEventsInput
): Promise<void> {
  const endpoint = endpointForOrg(input.orgId);
  const baseBody = {
    p_org_id: input.orgId,
    p_session_id: input.sessionId,
    expected_epoch: input.expectedEpoch,
    expected_frozen_seq: input.expectedFrozenSeq,
    expected_tail_hash: input.expectedTailHash,
    tail: await toTailWire(input.tail),
    total_count: input.totalCount,
  };
  if (
    input.newFrozenSegments.length > 0 &&
    (await shouldUseStorageSegments(accessToken, endpoint))
  ) {
    const newFrozenSegments = await uploadFrozenSegmentsToStorage(
      accessToken,
      endpoint,
      input.orgId,
      input.sessionId,
      input.expectedEpoch,
      input.newFrozenSegments
    );
    try {
      await callSyncRpc(
        "cloud_append_session_events",
        accessToken,
        { ...baseBody, new_frozen_segments: newFrozenSegments },
        endpoint
      );
      return;
    } catch (error) {
      if (!isRpcSignatureUnsupported(error)) throw error;
      storageSegmentsUnsupportedEndpoints.add(endpoint.supabaseUrl);
    }
  }
  await callSyncRpc(
    "cloud_append_session_events",
    accessToken,
    {
      ...baseBody,
      new_frozen_segments: await mapSegmentsBounded(
        input.newFrozenSegments,
        toFrozenSegmentWire
      ),
    },
    endpoint
  );
}

export interface GetSessionEventsOptions {
  /**
   * Link-share capability (0012): when set, a registered non-member can read
   * the shared session. The user JWT proves registration; this token grants
   * access to the one session.
   */
  shareToken?: string;
  /** Server-side incremental fetch (frozen past the cursor + tail always). */
  afterSeq?: number;
  /** Endpoint snapshot shared with a preceding share-token resolve. */
  endpoint?: CloudEndpoint;
  /** Cancels the network read (dialog close / attempt supersession). */
  signal?: AbortSignal;
}

/**
 * Member: full segments snapshot for one shared session. Raises
 * ORG2_RETENTION_EXPIRED when the session left the plan's window. Frozen
 * segments are fetched through bounded server pages and reassembled in wire
 * order; the tail is returned only on the final page. This prevents a large
 * replay from forcing PostgreSQL to aggregate the entire history into one
 * JSON value (and hitting the managed 15 s statement timeout).
 *
 * With `options.shareToken` this becomes a registered-link read that does not
 * require org membership (opaque ORG2_UNAUTHORIZED on every capability
 * failure).
 *
 * A backend that predates the paged RPC receives one compatibility attempt
 * through `cloud_get_session_events`. Official cloud is upgraded in lockstep;
 * the fallback keeps existing small-session self-hosted deployments usable.
 */
export async function getSessionEvents(
  accessToken: string,
  orgId: string,
  sessionId: string,
  options?: GetSessionEventsOptions
): Promise<CloudSessionEventsSnapshot> {
  const segments: CloudSegmentWire[] = [];
  const summary = await streamSessionEvents(
    accessToken,
    orgId,
    sessionId,
    async (page) => {
      segments.push(...page.segments);
    },
    options
  );
  return { ...summary, segments };
}

/**
 * Bounded-memory variant used by large replay imports. A page is released as
 * soon as `onPage` resolves; callers must not retain it when they need a
 * genuinely streaming path.
 */
export async function streamSessionEvents(
  accessToken: string,
  orgId: string,
  sessionId: string,
  onPage: (page: CloudSessionEventsSnapshot) => Promise<void>,
  options?: GetSessionEventsOptions
): Promise<CloudSessionEventsSummary> {
  try {
    return await streamSessionEventsPaged(
      accessToken,
      orgId,
      sessionId,
      onPage,
      options
    );
  } catch (error) {
    if (!(error instanceof Org2CloudSyncError) || error.status !== 404) {
      throw error;
    }
    const snapshot = await getSessionEventsLegacy(
      accessToken,
      orgId,
      sessionId,
      options
    );
    await onPage(snapshot);
    const { segments: _segments, ...summary } = snapshot;
    return summary;
  }
}

async function streamSessionEventsPaged(
  accessToken: string,
  orgId: string,
  sessionId: string,
  onPage: (page: CloudSessionEventsSnapshot) => Promise<void>,
  options?: GetSessionEventsOptions
): Promise<CloudSessionEventsSummary> {
  let afterSeq = options?.afterSeq ?? 0;
  let expectedEpoch: number | null = null;
  let latest: CloudSessionEventsSummary = {
    epoch: null,
    frozenSeq: null,
    tailHash: null,
    count: null,
  };

  for (let pageIndex = 0; pageIndex < MAX_SESSION_EVENT_PAGES; pageIndex += 1) {
    const payload = await callSyncRpc(
      "cloud_get_session_events_page",
      accessToken,
      {
        p_org_id: orgId,
        p_session_id: sessionId,
        p_after_seq: afterSeq,
        p_limit: SESSION_EVENTS_PAGE_SIZE,
        ...(expectedEpoch !== null ? { p_expected_epoch: expectedEpoch } : {}),
        ...(options?.shareToken !== undefined
          ? { p_share_token: options.shareToken }
          : {}),
      },
      options?.endpoint ?? endpointForOrg(orgId),
      options?.signal
    );
    const parsed = CloudSessionEventsPageSchema.parse(payload);
    if (expectedEpoch === null) {
      expectedEpoch = parsed.epoch;
    } else if (parsed.epoch !== expectedEpoch) {
      throw new Org2CloudSyncError(
        "ORG2_CONFLICT session events epoch changed during paged read",
        409
      );
    }

    latest = {
      epoch: parsed.epoch,
      frozenSeq: parsed.frozenSeq,
      tailHash: parsed.tailHash,
      count: parsed.count,
    };
    await onPage({ ...latest, segments: parsed.segments });
    if (!parsed.hasMore) {
      return latest;
    }
    if (parsed.nextAfterSeq <= afterSeq) {
      throw new Org2CloudSyncError(
        "cloud_get_session_events_page did not advance its cursor"
      );
    }
    afterSeq = parsed.nextAfterSeq;
  }

  throw new Org2CloudSyncError(
    `cloud_get_session_events_page exceeded ${MAX_SESSION_EVENT_PAGES} pages`
  );
}

async function getSessionEventsLegacy(
  accessToken: string,
  orgId: string,
  sessionId: string,
  options?: GetSessionEventsOptions
): Promise<CloudSessionEventsSnapshot> {
  const payload = await callSyncRpc(
    "cloud_get_session_events",
    accessToken,
    {
      p_org_id: orgId,
      p_session_id: sessionId,
      ...(options?.shareToken !== undefined
        ? { p_share_token: options.shareToken }
        : {}),
      ...(options?.afterSeq !== undefined
        ? { p_after_seq: options.afterSeq }
        : {}),
    },
    options?.endpoint ?? endpointForOrg(orgId),
    options?.signal
  );
  const parsed = CloudSessionEventsSchema.parse(payload);
  return {
    epoch: parsed.epoch,
    frozenSeq: parsed.frozenSeq,
    tailHash: parsed.tailHash,
    count: parsed.count,
    segments: parsed.segments,
  };
}
