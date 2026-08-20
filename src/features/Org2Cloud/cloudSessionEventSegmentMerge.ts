import type { SessionEvent } from "@src/engines/SessionCore";
import type {
  SessionEventSegmentRecord,
  SessionEventSegmentsSnapshot,
} from "@src/features/TeamCollaboration/sync/CollabSyncBackend";

export interface CloudSessionEventSnapshot extends Omit<
  SessionEventSegmentsSnapshot,
  "segments"
> {
  segments: SessionEventSegmentRecord[];
  events: SessionEvent[];
}

/** Stable content fingerprint for no-op poll detection. */
export function cloudSessionSnapshotRevision(
  snapshot: Pick<
    CloudSessionEventSnapshot,
    "epoch" | "frozenSeq" | "tailHash" | "count"
  >
): string {
  return `${snapshot.epoch}|${snapshot.frozenSeq}|${snapshot.tailHash}|${snapshot.count}`;
}

function preserveSnapshotWhenUnchanged(
  previous: CloudSessionEventSnapshot | null,
  merged: CloudSessionEventSnapshot
): CloudSessionEventSnapshot {
  if (
    previous &&
    cloudSessionSnapshotRevision(previous) ===
      cloudSessionSnapshotRevision(merged)
  ) {
    return previous;
  }
  return merged;
}

function orderedSegments(
  segments: Iterable<SessionEventSegmentRecord>
): SessionEventSegmentRecord[] {
  return [...segments].sort((left, right) => {
    if (left.isTail !== right.isTail) return left.isTail ? 1 : -1;
    return left.seq - right.seq;
  });
}

function withFlattenedEvents(
  snapshot: SessionEventSegmentsSnapshot
): CloudSessionEventSnapshot {
  const segments = orderedSegments(snapshot.segments);
  return {
    ...snapshot,
    segments,
    events: segments.flatMap((segment) => segment.events),
  };
}

/**
 * Merge an incremental frozen-prefix + mutable-tail response.
 * The previous tail is always discarded: it may have rolled into a newly
 * frozen segment, and retaining it would duplicate transcript events.
 */
export function mergeCloudSessionEventSnapshot(
  previous: CloudSessionEventSnapshot | null,
  incoming: SessionEventSegmentsSnapshot,
  fullRead: boolean
): CloudSessionEventSnapshot {
  if (fullRead || !previous || previous.epoch !== incoming.epoch) {
    return preserveSnapshotWhenUnchanged(
      previous,
      withFlattenedEvents(incoming)
    );
  }

  const frozen = new Map<number, SessionEventSegmentRecord>();
  for (const segment of previous.segments) {
    if (!segment.isTail) frozen.set(segment.seq, segment);
  }
  let tail: SessionEventSegmentRecord | null = null;
  for (const segment of incoming.segments) {
    if (segment.isTail) tail = segment;
    else frozen.set(segment.seq, segment);
  }

  return preserveSnapshotWhenUnchanged(
    previous,
    withFlattenedEvents({
      epoch: incoming.epoch,
      frozenSeq: incoming.frozenSeq,
      tailHash: incoming.tailHash,
      count: incoming.count,
      segments: [...frozen.values(), ...(tail ? [tail] : [])],
    })
  );
}
