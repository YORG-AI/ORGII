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
} from "../sync/CollabSyncBackend";
import { computeSegmentHash } from "../sync/collabGzip";

/**
 * The segments-fetch capability shared by `importRemoteSession` (read-only
 * replay copy) and `forkSession` (writable relay copy). Both fetch the SAME
 * remote history through `fetchAndAssembleSegments`; they differ only in what
 * kind of local session the assembled events land in.
 */
export interface RemoteSessionFetchOptions {
  client: Pick<
    CollabSyncBackendClient,
    "getSessionEventSegments" | "streamSessionEventSegments"
  >;
  orgId: string;
  remoteSession: RemoteTeammateSessionMetadata;
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

export async function fetchAndAssembleSegments(
  options: RemoteSessionFetchOptions,
  afterSeq: number,
  baseFrozenEvents: SessionEvent[],
  expectedEpoch: number | null
): Promise<AssembledSegments | null> {
  const { client, orgId, remoteSession, shareToken, signal } = options;
  const snapshot = await client.getSessionEventSegments({
    orgId,
    sessionRowId: remoteSession.id,
    afterSeq,
    shareToken,
    signal,
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
