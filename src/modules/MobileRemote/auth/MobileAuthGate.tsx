import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";

import { useMobileRemotePlatform } from "../platform";
import { MobileAuthContext } from "./MobileAuthContext";
import { MobileAuthScreen } from "./MobileAuthScreen";
import {
  type MobileAuthClient,
  MobileAuthClientError,
  isRetryableMobileAuthError,
} from "./mobileAuthClient";
import {
  createInitialMobileAuthState,
  reduceMobileAuthState,
} from "./mobileAuthState";

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
  navigate,
}: MobileAuthGateProps) {
  const platform = useMobileRemotePlatform();
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
  const signOutCleanupRef = useRef<Promise<void> | null>(null);
  const clientRef = useRef<MobileAuthClient | null>(null);
  clientRef.current ??= providedClient ?? platform.auth.createClient();

  const clearExpiryTimer = useCallback(() => {
    if (expiryTimerRef.current !== null) {
      platform.runtime.clearTimeout(expiryTimerRef.current);
      expiryTimerRef.current = null;
    }
  }, [platform.runtime]);

  const authenticate = useCallback(
    (options: { forceRefresh?: boolean } = {}) => {
      if (inFlightRef.current) return inFlightRef.current;
      const generation = ++generationRef.current;
      const callback = platform.auth.isCallback();
      const callbackUrl = platform.auth.currentUrl();

      if (callback) {
        dispatch({ type: "begin", phase: "exchanging", generation });
        platform.auth.scrubCallback();
      } else if (
        stateRef.current.phase !== "signed_in" ||
        stateRef.current.session.expiresAt <= platform.runtime.now() / 1_000
      ) {
        dispatch({ type: "begin", phase: "checking", generation });
      }

      const operation = (async () => {
        try {
          let session;
          if (callback) {
            if (!(await platform.auth.consumeOAuthAttempt())) {
              throw new MobileAuthClientError(
                "Authentication callback has expired",
                false
              );
            }
            session = await clientRef.current!.exchangeCallback(callbackUrl);
          } else {
            const stored = await platform.auth.readSession();
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
          await platform.auth.writeSession(session);
          if (generation !== generationRef.current) return;
          await clientRef.current!.establishServerSession(session.accessToken);
          if (generation !== generationRef.current) return;

          dispatch({
            type: "signed_in",
            generation,
            session,
            recoveredPairingIntent: await platform.auth.consumePairingIntent(),
          });
        } catch (error) {
          if (generation !== generationRef.current) return;
          const retryable = isRetryableMobileAuthError(error);
          if (!retryable) await platform.auth.clearSession();
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
    [platform.auth, platform.runtime]
  );

  useEffect(() => {
    void authenticate();
  }, [authenticate]);

  const startSignIn = useCallback(() => {
    const generation = ++generationRef.current;
    clearExpiryTimer();
    const attemptId = platform.runtime.randomUUID();
    dispatch({ type: "begin", phase: "redirecting", generation });
    void (signOutCleanupRef.current ?? Promise.resolve())
      .then(() => platform.auth.beginOAuthAttempt(attemptId))
      .then(() => clientRef.current!.buildLoginUrl(platform.auth.callbackUrl()))
      .then((url) => {
        if (generation === generationRef.current) {
          (navigate ?? platform.auth.navigate)(url);
        }
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
  }, [clearExpiryTimer, navigate, platform.auth, platform.runtime]);

  const signOut = useCallback(() => {
    const currentSession =
      stateRef.current.phase === "signed_in" ? stateRef.current.session : null;
    const generation = ++generationRef.current;
    const pendingAuthentication = inFlightRef.current;
    // Detach any refresh/callback operation from this auth episode. Its
    // generation guard still prevents stale completion from restoring state,
    // while a later sign-in is free to start immediately.
    inFlightRef.current = null;
    clearExpiryTimer();
    dispatch({ type: "signed_out", generation });
    const cleanup = (async () => {
      // Preserve final-write-wins semantics for async Keychain and server
      // session adapters. The stale operation remains generation-guarded;
      // sign-out cleanup runs after it and is therefore authoritative.
      await pendingAuthentication?.catch(() => undefined);
      const session =
        currentSession ?? (await platform.auth.readSession().catch(() => null));
      await Promise.allSettled([
        Promise.resolve().then(() => platform.auth.clearSession()),
        Promise.resolve().then(() => platform.auth.clearIntents()),
        Promise.resolve().then(() => clientRef.current!.signOut(session)),
      ]);
    })();
    signOutCleanupRef.current = cleanup;
    void cleanup.finally(() => {
      if (signOutCleanupRef.current === cleanup) {
        signOutCleanupRef.current = null;
      }
    });
  }, [clearExpiryTimer, platform.auth]);

  useEffect(() => {
    clearExpiryTimer();
    if (state.phase !== "signed_in" || platform.runtime.isHidden()) return;
    const delay = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(
        0,
        state.session.expiresAt * 1_000 -
          platform.runtime.now() -
          EXPIRY_REFRESH_SKEW_MS
      )
    );
    expiryTimerRef.current = platform.runtime.setTimeout(() => {
      expiryTimerRef.current = null;
      void authenticate({ forceRefresh: true });
    }, delay);
    return clearExpiryTimer;
  }, [authenticate, clearExpiryTimer, platform.runtime, state]);

  useEffect(() => {
    const handleVisibility = () => {
      clearExpiryTimer();
      if (
        !platform.runtime.isHidden() &&
        stateRef.current.phase === "signed_in"
      ) {
        void authenticate({ forceRefresh: true });
      }
    };
    const unsubscribe = platform.runtime.subscribeVisibility(handleVisibility);
    return () => {
      clearExpiryTimer();
      unsubscribe();
    };
  }, [authenticate, clearExpiryTimer, platform.runtime]);

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
