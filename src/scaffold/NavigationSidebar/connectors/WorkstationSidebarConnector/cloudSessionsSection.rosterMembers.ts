/**
 * Cloud org roster loading for the Team Sessions member filter
 * (`cloudSessionsSection.tsx`). Fetches/caches the org's member list via
 * `loadCloudOrgMembers` and exposes it only once it matches the current
 * auth identity + org, so a stale roster from a just-abandoned org/account
 * never flashes into the filter dropdown.
 */
import { useAtomValue, useStore } from "jotai";
import React, { useEffect, useState } from "react";

import {
  type Org2CloudAuthState,
  commitRefreshedAuth,
  org2CloudAuthIdentityKey,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { type CloudOrgMember } from "@src/features/Org2Cloud/org2CloudClient";
import { loadCloudOrgMembers } from "@src/features/Org2Cloud/org2CloudMembersCoordinator";
import { org2CloudRosterVersionAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";

interface UseCloudOrgRosterMembersParams {
  orgId: string | null;
  auth: Org2CloudAuthState | null;
  setAuth: Parameters<typeof commitRefreshedAuth>[0];
  store: ReturnType<typeof useStore>;
}

export function useCloudOrgRosterMembers({
  orgId,
  auth,
  setAuth,
  store,
}: UseCloudOrgRosterMembersParams): CloudOrgMember[] | null {
  const authIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const rosterVersionByOrg = useAtomValue(org2CloudRosterVersionAtom);
  const rosterVersion = orgId ? (rosterVersionByOrg[orgId] ?? 0) : 0;
  const [rosterSnapshot, setRosterSnapshot] = useState<{
    identityKey: string;
    orgId: string;
    members: CloudOrgMember[];
  } | null>(null);
  const signedIn = Boolean(auth);
  const rosterMembers =
    signedIn &&
    rosterSnapshot?.identityKey === authIdentityKey &&
    rosterSnapshot.orgId === orgId
      ? rosterSnapshot.members
      : null;
  const authRef = React.useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);
  useEffect(() => {
    if (!orgId || !signedIn) return;
    let cancelled = false;
    void (async () => {
      const current = authRef.current;
      if (!current) return;
      const requestIdentityKey = org2CloudAuthIdentityKey(current);
      const loaded = await loadCloudOrgMembers(
        store,
        current,
        orgId,
        rosterVersion
      );
      if (!loaded || cancelled) return;
      const latest = authRef.current;
      if (!latest || org2CloudAuthIdentityKey(latest) !== requestIdentityKey) {
        return;
      }
      commitRefreshedAuth(setAuth, current, loaded.auth);
      setRosterSnapshot({
        identityKey: requestIdentityKey,
        orgId,
        members: loaded.members,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [authIdentityKey, orgId, rosterVersion, setAuth, signedIn, store]);

  return rosterMembers;
}
