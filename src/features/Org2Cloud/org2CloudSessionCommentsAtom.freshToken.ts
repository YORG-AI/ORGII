/**
 * Shared auth composition for `org2CloudSessionCommentsAtom.ts`'s
 * `useSessionComments` hook: `useCloudFreshAccessToken` below.
 */
import { useAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import { commitRefreshedAuth, org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { ensureFreshSession } from "./org2CloudClient";

/**
 * The `ensureFreshSession` + `commitRefreshedAuth` composition as ONE
 * stable callback: a fresh JWT per RPC batch, committed compare-and-set so
 * a signed-out auth atom is never resurrected. This is the blessed
 * React-side variant of the idiom, shared by `useSessionComments` and the
 * task surfaces (`SessionCommentsContext`'s create/reopen/reset wrappers).
 * Reads auth through a ref so the token-refresh write inside a batch never
 * retriggers the callers' effects (org2CloudRemoteSessionsAtom idiom).
 */
export function useCloudFreshAccessToken(): () => Promise<string> {
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  return useCallback(async (): Promise<string> => {
    const current = authRef.current;
    if (!current) throw new Error("not signed in to ORG2 Cloud");
    const fresh = await ensureFreshSession(current);
    if (!fresh) throw new Error("token refresh failed");
    commitRefreshedAuth(setAuth, current, fresh);
    return fresh.accessToken;
  }, [setAuth]);
}
