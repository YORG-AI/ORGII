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
import { resolveSessionDisplayMetadata } from "@src/util/session/sessionDisplayMetadata";

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
  /**
   * Pause capture: on an aborted fresh stream, receives the last PERSISTED
   * position (epoch / frozen seq / counts) so the caller can offer a resume
   * that continues past it. Persisted pages are deliberately NOT rolled back
   * on abort when this is provided. Never called when nothing durable was
   * written (the next start is a plain fresh stream).
   */
  onPauseState?: (state: {
    epoch: number;
    seq: number;
    count: number;
    frozenCount: number;
  }) => void;
  /**
   * Continue a previously paused fresh download: skip straight to the
   * incremental streamer with this cursor. Epoch drift or a persisted-count
   * mismatch degrades to a full fresh restream, so a stale cursor can never
   * corrupt the copy.
   */
  resumeCursor?: {
    epoch: number;
    seq: number;
    count: number;
    frozenCount: number;
  } | null;
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
    let epoch: number | null = null;
    let expectedFrozenSeq = 0;
    let persistedCount = 0;
    let frozenCount = 0;
    let tailHash: string | null = null;
    // Pause bookkeeping: expectedFrozenSeq advances during page VALIDATION,
    // before the page persists — a resume cursor must only ever describe
    // rows that actually landed in SQLite.
    let lastPersistedFrozenSeq = 0;

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
            // First page with data: only now is it certain the owner still
            // publishes segments. Clearing here rather than at attempt
            // start lets an EXISTING local copy survive the unpublished
            // race (this path also serves full restreams of stale imports).
            await eventStoreProxy.clearPersistedHistory(localSessionId);
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
          lastPersistedFrozenSeq = expectedFrozenSeq;
          if (tail) tailHash = tail.segmentHash;
          options.onProgress?.({
            loadedEvents: persistedCount,
            totalEvents: page.count,
          });
        }
      );

      if (summary.epoch === null || summary.count === null) {
        // No page carried data, so nothing was cleared or persisted — an
        // existing local copy is untouched.
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
      options.onProgress?.({
        loadedEvents: persistedCount,
        totalEvents: summary.count,
        phase: "finalizing",
      });
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
      if (options.signal?.aborted && options.onPauseState) {
        // Pause, not failure: keep the persisted pages and hand the caller
        // a cursor describing them. Nothing durable ⇒ no capture — the next
        // start is an ordinary fresh stream.
        if (epoch !== null && persistedCount > 0) {
          options.onPauseState({
            epoch,
            seq: lastPersistedFrozenSeq,
            count: persistedCount,
            frozenCount,
          });
        }
        throw error;
      }
      if (epoch !== null) {
        // Partial rows were written this attempt; drop them.
        await eventStoreProxy.clearPersistedHistory(localSessionId);
        await eventStoreProxy.clear(localSessionId).catch(() => undefined);
      }
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

/**
 * Incremental streamed refresh for an already-imported replay: fetch only
 * frozen segments past the cursor plus the current tail, upsert them into
 * the existing persisted rows (event ids are stable across tail freezes, so
 * re-sent tail events dedup in place), then republish. Returns null when the
 * delta cannot be applied cleanly — the caller restreams from scratch. The
 * finalize count check is the safety net: any drift (a tail rewritten in
 * place, legacy un-namespaced rows) surfaces as a count mismatch.
 */
async function streamIncrementalRemoteSessionToCache(
  options: ImportRemoteSessionOptions,
  localSessionId: string,
  cursor: { epoch: number; seq: number; count: number; frozenCount: number }
): Promise<PersistedStreamSummary | null> {
  const stream = options.client.streamSessionEventSegments;
  if (!stream) return null;
  // Cheap probe (COUNT, no event load): the local store must hold exactly
  // what the cursor claims before a delta may be spliced onto it.
  const persistedCount =
    await eventStoreProxy.countPersistedEvents(localSessionId);
  if (persistedCount !== cursor.count) {
    log.info("incremental declined: persisted count diverged from cursor", {
      localSessionId,
      persistedCount,
      cursorCount: cursor.count,
    });
    return null;
  }

  let expectedFrozenSeq = cursor.seq;
  let appendedFrozenCount = 0;
  let appendedCount = 0;
  let tailHash: string | null = null;
  let lastPersistedFrozenSeq = cursor.seq;
  try {
    const summary = await stream(
      {
        orgId: options.orgId,
        sessionRowId: options.remoteSession.id,
        afterSeq: cursor.seq,
        ...(options.shareToken !== undefined
          ? { shareToken: options.shareToken }
          : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
      async (page) => {
        throwIfAborted(options.signal);
        if (page.epoch === null || page.count === null) return;
        if (page.epoch !== cursor.epoch) {
          throw new Error(
            "ORG2_CONFLICT session events epoch changed during incremental import"
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
              `Failed to persist incremental import ${options.remoteSession.sourceSessionId}`
            );
          }
        }
        appendedCount += localEvents.length;
        appendedFrozenCount += frozen.reduce(
          (count, segment) => count + segment.events.length,
          0
        );
        lastPersistedFrozenSeq = expectedFrozenSeq;
        if (tail) tailHash = tail.segmentHash;
        options.onProgress?.({
          // Approximate: overlap with the re-sent tail dedups on upsert.
          loadedEvents: Math.min(
            page.count,
            cursor.frozenCount + appendedCount
          ),
          totalEvents: page.count,
        });
      }
    );

    if (summary.epoch === null || summary.count === null) return null;
    if (summary.epoch !== cursor.epoch) {
      throw new Error("Incremental replay summary epoch did not match cursor");
    }
    if (expectedFrozenSeq !== (summary.frozenSeq ?? 0)) {
      throw new Error("Incremental replay summary did not reconcile");
    }
    throwIfAborted(options.signal);
    options.onProgress?.({
      loadedEvents: summary.count,
      totalEvents: summary.count,
      phase: "finalizing",
    });
    const finalizedCount =
      await eventStoreProxy.finalizePersistedImport(localSessionId);
    if (finalizedCount !== summary.count) {
      throw new Error(
        `Incremental replay finalize count ${finalizedCount} did not match ${summary.count}`
      );
    }
    throwIfAborted(options.signal);
    const loaded = await eventStoreProxy.loadInitialTurnWindow(
      localSessionId,
      0
    );
    if (summary.count > 0 && loaded <= 0) {
      throw new Error("Failed to hydrate incremental replay turn window");
    }
    return {
      epoch: summary.epoch,
      frozenSeq: summary.frozenSeq ?? 0,
      frozenCount: cursor.frozenCount + appendedFrozenCount,
      count: finalizedCount,
      tailHash: tailHash ?? summary.tailHash,
    };
  } catch (error) {
    if (options.signal?.aborted) {
      // Pause capture for the incremental case. The tail upsert dedups
      // re-sent events, so the durable count is PROBED, not derived —
      // making the pause resumable instead of leaving unfinalized rows
      // for the next start's count probe to disown.
      if (options.onPauseState) {
        const persisted = await eventStoreProxy
          .countPersistedEvents(localSessionId)
          .catch(() => null);
        if (persisted !== null && persisted > 0) {
          options.onPauseState({
            epoch: cursor.epoch,
            seq: lastPersistedFrozenSeq,
            count: persisted,
            frozenCount: cursor.frozenCount + appendedFrozenCount,
          });
        }
      }
      throw error;
    }
    log.warn("incremental replay refresh failed; falling back to restream", {
      localSessionId,
      error,
    });
    return null;
  }
}

/**
 * Activity time of the OWNER's session, for the imported copy's timestamps.
 *
 * The replay copy describes someone else's work; stamping it with the moment
 * the viewer clicked made every card jump its Started / Last updated to "Now"
 * on first open, reordered List/Diary around the click, and pulled an old
 * session back out of the auto-archived column. Cloud metadata carries no
 * creation timestamp, so `lastActivityAt` is the only source-side time we
 * have — the same proxy the pre-click cloud card itself renders.
 *
 * Returns undefined for a row carrying no usable `lastActivityAt`, and the
 * two callers deliberately treat that differently: the refresh path leaves
 * the existing stamps alone (nothing to adopt, and the row already has some),
 * while the write path falls back to `now` because `created_at`/`updated_at`
 * are required on the insert it may be about to make.
 */
function readSourceActivityAt(
  remoteSession: ImportRemoteSessionOptions["remoteSession"]
): string | undefined {
  const lastActivityAt = remoteSession.lastActivityAt;
  if (!lastActivityAt) return undefined;
  return Number.isFinite(Date.parse(lastActivityAt))
    ? lastActivityAt
    : undefined;
}

/**
 * A session cannot have been created after its own last activity. Keeping the
 * earlier of the two also heals rows imported before the fix above, whose
 * `created_at` is the old import-click stamp.
 */
function resolveImportedCreatedAt(
  existingCreatedAt: string | undefined,
  activityAt: string
): string {
  if (!existingCreatedAt) return activityAt;
  const existingMs = Date.parse(existingCreatedAt);
  if (!Number.isFinite(existingMs)) return activityAt;
  return existingMs <= Date.parse(activityAt) ? existingCreatedAt : activityAt;
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

/**
 * Re-resolve an existing replay copy's presentation from the current roster
 * row, without fetching content.
 *
 * Three of the four call sites reach here having downloaded NOTHING — the
 * roster published no segments, a restream returned empty, or the assembler
 * refused the payload — and they still adopt the source's activity time. That
 * is deliberate, not an oversight: `updated_at` on a replay copy describes the
 * OWNER's session activity, not how fresh our local content is. The cloud card
 * for a session with no local copy at all already renders
 * `created_at`/`updated_at` from the same `lastActivityAt`
 * (`cloudRemoteToKanbanTask.ts`), so a copy that adopts it stays consistent
 * with the card it replaced. Content progress is tracked separately and
 * explicitly by the `importedFrom` cursor (`epoch`/`seq`/`count`); the two are
 * not meant to move together, and gating the clock on a successful fetch would
 * reintroduce exactly the card-jumping this module's timestamps exist to avoid.
 */
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
  // Rows imported before the ownership stamp used the selector form carry a
  // bare org uuid, which resolves to no owning org. Heal them here: this
  // refresh is the only path a long-lived import takes, so without it a
  // legacy row never regains its ownership-derived affordances. Guest rows
  // (no ownership stamp) and non-cloud scopes are left untouched.
  const normalizedOrgId =
    existing.orgId === importedFrom.orgId
      ? buildCloudOrgSelectorValue(importedFrom.orgId)
      : existing.orgId;
  // Same healing rationale for the source-activity timestamps: a copy imported
  // before they were tracked carries the old import-click stamp, and a
  // cursor-current reopen never reaches the write path that would correct it.
  const activityAt = readSourceActivityAt(remoteSession);
  const createdAt = activityAt
    ? resolveImportedCreatedAt(existing.created_at, activityAt)
    : existing.created_at;
  const timestampsUnchanged =
    !activityAt ||
    (existing.created_at === createdAt &&
      existing.updated_at === activityAt &&
      existing.completed_at === activityAt);
  const unchanged =
    existing.orgId === normalizedOrgId &&
    timestampsUnchanged &&
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
    ...(normalizedOrgId !== undefined ? { orgId: normalizedOrgId } : {}),
    ...(activityAt
      ? {
          created_at: createdAt,
          updated_at: activityAt,
          completed_at: activityAt,
        }
      : {}),
    name: remoteSession.title,
    repoPath,
    agentDisplayName: sourcePresentation.agentLabel,
    agentIconId: sourcePresentation.agentIconId,
    importedFrom: refreshedImportedFrom,
  };
  upsertSession(refreshed);
  if (activityAt) {
    // upsertSession pins timestamps; this row's clock is the source's.
    applyImportedSessionTimestamps(existing.session_id, {
      created_at: createdAt ?? activityAt,
      updated_at: activityAt,
      completed_at: activityAt,
    });
  }
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
