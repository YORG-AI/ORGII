import { useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";

import { buildCloudSessionFetchClient } from "@src/features/Org2Cloud/org2CloudBackendAdapter";
import { importRemoteSession } from "@src/features/TeamCollaboration/engine/collabSessionImport";
import { createLogger } from "@src/hooks/logger";
import { BoundedMap } from "@src/util/collections/BoundedMap";

import { commitRefreshedAuth, org2CloudAuthAtom } from "../org2CloudAuthAtom";
import { ensureFreshSession } from "../org2CloudClient";
import type { ConversationFamilyMember } from "./continuationEvents";

const log = createLogger("ConversationFamilyLoader");

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

  useEffect(() => {
    if (!family || !auth) return;
    for (const member of family) {
      const bareSessionId = member.bareSessionId;
      if (
        bareSessionId === anchorBareSessionId ||
        loadedBareSessionIds.has(bareSessionId)
      ) {
        continue;
      }
      const row = member.row;
      // Nothing fetchable: tombstoned, metadata-only (no events pushed), or
      // the synthesized pseudo-row a fresh local fork gets before its push.
      if (row.deletedAt || row.eventsEpoch === undefined || !row.eventsCount) {
        continue;
      }
      if (row.id === `local-${bareSessionId}`) continue;
      const memberKey = `${row.orgId}:${bareSessionId}`;
      const position = `${row.eventsEpoch}:${row.eventsCount}`;
      // `get` rather than `peek`: re-checking a member is what keeps it warm,
      // so an actively followed conversation should not be the eviction victim.
      if (attemptedImportPositions.get(memberKey) === position) continue;
      attemptedImportPositions.set(memberKey, position);
      void (async () => {
        try {
          const fresh = await ensureFreshSession(auth);
          if (!fresh) return;
          commitRefreshedAuth(setAuth, auth, fresh);
          await importRemoteSession({
            client: buildCloudSessionFetchClient(fresh.accessToken),
            orgId: row.orgId,
            remoteSession: row,
            sourceEndpointUrl: auth.supabaseUrl,
          });
        } catch (error) {
          // Leave the recorded position: a broken member should not retry in
          // a loop on every render. The next push (new epoch/count) no longer
          // matches the stored value, so it is retried then.
          log.warn(
            `background family import failed for ${bareSessionId}`,
            error
          );
        }
      })();
    }
  }, [family, loadedBareSessionIds, anchorBareSessionId, auth, setAuth]);
}
