/**
 * Byte-bounded Cloud snapshot import orchestration.
 *
 * Cloud returns opaque gzip wire rows a page at a time. The renderer forwards
 * each page once to Rust; it never decodes, rewrites, or assembles a
 * session-sized `SessionEvent[]`.
 */
import {
  type CollaborationSnapshotCursor,
  type CollaborationSnapshotIngestCommitResult,
  collaborationSnapshotIngestAbort,
  collaborationSnapshotIngestApplyWirePage,
  collaborationSnapshotIngestBegin,
  collaborationSnapshotIngestCommit,
  collaborationSnapshotIngestGetCursor,
} from "@src/api/tauri/collaborationSnapshotIngest";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import type {
  CollabSyncBackendClient,
  SessionEventWirePage,
  SessionEventWirePageCursor,
} from "../sync/CollabSyncBackend";
import {
  SESSION_EVENT_WIRE_MAX_PAGE_BYTES,
  SESSION_EVENT_WIRE_MAX_PAGE_SEGMENTS,
} from "../sync/CollabSyncBackend";

export interface RemoteSnapshotIngestOptions {
  client: Pick<CollabSyncBackendClient, "getSessionEventWirePage">;
  orgId: string;
  remoteSession: RemoteTeammateSessionMetadata;
  localSessionId: string;
  previous?: CollaborationSnapshotCursor;
  shareToken?: string;
  signal?: AbortSignal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function pageHasSnapshot(
  page: SessionEventWirePage
): page is SessionEventWirePage & {
  epoch: number;
  frozenSeq: number;
  count: number;
} {
  return page.epoch !== null && page.frozenSeq !== null && page.count !== null;
}

function pageMatchesPrevious(
  page: SessionEventWirePage & {
    epoch: number;
    frozenSeq: number;
    count: number;
  },
  previous: CollaborationSnapshotCursor
): boolean {
  return (
    page.epoch === previous.epoch &&
    page.frozenSeq >= previous.frozenSeq &&
    page.count >= previous.frozenCount
  );
}

function cursorMatchesRemoteSummary(
  cursor: CollaborationSnapshotCursor,
  remoteSession: RemoteTeammateSessionMetadata
): boolean {
  return (
    remoteSession.eventsEpoch === cursor.epoch &&
    (remoteSession.eventsFrozenSeq ?? 0) === cursor.frozenSeq &&
    remoteSession.eventsCount === cursor.count &&
    (remoteSession.eventsTailHash ?? null) === cursor.tailHash
  );
}

function unchangedCommit(
  localSessionId: string,
  cursor: CollaborationSnapshotCursor
): CollaborationSnapshotIngestCommitResult {
  return {
    localSessionId,
    epoch: cursor.epoch,
    frozenSeq: cursor.frozenSeq,
    eventCount: cursor.count,
    frozenEventCount: cursor.frozenCount,
    tailHash: cursor.tailHash,
    handoffItems: [],
    handoffScannedBytes: 0,
    handoffScannedEvents: 0,
  };
}

async function fetchWirePage(
  options: RemoteSnapshotIngestOptions,
  cursor: SessionEventWirePageCursor,
  includeTail: boolean
): Promise<SessionEventWirePage> {
  throwIfAborted(options.signal);
  return options.client.getSessionEventWirePage({
    orgId: options.orgId,
    sessionRowId: options.remoteSession.id,
    cursor,
    includeTail,
    maxSegments: SESSION_EVENT_WIRE_MAX_PAGE_SEGMENTS,
    maxWireBytes: SESSION_EVENT_WIRE_MAX_PAGE_BYTES,
    ...(options.shareToken !== undefined
      ? { shareToken: options.shareToken }
      : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
}

async function ingestPageChain(
  options: RemoteSnapshotIngestOptions,
  firstPage: SessionEventWirePage & {
    epoch: number;
    frozenSeq: number;
    count: number;
  },
  firstCursor: SessionEventWirePageCursor,
  replace: boolean,
  previous?: CollaborationSnapshotCursor
): Promise<CollaborationSnapshotIngestCommitResult> {
  const { token } = await collaborationSnapshotIngestBegin({
    localSessionId: options.localSessionId,
    epoch: firstPage.epoch,
    expectedCount: firstPage.count,
    expectedFrozenSeq: firstPage.frozenSeq,
    tailHash: firstPage.tailHash,
    replace,
    ...(previous !== undefined ? { previous } : {}),
  });
  let committed = false;
  try {
    let page = firstPage;
    let cursor = firstCursor;
    for (;;) {
      throwIfAborted(options.signal);
      await collaborationSnapshotIngestApplyWirePage({
        token,
        epoch: page.epoch,
        frozenSeq: page.frozenSeq,
        count: page.count,
        tailHash: page.tailHash,
        cursor,
        nextCursor: page.nextCursor,
        tailIncluded: page.tailIncluded,
        hasMore: page.hasMore,
        returnedWireBytes: page.returnedWireBytes,
        segments: page.segments,
      });
      if (!page.hasMore) break;
      const nextCursor = page.nextCursor;
      if (!nextCursor) {
        throw new Error("Cloud replay page hasMore without a continuation");
      }
      cursor = nextCursor;
      const fetchedPage = await fetchWirePage(options, cursor, false);
      if (
        !pageHasSnapshot(fetchedPage) ||
        fetchedPage.epoch !== firstPage.epoch ||
        fetchedPage.frozenSeq !== firstPage.frozenSeq ||
        fetchedPage.count !== firstPage.count ||
        fetchedPage.tailHash !== firstPage.tailHash
      ) {
        throw new Error("Cloud replay snapshot changed while paging");
      }
      page = fetchedPage;
    }
    throwIfAborted(options.signal);
    const result = await collaborationSnapshotIngestCommit(token);
    committed = true;
    return result;
  } finally {
    if (!committed) {
      await collaborationSnapshotIngestAbort(token).catch(() => undefined);
    }
  }
}

async function replaceSnapshot(
  options: RemoteSnapshotIngestOptions
): Promise<CollaborationSnapshotIngestCommitResult | null> {
  const cursor: SessionEventWirePageCursor = { direction: "backward" };
  const firstPage = await fetchWirePage(options, cursor, true);
  if (!pageHasSnapshot(firstPage)) return null;
  return ingestPageChain(options, firstPage, cursor, true);
}

/**
 * Import one authoritative snapshot with bounded memory.
 *
 * A compatible local generation first attempts a forward delta. Any epoch or
 * local-state mismatch retries as a byte-bounded backward rebuild; it never
 * falls back to the legacy decoded full-history API.
 */
export async function ingestRemoteSnapshot(
  options: RemoteSnapshotIngestOptions
): Promise<CollaborationSnapshotIngestCommitResult | null> {
  const cursorHint = options.previous;
  if (!cursorHint) return replaceSnapshot(options);

  // The renderer's importedFrom cursor is only a hint. Trust the lightweight
  // Rust health query, which also proves the mapped event rows still exist.
  // An unchanged healthy snapshot performs zero Cloud wire reads; a hollow
  // or corrupt local snapshot is rebuilt instead of splicing onto bad state.
  throwIfAborted(options.signal);
  const previous = await collaborationSnapshotIngestGetCursor(
    options.localSessionId
  );
  throwIfAborted(options.signal);
  if (!previous) return replaceSnapshot(options);
  if (cursorMatchesRemoteSummary(previous, options.remoteSession)) {
    return unchangedCommit(options.localSessionId, previous);
  }

  const cursor: SessionEventWirePageCursor = {
    direction: "forward",
    afterSeq: previous.frozenSeq,
    ...(options.remoteSession.eventsFrozenSeq !== undefined
      ? { throughSeq: options.remoteSession.eventsFrozenSeq }
      : {}),
  };
  const firstPage = await fetchWirePage(options, cursor, true);
  if (!pageHasSnapshot(firstPage)) return null;
  if (!pageMatchesPrevious(firstPage, previous)) {
    return replaceSnapshot(options);
  }

  try {
    return await ingestPageChain(options, firstPage, cursor, false, previous);
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) throw error;
    return replaceSnapshot(options);
  }
}
