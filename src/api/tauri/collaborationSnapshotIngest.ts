import { rpc, schemas } from "./rpc";

export type CollaborationSnapshotCursor =
  schemas.collaborationSnapshotIngest.CollaborationSnapshotCursor;
export type CollaborationSnapshotIngestBeginRequest =
  schemas.collaborationSnapshotIngest.CollaborationSnapshotIngestBeginRequest;
export type CollaborationSnapshotIngestGetCursorRequest =
  schemas.collaborationSnapshotIngest.CollaborationSnapshotIngestGetCursorRequest;
export type CollaborationSnapshotIngestPageRequest =
  schemas.collaborationSnapshotIngest.CollaborationSnapshotIngestPageRequest;
export type CollaborationSnapshotIngestProgress =
  schemas.collaborationSnapshotIngest.CollaborationSnapshotIngestProgress;
export type CollaborationSnapshotIngestCommitResult =
  schemas.collaborationSnapshotIngest.CollaborationSnapshotIngestCommitResult;

/** Start one single-use, crash-safe staged snapshot publication. */
export function collaborationSnapshotIngestBegin(
  request: CollaborationSnapshotIngestBeginRequest
): Promise<{ token: string }> {
  return rpc.collaborationSnapshotIngest.begin({ request });
}

/** Return the trusted local cursor only when the imported snapshot is intact. */
export function collaborationSnapshotIngestGetCursor(
  localSessionId: CollaborationSnapshotIngestGetCursorRequest["localSessionId"]
): Promise<CollaborationSnapshotCursor | null> {
  return rpc.collaborationSnapshotIngest.getCursor({
    request: { localSessionId },
  });
}

/** True only for a native fork with an intact collaboration snapshot index. */
export function collaborationSnapshotSecondaryProbe(
  sessionId: string
): Promise<boolean> {
  return rpc.collaborationSnapshotIngest.probeSecondary({
    request: { sessionId },
  });
}

/**
 * Persist one bounded page of opaque Cloud wires in Rust. The compressed
 * payloads cross IPC once; decoded SessionEvent arrays never return to JS.
 */
export function collaborationSnapshotIngestApplyWirePage(
  request: CollaborationSnapshotIngestPageRequest
): Promise<CollaborationSnapshotIngestProgress> {
  return rpc.collaborationSnapshotIngest.applyWirePage({ request });
}

/** Atomically publish the verified staged snapshot into sessions.db. */
export function collaborationSnapshotIngestCommit(
  token: string
): Promise<CollaborationSnapshotIngestCommitResult> {
  return rpc.collaborationSnapshotIngest.commit({ request: { token } });
}

/** Discard a staged snapshot without changing the currently visible copy. */
export function collaborationSnapshotIngestAbort(token: string): Promise<void> {
  return rpc.collaborationSnapshotIngest.abort({ request: { token } });
}
