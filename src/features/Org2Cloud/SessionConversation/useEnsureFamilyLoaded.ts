import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef, useState } from "react";

import { buildCloudSessionFetchClient } from "@src/features/Org2Cloud/org2CloudBackendAdapter";
import { importRemoteSession } from "@src/features/TeamCollaboration/engine/collabSessionImport";
import { createLogger } from "@src/hooks/logger";
import { BoundedMap } from "@src/util/collections/BoundedMap";

import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "../org2CloudAuthAtom";
import { ensureFreshSession } from "../org2CloudClient";
import type { ConversationFamilyMember } from "./continuationEvents";
import { conversationPlaneSignalAtom } from "./conversationPlaneAtom";

const log = createLogger("ConversationFamilyLoader");
const MAX_FAMILY_IMPORT_CONCURRENCY = 4;

/**
 * Last import position attempted per family member, keyed by org + session.
 *
 * The value is the member's replay position (`epoch:count`): a member whose
 * owner pushes more events no longer matches, so it gets a fresh (incremental)
 * import and open conversations keep following the family without
 * re-downloading unchanged transcripts.
 *
 * This used to be a `Set` keyed by org + session + position, which meant every
 * push by every member added a permanent entry — the set grew for the lifetime
 * of the process, in step with how active the org was. Keying by member and
 * holding the position as the value makes it one entry per member instead of
 * one per push, and the cap bounds the number of distinct members.
 */
const MAX_TRACKED_FAMILY_MEMBERS = 256;

const attemptedImportPositions = new BoundedMap<string, string>({
  maxSize: MAX_TRACKED_FAMILY_MEMBERS,
  name: "ConversationFamilyLoader.attemptedImports",
});

/**
 * Silently import family members the viewer has no local copy of, so their
 * segments stream into the conversation like any other message — no
 * placeholder divider, no manual replay click. The import engine dedups
 * concurrent calls per session, upserts the local row itself, and streams
 * incrementally when a cursor exists, so this stays cheap on refreshes.
 */
export function useEnsureFamilyLoaded(
  family: readonly ConversationFamilyMember[] | null,
  loadedBareSessionIds: ReadonlySet<string>,
  anchorBareSessionId: string
): void {
  const auth = useAtomValue(org2CloudAuthAtom);
  const setAuth = useSetAtom(org2CloudAuthAtom);
  const authIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const conversationPlaneSignals = useAtomValue(conversationPlaneSignalAtom);
  const familyOrgId = family?.[0]?.row.orgId ?? null;
  const recoverySignal = familyOrgId
    ? (conversationPlaneSignals[familyOrgId] ?? 0)
    : 0;
  const failedImportRef = useRef(false);
  const previousRecoverySignalRef = useRef({
    orgId: familyOrgId,
    value: recoverySignal,
  });
  const [failedImportRetryVersion, setFailedImportRetryVersion] = useState(0);

  // A background failure must remain retryable, but retry only at an
  // invalidation owned by the app-wide Cloud realtime boundary. Its global
  // foreground recovery already bumps the same per-org signal, so transcript
  // surfaces must not install their own browser listeners. `importRemoteSession`
  // owns the actual per-source serialization and durable cursor/no-op decision.
  useEffect(() => {
    const previous = previousRecoverySignalRef.current;
    previousRecoverySignalRef.current = {
      orgId: familyOrgId,
      value: recoverySignal,
    };
    if (
      !failedImportRef.current ||
      !familyOrgId ||
      previous.orgId !== familyOrgId ||
      previous.value === recoverySignal
    ) {
      return;
    }
    failedImportRef.current = false;
    setFailedImportRetryVersion((version) => version + 1);
  }, [familyOrgId, recoverySignal]);

  useEffect(() => {
    const requestAuth = auth;
    if (!family || !requestAuth || !authIdentityKey) return;
    const pending = family.filter((member) => {
      const bareSessionId = member.bareSessionId;
      const row = member.row;
      if (
        !(
          bareSessionId !== anchorBareSessionId &&
          !loadedBareSessionIds.has(bareSessionId) &&
          !row.deletedAt &&
          row.eventsEpoch !== undefined &&
          Boolean(row.eventsCount) &&
          row.id !== `local-${bareSessionId}`
        )
      ) {
        return false;
      }
      const memberKey = `${authIdentityKey}:${row.orgId}:${bareSessionId}`;
      const position = `${row.eventsEpoch}:${row.eventsCount}`;
      return attemptedImportPositions.get(memberKey) !== position;
    });
    let cancelled = false;
    let cursor = 0;
    const activeClaims = new Map<string, string>();
    const releaseClaim = (memberKey: string, position: string) => {
      // Cleanup may already have released this worker's claim and a newer
      // effect may since have claimed the same position. A late completion
      // from the cancelled worker must not delete that newer claim.
      if (activeClaims.get(memberKey) !== position) return;
      activeClaims.delete(memberKey);
      if (attemptedImportPositions.peek(memberKey) === position) {
        attemptedImportPositions.delete(memberKey);
      }
    };
    const worker = async () => {
      for (;;) {
        if (cancelled) return;
        const member = pending[cursor];
        cursor += 1;
        if (!member) return;
        const bareSessionId = member.bareSessionId;
        const row = member.row;
        const memberKey = `${authIdentityKey}:${row.orgId}:${bareSessionId}`;
        const position = `${row.eventsEpoch}:${row.eventsCount}`;
        // Claim only work this worker is about to execute. Claiming the full
        // filtered batch up front strands entries beyond the worker limit if
        // the active workers stop early (for example, on auth refresh failure).
        if (attemptedImportPositions.peek(memberKey) === position) continue;
        attemptedImportPositions.set(memberKey, position);
        activeClaims.set(memberKey, position);
        try {
          const fresh = await ensureFreshSession(requestAuth);
          if (!fresh) {
            releaseClaim(memberKey, position);
            failedImportRef.current = true;
            return;
          }
          if (
            cancelled ||
            org2CloudAuthIdentityKey(fresh) !== authIdentityKey
          ) {
            releaseClaim(memberKey, position);
            return;
          }
          commitRefreshedAuth(setAuth, requestAuth, fresh);
          await importRemoteSession({
            client: buildCloudSessionFetchClient(fresh.accessToken),
            orgId: row.orgId,
            remoteSession: row,
            sourceEndpointUrl: requestAuth.supabaseUrl,
          });
          if (cancelled) {
            releaseClaim(memberKey, position);
            return;
          }
          // A successful position remains in attemptedImportPositions; it is
          // the no-op guard until the owner's replay position advances.
          activeClaims.delete(memberKey);
        } catch (error) {
          releaseClaim(memberKey, position);
          failedImportRef.current = true;
          log.warn(
            `background family import failed for ${bareSessionId}`,
            error
          );
        }
      }
    };
    void Promise.all(
      Array.from(
        { length: Math.min(MAX_FAMILY_IMPORT_CONCURRENCY, pending.length) },
        worker
      )
    );
    return () => {
      cancelled = true;
      for (const [memberKey, position] of activeClaims) {
        releaseClaim(memberKey, position);
      }
    };
  }, [
    family,
    loadedBareSessionIds,
    anchorBareSessionId,
    auth,
    authIdentityKey,
    failedImportRetryVersion,
    setAuth,
  ]);
}
