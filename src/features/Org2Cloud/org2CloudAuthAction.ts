/**
 * One authenticated-action refresh boundary for ORG2 Cloud UI flows.
 *
 * `ensureFreshSession` deliberately returns `null` for both a transient
 * transport failure and a permanently rejected refresh credential. UI
 * actions need the distinction: a transient failure is retryable while a
 * 400/401 means the persisted auth state is no longer usable and must stop
 * presenting the user as signed in.
 */
import {
  type Org2CloudAuthState,
  commitRefreshedAuth,
} from "./org2CloudAuthAtom";
import { ensureFreshSession } from "./org2CloudClient";

export type SetOrg2CloudAuth = (
  update: (previous: Org2CloudAuthState | null) => Org2CloudAuthState | null
) => void;

export type Org2CloudAuthActionResult =
  | { status: "ready"; auth: Org2CloudAuthState }
  | { status: "expired" }
  | { status: "unavailable" }
  | { status: "superseded" };

/**
 * Refresh and persist the session used by one foreground action.
 *
 * Permanent rejection clears only the exact session that initiated the
 * request. A sign-out, endpoint switch, or newer login that wins while the
 * refresh is in flight is preserved and reported as `superseded`.
 */
export async function refreshOrg2CloudAuthForAction(
  current: Org2CloudAuthState,
  setAuth: SetOrg2CloudAuth
): Promise<Org2CloudAuthActionResult> {
  let refreshRejected = false;
  let rejectedSessionCleared = false;
  const fresh = await ensureFreshSession(current, {
    onRefreshRejected: () => {
      refreshRejected = true;
      setAuth((latest) => {
        if (latest !== current) return latest;
        rejectedSessionCleared = true;
        return null;
      });
    },
  });

  if (refreshRejected) {
    return rejectedSessionCleared
      ? { status: "expired" }
      : { status: "superseded" };
  }
  if (!fresh) return { status: "unavailable" };
  if (!commitRefreshedAuth(setAuth, current, fresh)) {
    return { status: "superseded" };
  }
  return { status: "ready", auth: fresh };
}
