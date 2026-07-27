/**
 * Thin React shell for `Org2CloudSyncEngine`, keyed to the signed-in cloud
 * identity. Deliberately NOT stopped on unmount (the engine outlives React
 * tree churn; mounted once in the router root next to `useOrg2CloudOrgs`),
 * but it IS restarted across identity boundaries:
 *
 *  - signed out → engine stopped: no cloud event listeners remain and every
 *    per-identity Map (session push hashes,
 *    activity stamps, hydrate/backoff/full-listing memory) is cleared.
 *  - account/endpoint switch → stop + start: the fresh start's first pass
 *    re-lists collab state under the new identity instead of trusting
 *    another account's in-memory cursors for the same org ids.
 */
import { useAtomValue } from "jotai";
import { useEffect } from "react";

import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "./org2CloudAuthAtom";
import {
  org2CloudOrgsAtom,
  org2CloudOrgsLoadedAtom,
} from "./org2CloudOrgsAtom";
import { org2CloudSyncEngine } from "./org2CloudSyncEngine";

export function useOrg2CloudSyncEngine(): void {
  const auth = useAtomValue(org2CloudAuthAtom);
  const authIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const orgs = useAtomValue(org2CloudOrgsAtom);
  const orgsLoaded = useAtomValue(org2CloudOrgsLoadedAtom);
  const rosterKey = JSON.stringify(
    orgs
      .map(({ orgId, role, name }) => ({ orgId, role, name }))
      .sort((left, right) => left.orgId.localeCompare(right.orgId))
  );

  useEffect(() => {
    // stop() is idempotent and also covers the A→B switch (no null between):
    // the old identity's engine state must never survive into the new one.
    org2CloudSyncEngine.stop();
    if (authIdentityKey) {
      org2CloudSyncEngine.start(getInstrumentedStore());
    }
    return undefined;
  }, [authIdentityKey]);

  useEffect(() => {
    if (!authIdentityKey || !orgsLoaded) return;
    org2CloudSyncEngine.reconcileRoster();
  }, [authIdentityKey, orgsLoaded, rosterKey]);
}
