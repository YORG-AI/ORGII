/**
 * Consolidated remote-session import (design §7.4, dedups the old M5 copies).
 *
 * `importRemoteSession` is THE consolidated teammate-session import (design
 * §7.4 + M5 dedup) — backend-agnostic, its only backend dependency being
 * `client.getSessionEventSegments` (satisfied on the managed cloud by
 * `org2CloudBackendAdapter`) via `fetchAndAssembleSegments`.
 *
 * The two halves it orchestrates live in siblings:
 * - `collabImportStreaming`    bounded page download straight into SQLite
 * - `collabImportPresentation` source-derived timestamps + display refresh
 */
import { indexOrgtrackCollaborationSession } from "@src/api/tauri/lineage";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { buildCloudOrgSelectorValue } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { createLogger } from "@src/hooks/logger";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import { recordGuestImportedSession } from "@src/store/session/sessionAtom/guestImportRegistry";
import {
  applyImportedSessionTimestamps,
  upsertSession,
} from "@src/store/session/sessionAtom/mutations";
import { persistSessions } from "@src/store/session/sessionAtom/persistence";
import type {
  Session,
  SessionImportedFrom,
} from "@src/store/session/sessionAtom/types";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { namespaceCopyEventId } from "../copyEventId";
import {
  clearImportCursor,
  readImportCursor,
  recordImportCursor,
} from "./collabImportCursorRegistry";
import {
  deriveImportedSessionId,
  findImportedSession,
  normalizeSourceEndpointUrl,
  rewriteEventsForImportedSnapshot,
} from "./collabImportIdentity";
import {
  readSourceActivityAt,
  refreshImportedSessionPresentation,
  resolveImportedCreatedAt,
  resolveImportedSourceDisplay,
  resolveImportedSourcePresentation,
} from "./collabImportPresentation";
import type {
  ImportRemoteSessionOptions,
  PersistedStreamSummary,
} from "./collabImportStreaming";
import {
  streamFreshRemoteSessionToCache,
  streamIncrementalRemoteSessionToCache,
} from "./collabImportStreaming";
import type { AssembledSegments } from "./collabRemoteFetch";
import { fetchAndAssembleSegments, throwIfAborted } from "./collabRemoteFetch";

const log = createLogger("collabSyncEngineHelpers");

export type { ImportRemoteSessionOptions };

export interface ImportRemoteSessionResult {
  localSessionId: string;
  /**
   * false ⇒ replay events were unchanged. Display-only source metadata may
   * still have been refreshed on the existing local row.
   */
  updated: boolean;
  /**
   * A fresh streamed import deliberately skips the derived provenance index:
   * building it currently reloads the complete history. A later no-op refresh
   * may index after the replay is already durable and usable.
   */
  deferIndex?: boolean;
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
  if (result && options.workspaceRepoPath && !result.deferIndex) {
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

type ImportReplayCursor = Pick<
  SessionImportedFrom,
  "epoch" | "seq" | "count" | "frozenCount" | "tailHash"
>;

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
  let cursor: ImportReplayCursor | null = existing?.importedFrom ?? null;
  let localSessionId = existing?.session_id;

  if (
    remoteSession.eventsEpoch === undefined ||
    remoteSession.eventsCount === undefined
  ) {
    // No segments published (or publishing stopped): keep any local copy.
    if (!existing) return null;
    refreshImportedSessionPresentation(existing, remoteSession);
    return { localSessionId: existing.session_id, updated: false };
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
    // with a cheap COUNT (a full getPersistedEvents read on a large replay
    // made every cached open slow); fall through to a refetch when hollow.
    const persistedCount = await eventStoreProxy.countPersistedEvents(
      existing.session_id
    );
    if (persistedCount > 0 || remoteSession.eventsCount === 0) {
      refreshImportedSessionPresentation(existing, remoteSession);
      // Write-through: heals installs whose registry predates this row, so
      // the cursor survives the atom row's eventual eviction.
      recordImportCursor(existing.session_id, {
        orgId,
        sourceSessionId: remoteSession.sourceSessionId,
        sourceEndpointUrl,
        epoch: cursor.epoch,
        seq: cursor.seq,
        count: cursor.count,
        frozenCount: cursor.frozenCount,
        tailHash: cursor.tailHash,
      });
      return { localSessionId: existing.session_id, updated: false };
    }
  }

  let assembled: AssembledSegments | null = null;
  let streamed: PersistedStreamSummary | null = null;
  if (options.client.streamSessionEventSegments) {
    // Streamed imports persist bounded pages straight to SQLite — the full
    // replay never materializes in WebView memory. An existing import first
    // tries an incremental append past its cursor; any mismatch falls back
    // to a full restream. The assembled path's atomic restore-on-failure is
    // deliberately traded away here: a failed restream clears the local
    // copy, and the next open simply re-downloads it.
    localSessionId ??= await deriveImportedSessionId(
      orgId,
      remoteSession.sourceSessionId,
      sourceEndpointUrl
    );
    onBeforeWrite?.(localSessionId);
    // The atom row is a UI cache bounded to the most recently active
    // sessions; when it (or its cursor) is gone, the durable registry is
    // the cursor of record — without it a fully-synced local replay would
    // be mistaken for a first import and cleared + fully restreamed.
    if (!cursor || cursor.frozenCount === undefined) {
      cursor =
        readImportCursor(localSessionId, {
          orgId,
          sourceSessionId: remoteSession.sourceSessionId,
          sourceEndpointUrl,
        }) ?? cursor;
    }
    if (options.resumeCursor) {
      // Paused-download continuation: the incremental streamer already
      // guards everything a stale cursor could break (count probe, in-epoch
      // check, finalize reconcile) and falls back to null on any mismatch.
      streamed = await streamIncrementalRemoteSessionToCache(
        options,
        localSessionId,
        options.resumeCursor
      );
    }
    if (
      !streamed &&
      cursor &&
      cursor.epoch >= 1 &&
      cursor.epoch === remoteSession.eventsEpoch &&
      cursor.frozenCount !== undefined &&
      (remoteSession.eventsFrozenSeq ?? 0) >= cursor.seq
    ) {
      streamed = await streamIncrementalRemoteSessionToCache(
        options,
        localSessionId,
        {
          epoch: cursor.epoch,
          seq: cursor.seq,
          count: cursor.count,
          frozenCount: cursor.frozenCount,
        }
      );
    }
    if (!streamed) {
      // Every full restream costs a whole-session DELETE+INSERT (twice,
      // through the FTS triggers) plus the full download — it must always
      // say why, or churn like the cursor-loss regression stays invisible.
      log.info("full restream", {
        localSessionId,
        reason: !cursor
          ? "no cursor"
          : cursor.frozenCount === undefined
            ? "legacy cursor without frozenCount"
            : cursor.epoch !== remoteSession.eventsEpoch
              ? `epoch ${cursor.epoch} -> ${remoteSession.eventsEpoch}`
              : (remoteSession.eventsFrozenSeq ?? 0) < cursor.seq
                ? "frozen line regressed"
                : "incremental declined",
      });
    }
    streamed ??= await streamFreshRemoteSessionToCache(options, localSessionId);
    if (!streamed) {
      // No segments published (or publishing stopped mid-race): keep any
      // local copy — the deferred clear above never ran.
      if (!existing) return null;
      // ...but only a copy that still matches its cursor. A failed
      // incremental may have left unfinalized rows past it; pinning those
      // would replay a corrupted tail until the owner republishes.
      const cursorCount = existing.importedFrom?.count;
      if (cursorCount !== undefined) {
        const persisted = await eventStoreProxy.countPersistedEvents(
          existing.session_id
        );
        if (persisted !== cursorCount) {
          log.warn(
            "unpublished refresh left an inconsistent local copy; clearing",
            { localSessionId: existing.session_id, persisted, cursorCount }
          );
          await eventStoreProxy.clearPersistedHistory(existing.session_id);
          await eventStoreProxy
            .clear(existing.session_id)
            .catch(() => undefined);
          clearImportCursor(existing.session_id);
          return null;
        }
      }
      refreshImportedSessionPresentation(existing, remoteSession);
      return { localSessionId: existing.session_id, updated: false };
    }
  } else {
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
      const persistedEvents = await eventStoreProxy.getPersistedEvents(
        existing.session_id
      );
      if (persistedEvents.length === cursor.count) {
        assembled = await fetchAndAssembleSegments(
          options,
          cursor.seq,
          persistedEvents.slice(0, cursor.frozenCount),
          cursor.epoch
        );
      }
    }
    if (!assembled) {
      // Existing imports normally fetch only a delta. Epoch changes still use
      // the compatibility assembler so their prior snapshot can be restored
      // atomically if the replacement fails.
      assembled = await fetchAndAssembleSegments(options, 0, [], null);
    }
    if (!assembled) {
      if (!existing) return null;
      refreshImportedSessionPresentation(existing, remoteSession);
      return { localSessionId: existing.session_id, updated: false };
    }
    // Keep the first fetch ahead of hashing the deterministic id. Besides
    // shaving startup latency, this preserves the import queue's immediate
    // single-flight handoff for existing backend implementations.
    localSessionId ??= await deriveImportedSessionId(
      orgId,
      remoteSession.sourceSessionId,
      sourceEndpointUrl
    );
    onBeforeWrite?.(localSessionId);
  }

  if (!localSessionId) {
    throw new Error("Failed to derive an imported session id");
  }
  const localEvents = assembled
    ? rewriteEventsForImportedSnapshot(assembled.events, localSessionId)
    : [];
  const replay = streamed ?? assembled;
  if (!replay) return null;
  // Only the assembled (non-streamed) path needs the full prior snapshot:
  // it is the restore point for its atomic replace, and the source of the
  // legacy bare-row purge below. Streamed paths must not pay this read.
  const priorPersisted =
    existing && !streamed
      ? await eventStoreProxy.getPersistedEvents(localSessionId)
      : [];
  let storageMutated = streamed !== null;
  try {
    throwIfAborted(options.signal);
    const now = new Date().toISOString();
    // Source-side activity time, NOT `now`: see readSourceActivityAt.
    // `importedAt` below stays `now` — that one really is about this device.
    const activityAt = readSourceActivityAt(remoteSession) ?? now;
    const createdAt = resolveImportedCreatedAt(
      existing?.created_at,
      activityAt
    );
    const importedFrom: SessionImportedFrom = {
      orgId,
      sourceSessionId: remoteSession.sourceSessionId,
      sourceEndpointUrl,
      ownerMemberId: remoteSession.ownerMemberId,
      ownerDisplayName: remoteSession.ownerDisplayName,
      ownerAvatarUrl: remoteSession.ownerAvatarUrl,
      externalHistorySource:
        remoteSession.origin?.kind === "external_history"
          ? remoteSession.origin.source
          : existing?.importedFrom?.externalHistorySource,
      sourceDisplay: resolveImportedSourceDisplay(remoteSession, existing),
      epoch: replay.epoch,
      seq: replay.frozenSeq,
      count: streamed?.count ?? localEvents.length,
      frozenCount: replay.frozenCount,
      tailHash: replay.tailHash ?? undefined,
      importedAt: now,
      shareToken: shareToken ?? existing?.importedFrom?.shareToken,
      shareEndpointUrl:
        shareEndpointUrl ?? existing?.importedFrom?.shareEndpointUrl,
    };
    const sourcePresentation = resolveImportedSourcePresentation(
      localSessionId,
      importedFrom
    );
    const importedRow: Session = {
      session_id: localSessionId,
      status: "completed",
      created_at: createdAt,
      updated_at: activityAt,
      completed_at: activityAt,
      name: remoteSession.title,
      repoPath: remoteSession.repoPath,
      branch: remoteSession.branch,
      baseBranch: remoteSession.baseBranch,
      worktreeBranch: remoteSession.worktreeBranch,
      category: "external_history",
      // No runnable model: the imported copy's composer is a FORK ENTRY, not a
      // live agent. The source model is retained under importedFrom.sourceDisplay
      // for read-only presentation, while leaving this field unset makes the
      // composer ask which of the viewer's OWN local models/keys the fork should
      // actually use.
      model: undefined,
      // Opening a cloud row replaces it with this local replay in Kanban,
      // sidebar, search, and workstation consumers. Keep the same source-agent
      // presentation on the replacement row so that transition never renames
      // the agent to an import-mechanism placeholder.
      agentIconId: sourcePresentation.agentIconId,
      agentDisplayName: sourcePresentation.agentLabel,
      pinned: existing?.pinned ?? false,
      // Ownership stamp (`Session.orgId`, distinct from `importedFrom.orgId`
      // provenance — see sessionAtom/types.ts): filing the import under the
      // org makes it match the sidebar org selector. Only MEMBER imports are
      // stamped — the engine PullLoop and the panel replay both run in member
      // context (org sync profile, no token). A share-token import is the
      // GUEST path (CollabShareImportDialog, no local membership): it stays
      // under Personal, i.e. no orgId (preserving any prior member stamp).
      // Selector value (`cloud:<uuid>`), never a bare org uuid: a bare value
      // fails `parseCloudOrgSelectorValue`, hiding the session from every
      // consumer that resolves ownership through it (share dialog, org
      // selector, the engine's own ownedByOrg gate).
      orgId: shareToken ? existing?.orgId : buildCloudOrgSelectorValue(orgId),
      importedFrom,
      // Retire the legacy error_message idiom for collab imports; clears any
      // leftover value on upgraded pre-M3 rows.
      error_message: undefined,
    };
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
    if (!streamed) {
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
    }
    throwIfAborted(options.signal);
    // No await after the final abort check: the session row, guest registry
    // and persisted list commit synchronously as one local critical section.
    upsertSession(importedRow);
    // Re-import of an existing copy: upsertSession pins timestamps against
    // careless reconcile writes, but this row's clock belongs to the source.
    applyImportedSessionTimestamps(localSessionId, {
      created_at: createdAt,
      updated_at: activityAt,
      completed_at: activityAt,
    });
    recordGuestImportedSession(importedRow);
    recordImportCursor(localSessionId, {
      orgId,
      sourceSessionId: remoteSession.sourceSessionId,
      sourceEndpointUrl,
      epoch: importedFrom.epoch,
      seq: importedFrom.seq,
      count: importedFrom.count,
      frozenCount: importedFrom.frozenCount,
      tailHash: importedFrom.tailHash,
    });
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
        clearImportCursor(localSessionId);
      }
    }
    throw error;
  }
  return {
    localSessionId,
    updated: true,
    ...(streamed ? { deferIndex: true } : {}),
  };
}
