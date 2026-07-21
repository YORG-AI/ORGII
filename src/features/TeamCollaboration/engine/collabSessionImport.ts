/**
 * Consolidated remote-session import (design §7.4, dedups the old M5 copies).
 *
 * `importRemoteSession` is THE consolidated teammate-session import (design
 * §7.4 + M5 dedup) — backend-agnostic, its only backend dependency being
 * `client.getSessionEventSegments` (satisfied on the managed cloud by
 * `org2CloudBackendAdapter`) via `fetchAndAssembleSegments`.
 */
import { indexOrgtrackCollaborationSession } from "@src/api/tauri/lineage";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { createLogger } from "@src/hooks/logger";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import { recordGuestImportedSession } from "@src/store/session/sessionAtom/guestImportRegistry";
import { upsertSession } from "@src/store/session/sessionAtom/mutations";
import { persistSessions } from "@src/store/session/sessionAtom/persistence";
import type {
  Session,
  SessionImportedFrom,
} from "@src/store/session/sessionAtom/types";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { namespaceCopyEventId } from "../copyEventId";
import {
  deriveImportedSessionId,
  findImportedSession,
  normalizeSourceEndpointUrl,
  rewriteEventsForImportedSnapshot,
} from "./collabImportIdentity";
import type {
  AssembledSegments,
  RemoteSessionFetchOptions,
} from "./collabRemoteFetch";
import { fetchAndAssembleSegments, throwIfAborted } from "./collabRemoteFetch";

const log = createLogger("collabSyncEngineHelpers");

export interface ImportRemoteSessionOptions extends RemoteSessionFetchOptions {
  /**
   * Invoked with the local session id BEFORE any event-store write, so the
   * engine can arm its self-import guard (the eventStore write re-enters the
   * push subscription).
   */
  onBeforeWrite?: (localSessionId: string) => void;
  /**
   * Viewer-local checkout of the shared repo. When present, the authorized
   * replay is indexed into Session Blame with owner paths remapped to this
   * workspace. The owner's absolute `remoteSession.repoPath` is never used as
   * a local navigation path.
   */
  workspaceRepoPath?: string;
}

export interface ImportRemoteSessionResult {
  localSessionId: string;
  /** false ⇒ the local cursor already matched the remote summary. */
  updated: boolean;
}

/**
 * Per-source serialization. Each caller keeps its own AbortSignal and result;
 * concurrent attempts cannot interleave durable writes or cancel one another.
 */
const remoteSessionImportTails = new Map<string, Promise<void>>();

/**
 * THE import path for teammate sessions — used by both the engine PullLoop
 * (auto-import) and the panel's direct-replay action. Handles:
 * - cursor comparison against the remote summary (no-op when unchanged),
 * - incremental application (new frozen segments appended to the local
 *   frozen prefix, tail region replaced) with local-count + contiguity
 *   validation, falling back to a full refetch on any mismatch,
 * - persistence (`saveToCache`, fix P7) and the `importedFrom` cursor.
 *
 * Concurrent calls for the same source serialize without sharing a caller's
 * cancellation. Returns null when the owner has published no segments and nothing
 * was previously imported (callers may fall back to the snapshot-request
 * flow); THROWS when the durable cache write fails so callers treat the
 * import as retryable rather than silently absent.
 */
export async function importRemoteSession(
  options: ImportRemoteSessionOptions
): Promise<ImportRemoteSessionResult | null> {
  const endpoint = normalizeSourceEndpointUrl(
    options.sourceEndpointUrl ??
      options.shareEndpointUrl ??
      "unknown-cloud-endpoint"
  );
  const key = `${endpoint}:${options.orgId}:${options.remoteSession.sourceSessionId}`;
  const previous = remoteSessionImportTails.get(key) ?? Promise.resolve();
  const task = previous
    .catch(() => undefined)
    .then(() =>
      importRemoteSessionInner({ ...options, sourceEndpointUrl: endpoint })
    );
  const tail = task.then(
    () => undefined,
    () => undefined
  );
  remoteSessionImportTails.set(key, tail);
  let result: ImportRemoteSessionResult | null;
  try {
    result = await task;
  } finally {
    if (remoteSessionImportTails.get(key) === tail) {
      remoteSessionImportTails.delete(key);
    }
  }
  if (result && options.workspaceRepoPath) {
    try {
      await indexOrgtrackCollaborationSession({
        localSessionId: result.localSessionId,
        sourceSessionId: options.remoteSession.sourceSessionId,
        title: options.remoteSession.title,
        workspacePath: options.workspaceRepoPath,
        sourceWorkspacePath: options.remoteSession.repoPath,
        orgId: options.orgId,
        sessionRowId: options.remoteSession.id,
        ownerMemberId: options.remoteSession.ownerMemberId,
        ownerDisplayName: options.remoteSession.ownerDisplayName,
      });
    } catch (error) {
      // Replay remains usable; every later open retries this derived index.
      log.warn("failed to index collaboration replay for Session Blame", {
        localSessionId: result.localSessionId,
        error,
      });
    }
  }
  return result;
}

async function importRemoteSessionInner(
  options: ImportRemoteSessionOptions
): Promise<ImportRemoteSessionResult | null> {
  const {
    orgId,
    remoteSession,
    onBeforeWrite,
    shareToken,
    shareEndpointUrl,
    sourceEndpointUrl = "unknown-cloud-endpoint",
  } = options;
  const store = getInstrumentedStore();
  const sessions = store.get(sessionsAtom) as Session[];
  const existing = findImportedSession(
    sessions,
    orgId,
    remoteSession.sourceSessionId,
    sourceEndpointUrl
  );
  // Legacy (error_message) imports have no usable cursor → full refetch.
  const cursor = existing?.importedFrom ?? null;

  if (
    remoteSession.eventsEpoch === undefined ||
    remoteSession.eventsCount === undefined
  ) {
    // No segments published (or publishing stopped): keep any local copy.
    return existing
      ? { localSessionId: existing.session_id, updated: false }
      : null;
  }

  if (
    existing &&
    cursor &&
    cursor.epoch === remoteSession.eventsEpoch &&
    cursor.seq === (remoteSession.eventsFrozenSeq ?? 0) &&
    cursor.count === remoteSession.eventsCount &&
    (cursor.tailHash ?? null) === (remoteSession.eventsTailHash ?? null)
  ) {
    // Cursor no-op — but only if the local store still HAS the events. A
    // cache row can outlive its event data (restart/cleanup churn), and
    // trusting the cursor then pins an unrecoverable empty replay: every
    // click returns here and Reload re-reads the same empty store. Verify
    // before short-circuiting; fall through to a full refetch when hollow.
    const persisted = await eventStoreProxy.getPersistedEvents(
      existing.session_id
    );
    if (persisted.length > 0 || remoteSession.eventsCount === 0) {
      return { localSessionId: existing.session_id, updated: false };
    }
  }

  let assembled: AssembledSegments | null = null;
  if (
    existing &&
    cursor &&
    cursor.epoch >= 1 &&
    cursor.epoch === remoteSession.eventsEpoch &&
    cursor.frozenCount !== undefined &&
    (remoteSession.eventsFrozenSeq ?? 0) >= cursor.seq
  ) {
    // Incremental: verify the local store still holds exactly what the
    // cursor claims before splicing onto it (design §7.4 last line).
    const localEvents = await eventStoreProxy.getPersistedEvents(
      existing.session_id
    );
    if (localEvents.length === cursor.count) {
      assembled = await fetchAndAssembleSegments(
        options,
        cursor.seq,
        localEvents.slice(0, cursor.frozenCount),
        cursor.epoch
      );
    }
  }
  if (!assembled) {
    // Full refetch: epoch change, missing/legacy cursor, or any validation
    // failure above.
    assembled = await fetchAndAssembleSegments(options, 0, [], null);
  }
  if (!assembled) {
    return existing
      ? { localSessionId: existing.session_id, updated: false }
      : null;
  }

  // Deterministic id (not random): a retry after a failed durable write must
  // reuse the same local id instead of leaking a new orphan per attempt.
  const localSessionId =
    existing?.session_id ??
    (await deriveImportedSessionId(
      orgId,
      remoteSession.sourceSessionId,
      sourceEndpointUrl
    ));
  onBeforeWrite?.(localSessionId);
  const localEvents = rewriteEventsForImportedSnapshot(
    assembled.events,
    localSessionId
  );
  throwIfAborted(options.signal);
  const now = new Date().toISOString();
  const importedFrom: SessionImportedFrom = {
    orgId,
    sourceSessionId: remoteSession.sourceSessionId,
    sourceEndpointUrl,
    ownerMemberId: remoteSession.ownerMemberId,
    ownerDisplayName: remoteSession.ownerDisplayName,
    externalHistorySource:
      remoteSession.origin?.kind === "external_history"
        ? remoteSession.origin.source
        : existing?.importedFrom?.externalHistorySource,
    epoch: assembled.epoch,
    seq: assembled.frozenSeq,
    count: localEvents.length,
    frozenCount: assembled.frozenCount,
    tailHash: assembled.tailHash ?? undefined,
    importedAt: now,
    shareToken: shareToken ?? existing?.importedFrom?.shareToken,
    shareEndpointUrl:
      shareEndpointUrl ?? existing?.importedFrom?.shareEndpointUrl,
  };
  const priorPersisted = existing
    ? await eventStoreProxy.getPersistedEvents(localSessionId)
    : [];
  const importedRow: Session = {
    session_id: localSessionId,
    status: "completed",
    created_at: existing?.created_at ?? now,
    updated_at: now,
    completed_at: now,
    name: remoteSession.title,
    repoPath: remoteSession.repoPath,
    category: "external_history",
    // No stored model: the imported copy's composer is a FORK ENTRY, not a
    // live agent — leaving model unset makes the composer show the normal
    // "Select model" picker over the viewer's OWN local models/keys (the
    // model the fork will actually run with), instead of a dead
    // "Collaboration Snapshot" label the viewer can't run.
    model: undefined,
    agentIconId: "archive",
    agentDisplayName: "Collaboration Snapshot",
    pinned: existing?.pinned ?? false,
    // Ownership stamp (`Session.orgId`, distinct from `importedFrom.orgId`
    // provenance — see sessionAtom/types.ts): filing the import under the
    // org makes it match the sidebar org selector. Only MEMBER imports are
    // stamped — the engine PullLoop and the panel replay both run in member
    // context (org sync profile, no token). A share-token import is the
    // GUEST path (CollabShareImportDialog, no local membership): it stays
    // under Personal, i.e. no orgId (preserving any prior member stamp).
    orgId: shareToken ? existing?.orgId : orgId,
    importedFrom,
    // Retire the legacy error_message idiom for collab imports; clears any
    // leftover value on upgraded pre-M3 rows.
    error_message: undefined,
  };
  let storageMutated = false;
  try {
    // A pre-namespacing import left bare rows in SQLite. Purge before the
    // replacement, but keep the prior snapshot above so cancellation/error
    // can restore the exact pre-import state.
    const hasBareRows = priorPersisted.some(
      (event) => event.id !== namespaceCopyEventId(localSessionId, event.id)
    );
    if (hasBareRows) {
      storageMutated = true;
      await eventStoreProxy.clearPersistedHistory(localSessionId);
    }
    // Durable events first, cursor/session row last. Closing the import modal
    // after this write but before commit triggers the rollback below.
    storageMutated = true;
    await eventStoreProxy.set(localEvents, localSessionId);
    const savedCount = await eventStoreProxy.saveToCache(localSessionId);
    if (localEvents.length > 0 && savedCount <= 0) {
      throw new Error(
        `Failed to durably persist imported session ${remoteSession.sourceSessionId} (saveToCache returned ${savedCount})`
      );
    }
    throwIfAborted(options.signal);
    // No await after the final abort check: the session row, guest registry
    // and persisted list commit synchronously as one local critical section.
    upsertSession(importedRow);
    recordGuestImportedSession(importedRow);
    persistSessions(store.get(sessionsAtom) as Session[]);
  } catch (error) {
    if (storageMutated) {
      await eventStoreProxy
        .clearPersistedHistory(localSessionId)
        .catch((rollbackError) =>
          log.error("failed to clear cancelled import history", rollbackError)
        );
      if (priorPersisted.length > 0) {
        await eventStoreProxy.set(priorPersisted, localSessionId);
        const restored = await eventStoreProxy.saveToCache(localSessionId);
        if (restored <= 0) {
          log.error("failed to restore prior import history", {
            localSessionId,
          });
        }
      } else {
        await eventStoreProxy.clear(localSessionId).catch(() => undefined);
      }
    }
    throw error;
  }
  return { localSessionId, updated: true };
}
