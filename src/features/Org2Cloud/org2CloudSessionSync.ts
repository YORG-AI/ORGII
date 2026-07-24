import {
  type ExternalReplayCloudManifest,
  type ExternalReplayTarget,
  externalReplayCloudPrefixHash,
  externalReplayCloudPrepareForTarget,
  externalReplayCloudReadBatch,
  externalReplayCloudRelease,
  resolveExternalReplayTarget,
  resolveSecondaryReplayTarget,
} from "@src/api/tauri/externalHistory/replay";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { createLogger } from "@src/hooks/logger";
import { COLLAB_SESSION_ACCESS_MODE } from "@src/store/collaboration/types";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import type { Session } from "@src/store/session/sessionAtom/types";

import {
  sha256Hex,
  stableStringify,
} from "../TeamCollaboration/collabSyncUtils";
import {
  computeFrozenEventCount,
  splitFrozenIntoSegments,
} from "../TeamCollaboration/engine/collabSyncEngineHelpers";
import { getSessionForkedFrom } from "../TeamCollaboration/forkSession";
import { computeSegmentHash } from "../TeamCollaboration/sync/collabGzip";
import type { SegmentWirePayload } from "../TeamCollaboration/sync/segmentCodec";
import type { CloudPushAccess } from "./org2CloudAccessSettings";
import type { Org2CloudAuthState } from "./org2CloudAuthAtom";
import { broadcastOrgControlChangedToPeers } from "./org2CloudControlBus";
import {
  buildCloudSessionMetadata,
  metadataPayloadForHash,
} from "./org2CloudSessionSync.metadata";
import { Org2CloudSessionSyncState } from "./org2CloudSessionSync.state";
import type {
  Org2CloudSyncClientDeps,
  PreparedPushEvents,
  PreparedPushPlan,
} from "./org2CloudSessionSync.types";
import type { CollabSessionPushCursor } from "./org2CloudSyncAtoms";
import { isOrg2SyncErrorCode } from "./org2CloudSyncClient";
import type { CloudStore } from "./org2CloudSyncLifecycle";

export {
  buildCloudSessionMetadata,
  isCloudPushCandidate,
} from "./org2CloudSessionSync.metadata";
export type { Org2CloudSyncClientDeps } from "./org2CloudSessionSync.types";

const log = createLogger("Org2CloudSyncEngine");

/** Server-epoch probes need only one compact physical row. */
const HEAD_READ_MAX_WIRE_BYTES = 64 * 1024;

/**
 * Keep every segment mutation comfortably below PostgREST / PostgreSQL
 * statement-timeout and renderer-RSS cliffs. Each frozen segment is bounded
 * to 256 KiB before gzip, so a batch carries at most ~4 MiB of canonical
 * input and the client codec only materializes one batch of wire payloads.
 */
export const SESSION_SEGMENT_UPLOAD_BATCH_SIZE = 16;

/** Hash only a bounded event window at once; large CLI histories can be GBs. */
const EVENT_HASH_CONCURRENCY = 16;

/** Per-session transient retry policy (org entitlement failures back off elsewhere). */
export const SESSION_PUSH_RETRY_BASE_MS = 60_000;
export const SESSION_PUSH_RETRY_MAX_MS = 30 * 60_000;

interface SessionPushRetryState {
  failures: number;
  retryAtMs: number;
}

interface PreparedExternalPush {
  stampAtRead: number;
  manifest: ExternalReplayCloudManifest;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

async function hashEventsBounded(events: SessionEvent[]): Promise<string[]> {
  const hashes = new Array<string>(events.length);
  for (let start = 0; start < events.length; start += EVENT_HASH_CONCURRENCY) {
    const end = Math.min(start + EVENT_HASH_CONCURRENCY, events.length);
    const batch = events.slice(start, end);
    const batchHashes = await Promise.all(
      batch.map((event) => sha256Hex(stableStringify(event)))
    );
    for (let index = 0; index < batchHashes.length; index += 1) {
      hashes[start + index] = batchHashes[index];
    }
  }
  return hashes;
}
/**
 * Owns one session's metadata/event push plane, including persisted cursors,
 * event-clean stamps, OCC re-anchors, and retract bookkeeping.
 *
 * In-memory bookkeeping (pushed-metadata hashes, clean-event-plane stamps,
 * cursor/pushed-marker storage) lives in the Org2CloudSessionSyncState base
 * class in org2CloudSessionSync.state.ts; this subclass adds the
 * network-facing push/rewrite orchestration that calls the sync client.
 */
export class Org2CloudSessionSync extends Org2CloudSessionSyncState {
  /** Transient event-plane failures, bounded by live (org, session) pairs. */
  private readonly sessionPushRetryStates = new Map<
    string,
    SessionPushRetryState
  >();
  /** External replay spools are prepared once and reused across orgs/pass. */
  private readonly passExternalPrepareCache = new Map<
    string,
    Promise<PreparedExternalPush>
  >();

  constructor(
    getStore: () => CloudStore | null,
    private readonly client: Org2CloudSyncClientDeps
  ) {
    super(getStore);
  }

  override reset(): void {
    this.releaseExternalPassSpools();
    super.reset();
    this.sessionPushRetryStates.clear();
    this.passExternalPrepareCache.clear();
  }

  override beginPass(): void {
    this.releaseExternalPassSpools();
    super.beginPass();
    this.passExternalPrepareCache.clear();
  }

  private releaseExternalPassSpools(): void {
    for (const prepared of this.passExternalPrepareCache.values()) {
      void prepared
        .then(({ manifest }) => externalReplayCloudRelease(manifest.token))
        .catch((error: unknown) => {
          log.warn("failed to release external replay cloud spool", error);
        });
    }
  }

  override prune(
    liveOrgIds: ReadonlySet<string>,
    liveSessionIds: ReadonlySet<string>
  ): void {
    super.prune(liveOrgIds, liveSessionIds);
    for (const key of this.sessionPushRetryStates.keys()) {
      const separatorIndex = key.indexOf(":");
      const orgId = separatorIndex === -1 ? key : key.slice(0, separatorIndex);
      const sessionId =
        separatorIndex === -1 ? "" : key.slice(separatorIndex + 1);
      if (!liveOrgIds.has(orgId) || !liveSessionIds.has(sessionId)) {
        this.sessionPushRetryStates.delete(key);
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

  private async pushExternalSession(
    auth: Org2CloudAuthState,
    orgId: string,
    session: Session,
    scopeKey: string | null,
    access: CloudPushAccess,
    replayTarget: ExternalReplayTarget,
    signal?: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal);
    const sessionId = session.session_id;
    const { stampAtRead, manifest } =
      await this.prepareExternalPushForPass(replayTarget);
    throwIfAborted(signal);
    const cursor = this.getCursor(orgId, sessionId);
    if (!cursor && manifest.totalCount === 0) {
      await this.upsertMetadataIfChanged(
        auth,
        orgId,
        session,
        scopeKey,
        access
      );
      throwIfAborted(signal);
      this.markEventPlaneClean(orgId, session, stampAtRead);
      return;
    }
    const sourceShrank =
      cursor !== undefined && manifest.totalCount < cursor.pushedCount;
    if (cursor && sourceShrank) {
      log.warn(
        `bounded replay spool for ${sessionId} has ${manifest.totalCount} ` +
          `events but the cloud cursor covers ${cursor.pushedCount}; ` +
          "rewriting the cloud epoch"
      );
    }

    let frozenIntact =
      !sourceShrank &&
      cursor !== undefined &&
      manifest.frozenEventCount >= cursor.frozenEventCount;
    if (cursor && frozenIntact && cursor.frozenEventCount > 0) {
      const prefix = await externalReplayCloudPrefixHash({
        token: manifest.token,
        eventCount: cursor.frozenEventCount,
      });
      throwIfAborted(signal);
      frozenIntact = prefix.frozenChainHash === cursor.frozenChainHash;
    }
    if (
      cursor &&
      frozenIntact &&
      manifest.frozenEventCount === cursor.frozenEventCount &&
      manifest.tailHash === cursor.tailHash &&
      manifest.totalCount === cursor.pushedCount
    ) {
      await this.upsertMetadataIfChanged(
        auth,
        orgId,
        session,
        scopeKey,
        access
      );
      throwIfAborted(signal);
      this.markEventPlaneClean(orgId, session, stampAtRead);
      return;
    }

    throwIfAborted(signal);
    await this.upsertMetadataIfChanged(auth, orgId, session, scopeKey, access);
    throwIfAborted(signal);
    if (cursor && frozenIntact) {
      try {
        await this.appendExternalSpool(
          auth,
          orgId,
          sessionId,
          manifest,
          cursor,
          signal
        );
      } catch (error) {
        if (!isOrg2SyncErrorCode(error, "ORG2_CONFLICT")) throw error;
        await this.rewriteExternalSpool(
          auth,
          orgId,
          sessionId,
          manifest,
          null,
          signal
        );
      }
    } else {
      await this.rewriteExternalSpool(
        auth,
        orgId,
        sessionId,
        manifest,
        cursor ? cursor.epoch + 1 : 1,
        signal
      );
    }
    throwIfAborted(signal);
    this.markEventPlaneClean(orgId, session, stampAtRead);
  }

  private async readExternalFrozenBatch(
    manifest: ExternalReplayCloudManifest,
    startEventIndex: number,
    startSegmentIndex?: number,
    signal?: AbortSignal
  ) {
    throwIfAborted(signal);
    if (startEventIndex >= manifest.frozenEventCount) {
      return {
        segments: [],
        startEventIndex,
        nextEventIndex: startEventIndex,
        startSegmentIndex: startSegmentIndex ?? 0,
        nextSegmentIndex: startSegmentIndex ?? 0,
        eof: true,
        serializedBytes: 0,
      };
    }
    const batch = await externalReplayCloudReadBatch({
      token: manifest.token,
      startEventIndex,
      endEventIndex: manifest.frozenEventCount,
      ...(startSegmentIndex !== undefined ? { startSegmentIndex } : {}),
      // Leave room for JSON array punctuation in the 256 KiB wire segment.
      maxBytes: 240 * 1024,
    });
    throwIfAborted(signal);
    if (
      !batch.eof &&
      batch.nextEventIndex <= startEventIndex &&
      batch.nextSegmentIndex <= batch.startSegmentIndex
    ) {
      throw new Error("External replay cloud batch cursor did not advance");
    }
    return batch;
  }

  private async readExternalTail(
    manifest: ExternalReplayCloudManifest,
    signal?: AbortSignal
  ): Promise<Omit<SegmentWirePayload, "seq"> | null> {
    throwIfAborted(signal);
    if (manifest.tailEventCount === 0) return null;
    const batch = await externalReplayCloudReadBatch({
      token: manifest.token,
      startEventIndex: manifest.frozenEventCount,
      endEventIndex: manifest.totalCount,
      maxBytes: 256 * 1024,
    });
    throwIfAborted(signal);
    if (
      !batch.eof ||
      batch.serializedBytes > 256 * 1024 ||
      batch.segments.length !== 1
    ) {
      throw new Error(
        "External replay mutable tail exceeds the 256 KiB cloud wire budget"
      );
    }
    const segment = batch.segments[0];
    if (!segment) return null;
    return {
      payloadGz: segment.payloadGz,
      eventCount: segment.eventCount,
      segmentHash: segment.segmentHash,
    };
  }

  private async appendExternalSpool(
    auth: Org2CloudAuthState,
    orgId: string,
    sessionId: string,
    manifest: ExternalReplayCloudManifest,
    cursor: CollabSessionPushCursor,
    signal?: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal);
    let eventIndex = cursor.frozenEventCount;
    let segmentIndex: number | undefined;
    let frozenSeq = cursor.frozenSeq;
    let expectedTailHash = cursor.tailHash;
    do {
      const batch = await this.readExternalFrozenBatch(
        manifest,
        eventIndex,
        segmentIndex,
        signal
      );
      const finalFrozenBatch = batch.eof;
      const tail = finalFrozenBatch
        ? await this.readExternalTail(manifest, signal)
        : null;
      const segments = batch.segments.map((segment, index) => ({
        seq: frozenSeq + index + 1,
        payloadGz: segment.payloadGz,
        eventCount: segment.eventCount,
        segmentHash: segment.segmentHash,
      }));
      await this.client.appendSessionEventWires(auth.accessToken, {
        orgId,
        sessionId,
        expectedEpoch: cursor.epoch,
        expectedFrozenSeq: frozenSeq,
        expectedTailHash,
        newFrozenSegments: segments,
        tail,
        totalCount: batch.nextEventIndex + (tail?.eventCount ?? 0),
      });
      throwIfAborted(signal);
      eventIndex = batch.nextEventIndex;
      segmentIndex = batch.nextSegmentIndex;
      frozenSeq += segments.length;
      expectedTailHash = finalFrozenBatch ? manifest.tailHash : null;
      if (finalFrozenBatch) break;
    } while (eventIndex < manifest.frozenEventCount);
    throwIfAborted(signal);
    this.setExternalCursor(orgId, sessionId, manifest, cursor.epoch, frozenSeq);
    broadcastOrgControlChangedToPeers(orgId, "sessions");
  }

  private async rewriteExternalSpool(
    auth: Org2CloudAuthState,
    orgId: string,
    sessionId: string,
    manifest: ExternalReplayCloudManifest,
    requestedEpoch: number | null,
    signal?: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal);
    let epoch =
      requestedEpoch ??
      (await this.readServerEpoch(auth, orgId, sessionId, signal)) + 1;
    let reanchored = requestedEpoch === null;
    for (;;) {
      try {
        await this.rewriteExternalAtEpoch(
          auth,
          orgId,
          sessionId,
          manifest,
          epoch,
          signal
        );
        return;
      } catch (error) {
        if (!isOrg2SyncErrorCode(error, "ORG2_CONFLICT") || reanchored) {
          throw error;
        }
        reanchored = true;
        epoch =
          (await this.readServerEpoch(auth, orgId, sessionId, signal)) + 1;
      }
    }
  }

  private async rewriteExternalAtEpoch(
    auth: Org2CloudAuthState,
    orgId: string,
    sessionId: string,
    manifest: ExternalReplayCloudManifest,
    epoch: number,
    signal?: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal);
    const first = await this.readExternalFrozenBatch(
      manifest,
      0,
      undefined,
      signal
    );
    const firstTail = first.eof
      ? await this.readExternalTail(manifest, signal)
      : null;
    const firstSegments = first.segments.map((segment, index) => ({
      seq: index + 1,
      payloadGz: segment.payloadGz,
      eventCount: segment.eventCount,
      segmentHash: segment.segmentHash,
    }));
    await this.client.rewriteSessionEventWires(auth.accessToken, {
      orgId,
      sessionId,
      newEpoch: epoch,
      frozenSegments: firstSegments,
      tail: firstTail,
      totalCount: first.nextEventIndex + (firstTail?.eventCount ?? 0),
    });
    throwIfAborted(signal);
    let eventIndex = first.nextEventIndex;
    let segmentIndex = first.nextSegmentIndex;
    let frozenSeq = firstSegments.length;
    let expectedTailHash = first.eof ? manifest.tailHash : null;
    while (eventIndex < manifest.frozenEventCount) {
      const batch = await this.readExternalFrozenBatch(
        manifest,
        eventIndex,
        segmentIndex,
        signal
      );
      const tail = batch.eof
        ? await this.readExternalTail(manifest, signal)
        : null;
      const segments = batch.segments.map((segment, index) => ({
        seq: frozenSeq + index + 1,
        payloadGz: segment.payloadGz,
        eventCount: segment.eventCount,
        segmentHash: segment.segmentHash,
      }));
      await this.client.appendSessionEventWires(auth.accessToken, {
        orgId,
        sessionId,
        expectedEpoch: epoch,
        expectedFrozenSeq: frozenSeq,
        expectedTailHash,
        newFrozenSegments: segments,
        tail,
        totalCount: batch.nextEventIndex + (tail?.eventCount ?? 0),
      });
      throwIfAborted(signal);
      eventIndex = batch.nextEventIndex;
      segmentIndex = batch.nextSegmentIndex;
      frozenSeq += segments.length;
      expectedTailHash = batch.eof ? manifest.tailHash : null;
    }
    throwIfAborted(signal);
    this.setExternalCursor(orgId, sessionId, manifest, epoch, frozenSeq);
    broadcastOrgControlChangedToPeers(orgId, "sessions");
  }

  private setExternalCursor(
    orgId: string,
    sessionId: string,
    manifest: ExternalReplayCloudManifest,
    epoch: number,
    frozenSeq: number
  ): void {
    this.setCursor({
      orgId,
      sessionId,
      epoch,
      frozenSeq,
      pushedCount: manifest.totalCount,
      frozenEventCount: manifest.frozenEventCount,
      frozenChainHash: manifest.frozenChainHash,
      tailHash: manifest.tailHash,
    });
  }

  /**
   * Seed the volatile cold-start caches from a server-authoritative listing.
   * For imported CLI sessions the local `updated_at` comes from the source
   * transcript and is part of the uploaded metadata. When that payload and
   * the persisted cursor both match the server summary, a restart does not
   * need to read/normalize/hash the entire transcript again.
   */
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
    if (localHash !== remoteHash) return;

    // upsertMetadataIfChanged gates on the FULL payload hash; seeding the
    // stripped comparison hash would never match it and every restart would
    // re-upsert an identical payload for every pushed session.
    this.lastPushedMetadataHashes.set(
      key,
      await sha256Hex(stableStringify(localMetadata))
    );
    this.setPushedMetadataMarker(orgId, session.session_id);
    if (!resolveExternalReplayTarget(session.session_id)) return;
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
    this.markEventPlaneClean(
      orgId,
      session,
      this.eventActivityStamps.get(session.session_id) ?? 0
    );
  }

  /** Soft-tombstone a prior push and clear every local pushed marker. */
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
    this.clearPushedMetadataMarker(orgId, sessionId);
    this.clearCursor(orgId, sessionId);
    broadcastOrgControlChangedToPeers(orgId, "sessions");
  }

  private async upsertMetadataIfChanged(
    auth: Org2CloudAuthState,
    orgId: string,
    session: Session,
    scopeKey: string | null,
    access: CloudPushAccess
  ): Promise<void> {
    const displayName =
      auth.profile?.displayName ?? auth.profile?.primaryEmail ?? auth.userId;
    const metadata = buildCloudSessionMetadata(
      session,
      orgId,
      auth.userId,
      displayName,
      scopeKey,
      access,
      auth.profile?.avatarUrl
    );
    const key = `${orgId}:${session.session_id}`;
    const hash = await sha256Hex(stableStringify(metadata));
    if (this.lastPushedMetadataHashes.get(key) === hash) return;
    await this.client.upsertSessionMetadata(
      auth.accessToken,
      orgId,
      session.session_id,
      metadata
    );
    this.lastPushedMetadataHashes.set(key, hash);
    this.setPushedMetadataMarker(orgId, session.session_id);
    broadcastOrgControlChangedToPeers(orgId, "sessions");
  }

  /** Native SDE path only; external/managed CLI sessions use Rust spools. */
  async loadPushEvents(sessionId: string): Promise<SessionEvent[]> {
    return eventStoreProxy.getPersistedEvents(sessionId);
  }

  private prepareExternalPushForPass(
    target: ExternalReplayTarget
  ): Promise<PreparedExternalPush> {
    const { sessionId } = target;
    const cached = this.passExternalPrepareCache.get(sessionId);
    if (cached) return cached;
    const prepared = (async (): Promise<PreparedExternalPush> => ({
      stampAtRead: this.eventActivityStamps.get(sessionId) ?? 0,
      manifest: await externalReplayCloudPrepareForTarget(target),
    }))();
    this.passExternalPrepareCache.set(sessionId, prepared);
    return prepared;
  }

  private preparePushEventsForPass(
    sessionId: string
  ): Promise<PreparedPushEvents> {
    const cached = this.passPushPrepareCache.get(sessionId);
    if (cached) return cached;
    const prepared = (async (): Promise<PreparedPushEvents> => {
      const stampAtRead = this.eventActivityStamps.get(sessionId) ?? 0;
      const events = await this.loadPushEvents(sessionId);
      let planPromise: Promise<PreparedPushPlan> | null = null;
      const plan = (): Promise<PreparedPushPlan> => {
        if (!planPromise) {
          planPromise = (async () => {
            const perEventHashes = await hashEventsBounded(events);
            const frozenEventCount = computeFrozenEventCount(events);
            const tailEvents = events.slice(frozenEventCount);
            const tailHash =
              tailEvents.length > 0
                ? await computeSegmentHash(tailEvents)
                : null;
            const frozenChainHash = await this.computeFrozenChainHash(
              perEventHashes,
              frozenEventCount
            );
            return {
              perEventHashes,
              frozenEventCount,
              tailEvents,
              tailHash,
              frozenChainHash,
            };
          })();
        }
        return planPromise;
      };
      return { stampAtRead, events, plan };
    })();
    this.passPushPrepareCache.set(sessionId, prepared);
    return prepared;
  }

  async pushSession(
    auth: Org2CloudAuthState,
    orgId: string,
    session: Session,
    scopeKey: string | null,
    access: CloudPushAccess,
    signal?: AbortSignal
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
      await this.pushSessionOnce(
        auth,
        orgId,
        session,
        scopeKey,
        access,
        signal
      );
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
    access: CloudPushAccess,
    signal?: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal);
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
      throwIfAborted(signal);
      return;
    }
    const primaryReplayTarget = resolveExternalReplayTarget(sessionId);
    const replayTarget =
      primaryReplayTarget ??
      (getSessionForkedFrom(session)
        ? await resolveSecondaryReplayTarget(sessionId)
        : null);
    if (replayTarget) {
      await this.pushExternalSession(
        auth,
        orgId,
        session,
        scopeKey,
        access,
        replayTarget,
        signal
      );
      return;
    }
    const { stampAtRead, events, plan } =
      await this.preparePushEventsForPass(sessionId);
    const cursor = this.getCursor(orgId, sessionId);
    if (!cursor && events.length === 0) {
      await this.upsertMetadataIfChanged(
        auth,
        orgId,
        session,
        scopeKey,
        access
      );
      this.markEventPlaneClean(orgId, session, stampAtRead);
      return;
    }
    if (cursor && events.length < cursor.pushedCount) {
      log.warn(
        `persisted read for ${sessionId} returned ${events.length} events ` +
          `but the cloud cursor covers ${cursor.pushedCount}; skipping`
      );
      return;
    }

    const {
      perEventHashes,
      frozenEventCount,
      tailEvents,
      tailHash,
      frozenChainHash,
    } = await plan();

    if (cursor) {
      let frozenIntact = frozenEventCount >= cursor.frozenEventCount;
      if (frozenIntact && cursor.frozenEventCount > 0) {
        const chainAtCursor =
          cursor.frozenEventCount === frozenEventCount
            ? frozenChainHash
            : await this.computeFrozenChainHash(
                perEventHashes,
                cursor.frozenEventCount
              );
        frozenIntact = chainAtCursor === cursor.frozenChainHash;
      }

      if (frozenIntact) {
        const newFrozenEvents = events.slice(
          cursor.frozenEventCount,
          frozenEventCount
        );
        if (
          newFrozenEvents.length === 0 &&
          tailHash === cursor.tailHash &&
          events.length === cursor.pushedCount
        ) {
          await this.upsertMetadataIfChanged(
            auth,
            orgId,
            session,
            scopeKey,
            access
          );
          this.markEventPlaneClean(orgId, session, stampAtRead);
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
              frozenEventCount,
              frozenChainHash,
              tailEvents,
              tailHash,
            }
          );
          broadcastOrgControlChangedToPeers(orgId, "sessions");
          this.markEventPlaneClean(orgId, session, stampAtRead);
          return;
        } catch (error) {
          if (!isOrg2SyncErrorCode(error, "ORG2_CONFLICT")) throw error;
          await this.rewriteSession(auth, orgId, session, scopeKey, access, {
            events,
            perEventHashes,
            frozenEventCount,
            frozenChainHash,
            tailEvents,
            tailHash,
            newEpoch: null,
          });
          this.markEventPlaneClean(orgId, session, stampAtRead);
          return;
        }
      }

      await this.rewriteSession(auth, orgId, session, scopeKey, access, {
        events,
        perEventHashes,
        frozenEventCount,
        frozenChainHash,
        tailEvents,
        tailHash,
        newEpoch: cursor.epoch + 1,
      });
      this.markEventPlaneClean(orgId, session, stampAtRead);
      return;
    }

    await this.rewriteSession(auth, orgId, session, scopeKey, access, {
      events,
      perEventHashes,
      frozenEventCount,
      frozenChainHash,
      tailEvents,
      tailHash,
      newEpoch: 1,
    });
    this.markEventPlaneClean(orgId, session, stampAtRead);
  }

  /**
   * Extend an established epoch in statement-timeout-safe batches. Every
   * acknowledged batch advances the durable cursor, so a transport failure or
   * app restart resumes after the last committed segment instead of reloading,
   * re-encoding, and re-uploading the complete transcript.
   */
  private async appendSessionBatches(
    auth: Org2CloudAuthState,
    orgId: string,
    sessionId: string,
    initialCursor: CollabSessionPushCursor,
    frozenSegments: ReturnType<typeof splitFrozenIntoSegments>,
    plan: {
      events: SessionEvent[];
      perEventHashes: string[];
      frozenEventCount: number;
      frozenChainHash: string;
      tailEvents: SessionEvent[];
      tailHash: string | null;
    }
  ): Promise<CollabSessionPushCursor> {
    let cursor = initialCursor;
    // An empty frozen delta still needs one append to replace the mutable tail
    // (or repair total_count), so model it as a single empty final batch.
    const batchCount = Math.max(
      1,
      Math.ceil(frozenSegments.length / SESSION_SEGMENT_UPLOAD_BATCH_SIZE)
    );
    for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
      const start = batchIndex * SESSION_SEGMENT_UPLOAD_BATCH_SIZE;
      const batch = frozenSegments.slice(
        start,
        start + SESSION_SEGMENT_UPLOAD_BATCH_SIZE
      );
      const finalBatch = batchIndex === batchCount - 1;
      const appendedEventCount = batch.reduce(
        (count, segment) => count + segment.events.length,
        0
      );
      const nextFrozenEventCount = cursor.frozenEventCount + appendedEventCount;
      const nextFrozenSeq = cursor.frozenSeq + batch.length;
      const nextChainHash =
        nextFrozenEventCount === plan.frozenEventCount
          ? plan.frozenChainHash
          : await this.computeFrozenChainHash(
              plan.perEventHashes,
              nextFrozenEventCount
            );
      const nextTail = finalBatch ? plan.tailEvents : [];
      const nextTailHash = finalBatch ? plan.tailHash : null;
      const nextPushedCount = finalBatch
        ? plan.events.length
        : nextFrozenEventCount;

      await this.client.appendSessionEvents(auth.accessToken, {
        orgId,
        sessionId,
        expectedEpoch: cursor.epoch,
        expectedFrozenSeq: cursor.frozenSeq,
        expectedTailHash: cursor.tailHash,
        newFrozenSegments: batch,
        tail: nextTail.length > 0 ? nextTail : null,
        totalCount: nextPushedCount,
      });
      cursor = {
        orgId,
        sessionId,
        epoch: cursor.epoch,
        frozenSeq: nextFrozenSeq,
        pushedCount: nextPushedCount,
        frozenEventCount: nextFrozenEventCount,
        frozenChainHash: nextChainHash,
        tailHash: nextTailHash,
      };
      this.setCursor(cursor);
    }
    return cursor;
  }

  /** Full epoch rewrite; conflicts re-anchor on the current server epoch once. */
  private async rewriteSession(
    auth: Org2CloudAuthState,
    orgId: string,
    session: Session,
    scopeKey: string | null,
    access: CloudPushAccess,
    plan: {
      events: SessionEvent[];
      perEventHashes: string[];
      frozenEventCount: number;
      frozenChainHash: string;
      tailEvents: SessionEvent[];
      tailHash: string | null;
      newEpoch: number | null;
    }
  ): Promise<void> {
    const sessionId = session.session_id;
    let epoch = plan.newEpoch;
    let reanchored = epoch === null;
    if (epoch === null) {
      epoch = (await this.readServerEpoch(auth, orgId, sessionId)) + 1;
    }
    await this.upsertMetadataIfChanged(auth, orgId, session, scopeKey, access);
    const frozenSegments = splitFrozenIntoSegments(
      plan.events.slice(0, plan.frozenEventCount),
      1
    );
    for (;;) {
      try {
        const progressive =
          frozenSegments.length > SESSION_SEGMENT_UPLOAD_BATCH_SIZE;
        const initialSegments = progressive
          ? frozenSegments.slice(0, SESSION_SEGMENT_UPLOAD_BATCH_SIZE)
          : frozenSegments;
        const initialFrozenEventCount = initialSegments.reduce(
          (count, segment) => count + segment.events.length,
          0
        );
        const initialChainHash =
          initialFrozenEventCount === plan.frozenEventCount
            ? plan.frozenChainHash
            : await this.computeFrozenChainHash(
                plan.perEventHashes,
                initialFrozenEventCount
              );
        await this.client.rewriteSessionEvents(auth.accessToken, {
          orgId,
          sessionId,
          newEpoch: epoch,
          frozenSegments: initialSegments,
          tail:
            !progressive && plan.tailEvents.length > 0 ? plan.tailEvents : null,
          totalCount: progressive
            ? initialFrozenEventCount
            : plan.events.length,
        });
        const cursor: CollabSessionPushCursor = {
          orgId,
          sessionId,
          epoch,
          frozenSeq: initialSegments.length,
          pushedCount: progressive
            ? initialFrozenEventCount
            : plan.events.length,
          frozenEventCount: initialFrozenEventCount,
          frozenChainHash: initialChainHash,
          tailHash: progressive ? null : plan.tailHash,
        };
        this.setCursor(cursor);
        if (progressive) {
          await this.appendSessionBatches(
            auth,
            orgId,
            sessionId,
            cursor,
            frozenSegments.slice(initialSegments.length),
            plan
          );
        }
        broadcastOrgControlChangedToPeers(orgId, "sessions");
        return;
      } catch (error) {
        if (!isOrg2SyncErrorCode(error, "ORG2_CONFLICT") || reanchored) {
          throw error;
        }
        reanchored = true;
        epoch = (await this.readServerEpoch(auth, orgId, sessionId)) + 1;
      }
    }
  }

  private async readServerEpoch(
    auth: Org2CloudAuthState,
    orgId: string,
    sessionId: string,
    signal?: AbortSignal
  ): Promise<number> {
    throwIfAborted(signal);
    const snapshot = await this.client.getSessionEvents(
      auth.accessToken,
      orgId,
      sessionId,
      {
        boundedWirePage: true,
        cursor: { direction: "backward" },
        includeTail: false,
        maxSegments: 1,
        maxWireBytes: HEAD_READ_MAX_WIRE_BYTES,
        ...(signal !== undefined ? { signal } : {}),
      }
    );
    throwIfAborted(signal);
    return snapshot.epoch ?? 0;
  }
}
