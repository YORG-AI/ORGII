export const FORK_SNAPSHOT_ERROR_KIND = {
  SNAPSHOT_INCOMPLETE: "snapshot_incomplete",
} as const;

export type ForkSnapshotErrorKind =
  (typeof FORK_SNAPSHOT_ERROR_KIND)[keyof typeof FORK_SNAPSHOT_ERROR_KIND];

/**
 * A fork must never silently continue when the source claims a replayable
 * history but the seq-0 snapshot is internally inconsistent.
 */
export class ForkSnapshotIntegrityError extends Error {
  readonly kind: ForkSnapshotErrorKind;

  constructor(kind: ForkSnapshotErrorKind, message: string) {
    super(message);
    this.name = "ForkSnapshotIntegrityError";
    this.kind = kind;
  }
}

export type SegmentIntegrityMismatch = "event_count" | "content_hash";

/**
 * A decoded segment whose payload disagrees with its own wire descriptors
 * (`eventCount` / `segmentHash`). Structural checks (contiguity, totals)
 * cannot catch this — it is the content-level tamper/corruption signal.
 */
export class SegmentIntegrityError extends Error {
  readonly kind = "segment_integrity" as const;
  readonly seq: number;
  readonly isTail: boolean;
  readonly mismatch: SegmentIntegrityMismatch;

  constructor(
    seq: number,
    isTail: boolean,
    mismatch: SegmentIntegrityMismatch
  ) {
    super(
      `Segment ${isTail ? "tail" : `seq ${seq}`} failed ${mismatch} verification`
    );
    this.name = "SegmentIntegrityError";
    this.seq = seq;
    this.isTail = isTail;
    this.mismatch = mismatch;
  }
}

export type ForkOperationErrorKind =
  | ForkSnapshotErrorKind
  | "segment_integrity"
  | "replay_unavailable"
  | "agent_unavailable"
  | "backend_registration";

export class ForkOperationError extends Error {
  readonly kind: ForkOperationErrorKind;
  readonly sourceSessionId: string;
  readonly cause?: unknown;

  constructor(
    kind: ForkOperationErrorKind,
    sourceSessionId: string,
    message: string,
    cause?: unknown
  ) {
    super(message);
    this.name = "ForkOperationError";
    this.kind = kind;
    this.sourceSessionId = sourceSessionId;
    this.cause = cause;
  }
}

export function classifyForkOperationError(
  error: unknown
): ForkOperationErrorKind | null {
  if (error instanceof ForkSnapshotIntegrityError) return error.kind;
  if (error instanceof SegmentIntegrityError) return error.kind;
  if (error instanceof ForkOperationError) return error.kind;
  return null;
}
