import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";

import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";

import { clearWebCloudSessionEventCache } from "./webCloudSessionEventCache";

/**
 * Owns the persisted Web transcript cache's authentication lifecycle.
 *
 * Token refreshes keep the same stable identity and preserve the cache.
 * Sign-out, rejected refresh, endpoint switch, and account switch clear every
 * snapshot from the browser profile. Keeping this above the auth router means
 * automatic sign-out cannot unmount the cleanup owner before it observes the
 * identity transition.
 */
export function WebCloudSessionEventCacheLifecycle() {
  const auth = useAtomValue(org2CloudAuthAtom);
  const identityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const previousIdentityRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const previousIdentity = previousIdentityRef.current;
    previousIdentityRef.current = identityKey;

    const signedOut = identityKey === null;
    const switchedIdentity =
      previousIdentity !== undefined &&
      previousIdentity !== null &&
      previousIdentity !== identityKey;
    if (signedOut || switchedIdentity) {
      void clearWebCloudSessionEventCache();
    }
  }, [identityKey]);

  return null;
}
