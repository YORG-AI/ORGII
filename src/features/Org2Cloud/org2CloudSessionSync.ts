/**
 * Owns one session's metadata/event push plane, including persisted cursors,
 * event-clean stamps, OCC re-anchors, and retract bookkeeping.
 *
 * The class is assembled from an inheritance chain, each link a sibling file:
 * - `.state`      in-memory bookkeeping (hashes, clean stamps, cursors)
 * - `.pushEvents` materializing a session's events into a prepared push plan
 * - `.turnIndex`  the 0012 index publish (and the sync-client dependency)
 * - `.upload`     metadata upsert plus the three segment mutations
 * and this file adds the pass orchestration that decides which of them runs.
 */
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { createLogger } from "@src/hooks/logger";
import { COLLAB_SESSION_ACCESS_MODE } from "@src/store/collaboration/types";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import type { Session } from "@src/store/session/sessionAtom/types";
import { isImportedHistorySession } from "@src/util/session/sessionDispatch";

import {
  sha256Hex,
  stableStringify,
} from "../TeamCollaboration/collabSyncUtils";
import { splitFrozenIntoSegments } from "../TeamCollaboration/engine/collabSyncEngineHelpers";
import type { CloudPushAccess } from "./org2CloudAccessSettings";
import type { Org2CloudAuthState } from "./org2CloudAuthAtom";
import { broadcastOrgControlChangedToPeers } from "./org2CloudControlBus";
import {
  buildCloudSessionMetadata,
  metadataPayloadForHash,
} from "./org2CloudSessionSync.metadata";
import { Org2CloudSessionSyncUpload } from "./org2CloudSessionSync.upload";
import { isOrg2SyncErrorCode } from "./org2CloudSyncClient";

export {
  buildCloudSessionMetadata,
  isCloudPushCandidate,
} from "./org2CloudSessionSync.metadata";
export type { Org2CloudSyncClientDeps } from "./org2CloudSessionSync.types";
export { IMPORTED_INCREMENTAL_REANCHOR_EVERY } from "./org2CloudSessionSync.pushEvents";
export { normalizeTurnPromptPreview } from "./org2CloudSessionSync.turnIndex";
export { SESSION_SEGMENT_UPLOAD_BATCH_SIZE } from "./org2CloudSessionSync.upload";

const log = createLogger("Org2CloudSyncEngine");

/** Per-session transient retry policy (org entitlement failures back off elsewhere). */
export const SESSION_PUSH_RETRY_BASE_MS = 60_000;
export const SESSION_PUSH_RETRY_MAX_MS = 30 * 60_000;

interface SessionPushRetryState {
  failures: number;
  retryAtMs: number;
}

export class Org2CloudSessionSync extends Org2CloudSessionSyncUpload {
  /** Transient event-plane failures, bounded by live (org, session) pairs. */
  private readonly sessionPushRetryStates = new Map<
    string,
    SessionPushRetryState
  >();

  /** A short read must repeat identically across passes before it rewrites. */
  private readonly sessionShrinkCandidates = new Map<string, number>();

  override reset(): void {
    super.reset();
    this.sessionPushRetryStates.clear();
    this.sessionShrinkCandidates.clear();
  }

  override prune(
    liveOrgIds: ReadonlySet<string>,
    liveSessionIds: ReadonlySet<string>
  ): void {
    super.prune(liveOrgIds, liveSessionIds);
    for (const states of [
      this.sessionPushRetryStates,
      this.sessionShrinkCandidates,
    ] as const) {
      for (const key of states.keys()) {
        const separatorIndex = key.indexOf(":");
        const orgId =
          separatorIndex === -1 ? key : key.slice(0, separatorIndex);
        const sessionId =
          separatorIndex === -1 ? "" : key.slice(separatorIndex + 1);
        if (!liveOrgIds.has(orgId) || !liveSessionIds.has(sessionId)) {
          states.delete(key);
        }
      }
    }
  }

  private isSessionPushBackedOff(orgId: string, sessionId: string): boolean {
    const key = `${orgId}:${sessionId}`;
    const state = this.sessionPushRetryStates.get(key);
    if (!state) return false;
    if (Date.now() < state.retryAtMs) return true;
    return false;
  }

  private noteSessionPushFailure(orgId: string, sessionId: string): void {
    const key = `${orgId}:${sessionId}`;
    const previous = this.sessionPushRetryStates.get(key);
    const failures = (previous?.failures ?? 0) + 1;
    const delayMs = Math.min(
      SESSION_PUSH_RETRY_BASE_MS * 2 ** (failures - 1),
      SESSION_PUSH_RETRY_MAX_MS
    );
    this.sessionPushRetryStates.set(key, {
      failures,
      retryAtMs: Date.now() + delayMs,
    });
  }

  private clearSessionPushFailure(orgId: string, sessionId: string): void {
    this.sessionPushRetryStates.delete(`${orgId}:${sessionId}`);
  }

  private shouldBackOffSessionFailure(error: unknown): boolean {
    // Entitlement failures already have org-wide active/inactive backoff and
    // toast policy in Org2CloudSyncEngine. Duplicating that state here would
    // keep one session asleep after the org is explicitly resumed.
    return (
      !isOrg2SyncErrorCode(error, "ORG2_QUOTA_EXCEEDED") &&
      !isOrg2SyncErrorCode(error, "ORG2_SYNC_DISABLED")
    );
  }

  /** Seed volatile cold-start caches from a server-authoritative listing. */
  async seedFromRemoteSummary(
    auth: Org2CloudAuthState,
    orgId: string,
    session: Session,
    scopeKey: string | null,
    access: CloudPushAccess,
    remote: RemoteTeammateSessionMetadata
  ): Promise<void> {
    const key = `${orgId}:${session.session_id}`;
    if (this.remoteSeedAttemptedKeys.has(key)) return;
    this.remoteSeedAttemptedKeys.add(key);
    if (
      remote.deletedAt ||
      remote.ownerUserId !== auth.userId ||
      remote.sourceSessionId !== session.session_id
    ) {
      return;
    }
    const displayName =
      auth.profile?.displayName ?? auth.profile?.primaryEmail ?? auth.userId;
    const localMetadata = buildCloudSessionMetadata(
      session,
      orgId,
      auth.userId,
      displayName,
      scopeKey,
      access,
      auth.profile?.avatarUrl
    );
    const [localHash, remoteHash] = await Promise.all([
      sha256Hex(stableStringify(metadataPayloadForHash(localMetadata))),
      sha256Hex(stableStringify(metadataPayloadForHash(remote))),
    ]);
    if (localHash === remoteHash) {
      // upsertMetadataIfChanged gates on the FULL payload hash; seeding the
      // stripped comparison hash would never match it and every restart would
      // re-upsert an identical payload for every pushed session.
      this.lastPushedMetadataHashes.set(
        key,
        await sha256Hex(stableStringify(localMetadata))
      );
      this.setPushedMetadataMarker(orgId, session.session_id);
    }

    // Metadata and transcript are independent planes. Even if a title or
    // access field changed locally, a cursor stamped with this exact local
    // content version plus the server summary proves the event plane clean.
    // Legacy cursors lack the stamp and deliberately take one normal read.
    const cursor = this.getCursor(orgId, session.session_id);
    if (
      !cursor ||
      remote.eventsEpoch !== cursor.epoch ||
      remote.eventsFrozenSeq !== cursor.frozenSeq ||
      remote.eventsCount !== cursor.pushedCount ||
      (remote.eventsTailHash ?? null) !== cursor.tailHash
    ) {
      return;
    }
    let localContentRevision: number | undefined;
    if (!isImportedHistorySession(session.session_id)) {
      const durable = await eventStoreProxy.getPersistedEventRevision(
        session.session_id
      );
      if (durable && durable.eventCount > 0) {
        if (durable.eventCount !== cursor.pushedCount) return;
        if (
          cursor.localContentRevision !== undefined &&
          cursor.localContentRevision !== durable.revision
        ) {
          return;
        }
        // Legacy revisions are upgraded from the server cursor + local count
        // proof. Crucially this is independent of Session.updated_at: rename,
        // pin and org-access edits are metadata changes and must not trigger a
        // multi-GB replay materialization.
        localContentRevision = durable.revision;
        if (cursor.localContentRevision !== durable.revision) {
          this.setCursor({ ...cursor, localContentRevision: durable.revision });
        }
      } else if (cursor.localContentUpdatedAt !== session.updated_at) {
        return;
      }
    } else if (cursor.localContentUpdatedAt !== session.updated_at) {
      return;
    }
    this.markEventPlaneClean(
      orgId,
      session,
      this.eventActivityStamps.get(session.session_id) ?? 0,
      Date.now(),
      localContentRevision
    );
  }

  /** Soft-tombstone a prior push and clear every local pushed marker. */
  /** Live server rows this ACCOUNT owns in the org, regardless of which
   * device pushed them or whether local push markers survived. */
  async listSelfOwnedLiveRemoteSessionIds(
    auth: Org2CloudAuthState,
    orgId: string
  ): Promise<string[]> {
    const result = await this.client.listOrgSessions(auth.accessToken, orgId);
    return result.sessions
      .filter((row) => row.ownerUserId === auth.userId && !row.deletedAt)
      .map((row) => row.sourceSessionId);
  }

  async retractSession(
    auth: Org2CloudAuthState,
    orgId: string,
    sessionId: string
  ): Promise<void> {
    try {
      await this.client.deleteSession(auth.accessToken, orgId, sessionId);
    } catch (error) {
      if (!isOrg2SyncErrorCode(error, "ORG2_SESSION_NOT_FOUND")) throw error;
    }
    this.invalidatePushedMetadataHash(orgId, sessionId);
    this.lastPushedTurnIndexHashes.delete(`${orgId}:${sessionId}`);
    this.clearPushedMetadataMarker(orgId, sessionId);
    this.clearCursor(orgId, sessionId);
    broadcastOrgControlChangedToPeers(orgId, "sessions");
  }

  async pushSession(
    auth: Org2CloudAuthState,
    orgId: string,
    session: Session,
    scopeKey: string | null,
    access: CloudPushAccess
  ): Promise<void> {
    const sessionId = session.session_id;
    if (
      access.accessMode !== COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY &&
      this.isSessionPushBackedOff(orgId, sessionId)
    ) {
      // Metadata remains cheap and live while the expensive transcript plane
      // sleeps. The hash gate makes this a no-RPC no-op when unchanged.
      await this.upsertMetadataIfChanged(
        auth,
        orgId,
        session,
        scopeKey,
        access
      );
      return;
    }
    try {
      await this.pushSessionOnce(auth, orgId, session, scopeKey, access);
      this.clearSessionPushFailure(orgId, sessionId);
    } catch (error) {
      if (this.shouldBackOffSessionFailure(error)) {
        this.noteSessionPushFailure(orgId, sessionId);
      }
      throw error;
    }
  }

  private async pushSessionOnce(
    auth: Org2CloudAuthState,
    orgId: string,
    session: Session,
    scopeKey: string | null,
    access: CloudPushAccess
  ): Promise<void> {
    const sessionId = session.session_id;
    if (access.accessMode === COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY) {
      await this.upsertMetadataIfChanged(
        auth,
        orgId,
        session,
        scopeKey,
        access
      );
      // A metadata-only pass invalidates local segment knowledge. If policy
      // later rises to full replay, rebuild the authoritative transcript.
      this.cleanEventPlanes.get(sessionId)?.delete(orgId);
      this.clearCursor(orgId, sessionId);
      return;
    }
    // The external-history scanner updates sessionsAtom directly, without an
    // EventStore notification. Gate on the source's updated_at as well as the
    // event-store stamp, and defer metadata together with replay so a live CLI
    // turn does not produce one cloud upsert per scanner refresh.
    if (!this.isExternalHistorySettled(session)) return;
    if (this.isEventPlaneClean(orgId, session)) {
      await this.upsertMetadataIfChanged(
        auth,
        orgId,
        session,
        scopeKey,
        access
      );
      return;
    }
    const cursor = this.getCursor(orgId, sessionId);
    const prepared = await this.preparePushEventsForPass(sessionId, cursor);
    const { stampAtRead, mode, baseEventCount, localContentRevision, events } =
      prepared;
    const markPreparedClean = () =>
      this.markEventPlaneClean(
        orgId,
        session,
        stampAtRead,
        Date.now(),
        localContentRevision
      );
    if (!cursor && events.length === 0) {
      await this.upsertMetadataIfChanged(
        auth,
        orgId,
        session,
        scopeKey,
        access
      );
      markPreparedClean();
      return;
    }
    const shrinkKey = `${orgId}:${sessionId}`;
    let confirmedShrink = false;
    // Equals the plan's totalEventCount without forcing the plan: the shrink
    // dance below returns without pushing on its first observation, and
    // hashing a GB-scale transcript just to skip would defeat this pass.
    const observedTotalEventCount = baseEventCount + events.length;
    if (cursor && observedTotalEventCount < cursor.pushedCount) {
      if (observedTotalEventCount === 0) {
        // A hollow local read can NEVER authorize erasing the cloud copy.
        // An empty store (wiped cache, missing provider DB, rebuilding
        // import) reads zero on EVERY pass, so consecutive-pass
        // confirmation is no evidence of intent — and the cloud row may be
        // the only surviving copy (cursoride-93121e8a lost its 301 cloud
        // events to exactly this rewrite on 2026-07-31). Recovery for a
        // hollow local store is seed/import, not an empty rewrite.
        this.sessionShrinkCandidates.delete(shrinkKey);
        log.rateLimited(
          `hollow-push-${shrinkKey}`,
          60_000,
          `persisted read for ${sessionId} returned 0 events but the ` +
            `cloud cursor covers ${cursor.pushedCount}; refusing hollow ` +
            `epoch rewrite`
        );
        return;
      }
      if (
        this.sessionShrinkCandidates.get(shrinkKey) === observedTotalEventCount
      ) {
        this.sessionShrinkCandidates.delete(shrinkKey);
        confirmedShrink = true;
        log.info(
          `persisted read for ${sessionId} returned ${observedTotalEventCount} events ` +
            `on consecutive passes while the cloud cursor covers ` +
            `${cursor.pushedCount}; re-anchoring via epoch rewrite`
        );
      } else {
        this.sessionShrinkCandidates.set(shrinkKey, observedTotalEventCount);
        log.warn(
          `persisted read for ${sessionId} returned ${observedTotalEventCount} events ` +
            `but the cloud cursor covers ${cursor.pushedCount}; skipping`
        );
        return;
      }
    } else {
      this.sessionShrinkCandidates.delete(shrinkKey);
    }

    const preparedPlan = await prepared.plan();
    const {
      perEventHashes,
      frozenHashMode,
      totalEventCount,
      frozenEventCount,
      localFrozenEventCount,
      tailEvents,
      tailHash,
      frozenChainHash,
      importedReplay,
    } = preparedPlan;

    if (cursor && mode === "incremental") {
      const priorFrozenInsideWindow = cursor.frozenEventCount - baseEventCount;
      const newFrozenEvents = events.slice(
        priorFrozenInsideWindow,
        localFrozenEventCount
      );
      if (
        newFrozenEvents.length === 0 &&
        tailHash === cursor.tailHash &&
        totalEventCount === cursor.pushedCount
      ) {
        await this.upsertMetadataIfChanged(
          auth,
          orgId,
          session,
          scopeKey,
          access
        );
        if (importedReplay) {
          this.setCursor({
            ...cursor,
            frozenChainHash,
            importedReplay,
          });
        }
        markPreparedClean();
        return;
      }
      await this.upsertMetadataIfChanged(
        auth,
        orgId,
        session,
        scopeKey,
        access
      );
      try {
        await this.appendIncrementalSession(
          auth,
          orgId,
          sessionId,
          cursor,
          newFrozenEvents,
          preparedPlan
        );
      } catch (error) {
        if (!isOrg2SyncErrorCode(error, "ORG2_CONFLICT")) throw error;
        const fullPrepared = await this.preparePushEventsForPass(
          sessionId,
          cursor,
          true
        );
        const fullPlan = await fullPrepared.plan();
        await this.rewriteSession(auth, orgId, session, scopeKey, access, {
          events: fullPrepared.events,
          ...fullPlan,
          newEpoch: null,
        });
      }
      broadcastOrgControlChangedToPeers(orgId, "sessions");
      markPreparedClean();
      void this.publishTurnIndexBestEffort(auth, orgId, session, stampAtRead);
      return;
    }

    if (cursor) {
      let frozenIntact =
        !confirmedShrink && frozenEventCount >= cursor.frozenEventCount;
      if (frozenIntact && cursor.frozenEventCount > 0) {
        // The cursor's commitment may be in either hash mode: flat-v1 cursors
        // predate the imported-replay checkpoint, a failed turn-id probe
        // downgrades a checkpointed cursor, and an interrupted batch append
        // persists a merkle commitment without its checkpoint. Both modes
        // commit to the same per-event hashes, so intactness accepts a match
        // in either — an intact history rides the delta append and adopts
        // this plan's mode there; a mode change alone must never force the
        // O(total) epoch rewrite.
        frozenIntact = await this.frozenChainMatchesCursor(
          cursor,
          preparedPlan
        );
      }

      if (!frozenIntact) {
        // An epoch rewrite re-uploads the ENTIRE frozen history. It is the
        // expensive path, so name the condition that forced it: a silent
        // rewrite loop is indistinguishable from steady state in the ledger.
        log.info(
          `epoch rewrite for ${sessionId} org ${orgId}: ` +
            `confirmedShrink=${confirmedShrink} ` +
            `frozen=${frozenEventCount} cursorFrozen=${cursor.frozenEventCount} ` +
            `chainMismatch=${
              !confirmedShrink && frozenEventCount >= cursor.frozenEventCount
            }`
        );
      }

      if (frozenIntact) {
        const newFrozenEvents = events.slice(
          cursor.frozenEventCount,
          frozenEventCount
        );
        if (
          newFrozenEvents.length === 0 &&
          tailHash === cursor.tailHash &&
          totalEventCount === cursor.pushedCount
        ) {
          await this.upsertMetadataIfChanged(
            auth,
            orgId,
            session,
            scopeKey,
            access
          );
          if (importedReplay && frozenChainHash !== cursor.frozenChainHash) {
            // Same content in an upgraded hash mode: converge the local
            // cursor (a checkpoint plus its merkle commitment) so the next
            // delta takes the bounded path — no network write is needed.
            // The downgrade direction deliberately keeps the cursor: a
            // still-valid checkpoint must survive a transiently failed probe.
            this.setCursor({ ...cursor, frozenChainHash, importedReplay });
          }
          markPreparedClean();
          return;
        }
        await this.upsertMetadataIfChanged(
          auth,
          orgId,
          session,
          scopeKey,
          access
        );
        const frozenSegments = splitFrozenIntoSegments(
          newFrozenEvents,
          cursor.frozenSeq + 1
        );
        try {
          await this.appendSessionBatches(
            auth,
            orgId,
            sessionId,
            cursor,
            frozenSegments,
            {
              events,
              perEventHashes,
              frozenHashMode,
              totalEventCount,
              frozenEventCount,
              localFrozenEventCount,
              frozenChainHash,
              tailEvents,
              tailHash,
              importedReplay,
            }
          );
          broadcastOrgControlChangedToPeers(orgId, "sessions");
          markPreparedClean();
          void this.publishTurnIndexBestEffort(
            auth,
            orgId,
            session,
            stampAtRead
          );
          return;
        } catch (error) {
          if (!isOrg2SyncErrorCode(error, "ORG2_CONFLICT")) throw error;
          await this.rewriteSession(auth, orgId, session, scopeKey, access, {
            events,
            perEventHashes,
            frozenHashMode,
            totalEventCount,
            frozenEventCount,
            localFrozenEventCount,
            frozenChainHash,
            tailEvents,
            tailHash,
            importedReplay,
            newEpoch: null,
          });
          markPreparedClean();
          void this.publishTurnIndexBestEffort(
            auth,
            orgId,
            session,
            stampAtRead
          );
          return;
        }
      }

      await this.rewriteSession(auth, orgId, session, scopeKey, access, {
        events,
        perEventHashes,
        frozenHashMode,
        totalEventCount,
        frozenEventCount,
        localFrozenEventCount,
        frozenChainHash,
        tailEvents,
        tailHash,
        importedReplay,
        newEpoch: cursor.epoch + 1,
      });
      markPreparedClean();
      void this.publishTurnIndexBestEffort(auth, orgId, session, stampAtRead);
      return;
    }

    await this.rewriteSession(auth, orgId, session, scopeKey, access, {
      events,
      perEventHashes,
      frozenHashMode,
      totalEventCount,
      frozenEventCount,
      localFrozenEventCount,
      frozenChainHash,
      tailEvents,
      tailHash,
      importedReplay,
      newEpoch: 1,
    });
    markPreparedClean();
    void this.publishTurnIndexBestEffort(auth, orgId, session, stampAtRead);
  }
}
