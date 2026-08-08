/**
 * Shared remote segments fetch + assembly (design §7.4).
 *
 * The segments-fetch capability behind both teammate-session import
 * (`collabSessionImport.ts`, read-only replay copy) and fork
 * (`collabSessionFork.ts`, writable relay copy): contiguity, per-segment
 * content-hash proof and summary reconciliation all live here so the two
 * callers cannot drift apart on validation.
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import { SegmentIntegrityError } from "../forkSnapshotIntegrity";
import type {
  CollabSyncBackendClient,
  SessionEventSegmentRecord,
  SessionEventSegmentsSnapshot,
} from "../sync/CollabSyncBackend";
import { computeSegmentHash } from "../sync/collabGzip";

/**
 * The segments-fetch capability shared by `importRemoteSession` (read-only
 * replay copy) and `forkSession` (writable relay copy). Both fetch the SAME
 * remote history through `fetchAndAssembleSegments`; they differ only in what
 * kind of local session the assembled events land in.
 */
export interface RemoteSessionImportProgress {
  /** Events fetched/persisted so far, including any locally retained base. */
  loadedEvents: number;
  /** Server-reported total events for the session; null until known. */
  totalEvents: number | null;
  /** Defaults to "downloading" when omitted. */
  phase?: "downloading" | "finalizing";
}

export interface RemoteSessionFetchOptions {
  client: Pick<
    CollabSyncBackendClient,
    "getSessionEventSegments" | "streamSessionEventSegments"
  >;
  orgId: string;
  remoteSession: RemoteTeammateSessionMetadata;
  /**
   * Per-page progress. The paged events RPC reports the session's total on
   * every page; without this callback that number is simply discarded.
   */
  onProgress?: (progress: RemoteSessionImportProgress) => void;
  /**
   * Link-share capability (design §6.4): when set, every segments fetch
   * authenticates with the token alone — the caller is typically NOT an org
   * member (guest deep link). The token is the only credential.
   * `remoteSession` then comes from `resolveSessionShare`, whose projection
   * includes the segments summary this importer diffs against.
   */
  shareToken?: string;
  /** Non-secret issuing endpoint persisted with a guest capability. */
  shareEndpointUrl?: string;
  /** Deployment identity used to isolate deterministic imports and cursors. */
  sourceEndpointUrl?: string;
  /** Cancels fetch, decode and the durable local apply. */
  signal?: AbortSignal;
}

export interface AssembledSegments {
  events: SessionEvent[];
  epoch: number;
  frozenSeq: number;
  frozenCount: number;
  tailHash: string | null;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

export async function validateSegmentIntegrity(
  segment: SessionEventSegmentRecord
): Promise<void> {
  if (segment.events.length !== segment.eventCount) {
    throw new SegmentIntegrityError(segment.seq, segment.isTail, "event_count");
  }
  if ((await computeSegmentHash(segment.events)) !== segment.segmentHash) {
    throw new SegmentIntegrityError(
      segment.seq,
      segment.isTail,
      "content_hash"
    );
  }
}

/**
 * One snapshot fetch, preferring the page-streamed wire so per-page progress
 * can be reported while the result is still assembled in memory for the
 * atomic splice/restore paths. Byte-identical result either way.
 */
async function fetchSegmentsSnapshot(params: {
  client: RemoteSessionFetchOptions["client"];
  orgId: string;
  sessionRowId: string;
  afterSeq: number;
  shareToken: string | undefined;
  signal: AbortSignal | undefined;
  baseEventCount: number;
  onProgress: RemoteSessionFetchOptions["onProgress"];
}): Promise<SessionEventSegmentsSnapshot> {
  const stream = params.client.streamSessionEventSegments;
  if (!stream) {
    return params.client.getSessionEventSegments({
      orgId: params.orgId,
      sessionRowId: params.sessionRowId,
      afterSeq: params.afterSeq,
      shareToken: params.shareToken,
      signal: params.signal,
    });
  }
  const segments: SessionEventSegmentRecord[] = [];
  let loadedEvents = params.baseEventCount;
  const summary = await stream(
    {
      orgId: params.orgId,
      sessionRowId: params.sessionRowId,
      afterSeq: params.afterSeq,
      shareToken: params.shareToken,
      signal: params.signal,
    },
    async (page) => {
      throwIfAborted(params.signal);
      segments.push(...page.segments);
      loadedEvents += page.segments.reduce(
        (count, segment) => count + segment.events.length,
        0
      );
      params.onProgress?.({
        loadedEvents,
        totalEvents: page.count ?? null,
      });
    }
  );
  return { ...summary, segments };
}

export async function fetchAndAssembleSegments(
  options: RemoteSessionFetchOptions,
  afterSeq: number,
  baseFrozenEvents: SessionEvent[],
  expectedEpoch: number | null
): Promise<AssembledSegments | null> {
  const { client, orgId, remoteSession, shareToken, signal, onProgress } =
    options;
  const snapshot = await fetchSegmentsSnapshot({
    client,
    orgId,
    sessionRowId: remoteSession.id,
    afterSeq,
    shareToken,
    signal,
    baseEventCount: baseFrozenEvents.length,
    onProgress,
  });
  if (snapshot.epoch === null || snapshot.count === null) return null;
  // The snapshot is authoritative over the (possibly stale) list summary; a
  // mid-flight epoch change invalidates the incremental base.
  if (expectedEpoch !== null && snapshot.epoch !== expectedEpoch) return null;

  // Content-level proof BEFORE assembly: contiguity and totals below are
  // structural only — a payload whose decoded events disagree with its own
  // eventCount/segmentHash must fail closed, not splice into local history.
  for (const segment of snapshot.segments) {
    await validateSegmentIntegrity(segment);
  }

  const frozen: SessionEventSegmentRecord[] = snapshot.segments
    .filter((segment) => !segment.isTail)
    .sort((a, b) => a.seq - b.seq);
  // Contiguity (design §7.4): frozen seqs must run afterSeq+1..frozenSeq
  // with no gaps, and the reassembled stream must match the summary count.
  let expectedSeq = afterSeq;
  for (const segment of frozen) {
    if (segment.seq !== expectedSeq + 1) return null;
    expectedSeq = segment.seq;
  }
  if ((snapshot.frozenSeq ?? 0) !== expectedSeq) return null;

  const tailSegment =
    snapshot.segments.find((segment) => segment.isTail) ?? null;
  const tailEvents = tailSegment?.events ?? [];
  const events = [
    ...baseFrozenEvents,
    ...frozen.flatMap((segment) => segment.events),
    ...tailEvents,
  ];
  if (events.length !== snapshot.count) return null;
  return {
    events,
    epoch: snapshot.epoch,
    frozenSeq: snapshot.frozenSeq ?? 0,
    frozenCount: events.length - tailEvents.length,
    tailHash: tailSegment?.segmentHash ?? snapshot.tailHash,
  };
}
