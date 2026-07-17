/**
 * Per-surface open/close state + eligibility gate for MoveToOrgDialog,
 * mirroring useSessionShareDialog. Each mount surface (sidebar context menu,
 * chat panel header menu) owns one instance.
 */
import { useStore } from "jotai";
import { useCallback, useState } from "react";

import type { Session } from "@src/store/session/sessionAtom/types";

import { org2CloudAuthAtom } from "../../../Org2Cloud/org2CloudAuthAtom";
import { org2CloudOrgsAtom } from "../../../Org2Cloud/org2CloudOrgsAtom";
import { isCloudPushCandidate } from "../../../Org2Cloud/org2CloudSyncEngine";

export interface UseMoveToOrgDialogResult {
  moveDialogSession: Session | null;
  /**
   * Menu-item gate: signed into ORG2 Cloud with ≥1 cloud org, and the session
   * is the owner's own pushable session (never an imported teammate copy —
   * `importedFrom` sessions pulled from the cloud must not round-trip back
   * out; the user's own external history IS taggable/shareable).
   */
  isMoveEligible: (session: Session) => boolean;
  openMoveToOrg: (session: Session) => void;
  closeMoveToOrg: () => void;
}

export function useMoveToOrgDialog(): UseMoveToOrgDialogResult {
  // Read the atoms from the store AT CALL TIME: the gate runs inside a native
  // context-menu handler, and a click-time read can never see values captured
  // by an earlier render (e.g. the pre-hydration empty roster).
  const store = useStore();
  const [moveDialogSession, setMoveDialogSession] = useState<Session | null>(
    null
  );

  const isMoveEligible = useCallback(
    (session: Session) =>
      store.get(org2CloudAuthAtom) !== null &&
      store.get(org2CloudOrgsAtom).length > 0 &&
      isCloudPushCandidate(session),
    [store]
  );

  const openMoveToOrg = useCallback((session: Session) => {
    setMoveDialogSession(session);
  }, []);

  const closeMoveToOrg = useCallback(() => {
    setMoveDialogSession(null);
  }, []);

  return {
    moveDialogSession,
    isMoveEligible,
    openMoveToOrg,
    closeMoveToOrg,
  };
}
