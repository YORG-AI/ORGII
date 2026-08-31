/**
 * Per-surface open/close state + eligibility gate for the cloud
 * SessionShareDialog, mirroring `useCloudSyncLevelDialog` /
 * `useSessionShareDialog`: signed into ORG2 Cloud, the session is the
 * owner's own pushable session, and it belongs to ≥1 cloud org (repo-scope
 * matched via any of the checkout's remotes — see
 * `getCloudShareOrgsForSession`).
 */
import { useAtomValue, useStore } from "jotai";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

import { persistedScopeKeysForImportedSession } from "@src/features/TeamCollaboration/importedSessionScopeMatch";
import {
  getShareableScopeKeyVersion,
  peekShareableScopeKeys,
  primeShareableScopeKey,
  subscribeShareableScopeKeys,
} from "@src/features/TeamCollaboration/repoScopeResolver";
import { sessionOrgTagsAtom } from "@src/features/TeamCollaboration/sessionOrgTagsAtom";
import type { Session } from "@src/store/session/sessionAtom/types";

import { org2CloudAuthAtom } from "../org2CloudAuthAtom";
import {
  type Org2CloudOrg,
  org2CloudOrgsAtom,
  sidebarActiveCloudOrgIdAtom,
} from "../org2CloudOrgsAtom";
import { org2CloudRepoScopesAtom } from "../org2CloudSyncAtoms";
import { isCloudPushCandidate } from "../org2CloudSyncEngine";
import { getActiveCloudShareOrgsForSession } from "./shareEligibility";

/**
 * Resolved scope keys for one session, backed by the module-level resolver
 * cache the sync engine also feeds (same idiom as useSessionShareDialog:
 * `undefined` = still resolving → not eligible yet; the subscription
 * re-renders the consumer when the keys land).
 */
function getSessionScopeKeys(session: Session): string[] | null | undefined {
  const persistedKeys = persistedScopeKeysForImportedSession(session);
  if (persistedKeys !== undefined) return persistedKeys;
  if (!session.repoPath) return null;
  const keys = peekShareableScopeKeys(session.repoPath);
  if (keys === undefined) primeShareableScopeKey(session.repoPath);
  return keys;
}

export interface UseCloudSessionShareDialogResult {
  /** Session the dialog is open for; null = closed. */
  cloudShareSession: Session | null;
  /** Share-capable cloud orgs for the open session (dialog sections). */
  cloudShareOrgs: Org2CloudOrg[];
  isCloudShareEligible: (session: Session) => boolean;
  openCloudShare: (session: Session) => void;
  closeCloudShare: () => void;
}

export function useCloudSessionShareDialog(): UseCloudSessionShareDialogResult {
  const store = useStore();
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const repoScopesByOrg = useAtomValue(org2CloudRepoScopesAtom);
  const sessionOrgTags = useAtomValue(sessionOrgTagsAtom);
  const activeCloudOrgId = useAtomValue(sidebarActiveCloudOrgIdAtom);
  const [cloudShareSession, setCloudShareSession] = useState<Session | null>(
    null
  );
  // Re-render when any repo scope key resolves (async git-remote IPC).
  const scopeKeyVersion = useSyncExternalStore(
    subscribeShareableScopeKeys,
    getShareableScopeKeyVersion
  );

  const orgsForSession = useCallback(
    (session: Session) =>
      getActiveCloudShareOrgsForSession(
        activeCloudOrgId,
        session,
        sessionOrgTags,
        cloudOrgs,
        repoScopesByOrg,
        getSessionScopeKeys(session)
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scopeKeyVersion invalidates the module cache read inside getSessionScopeKeys; it is a signal, not a direct function input
    [
      activeCloudOrgId,
      cloudOrgs,
      repoScopesByOrg,
      scopeKeyVersion,
      sessionOrgTags,
    ]
  );

  // Store reads at call time — the gate runs inside a native context-menu
  // handler and must see the live roster/scopes, never a render-time capture.
  const isCloudShareEligible = useCallback(
    (session: Session) =>
      store.get(org2CloudAuthAtom) !== null &&
      isCloudPushCandidate(session) &&
      getActiveCloudShareOrgsForSession(
        store.get(sidebarActiveCloudOrgIdAtom),
        session,
        store.get(sessionOrgTagsAtom),
        store.get(org2CloudOrgsAtom),
        store.get(org2CloudRepoScopesAtom),
        getSessionScopeKeys(session)
      ).length > 0,
    [store]
  );

  const cloudShareOrgs = useMemo(
    () => (cloudShareSession ? orgsForSession(cloudShareSession) : []),
    [cloudShareSession, orgsForSession]
  );

  const openCloudShare = useCallback((session: Session) => {
    setCloudShareSession(session);
  }, []);

  const closeCloudShare = useCallback(() => {
    setCloudShareSession(null);
  }, []);

  return {
    cloudShareSession,
    cloudShareOrgs,
    isCloudShareEligible,
    openCloudShare,
    closeCloudShare,
  };
}
