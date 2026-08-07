/**
 * Per-surface open/close state + eligibility gate for CloudSyncLevelDialog,
 * mirroring useMoveToOrgDialog (the two share the same eligibility rule:
 * signed into ORG2 Cloud, a cloud org is selected in the sidebar, and the
 * session is the owner's own pushable session — only imported teammate copies (pulled from the cloud,
 * `importedFrom` set) are excluded; the user's OWN external history (imported
 * Claude Code / Cursor / … sessions) IS shareable and has a sync level).
 */
import { atom, useAtom, useStore } from "jotai";
import { useCallback } from "react";

import type { Session } from "@src/store/session/sessionAtom/types";

import { org2CloudAuthAtom } from "../org2CloudAuthAtom";
import {
  getSidebarActiveCloudOrg,
  org2CloudOrgsAtom,
  sidebarActiveCloudOrgIdAtom,
} from "../org2CloudOrgsAtom";
import { isCloudPushCandidate } from "../org2CloudSyncEngine";

/**
 * Open-dialog state. Module-level (instead of hook-local useState) because
 * the dialog's ONLY production entry is a native Tauri context-menu item,
 * which WebDriver cannot click — the `__e2e` cloud bridge drives this atom
 * directly for rendered E2E coverage. Behavior is unchanged for the single
 * mounted consumer (WorkstationSidebarConnector).
 */
export const cloudSyncLevelSessionAtom = atom<Session | null>(null);
cloudSyncLevelSessionAtom.debugLabel = "cloudSyncLevelSessionAtom";

export interface UseCloudSyncLevelDialogResult {
  syncLevelSession: Session | null;
  isSyncLevelEligible: (session: Session) => boolean;
  openSyncLevel: (session: Session) => void;
  closeSyncLevel: () => void;
}

export function useCloudSyncLevelDialog(): UseCloudSyncLevelDialogResult {
  // Store read at call time — the gate runs inside a native context-menu
  // handler and must see the live roster, never a render-time capture.
  const store = useStore();
  const [syncLevelSession, setSyncLevelSession] = useAtom(
    cloudSyncLevelSessionAtom
  );

  const isSyncLevelEligible = useCallback(
    (session: Session) => {
      const activeOrg = getSidebarActiveCloudOrg(
        store.get(sidebarActiveCloudOrgIdAtom),
        store.get(org2CloudOrgsAtom)
      );
      return (
        store.get(org2CloudAuthAtom) !== null &&
        activeOrg !== null &&
        isCloudPushCandidate(session)
      );
    },
    [store]
  );

  const openSyncLevel = useCallback(
    (session: Session) => {
      setSyncLevelSession(session);
    },
    [setSyncLevelSession]
  );

  const closeSyncLevel = useCallback(() => {
    setSyncLevelSession(null);
  }, [setSyncLevelSession]);

  return {
    syncLevelSession,
    isSyncLevelEligible,
    openSyncLevel,
    closeSyncLevel,
  };
}
