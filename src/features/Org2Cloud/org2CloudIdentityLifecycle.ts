import { getDefaultStore } from "jotai";

import { subscribeIdentitySnapshotWillChange } from "@src/features/Identity/identitySnapshotAtom";
import {
  type IdentitySnapshot,
  getActiveIdentitySession,
} from "@src/features/Identity/identityTypes";

import { resetCloudIdentityBoundState } from "./org2CloudEndpointAtom";

let uninstall: (() => void) | null = null;

function cloudIdentityKey(snapshot: IdentitySnapshot): string | null {
  const session = getActiveIdentitySession(snapshot, "org2_cloud");
  if (!session) return null;
  return [
    session.sessionId,
    session.generation,
    session.issuer.replace(/\/+$/, ""),
    session.subject,
  ].join("|");
}

export function didOrg2CloudIdentityChange(
  current: IdentitySnapshot,
  next: IdentitySnapshot
): boolean {
  return cloudIdentityKey(current) !== cloudIdentityKey(next);
}

/** Install once before the first Broker snapshot hydration. */
export function installOrg2CloudIdentityLifecycle(): void {
  if (uninstall) return;
  uninstall = subscribeIdentitySnapshotWillChange((current, next) => {
    if (!didOrg2CloudIdentityChange(current, next)) return;
    resetCloudIdentityBoundState(getDefaultStore());
  });
}
