import { useAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import {
  type Org2CloudAuthState,
  clearRejectedAuth,
  commitRefreshedAuth,
  isSameOrg2CloudSession,
  org2CloudAuthAtom,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { ensureFreshSession } from "@src/features/Org2Cloud/org2CloudClient";

/** Browser-safe, stale-session-guarded access-token resolver. */
export function useFreshWebCloudSession(): () => Promise<Org2CloudAuthState | null> {
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const authRef = useRef(auth);

  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  return useCallback(async () => {
    const current = authRef.current;
    if (!current) return null;

    const fresh = await ensureFreshSession(current, {
      onRefreshRejected: () => {
        if (clearRejectedAuth(setAuth, current)) authRef.current = null;
      },
    });
    if (!fresh || !isSameOrg2CloudSession(authRef.current, current)) {
      return null;
    }
    if (!commitRefreshedAuth(setAuth, current, fresh)) return null;
    authRef.current = fresh;
    return fresh;
  }, [setAuth]);
}
