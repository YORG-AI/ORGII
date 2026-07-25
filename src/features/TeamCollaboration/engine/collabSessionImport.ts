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
import { buildCloudOrgSelectorValue } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
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
import { resolveSessionDisplayMetadata } from "@src/util/session/sessionDisplayMetadata";

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
import {
  fetchAndAssembleSegments,
  throwIfAborted,
  validateSegmentIntegrity,
} from "./collabRemoteFetch";

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

interface PersistedStreamSummary {
  epoch: number;
  frozenSeq: number;
  frozenCount: number;
  count: number;
  tailHash: string | null;
}

const STREAM_IMPORT_MAX_ATTEMPTS = 3;

function isReplayEpochConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    ("code" in error
      ? (error as Error & { code?: unknown }).code === "ORG2_CONFLICT"
      : error.message.includes("ORG2_CONFLICT"))
  );
}

/**
 * Fresh large imports never need the full replay in JS or Rust memory. Decode
 * one server page, validate it, namespace it, and upsert it directly into
 * SQLite. Only the initial turn window is hydrated after the final summary
 * reconciles. An epoch race clears the partial rows and restarts from page 1.
 */
async function streamFreshRemoteSessionToCache(
  options: ImportRemoteSessionOptions,
  localSessionId: string
): Promise<PersistedStreamSummary | null> {
  const stream = options.client.streamSessionEventSegments;
  if (!stream) return null;

  for (let attempt = 0; attempt < STREAM_IMPORT_MAX_ATTEMPTS; attempt += 1) {
    await eventStoreProxy.clearPersistedHistory(localSessionId);
    let epoch: number | null = null;
    let expectedFrozenSeq = 0;
    let persistedCount = 0;
    let frozenCount = 0;
    let tailHash: string | null = null;

    try {
      const summary = await stream(
        {
          orgId: options.orgId,
          sessionRowId: options.remoteSession.id,
          afterSeq: 0,
          ...(options.shareToken !== undefined
            ? { shareToken: options.shareToken }
            : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        },
        async (page) => {
          throwIfAborted(options.signal);
          if (page.epoch === null || page.count === null) return;
          if (epoch === null) {
            epoch = page.epoch;
          } else if (page.epoch !== epoch) {
            throw new Error(
              "ORG2_CONFLICT session events epoch changed during streamed import"
            );
          }

          const frozen = page.segments
            .filter((segment) => !segment.isTail)
            .sort((a, b) => a.seq - b.seq);
          const tails = page.segments.filter((segment) => segment.isTail);
          if (tails.length > 1) {
            throw new Error("Replay page contained more than one tail");
          }
          for (const segment of [...frozen, ...tails]) {
            await validateSegmentIntegrity(segment);
          }
          for (const segment of frozen) {
            if (segment.seq !== expectedFrozenSeq + 1) {
              throw new Error("Replay page contained a frozen-segment gap");
            }
            expectedFrozenSeq = segment.seq;
          }

          const tail = tails[0] ?? null;
          const sourceEvents = [
            ...frozen.flatMap((segment) => segment.events),
            ...(tail?.events ?? []),
          ];
          const localEvents = rewriteEventsForImportedSnapshot(
            sourceEvents,
            localSessionId
          );
          if (localEvents.length > 0) {
            const savedCount = await eventStoreProxy.persistEventsBatch(
              localEvents,
              localSessionId
            );
            if (savedCount <= 0) {
              throw new Error(
                `Failed to persist streamed import ${options.remoteSession.sourceSessionId}`
              );
            }
          }
          persistedCount += localEvents.length;
          frozenCount += frozen.reduce(
            (count, segment) => count + segment.events.length,
            0
          );
          if (tail) tailHash = tail.segmentHash;
        }
      );

      if (summary.epoch === null || summary.count === null) {
        await eventStoreProxy.clearPersistedHistory(localSessionId);
        return null;
      }
      if (
        epoch !== summary.epoch ||
        expectedFrozenSeq !== (summary.frozenSeq ?? 0) ||
        persistedCount !== summary.count
      ) {
        throw new Error("Streamed replay summary did not reconcile");
      }
      throwIfAborted(options.signal);
      const finalizedCount =
        await eventStoreProxy.finalizePersistedImport(localSessionId);
      if (finalizedCount !== summary.count) {
        throw new Error(
          `Streamed replay finalize count ${finalizedCount} did not match ${summary.count}`
        );
      }
      throwIfAborted(options.signal);
      const loaded = await eventStoreProxy.loadInitialTurnWindow(
        localSessionId,
        0
      );
      if (summary.count > 0 && loaded <= 0) {
        throw new Error("Failed to hydrate streamed replay turn window");
      }
      return {
        epoch: summary.epoch,
        frozenSeq: summary.frozenSeq ?? 0,
        frozenCount,
        count: persistedCount,
        tailHash: tailHash ?? summary.tailHash,
      };
    } catch (error) {
      await eventStoreProxy.clearPersistedHistory(localSessionId);
      await eventStoreProxy.clear(localSessionId).catch(() => undefined);
      if (
        isReplayEpochConflict(error) &&
        attempt + 1 < STREAM_IMPORT_MAX_ATTEMPTS
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Streamed replay import exhausted its retry budget");
}

function resolveImportedSourceDisplay(
  remoteSession: ImportRemoteSessionOptions["remoteSession"],
  existing: Session | undefined
): NonNullable<SessionImportedFrom["sourceDisplay"]> {
  return {
    cliAgentType:
      remoteSession.cliAgentType ??
      existing?.importedFrom?.sourceDisplay?.cliAgentType,
    agentDisplayName:
      remoteSession.agentDisplayName ??
      existing?.importedFrom?.sourceDisplay?.agentDisplayName,
    agentDefinitionId:
      remoteSession.agentDefinitionId ??
      existing?.importedFrom?.sourceDisplay?.agentDefinitionId,
    model: remoteSession.model ?? existing?.importedFrom?.sourceDisplay?.model,
  };
}

function resolveImportedSourcePresentation(
  localSessionId: string,
  importedFrom: SessionImportedFrom
) {
  return resolveSessionDisplayMetadata({
    kind: "local",
    session: {
      session_id: localSessionId,
      importedFrom,
    },
  });
}

function refreshImportedSessionPresentation(
  existing: Session,
  remoteSession: ImportRemoteSessionOptions["remoteSession"]
): void {
  const importedFrom = existing.importedFrom;
  if (!importedFrom) return;

  const externalHistorySource =
    remoteSession.origin?.kind === "external_history"
      ? remoteSession.origin.source
      : importedFrom.externalHistorySource;
  const sourceDisplay = resolveImportedSourceDisplay(remoteSession, existing);
  const ownerAvatarUrl =
    remoteSession.ownerAvatarUrl ?? importedFrom.ownerAvatarUrl;
  const repoPath = remoteSession.repoPath ?? existing.repoPath;
  const refreshedImportedFrom: SessionImportedFrom = {
    ...importedFrom,
    ownerMemberId: remoteSession.ownerMemberId,
    ownerDisplayName: remoteSession.ownerDisplayName,
    ownerAvatarUrl,
    externalHistorySource,
    sourceDisplay,
  };
  const sourcePresentation = resolveImportedSourcePresentation(
    existing.session_id,
    refreshedImportedFrom
  );
  const unchanged =
    existing.name === remoteSession.title &&
    existing.repoPath === repoPath &&
    existing.agentDisplayName === sourcePresentation.agentLabel &&
    existing.agentIconId === sourcePresentation.agentIconId &&
    importedFrom.ownerMemberId === remoteSession.ownerMemberId &&
    importedFrom.ownerDisplayName === remoteSession.ownerDisplayName &&
    importedFrom.ownerAvatarUrl === ownerAvatarUrl &&
    importedFrom.externalHistorySource === externalHistorySource &&
    importedFrom.sourceDisplay?.cliAgentType === sourceDisplay.cliAgentType &&
    importedFrom.sourceDisplay?.agentDisplayName ===
      sourceDisplay.agentDisplayName &&
    importedFrom.sourceDisplay?.agentDefinitionId ===
      sourceDisplay.agentDefinitionId &&
    importedFrom.sourceDisplay?.model === sourceDisplay.model;
  if (unchanged) return;

  const refreshed: Session = {
    ...existing,
    name: remoteSession.title,
    repoPath,
    agentDisplayName: sourcePresentation.agentLabel,
    agentIconId: sourcePresentation.agentIconId,
    importedFrom: refreshedImportedFrom,
  };
  upsertSession(refreshed);
  recordGuestImportedSession(refreshed);
  persistSessions(getInstrumentedStore().get(sessionsAtom) as Session[]);
}

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
    // before short-circuiting; fall through to a full refetch when hollow.
    const persisted = await eventStoreProxy.getPersistedEvents(
      existing.session_id
    );
    if (persisted.length > 0 || remoteSession.eventsCount === 0) {
      refreshImportedSessionPresentation(existing, remoteSession);
      return { localSessionId: existing.session_id, updated: false };
    }
  }

  let assembled: AssembledSegments | null = null;
  let streamed: PersistedStreamSummary | null = null;
  let localSessionId = existing?.session_id;
  if (!existing && options.client.streamSessionEventSegments) {
    // Fresh imports are the common large-history path. Persist bounded pages
    // directly instead of constructing two full event arrays in the WebView.
    localSessionId = await deriveImportedSessionId(
      orgId,
      remoteSession.sourceSessionId,
      sourceEndpointUrl
    );
    onBeforeWrite?.(localSessionId);
    streamed = await streamFreshRemoteSessionToCache(options, localSessionId);
    if (!streamed) return null;
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
  const priorPersisted = existing
    ? await eventStoreProxy.getPersistedEvents(localSessionId)
    : [];
  let storageMutated = streamed !== null;
  try {
    throwIfAborted(options.signal);
    const now = new Date().toISOString();
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
      created_at: existing?.created_at ?? now,
      updated_at: now,
      completed_at: now,
      name: remoteSession.title,
      repoPath: remoteSession.repoPath,
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
  return {
    localSessionId,
    updated: true,
    ...(streamed ? { deferIndex: true } : {}),
  };
}
