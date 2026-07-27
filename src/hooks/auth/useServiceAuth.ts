import { useAtom } from "jotai";
import { useCallback, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { synchronizeSharedServiceAuthStorage } from "@src/api/http/auth/sharedAuthStorage";
import {
  refreshSupabaseSession,
  signInWithSupabase,
  signOutSupabase,
} from "@src/api/http/auth/supabase";
import { AUTH_ROUTES } from "@src/config/routes";
import {
  clearHostedToken,
  clearProcessedCode,
  getHostedToken,
  getTimeUntilExpiry,
  hasRefreshToken,
  isServiceAuthenticated,
  isTokenAboutToExpire,
  setAuthSkipped,
  verifyHostedToken,
} from "@src/config/serviceAuth";
import { createLogger } from "@src/hooks/logger";

import {
  hostedTokenAtom,
  serviceAuthAtom,
  serviceErrorAtom,
  serviceExpiryAtom,
  serviceLoadingAtom,
  serviceRefreshingAtom,
  serviceValidatedAtom,
} from "./serviceAuthAtoms";
import {
  isAuthError,
  isNetworkError,
  isNoRefreshTokenError,
  sleep,
} from "./serviceAuthHelpers";

export {
  clearAuthStateCompletely,
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

const logger = createLogger("ServiceAuth");

const REFRESH_THRESHOLD_SECONDS = 300;
const EXPIRY_CHECK_INTERVAL_MS = 30000;
const MAX_REFRESH_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const VISIBILITY_CHANGE_DEBOUNCE_MS = 500;
const VISIBILITY_VERIFY_MIN_INTERVAL_MS = 3 * 60 * 1000;
let lastVisibilityVerifyAt = 0;
let globalRefreshInProgress = false;

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
  const location = useLocation();
  const navigate = useNavigate();

  const [isAuthenticated, setIsAuthenticated] = useAtom(serviceAuthAtom);
  const [isLoading, setIsLoading] = useAtom(serviceLoadingAtom);
  const [token, setToken] = useAtom(hostedTokenAtom);
  const [expiresIn, setExpiresIn] = useAtom(serviceExpiryAtom);
  const [error, setError] = useAtom(serviceErrorAtom);
  const [hasValidated, setHasValidated] = useAtom(serviceValidatedAtom);
  const [isRefreshing, setIsRefreshing] = useAtom(serviceRefreshingAtom);

  const applyStoredAuthState = useCallback(() => {
    const storedToken = getHostedToken();
    const authenticated = isServiceAuthenticated();
    const timeLeft = getTimeUntilExpiry();

    setToken(storedToken);
    setIsAuthenticated(authenticated);
    setExpiresIn(timeLeft);
    setIsLoading(false);

    if (!storedToken && !authenticated) {
      setToken(null);
      setExpiresIn(null);
    }
  }, [setToken, setIsAuthenticated, setExpiresIn, setIsLoading]);

  const refreshToken = useCallback(async (): Promise<boolean> => {
    if (globalRefreshInProgress) return false;

    globalRefreshInProgress = true;
    setIsRefreshing(true);

    let lastError: unknown = null;

    for (let attempt = 0; attempt < MAX_REFRESH_RETRIES; attempt++) {
      try {
        const tokenResponse = await refreshSupabaseSession();

        setToken(tokenResponse.access_token);
        setExpiresIn(tokenResponse.expires_in);
        setIsAuthenticated(true);
        setError(null);

        window.dispatchEvent(new Event("localStorageChange"));

        globalRefreshInProgress = false;
        setIsRefreshing(false);
        return true;
      } catch (refreshError) {
        lastError = refreshError;

        if (isNoRefreshTokenError(refreshError)) {
          globalRefreshInProgress = false;
          setIsRefreshing(false);
          return false;
        }

        logger.warn(
          `Token refresh attempt ${attempt + 1}/${MAX_REFRESH_RETRIES} failed:`,
          refreshError
        );

        if (isAuthError(refreshError)) {
          logger.error("Auth error - refresh token is invalid");
          break;
        }

        if (isNetworkError(refreshError) && attempt < MAX_REFRESH_RETRIES - 1) {
          const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }

        if (!navigator.onLine) {
          logger.warn("Offline - keeping session alive without refresh");
          globalRefreshInProgress = false;
          setIsRefreshing(false);
          return false;
        }
      }
    }

    logger.error("Token refresh failed after all retries");

    if (isAuthError(lastError)) {
      clearHostedToken();
      setToken(null);
      setIsAuthenticated(false);
      setExpiresIn(null);
      setError("Session expired. Please log in again.");
    } else if (isNoRefreshTokenError(lastError)) {
      // User is not logged in.
    } else if (!navigator.onLine) {
      logger.warn("Offline after retries - keeping session");
    } else {
      logger.warn("Network issues - keeping session, will retry later");
      setError("Unable to refresh session. Will retry automatically.");
    }

    globalRefreshInProgress = false;
    setIsRefreshing(false);
    return false;
  }, [setIsRefreshing, setToken, setExpiresIn, setIsAuthenticated, setError]);

  const refresh = useCallback(() => {
    void synchronizeSharedServiceAuthStorage().then(
      applyStoredAuthState,
      applyStoredAuthState
    );
  }, [applyStoredAuthState]);

  useEffect(() => {
    if (hasValidated) return;

    const storedToken = getHostedToken();
    const hasRefresh = hasRefreshToken();

    if (!storedToken && !hasRefresh) {
      setIsAuthenticated(false);
      setToken(null);
      setExpiresIn(null);
      setHasValidated(true);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    const timeoutMs = 10000;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (storedToken) {
      const timeoutPromise = new Promise<{ valid: boolean }>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("Token validation timeout"));
        }, timeoutMs);
      });

      Promise.race([verifyHostedToken(), timeoutPromise])
        .then((result) => {
          clearTimeout(timeoutId);
          if (cancelled) return;
          if (result.valid) {
            setIsAuthenticated(true);
            setToken(storedToken);
            setExpiresIn(getTimeUntilExpiry());
          } else if (hasRefresh) {
            return refreshToken();
          } else {
            clearHostedToken();
            setToken(null);
            setIsAuthenticated(false);
          }
        })
        .catch((verifyError) => {
          clearTimeout(timeoutId);
          if (cancelled) return;
          logger.warn("Token validation failed:", verifyError);
          setIsAuthenticated(!!storedToken);
          setToken(storedToken);
        })
        .finally(() => {
          if (cancelled) return;
          setHasValidated(true);
          setIsLoading(false);
        });
    } else if (hasRefresh) {
      refreshToken().finally(() => {
        if (cancelled) return;
        setHasValidated(true);
        setIsLoading(false);
      });
    }

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    };
  }, [
    hasValidated,
    setHasValidated,
    setIsLoading,
    setIsAuthenticated,
    setToken,
    setExpiresIn,
    refreshToken,
  ]);

  useEffect(() => {
    if (!hasValidated) return;
    refresh();
  }, [location.pathname, refresh, hasValidated]);

  const login = useCallback(async () => {
    setAuthSkipped(false);
    await signInWithSupabase();
  }, []);

  const logout = useCallback(
    async (options: { redirect?: boolean } = { redirect: true }) => {
      try {
        await signOutSupabase();
      } catch (signOutError) {
        logger.warn("Supabase sign-out failed:", signOutError);
        clearHostedToken();
      }

      setToken(null);
      setIsAuthenticated(false);
      setExpiresIn(null);
      setError(null);
      setAuthSkipped(false);
      await clearProcessedCode().catch(() => {});

      if (options.redirect) {
        navigate(AUTH_ROUTES.login.path, { replace: true });
      }
    },
    [setToken, setIsAuthenticated, setExpiresIn, setError, navigate]
  );

  useEffect(() => {
    if (!isAuthenticated) return;

    const checkAndRefresh = async () => {
      if (!navigator.onLine) return;
      if (isTokenAboutToExpire(REFRESH_THRESHOLD_SECONDS)) {
        if (hasRefreshToken()) await refreshToken();
      }
      const timeLeft = getTimeUntilExpiry();
      setExpiresIn(timeLeft);
    };

    let disposed = false;
    let expiryCheckRunning = false;
    let expiryCheckTimeout: ReturnType<typeof setTimeout> | null = null;
    let debounceTimeout: ReturnType<typeof setTimeout> | null = null;

    const stopExpiryChecks = () => {
      if (expiryCheckTimeout) clearTimeout(expiryCheckTimeout);
      expiryCheckTimeout = null;
    };

    const scheduleExpiryCheck = () => {
      if (
        disposed ||
        expiryCheckTimeout ||
        document.visibilityState === "hidden"
      ) {
        return;
      }
      expiryCheckTimeout = setTimeout(runExpiryCheck, EXPIRY_CHECK_INTERVAL_MS);
    };

    const runExpiryCheck = async () => {
      expiryCheckTimeout = null;
      if (disposed || document.visibilityState === "hidden") return;
      if (expiryCheckRunning) {
        scheduleExpiryCheck();
        return;
      }

      expiryCheckRunning = true;
      try {
        await checkAndRefresh();
      } finally {
        expiryCheckRunning = false;
        scheduleExpiryCheck();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        stopExpiryChecks();
        return;
      }
      void runExpiryCheck();
      if (debounceTimeout) clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(async () => {
        if (!navigator.onLine) return;
        if (isTokenAboutToExpire(REFRESH_THRESHOLD_SECONDS)) {
          await refreshToken();
        } else if (
          Date.now() - lastVisibilityVerifyAt >=
          VISIBILITY_VERIFY_MIN_INTERVAL_MS
        ) {
          try {
            lastVisibilityVerifyAt = Date.now();
            const result = await verifyHostedToken();
            if (!result.valid && hasRefreshToken()) {
              await refreshToken();
            }
          } catch (verifyError) {
            if (isNetworkError(verifyError)) {
              logger.warn(
                "Verify unreachable on visibility change, keeping session"
              );
            } else if (hasRefreshToken()) {
              await refreshToken();
            }
          }
        }
      }, VISIBILITY_CHANGE_DEBOUNCE_MS);
    };

    void runExpiryCheck();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      disposed = true;
      stopExpiryChecks();
      if (debounceTimeout) clearTimeout(debounceTimeout);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isAuthenticated, setExpiresIn, refreshToken]);

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
