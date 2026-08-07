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
export type Org2CloudPendingShare = CloudShareDeepLink;

export const org2CloudPendingShareAtom = atom<Org2CloudPendingShare | null>(
  null
);
org2CloudPendingShareAtom.debugLabel = "org2CloudPendingShareAtom";

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
