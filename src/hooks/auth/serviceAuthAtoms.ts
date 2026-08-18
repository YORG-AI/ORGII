import { atom, getDefaultStore, useAtomValue } from "jotai";

import { subscribeIdentitySnapshotChanges } from "@src/features/Identity/identitySnapshotAtom";
import { getActiveIdentitySession } from "@src/features/Identity/identityTypes";

export const serviceAuthAtom = atom(false);
export const serviceLoadingAtom = atom(true);
/** @deprecated Access credentials are native leases, never persisted atoms. */
export const hostedTokenAtom = atom<string | null>(null);
export const serviceExpiryAtom = atom<number | null>(null);
export const serviceErrorAtom = atom<string | null>(null);
export const serviceValidatedAtom = atom(false);
export const serviceRefreshingAtom = atom(false);

subscribeIdentitySnapshotChanges((snapshot) => {
  const store = getDefaultStore();
  const session = getActiveIdentitySession(snapshot, "hosted_service_legacy");
  const flow = snapshot.flows.find(
    (candidate) => candidate.realm === "hosted_service_legacy"
  );
  const authenticated =
    session?.status === "ready" || session?.status === "offline_degraded";
  const loading =
    snapshot.revision === 0 ||
    session?.status === "restoring" ||
    (flow !== undefined && flow.phase !== "failed");
  const expiresIn = session?.expiresAtUnix
    ? Math.max(0, session.expiresAtUnix - Math.floor(Date.now() / 1_000))
    : null;
  const error =
    session?.status === "reauth_required"
      ? "Session expired. Please log in again."
      : snapshot.secureStoreStatus === "locked"
        ? "The system credential store is locked."
        : null;

  store.set(serviceAuthAtom, authenticated);
  store.set(serviceLoadingAtom, loading);
  store.set(hostedTokenAtom, null);
  store.set(serviceExpiryAtom, expiresIn);
  store.set(serviceErrorAtom, error);
  store.set(serviceValidatedAtom, snapshot.revision > 0);
  store.set(
    serviceRefreshingAtom,
    flow?.phase === "exchanging_code" || flow?.phase === "verifying_session"
  );
});

export interface UseServiceAuthStateReturn {
  isAuthenticated: boolean;
  isLoading: boolean;
  token: string | null;
  expiresIn: number | null;
  error: string | null;
  isRefreshing: boolean;
}

/** Read-only non-secret projection of the native Hosted identity realm. */
export function useServiceAuthState(): UseServiceAuthStateReturn {
  const isAuthenticated = useAtomValue(serviceAuthAtom);
  const isLoading = useAtomValue(serviceLoadingAtom);
  const token = useAtomValue(hostedTokenAtom);
  const expiresIn = useAtomValue(serviceExpiryAtom);
  const error = useAtomValue(serviceErrorAtom);
  const isRefreshing = useAtomValue(serviceRefreshingAtom);
  return { isAuthenticated, isLoading, token, expiresIn, error, isRefreshing };
}
