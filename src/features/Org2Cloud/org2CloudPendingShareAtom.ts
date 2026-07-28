import { atom } from "jotai";

import type { CloudShareDeepLink } from "./org2CloudOrgManagement";

/**
 * A cloud session share captured from an `orgii://cloud/session?share=…`
 * deep link (migration 0012), waiting to be consumed by
 * `CloudShareImportDialog` (resolve token → confirm → read-only import →
 * openSession).
 *
 * In-memory only and strictly one-shot — consumers must go through
 * `consumeOrg2CloudPendingShareAtom` so a re-render can never replay the
 * import. Aligned with `collabPendingShareAtom` / `org2CloudPendingInviteAtom`:
 * the atom IS the dialog visibility.
 */
export type Org2CloudPendingShare = CloudShareDeepLink & {
  /** Store-local request generation; distinguishes reopening the same token. */
  attemptId: number;
};

const org2CloudShareAttemptCounterAtom = atom(0);

export const org2CloudPendingShareAtom = atom<Org2CloudPendingShare | null>(
  null
);
org2CloudPendingShareAtom.debugLabel = "org2CloudPendingShareAtom";

/**
 * The only production write seam for incoming shares. Every hand-off gets a
 * new generation even when the exact same token is reopened, so dialog state
 * from an earlier resolve/import can never become current again.
 */
export const queueOrg2CloudPendingShareAtom = atom(
  null,
  (get, set, share: CloudShareDeepLink): Org2CloudPendingShare => {
    const attemptId = get(org2CloudShareAttemptCounterAtom) + 1;
    const pending = { ...share, attemptId };
    set(org2CloudShareAttemptCounterAtom, attemptId);
    set(org2CloudPendingShareAtom, pending);
    return pending;
  }
);
queueOrg2CloudPendingShareAtom.debugLabel = "queueOrg2CloudPendingShareAtom";

/**
 * Write-only consume atom: returns the pending share (or null) and clears it
 * in the same transaction, so exactly one consumer ever sees a given link.
 */
export const consumeOrg2CloudPendingShareAtom = atom(
  null,
  (get, set): Org2CloudPendingShare | null => {
    const pending = get(org2CloudPendingShareAtom);
    if (pending) set(org2CloudPendingShareAtom, null);
    return pending;
  }
);
consumeOrg2CloudPendingShareAtom.debugLabel =
  "consumeOrg2CloudPendingShareAtom";
