import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";

import { MobileAuthContext } from "./MobileAuthContext";
import { MobileAuthScreen } from "./MobileAuthScreen";
import {
  type MobileAuthClient,
  MobileAuthClientError,
  createMobileAuthClient,
  isRetryableMobileAuthError,
} from "./mobileAuthClient";
import {
  MOBILE_AUTH_CALLBACK_PATH,
  beginMobileOAuthAttempt,
  clearMobileAuthIntents,
  consumeMobileOAuthAttempt,
  consumeOpaquePairingIntent,
  isMobileAuthCallback,
} from "./mobileAuthIntent";
import {
  createInitialMobileAuthState,
  reduceMobileAuthState,
} from "./mobileAuthState";
import {
  clearMobileAuthSession,
  readMobileAuthSession,
  writeMobileAuthSession,
} from "./mobileAuthStorage";

const EXPIRY_REFRESH_SKEW_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_000_000;

export interface MobileAuthGateRenderProps {
  authUserId: string;
  recoveredPairingIntent: string | null;
}

export interface MobileAuthGateProps {
  children: (props: MobileAuthGateRenderProps) => React.ReactNode;
  /** Test seam; production uses the browser-safe official Cloud client. */
  client?: MobileAuthClient;
  navigate?: (url: string) => void;
}

export function MobileAuthGate({
  children,
  client: providedClient,
  navigate = (url) => window.location.assign(url),
}: MobileAuthGateProps) {
  const [state, dispatch] = useReducer(
    reduceMobileAuthState,
    undefined,
    createInitialMobileAuthState
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const generationRef = useRef(0);
  const expiryTimerRef = useRef<number | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const clientRef = useRef<MobileAuthClient | null>(null);
  clientRef.current ??= providedClient ?? createMobileAuthClient();

  const clearExpiryTimer = useCallback(() => {
    if (expiryTimerRef.current !== null) {
      window.clearTimeout(expiryTimerRef.current);
      expiryTimerRef.current = null;
    }
  }, []);

  const authenticate = useCallback(
    (options: { forceRefresh?: boolean } = {}) => {
      if (inFlightRef.current) return inFlightRef.current;
      const generation = ++generationRef.current;
      const callback = isMobileAuthCallback(window.location);
      const callbackUrl = window.location.href;

      if (callback) {
        dispatch({ type: "begin", phase: "exchanging", generation });
        window.history.replaceState(window.history.state, "", "/orgii/mobile");
      } else if (
        stateRef.current.phase !== "signed_in" ||
        stateRef.current.session.expiresAt <= Date.now() / 1_000
      ) {
        dispatch({ type: "begin", phase: "checking", generation });
      }

      const operation = (async () => {
        try {
          let session;
          if (callback) {
            if (!consumeMobileOAuthAttempt()) {
              throw new MobileAuthClientError(
                "Authentication callback has expired",
                false
              );
            }
            session = await clientRef.current!.exchangeCallback(callbackUrl);
          } else {
            const stored = readMobileAuthSession();
            if (!stored) {
              dispatch({ type: "signed_out", generation });
              return;
            }
            session = await clientRef.current!.restoreSession(stored, options);
          }
          if (generation !== generationRef.current) return;

          // Persist the rotating refresh token before the server-session
          // exchange. A transient exchange failure can then recover on Retry
          // without replaying an already-scrubbed OAuth callback.
          writeMobileAuthSession(session);
          await clientRef.current!.establishServerSession(session.accessToken);
          if (generation !== generationRef.current) return;

          dispatch({
            type: "signed_in",
            generation,
            session,
            recoveredPairingIntent: consumeOpaquePairingIntent(),
          });
        } catch (error) {
          if (generation !== generationRef.current) return;
          const retryable = isRetryableMobileAuthError(error);
          if (!retryable) clearMobileAuthSession();
          dispatch({
            type: "failed",
            generation,
            message:
              error instanceof Error ? error.message : "Authentication failed",
            retryable,
          });
        }
      })();
      inFlightRef.current = operation;
      void operation.finally(() => {
        if (inFlightRef.current === operation) inFlightRef.current = null;
      });
      return operation;
    },
    []
  );

  useEffect(() => {
    void authenticate();
  }, [authenticate]);

  const startSignIn = useCallback(() => {
    const generation = ++generationRef.current;
    clearExpiryTimer();
    const attemptId = crypto.randomUUID();
    beginMobileOAuthAttempt(attemptId);
    dispatch({ type: "begin", phase: "redirecting", generation });
    const callbackUrl = new URL(
      MOBILE_AUTH_CALLBACK_PATH,
      window.location.origin
    ).toString();
    void clientRef
      .current!.buildLoginUrl(callbackUrl)
      .then((url) => {
        if (generation === generationRef.current) navigate(url);
      })
      .catch((error) => {
        if (generation !== generationRef.current) return;
        dispatch({
          type: "failed",
          generation,
          message:
            error instanceof Error ? error.message : "Authentication failed",
          retryable: isRetryableMobileAuthError(error),
        });
      });
  }, [clearExpiryTimer, navigate]);

  const signOut = useCallback(() => {
    const currentSession =
      stateRef.current.phase === "signed_in"
        ? stateRef.current.session
        : readMobileAuthSession();
    const generation = ++generationRef.current;
    // Detach any refresh/callback operation from this auth episode. Its
    // generation guard still prevents stale completion from restoring state,
    // while a later sign-in is free to start immediately.
    inFlightRef.current = null;
    clearExpiryTimer();
    clearMobileAuthSession();
    clearMobileAuthIntents();
    dispatch({ type: "signed_out", generation });
    void clientRef.current!.signOut(currentSession);
  }, [clearExpiryTimer]);

  useEffect(() => {
    clearExpiryTimer();
    if (state.phase !== "signed_in" || document.hidden) return;
    const delay = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(
        0,
        state.session.expiresAt * 1_000 - Date.now() - EXPIRY_REFRESH_SKEW_MS
      )
    );
    expiryTimerRef.current = window.setTimeout(() => {
      expiryTimerRef.current = null;
      void authenticate({ forceRefresh: true });
    }, delay);
    return clearExpiryTimer;
  }, [authenticate, clearExpiryTimer, state]);

  useEffect(() => {
    const handleVisibility = () => {
      clearExpiryTimer();
      if (!document.hidden && stateRef.current.phase === "signed_in") {
        void authenticate({ forceRefresh: true });
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      clearExpiryTimer();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [authenticate, clearExpiryTimer]);

  const contextValue = useMemo(
    () =>
      state.phase === "signed_in" ? { session: state.session, signOut } : null,
    [signOut, state]
  );

  if (state.phase !== "signed_in" || !contextValue) {
    return (
      <MobileAuthScreen
        state={state}
        onSignIn={startSignIn}
        onRetry={() => void authenticate()}
      />
    );
  }

  return (
    <MobileAuthContext.Provider value={contextValue}>
      {children({
        authUserId: state.session.userId,
        recoveredPairingIntent: state.recoveredPairingIntent,
      })}
    </MobileAuthContext.Provider>
  );
}

MobileAuthGate.displayName = "MobileAuthGate";
