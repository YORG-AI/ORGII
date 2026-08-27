import { useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";

import { buildCloudSessionFetchClient } from "@src/features/Org2Cloud/org2CloudBackendAdapter";
import { importRemoteSession } from "@src/features/TeamCollaboration/engine/collabSessionImport";
import { createLogger } from "@src/hooks/logger";

import { commitRefreshedAuth, org2CloudAuthAtom } from "../org2CloudAuthAtom";
import { ensureFreshSession } from "../org2CloudClient";
import type { ConversationFamilyMember } from "./continuationEvents";

const log = createLogger("ConversationFamilyLoader");

/**
 * Keyed by org, session AND replay position — a member whose owner pushes
 * more events gets a fresh (incremental) import, so open conversations keep
 * following the family without re-downloading unchanged transcripts.
 */
const attemptedImports = new Set<string>();

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
      const key = `${row.orgId}:${bareSessionId}:${row.eventsEpoch}:${row.eventsCount}`;
      if (attemptedImports.has(key)) continue;
      attemptedImports.add(key);
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
          // Leave the attempt marker: a broken member should not retry in a
          // loop on every render. The next push (new epoch/count) re-keys.
          log.warn(
            `background family import failed for ${bareSessionId}`,
            error
          );
        }
      })();
    }
  }, [family, loadedBareSessionIds, anchorBareSessionId, auth, setAuth]);
}
