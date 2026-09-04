import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  type Org2CloudOrg,
  org2CloudOrgsAtom,
  org2CloudOrgsLoadStateAtom,
  org2CloudOrgsLoadedAtom,
  useRefetchOrg2CloudOrgs,
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

export interface WebSessionRosterState {
  status: "idle" | "loading" | "loaded" | "error";
  sessions: WebSessionListItem[];
  sessionFetchStateByOrg: Record<string, CloudRemoteSessionsFetchState>;
  error: string | null;
  failedOrganizationCount: number;
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
    return {
      status: "idle",
      sessions: [],
      sessionFetchStateByOrg: {},
      error: null,
      failedOrganizationCount: 0,
    };
  }

  const states: CloudRemoteSessionsFetchState[] = [];
  const sessionFetchStateByOrg: Record<string, CloudRemoteSessionsFetchState> =
    {};
  const sessions = orgs.flatMap((org) => {
    const entry = remoteSessionsEntryForIdentity(
      entries[org.orgId],
      identityKey
    );
    const state = entry?.state ?? "idle";
    states.push(state);
    sessionFetchStateByOrg[org.orgId] = state;
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
    sessionFetchStateByOrg,
    error: null,
    failedOrganizationCount: errorCount,
  };
}

export function useWebSessionRoster(): WebSessionRosterState & {
  organizationStatus: "idle" | "loading" | "retrying" | "ready" | "error";
  organizationsKnown: boolean;
  hasOrganizations: boolean;
  refresh: () => Promise<void>;
} {
  const { t } = useTranslation("navigation");
  const auth = useAtomValue(org2CloudAuthAtom);
  const orgs = useAtomValue(org2CloudOrgsAtom);
  const orgsLoaded = useAtomValue(org2CloudOrgsLoadedAtom);
  const organizationLoadState = useAtomValue(org2CloudOrgsLoadStateAtom);
  const entries = useAtomValue(org2CloudRemoteSessionsAtom);
  const setVersionByOrg = useSetAtom(org2CloudRemoteSessionsVersionAtom);
  const refetchOrgs = useRefetchOrg2CloudOrgs();
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

  const refresh = useCallback(async (): Promise<void> => {
    if (!identityKey) return;

    let refreshOrgs = orgs;
    if (!orgsLoaded || organizationLoadState === "error") {
      refreshOrgs = await refetchOrgs();
    }
    if (refreshOrgs.length === 0) return;

    setVersionByOrg((current) =>
      refreshOrgs.reduce(
        (next, org) =>
          bumpRemoteSessionsInvalidation(next, org.orgId, { full: true }),
        current
      )
    );
  }, [
    identityKey,
    organizationLoadState,
    orgs,
    orgsLoaded,
    refetchOrgs,
    setVersionByOrg,
  ]);

  return useMemo(() => {
    if (!identityKey) {
      return {
        status: "idle" as const,
        sessions: [],
        sessionFetchStateByOrg: {},
        error: null,
        failedOrganizationCount: 0,
        organizationStatus: "idle" as const,
        organizationsKnown: false,
        hasOrganizations: false,
        refresh,
      };
    }
    if (!orgsLoaded) {
      const terminalFailure = organizationLoadState === "error";
      return {
        status: terminalFailure ? ("error" as const) : ("loading" as const),
        sessions: [],
        sessionFetchStateByOrg: {},
        error: terminalFailure
          ? t("web.sessionsPage.organizationLoadErrorHint")
          : organizationLoadState === "retrying"
            ? t("web.sessionsPage.organizationRetryingHint")
            : null,
        failedOrganizationCount: 0,
        organizationStatus:
          organizationLoadState === "idle"
            ? ("loading" as const)
            : organizationLoadState,
        organizationsKnown: false,
        hasOrganizations: false,
        refresh,
      };
    }

    const rosterRefreshError =
      aggregated.failedOrganizationCount > 0
        ? t("web.sessionsPage.sessionRefreshErrorHint")
        : null;
    const organizationRefreshError =
      organizationLoadState === "error"
        ? t("web.sessionsPage.organizationRefreshErrorHint")
        : null;

    return {
      ...aggregated,
      error: organizationRefreshError ?? rosterRefreshError,
      organizationStatus: organizationLoadState,
      organizationsKnown: true,
      hasOrganizations: orgs.length > 0,
      refresh,
    };
  }, [
    aggregated,
    identityKey,
    organizationLoadState,
    orgs.length,
    orgsLoaded,
    refresh,
    t,
  ]);
}
