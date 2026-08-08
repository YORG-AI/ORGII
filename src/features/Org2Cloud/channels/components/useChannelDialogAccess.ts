/**
 * Shared plumbing for the org-channel dialogs (create / archive / delete /
 * manage members).
 *
 * Token acquisition follows the `useTeamRuntimeRoster` idiom —
 * `ensureFreshSession` + `commitRefreshedAuth` against the latest auth held in
 * a ref, so token-refresh writes never retrigger a caller's effects. The org
 * roster read reuses the app-wide `loadCloudOrgMembers` coordinator (the same
 * source the comments composer uses for mentionable members) rather than
 * introducing a new fetch; results are identity- and roster-version-keyed so
 * an account switch can never leak one org's roster into another's dialog.
 */
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "../../org2CloudAuthAtom";
import type { CloudOrgMember } from "../../org2CloudClient";
import { ensureFreshSession } from "../../org2CloudClient";
import { loadCloudOrgMembers } from "../../org2CloudMembersCoordinator";
import { org2CloudRosterVersionAtom } from "../../org2CloudOrgsAtom";

/**
 * Fresh access token for channel RPCs (`useOrgChannels.getFreshAccessToken`
 * shape). Throws when signed out or when the session cannot be refreshed —
 * callers surface that as their generic inline error.
 */
export function useFreshChannelAccessToken(): () => Promise<string> {
  const auth = useAtomValue(org2CloudAuthAtom);
  const setAuth = useSetAtom(org2CloudAuthAtom);

  // Latest auth via ref (panel idiom): token-refresh writes must not
  // invalidate the returned callback.
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  return useCallback(async (): Promise<string> => {
    const current = authRef.current;
    if (!current) throw new Error("signed out");
    const fresh = await ensureFreshSession(current);
    if (!fresh) throw new Error("cloud session refresh failed");
    commitRefreshedAuth(setAuth, current, fresh);
    return fresh.accessToken;
  }, [setAuth]);
}

export interface ActiveOrgMembersState {
  /** Active org members; empty while disabled, loading, or on failure. */
  members: readonly CloudOrgMember[];
  loading: boolean;
}

const NO_MEMBERS: readonly CloudOrgMember[] = [];

/**
 * Active org roster for the member pickers, via the shared coordinator
 * (modeled on `useSessionCommentMentionableMembers`). `enabled` gates the
 * read so the create dialog only fetches once the private picker is shown.
 */
export function useActiveOrgMembers(
  orgId: string | null,
  enabled: boolean
): ActiveOrgMembersState {
  const store = useStore();
  const auth = useAtomValue(org2CloudAuthAtom);
  const setAuth = useSetAtom(org2CloudAuthAtom);
  const rosterVersions = useAtomValue(org2CloudRosterVersionAtom);
  const identityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const rosterVersion = orgId ? (rosterVersions[orgId] ?? 0) : 0;
  const requestKey =
    enabled && identityKey && orgId
      ? `${identityKey}|${orgId}|${rosterVersion}`
      : null;
  const [resolved, setResolved] = useState<{
    key: string;
    members: CloudOrgMember[];
  } | null>(null);

  useEffect(() => {
    if (!auth || !identityKey || !orgId || !requestKey) return;
    let cancelled = false;
    const requestAuth = auth;
    void loadCloudOrgMembers(store, requestAuth, orgId, rosterVersion)
      .then((loaded) => {
        if (!loaded || cancelled) return;
        commitRefreshedAuth(setAuth, requestAuth, loaded.auth);
        // Late identity/version responses are discarded (coordinator idiom).
        const latestAuth = store.get(org2CloudAuthAtom);
        if (
          !latestAuth ||
          org2CloudAuthIdentityKey(latestAuth) !== identityKey ||
          (store.get(org2CloudRosterVersionAtom)[orgId] ?? 0) > rosterVersion
        ) {
          return;
        }
        setResolved({
          key: requestKey,
          members: loaded.members.filter(
            (member) => member.status === "active"
          ),
        });
      })
      .catch(() => {
        if (!cancelled) setResolved({ key: requestKey, members: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [auth, identityKey, orgId, requestKey, rosterVersion, setAuth, store]);

  if (!requestKey) return { members: NO_MEMBERS, loading: false };
  if (resolved?.key === requestKey) {
    return { members: resolved.members, loading: false };
  }
  return { members: NO_MEMBERS, loading: true };
}
