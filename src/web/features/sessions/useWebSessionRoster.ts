import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";

import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  type Org2CloudOrg,
  org2CloudOrgsAtom,
  org2CloudOrgsLoadedAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import {
  type CloudOrgRemoteSessionsEntry,
  type CloudRemoteSessionsFetchState,
  bumpRemoteSessionsInvalidation,
  org2CloudRemoteSessionsAtom,
  org2CloudRemoteSessionsVersionAtom,
  remoteSessionsEntryForIdentity,
} from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

export interface WebSessionListItem extends RemoteTeammateSessionMetadata {
  orgName: string;
  writable: boolean;
}

interface WebSessionRosterState {
  status: "idle" | "loading" | "loaded" | "error";
  sessions: WebSessionListItem[];
  error: string | null;
}

function sessionTimestamp(session: WebSessionListItem): number {
  const value = session.lastActivityAt;
  return value ? Date.parse(value) || 0 : 0;
}

function toSessionRows(
  org: Org2CloudOrg,
  userId: string,
  sessions: RemoteTeammateSessionMetadata[]
): WebSessionListItem[] {
  return sessions
    .filter((session) => !session.deletedAt)
    .map((session) => ({
      ...session,
      orgName: org.name,
      writable: session.ownerUserId === userId,
    }));
}

export function aggregateWebSessionRoster({
  orgs,
  entries,
  identityKey,
  userId,
}: {
  orgs: readonly Org2CloudOrg[];
  entries: Record<string, CloudOrgRemoteSessionsEntry>;
  identityKey: string | null;
  userId: string | null;
}): WebSessionRosterState {
  if (!identityKey || !userId) {
    return { status: "idle", sessions: [], error: null };
  }

  const states: CloudRemoteSessionsFetchState[] = [];
  const sessions = orgs.flatMap((org) => {
    const entry = remoteSessionsEntryForIdentity(
      entries[org.orgId],
      identityKey
    );
    states.push(entry?.state ?? "idle");
    return toSessionRows(org, userId, entry?.rows ?? []);
  });

  sessions.sort(
    (left, right) => sessionTimestamp(right) - sessionTimestamp(left)
  );

  const loadingCount = states.filter((state) => state === "loading").length;
  const errorCount = states.filter((state) => state === "error").length;
  const readyCount = states.filter((state) => state === "ready").length;
  const idleCount = states.filter(
    (state) => state === "idle" || state === undefined
  ).length;

  let status: WebSessionRosterState["status"] = "loaded";
  if (orgs.length === 0) {
    status = "loaded";
  } else if (sessions.length === 0 && loadingCount > 0) {
    status = "loading";
  } else if (sessions.length === 0 && errorCount === orgs.length) {
    status = "error";
  } else if (readyCount === 0 && idleCount === orgs.length) {
    status = "loading";
  }

  return {
    status,
    sessions,
    error:
      errorCount > 0
        ? `${errorCount} organization${errorCount === 1 ? "" : "s"} could not be refreshed.`
        : null,
  };
}

export function useWebSessionRoster(): WebSessionRosterState & {
  refresh: () => Promise<void>;
} {
  const auth = useAtomValue(org2CloudAuthAtom);
  const orgs = useAtomValue(org2CloudOrgsAtom);
  const orgsLoaded = useAtomValue(org2CloudOrgsLoadedAtom);
  const entries = useAtomValue(org2CloudRemoteSessionsAtom);
  const setVersionByOrg = useSetAtom(org2CloudRemoteSessionsVersionAtom);
  const identityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const userId = auth?.userId ?? null;

  const aggregated = useMemo(
    () =>
      aggregateWebSessionRoster({
        orgs,
        entries,
        identityKey,
        userId,
      }),
    [entries, identityKey, orgs, userId]
  );

  const refresh = useCallback((): Promise<void> => {
    if (!identityKey || orgs.length === 0) return Promise.resolve();
    setVersionByOrg((current) =>
      orgs.reduce(
        (next, org) =>
          bumpRemoteSessionsInvalidation(next, org.orgId, { full: true }),
        current
      )
    );
    return Promise.resolve();
  }, [identityKey, orgs, setVersionByOrg]);

  return useMemo(() => {
    if (!identityKey) {
      return { status: "idle" as const, sessions: [], error: null, refresh };
    }
    if (!orgsLoaded) {
      return { status: "loading" as const, sessions: [], error: null, refresh };
    }
    return { ...aggregated, refresh };
  }, [aggregated, identityKey, orgsLoaded, refresh]);
}
