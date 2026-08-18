import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

import { getOrRefreshHostedToken } from "@src/api/http/client/tokenRefresh";
import { AUTH_ROUTES } from "@src/config/routes";
import {
  SERVICE_AUTH_CONFIG,
  getCallbackUrl,
  setAuthSkipped,
} from "@src/config/serviceAuth";
import { identityClient } from "@src/features/Identity/identityClient";
import { signOutIdentity } from "@src/features/Identity/identityLifecycle";
import {
  readIdentitySnapshot,
  replaceIdentitySnapshot,
} from "@src/features/Identity/identitySnapshotAtom";
import { getActiveIdentitySession } from "@src/features/Identity/identityTypes";

import {
  hostedTokenAtom,
  serviceAuthAtom,
  serviceErrorAtom,
  serviceExpiryAtom,
  serviceLoadingAtom,
  serviceRefreshingAtom,
} from "./serviceAuthAtoms";

export {
  serviceAuthAtom,
  serviceErrorAtom,
  serviceExpiryAtom,
  serviceLoadingAtom,
  serviceRefreshingAtom,
  hostedTokenAtom,
  serviceValidatedAtom,
  useServiceAuthState,
} from "./serviceAuthAtoms";
export type { UseServiceAuthStateReturn } from "./serviceAuthAtoms";

export interface UseServiceAuthReturn {
  isAuthenticated: boolean;
  isLoading: boolean;
  token: string | null;
  expiresIn: number | null;
  error: string | null;
  isRefreshing: boolean;
  login: () => void;
  logout: (options?: { redirect?: boolean }) => void;
  refresh: () => void;
  refreshToken: () => Promise<boolean>;
}

export function useServiceAuth(): UseServiceAuthReturn {
  const navigate = useNavigate();
  const isAuthenticated = useAtomValue(serviceAuthAtom);
  const isLoading = useAtomValue(serviceLoadingAtom);
  const token = useAtomValue(hostedTokenAtom);
  const expiresIn = useAtomValue(serviceExpiryAtom);
  const error = useAtomValue(serviceErrorAtom);
  const isRefreshing = useAtomValue(serviceRefreshingAtom);
  const setError = useSetAtom(serviceErrorAtom);
  const setLoading = useSetAtom(serviceLoadingAtom);

  const refreshToken = useCallback(async (): Promise<boolean> => {
    return (await getOrRefreshHostedToken()) !== null;
  }, []);

  const refresh = useCallback(() => {
    void identityClient
      .getSnapshot()
      .then(replaceIdentitySnapshot)
      .catch(() => {});
  }, []);

  const login = useCallback(async () => {
    setAuthSkipped(false);
    setError(null);
    setLoading(true);
    try {
      const outcome = await identityClient.beginHostedServiceSignIn({
        supabaseUrl: SERVICE_AUTH_CONFIG.supabaseUrl,
        publicClientKey: SERVICE_AUTH_CONFIG.supabasePublishableKey,
        redirectUri: getCallbackUrl(),
        provider: SERVICE_AUTH_CONFIG.oauthProvider,
        scopes: SERVICE_AUTH_CONFIG.oauthScopes,
      });
      replaceIdentitySnapshot(outcome.snapshot);
    } catch {
      setLoading(false);
      setError("Unable to start sign-in. Please try again.");
    }
  }, [setError, setLoading]);

  const logout = useCallback(
    async (options: { redirect?: boolean } = { redirect: true }) => {
      setError(null);
      const snapshot = readIdentitySnapshot();
      const session = getActiveIdentitySession(
        snapshot,
        "hosted_service_legacy"
      );
      await signOutIdentity(
        "hosted_service_legacy",
        session ?? undefined
      ).catch(() => {});
      setAuthSkipped(false);
      if (options.redirect) {
        navigate(AUTH_ROUTES.login.path, { replace: true });
      }
    },
    [navigate, setError]
  );

  return {
    isAuthenticated,
    isLoading,
    token,
    expiresIn,
    error,
    isRefreshing,
    login,
    logout,
    refresh,
    refreshToken,
  };
}

export default useServiceAuth;
