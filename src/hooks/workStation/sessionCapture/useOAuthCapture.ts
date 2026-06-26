import { invoke } from "@tauri-apps/api/core";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useTauriListen } from "@src/hooks/platform/useTauriListen";

import type { EmbeddedWebviewCommands } from "./useEmbeddedWebview";
import { useEmbeddedWebview } from "./useEmbeddedWebview";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OAuthCaptureStartResult {
  authUrl: string;
  state: string;
  codeVerifier: string;
  /** Codex and Gemini provide a redirectUri; ClaudeCode does not. */
  redirectUri?: string;
}

/**
 * All data that differs between the three OAuth provider capture hooks.
 * Pass one of the pre-built provider configs or supply your own.
 */
export interface OAuthCaptureConfig<TResponse> {
  /** Unique label prefix for the embedded webview, e.g. "gemini-oauth". */
  labelPrefix: string;
  /** Tauri command names used by the embedded webview. */
  commands: EmbeddedWebviewCommands;
  /** Tauri event name that fires when the provider wants to open a new window. */
  navigateNewWindowEvent: string;
  /** Only URLs whose hostname matches (or ends with) one of these domains are allowed to navigate in-webview. */
  allowedDomains: readonly string[];
  /** Full origin of the OAuth callback redirect (e.g. "http://127.0.0.1:1456"). */
  callbackOrigin: string;
  /** Path of the OAuth callback redirect (e.g. "/oauth2callback"). */
  callbackPath: string;
  /** Auth URL used during E2E mock mode. */
  e2eMockUrl: string;
  /** `window` flag that enables the E2E mock (e.g. `__ORGII_E2E_GEMINI_OAUTH_MOCK__`). */
  e2eMockFlag: keyof Window & string;
  /**
   * Fetches the OAuth start parameters (authUrl, state, codeVerifier, optional
   * redirectUri) from the backend.
   */
  startLogin: () => Promise<OAuthCaptureStartResult>;
  /**
   * Exchanges the authorization code for tokens.
   * Receives all the PKCE parameters collected during startLogin plus the
   * callback code/state. Returns the provider-specific response object that
   * will be forwarded to `onTokenCaptured`.
   */
  exchangeCode: (params: {
    code: string;
    state: string;
    expectedState: string;
    codeVerifier: string;
    redirectUri: string | undefined;
  }) => Promise<TResponse>;
  /**
   * When `true` the webview is closed if the code exchange *fails* (Gemini
   * behaviour). On success the webview is always closed regardless of this
   * flag. Defaults to `false`.
   */
  closeWebviewOnExchangeError?: boolean;
  /**
   * When `true` `isSigningIn` is set to `true` at the start of the exchange
   * (Gemini behaviour). Defaults to `false`.
   */
  setSigningInBeforeExchange?: boolean;
}

// ---------------------------------------------------------------------------
// Hook options & return type
// ---------------------------------------------------------------------------

export interface UseOAuthCaptureOptions<TResponse> {
  containerRef: RefObject<HTMLDivElement | null>;
  onTokenCaptured?: (response: TResponse) => void;
  debug?: boolean;
}

export interface UseOAuthCaptureReturn<TResponse> {
  isSigningIn: boolean;
  isSignedIn: boolean;
  isWebviewOpen: boolean;
  isWebviewLoading: boolean;
  currentUrl: string;
  authUrl: string | null;
  error: string | null;
  /** Raw token response set after a successful exchange, or `null`. */
  lastResponse: TResponse | null;
  startLogin: () => Promise<void>;
  closeWebview: () => Promise<void>;
  reset: () => void;
  updatePosition: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// E2E mock helper (pure, testable)
// ---------------------------------------------------------------------------

export function isOAuthE2EMockEnabled(flag: keyof Window & string): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    typeof window !== "undefined" &&
    (window as Record<string, unknown>)[flag] === true
  );
}

// ---------------------------------------------------------------------------
// Domain allow-list helper (pure, testable)
// ---------------------------------------------------------------------------

export function shouldNavigateInWebview(
  url: string,
  allowedDomains: readonly string[]
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return allowedDomains.some(
    (domain) =>
      parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`)
  );
}

// ---------------------------------------------------------------------------
// Callback URL parser (pure, testable)
// ---------------------------------------------------------------------------

export interface ParsedOAuthCallback {
  code: string | null;
  state: string | null;
  oauthError: string | null;
  oauthErrorDescription: string | null;
}

export function parseOAuthCallback(
  currentUrl: string,
  callbackOrigin: string,
  callbackPath: string
): ParsedOAuthCallback | null {
  if (!currentUrl) return null;

  let parsed: URL;
  try {
    parsed = new URL(currentUrl);
  } catch {
    return null;
  }

  if (parsed.origin !== callbackOrigin || parsed.pathname !== callbackPath) {
    return null;
  }

  return {
    code: parsed.searchParams.get("code"),
    state: parsed.searchParams.get("state"),
    oauthError: parsed.searchParams.get("error"),
    oauthErrorDescription: parsed.searchParams.get("error_description"),
  };
}

// ---------------------------------------------------------------------------
// Generic hook
// ---------------------------------------------------------------------------

export function useOAuthCapture<TResponse>(
  config: OAuthCaptureConfig<TResponse>,
  {
    containerRef,
    onTokenCaptured,
    debug = false,
  }: UseOAuthCaptureOptions<TResponse>
): UseOAuthCaptureReturn<TResponse> {
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [expectedState, setExpectedState] = useState<string | null>(null);
  const [codeVerifier, setCodeVerifier] = useState<string | null>(null);
  const [redirectUri, setRedirectUri] = useState<string | undefined>(undefined);
  const [lastResponse, setLastResponse] = useState<TResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const exchangedCodeRef = useRef<string | null>(null);
  const onTokenCapturedRef = useRef(onTokenCaptured);

  useEffect(() => {
    onTokenCapturedRef.current = onTokenCaptured;
  }, [onTokenCaptured]);

  const {
    isOpen: isWebviewOpen,
    isLoading: isWebviewLoading,
    currentUrl,
    label,
    openWebview,
    closeWebview,
    updatePosition,
  } = useEmbeddedWebview({
    labelPrefix: config.labelPrefix,
    containerRef,
    commands: config.commands,
    debug,
    ignoreAboutBlank: true,
  });

  useTauriListen<{ url: string; webviewLabel: string }>(
    config.navigateNewWindowEvent,
    (payload) => {
      if (payload.webviewLabel !== label) return;
      if (!shouldNavigateInWebview(payload.url, config.allowedDomains)) return;
      void invoke("navigate_inline_webview", {
        label,
        url: payload.url,
      }).catch(() => undefined);
    }
  );

  const reset = useCallback(() => {
    setIsSigningIn(false);
    setIsSignedIn(false);
    setAuthUrl(null);
    setExpectedState(null);
    setCodeVerifier(null);
    setRedirectUri(undefined);
    setLastResponse(null);
    setError(null);
    exchangedCodeRef.current = null;
  }, []);

  const startLogin = useCallback(async () => {
    reset();
    if (isOAuthE2EMockEnabled(config.e2eMockFlag)) {
      setAuthUrl(config.e2eMockUrl);
      setExpectedState("e2e-state");
      setCodeVerifier("e2e-verifier");
      setIsSigningIn(false);
      return;
    }

    setIsSigningIn(true);
    try {
      const start = await config.startLogin();
      setAuthUrl(start.authUrl);
      setExpectedState(start.state);
      setCodeVerifier(start.codeVerifier);
      setRedirectUri(start.redirectUri);
      await openWebview(start.authUrl);
      // The webview is now showing the provider's login page. Clear the
      // signing-in flag so the loading overlay stops covering it — otherwise
      // the user can never see or interact with the login page. The real code
      // exchange phase re-sets this flag via `setSigningInBeforeExchange`.
      setIsSigningIn(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIsSigningIn(false);
    }
  }, [config, openWebview, reset]);

  const parsedCallback = useMemo(
    () =>
      parseOAuthCallback(
        currentUrl,
        config.callbackOrigin,
        config.callbackPath
      ),
    [config.callbackOrigin, config.callbackPath, currentUrl]
  );

  useEffect(() => {
    if (!parsedCallback) return;

    if (parsedCallback.oauthError) {
      queueMicrotask(() => {
        setError(
          parsedCallback.oauthErrorDescription ?? parsedCallback.oauthError
        );
        setIsSigningIn(false);
      });
      return;
    }

    if (
      !parsedCallback.code ||
      !parsedCallback.state ||
      !expectedState ||
      !codeVerifier
    ) {
      return;
    }

    const callbackCode = parsedCallback.code;
    const callbackState = parsedCallback.state;

    if (exchangedCodeRef.current === callbackCode) return;
    exchangedCodeRef.current = callbackCode;

    let cancelled = false;

    (async () => {
      try {
        if (config.setSigningInBeforeExchange) setIsSigningIn(true);

        const response = await config.exchangeCode({
          code: callbackCode,
          state: callbackState,
          expectedState,
          codeVerifier,
          redirectUri,
        });

        if (cancelled) return;

        setLastResponse(response);
        setIsSignedIn(true);
        setIsSigningIn(false);
        setError(null);
        onTokenCapturedRef.current?.(response);

        await closeWebview();
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setIsSigningIn(false);
        if (config.closeWebviewOnExchangeError) void closeWebview();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    closeWebview,
    codeVerifier,
    config,
    expectedState,
    parsedCallback,
    redirectUri,
  ]);

  return {
    isSigningIn,
    isSignedIn,
    isWebviewOpen,
    isWebviewLoading,
    currentUrl,
    authUrl,
    error,
    lastResponse,
    startLogin,
    closeWebview,
    reset,
    updatePosition,
  };
}
