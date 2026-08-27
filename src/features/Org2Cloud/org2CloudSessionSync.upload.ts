/**
 * Write half of the session push plane: the metadata upsert plus the three
 * segment mutations (bounded imported append, batched delta append, full
 * epoch rewrite) and the server-epoch head read they re-anchor on.
 *
 * Fourth link of the Org2CloudSessionSync inheritance chain; the orchestration
 * that decides WHICH of these runs lives in Org2CloudSessionSync itself.
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { Session } from "@src/store/session/sessionAtom/types";

import {
  sha256Hex,
  stableStringify,
} from "../TeamCollaboration/collabSyncUtils";
import { splitFrozenIntoSegments } from "../TeamCollaboration/engine/collabSyncEngineHelpers";
import type { CloudPushAccess } from "./org2CloudAccessSettings";
import type { Org2CloudAuthState } from "./org2CloudAuthAtom";
import { broadcastOrgControlChangedToPeers } from "./org2CloudControlBus";
import { buildCloudSessionMetadata } from "./org2CloudSessionSync.metadata";
import { IMPORTED_INCREMENTAL_SEGMENT_LIMIT } from "./org2CloudSessionSync.pushEvents";
import { Org2CloudSessionSyncTurnIndex } from "./org2CloudSessionSync.turnIndex";
import type { PreparedPushPlan } from "./org2CloudSessionSync.types";
import type { CollabSessionPushCursor } from "./org2CloudSyncAtoms";
import { isOrg2SyncErrorCode } from "./org2CloudSyncClient";

/** Largest cursor accepted by the backend's int4 `p_after_seq` argument. */
const HEAD_READ_AFTER_SEQ = 2_147_483_647;

/**
 * Keep every segment mutation comfortably below PostgREST / PostgreSQL
 * statement-timeout and renderer-RSS cliffs. Each frozen segment is bounded
 * to 256 KiB before gzip, so a batch carries at most ~4 MiB of canonical
 * input and the client codec only materializes one batch of wire payloads.
 */
export const SESSION_SEGMENT_UPLOAD_BATCH_SIZE = 16;

export class Org2CloudSessionSyncUpload extends Org2CloudSessionSyncTurnIndex {
  protected async upsertMetadataIfChanged(
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

  /**
   * One bounded append for a validated imported-history suffix. Large deltas
   * never enter this path: preparation falls back to the authoritative full
   * planner before any network mutation.
   */
  protected async appendIncrementalSession(
    auth: Org2CloudAuthState,
    orgId: string,
    sessionId: string,
    cursor: CollabSessionPushCursor,
    newFrozenEvents: SessionEvent[],
    plan: PreparedPushPlan
  ): Promise<void> {
    const frozenSegments = splitFrozenIntoSegments(
      newFrozenEvents,
      cursor.frozenSeq + 1
    );
    if (frozenSegments.length > IMPORTED_INCREMENTAL_SEGMENT_LIMIT) {
      throw new Error("Incremental imported replay exceeded its segment bound");
    }
    await this.client.appendSessionEvents(auth.accessToken, {
      orgId,
      sessionId,
      expectedEpoch: cursor.epoch,
      expectedFrozenSeq: cursor.frozenSeq,
      expectedTailHash: cursor.tailHash,
      newFrozenSegments: frozenSegments,
      tail: plan.tailEvents.length > 0 ? plan.tailEvents : null,
      totalCount: plan.totalEventCount,
    });
    this.setCursor({
      orgId,
      sessionId,
      epoch: cursor.epoch,
      frozenSeq: cursor.frozenSeq + frozenSegments.length,
      pushedCount: plan.totalEventCount,
      frozenEventCount: plan.frozenEventCount,
      frozenChainHash: plan.frozenChainHash,
      tailHash: plan.tailHash,
      ...(plan.importedReplay ? { importedReplay: plan.importedReplay } : {}),
    });
  }

  /**
   * Extend an established epoch in statement-timeout-safe batches. Every
   * acknowledged batch advances the durable cursor, so a transport failure or
   * app restart resumes after the last committed segment instead of reloading,
   * re-encoding, and re-uploading the complete transcript.
   */
  protected async appendSessionBatches(
    auth: Org2CloudAuthState,
    orgId: string,
    sessionId: string,
    initialCursor: CollabSessionPushCursor,
    frozenSegments: ReturnType<typeof splitFrozenIntoSegments>,
    plan: PreparedPushPlan & { events: SessionEvent[] }
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
          : await this.computeFrozenHashAtCount(
              plan.perEventHashes,
              nextFrozenEventCount,
              plan.frozenHashMode
            );
      const nextTail = finalBatch ? plan.tailEvents : [];
      const nextTailHash = finalBatch ? plan.tailHash : null;
      const nextPushedCount = finalBatch
        ? plan.totalEventCount
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
        ...(finalBatch && plan.importedReplay
          ? { importedReplay: plan.importedReplay }
          : {}),
      };
      this.setCursor(cursor);
    }
    return cursor;
  }

  /** Full epoch rewrite; conflicts re-anchor on the current server epoch once. */
  protected async rewriteSession(
    auth: Org2CloudAuthState,
    orgId: string,
    session: Session,
    scopeKey: string | null,
    access: CloudPushAccess,
    plan: PreparedPushPlan & {
      events: SessionEvent[];
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
            : await this.computeFrozenHashAtCount(
                plan.perEventHashes,
                initialFrozenEventCount,
                plan.frozenHashMode
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
            : plan.totalEventCount,
        });
        const cursor: CollabSessionPushCursor = {
          orgId,
          sessionId,
          epoch,
          frozenSeq: initialSegments.length,
          pushedCount: progressive
            ? initialFrozenEventCount
            : plan.totalEventCount,
          frozenEventCount: initialFrozenEventCount,
          frozenChainHash: initialChainHash,
          tailHash: progressive ? null : plan.tailHash,
          ...(!progressive && plan.importedReplay
            ? { importedReplay: plan.importedReplay }
            : {}),
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
    sessionId: string
  ): Promise<number> {
    const snapshot = await this.client.getSessionEvents(
      auth.accessToken,
      orgId,
      sessionId,
      { afterSeq: HEAD_READ_AFTER_SEQ }
    );
    return snapshot.epoch ?? 0;
  }
}
