/**
 * useKiroSessionCapture Hook
 *
 * Manages Kiro Pro credential capture by driving the official `kiro-cli login`
 * binary in a PTY (`start_kiro_login` / `cancel_kiro_login`). Parses the device
 * code from the CLI's stdout and opens an embedded webview for AWS IAM
 * Identity Center login. The previous direct-AWS-SDK SSO commands
 * (`start_kiro_sso_login` / `cancel_kiro_sso_login`) were archived to drop
 * the AWS SDK dependency tree.
 *
 * @example
 * const {
 *   isLoggingIn,
 *   isLoggedIn,
 *   deviceCode,
 *   accessToken,
 *   refreshToken,
 *   error,
 *   startLogin,
 *   cancelLogin,
 *   reset,
 *   openWebview,
 *   closeWebview,
 *   isWebviewOpen,
 * } = useKiroSessionCapture({ debug: true, containerRef });
 */
import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn, listen } from "@tauri-apps/api/event";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { useEmbeddedWebview } from "./useEmbeddedWebview";

// ============================================
// Type Definitions
// ============================================

export interface KiroLoginProgressPayload {
  /** Current status: "starting" | "waiting_for_code" | "browser_ready" | "waiting_for_auth" | "device_authorized" | "success" | "error" */
  status: string;
  /** Device code to display (if status is "waiting_for_code") */
  deviceCode?: string;
  /** Verification URL to open in browser (if status is "browser_ready" or "waiting_for_code") */
  verificationUrl?: string;
  /** Error message (if status is "error") */
  error?: string;
  /** Raw stdout line for debugging */
  stdout?: string;
}

export interface KiroLoginCompletePayload {
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  startUrl?: string;
  region?: string;
  expiresAt?: string;
  error?: string;
}

export interface UseKiroSessionCaptureOptions {
  /** Enable debug logging */
  debug?: boolean;
  /** Container ref for embedded webview positioning */
  containerRef?: RefObject<HTMLDivElement | null>;
}

export interface UseKiroSessionCaptureReturn {
  /** Whether login is in progress */
  isLoggingIn: boolean;
  /** Whether login completed successfully */
  isLoggedIn: boolean;
  /** Device code to display to user */
  deviceCode: string | null;
  /** Verification URL for browser */
  verificationUrl: string | null;
  /** Error message if any */
  error: string | null;
  /** Captured access token */
  accessToken: string | null;
  /** Captured refresh token */
  refreshToken: string | null;
  /** Captured client ID (for token refresh) */
  clientId: string | null;
  /** Captured client secret (for token refresh) */
  clientSecret: string | null;
  /** SSO start URL */
  startUrl: string | null;
  /** AWS region */
  region: string | null;
  /** Access token expiry timestamp */
  expiresAt: string | null;
  /** Whether the embedded webview is open */
  isWebviewOpen: boolean;
  /** Whether the webview is loading */
  isWebviewLoading: boolean;
  /** Current URL in the webview */
  currentUrl: string;
  /** Start the login flow */
  startLogin: (startUrl: string, region: string) => Promise<void>;
  /** Cancel the login flow */
  cancelLogin: () => Promise<void>;
  /** Reset state for retry */
  reset: () => void;
  /** Open the embedded webview to the verification URL */
  openWebview: (url?: string) => Promise<void>;
  /** Close the embedded webview */
  closeWebview: () => Promise<void>;
  /** Update webview position (call on resize) */
  updatePosition: () => Promise<void>;
}

const KIRO_COMMANDS = {
  create: "create_kiro_auth_webview",
  close: "close_kiro_auth_webview",
  urlChangedEvent: "kiro-webview-url-changed",
  // No updatePosition command — base hook falls back to close+recreate
} as const;

// ============================================
// Hook Implementation
// ============================================

export function useKiroSessionCapture(
  options: UseKiroSessionCaptureOptions = {}
): UseKiroSessionCaptureReturn {
  const { debug, containerRef } = options;

  // Auth-specific state
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [startUrl, setStartUrl] = useState<string | null>(null);
  const [region, setRegion] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);

  const {
    isOpen: isWebviewOpen,
    isLoading: isWebviewLoading,
    currentUrl,
    openWebview,
    closeWebview,
    updatePosition,
  } = useEmbeddedWebview({
    labelPrefix: "kiro-auth",
    containerRef,
    commands: KIRO_COMMANDS,
    debug,
  });

  // Refs for Tauri event listeners
  const progressListenerRef = useRef<UnlistenFn | null>(null);
  const completeListenerRef = useRef<UnlistenFn | null>(null);

  // ============================================
  // Auth event listeners (Kiro-specific)
  // ============================================

  useEffect(() => {
    let isMounted = true;

    const setupListeners = async () => {
      try {
        const progressUnlisten = await listen<KiroLoginProgressPayload>(
          "kiro-login-progress",
          (event) => {
            if (!isMounted) return;

            const {
              status,
              deviceCode: code,
              verificationUrl: url,
              error: errMsg,
            } = event.payload;

            if (status === "browser_ready") {
              if (code) setDeviceCode(code);
              if (url) setVerificationUrl(url);
            }

            if (status === "error" && errMsg) {
              setError(errMsg);
              setIsLoggingIn(false);
            }
          }
        );
        if (isMounted) progressListenerRef.current = progressUnlisten;

        const completeUnlisten = await listen<KiroLoginCompletePayload>(
          "kiro-login-complete",
          (event) => {
            if (!isMounted) return;

            const {
              success,
              accessToken: at,
              refreshToken: rt,
              clientId: cid,
              clientSecret: csecret,
              startUrl: surl,
              region: reg,
              expiresAt: exp,
              error: errMsg,
            } = event.payload;

            setIsLoggingIn(false);

            if (success && at) {
              setAccessToken(at);
              setRefreshToken(rt || null);
              setClientId(cid || null);
              setClientSecret(csecret || null);
              setStartUrl(surl || null);
              setRegion(reg || null);
              setExpiresAt(exp || null);
              setIsLoggedIn(true);
              setError(null);
            } else {
              setError(errMsg || "Login failed");
              setIsLoggedIn(false);
            }
          }
        );
        if (isMounted) completeListenerRef.current = completeUnlisten;
      } catch {
        // Ignore listener setup errors
      }
    };

    setupListeners();

    return () => {
      isMounted = false;
      progressListenerRef.current?.();
      progressListenerRef.current = null;
      completeListenerRef.current?.();
      completeListenerRef.current = null;
    };
  }, []);

  // Close webview automatically when login completes
  useEffect(() => {
    if (isLoggedIn && isWebviewOpen) {
      const timeout = setTimeout(() => {
        closeWebview();
      }, 0);
      return () => clearTimeout(timeout);
    }
  }, [isLoggedIn, isWebviewOpen, closeWebview]);

  // ============================================
  // Auth actions
  // ============================================

  const startLogin = useCallback(
    async (identityProvider: string, loginRegion: string) => {
      try {
        setIsLoggingIn(true);
        setError(null);
        setDeviceCode(null);
        setVerificationUrl(null);
        setAccessToken(null);
        setRefreshToken(null);
        setClientId(null);
        setClientSecret(null);
        setStartUrl(null);
        setRegion(null);
        setExpiresAt(null);
        setIsLoggedIn(false);

        await invoke("start_kiro_login", {
          identityProvider,
          region: loginRegion,
        });
      } catch (err: unknown) {
        let errorMsg = "Unknown error";
        if (err instanceof Error) {
          errorMsg = err.message;
        } else if (typeof err === "string") {
          errorMsg = err;
        } else if (err && typeof err === "object" && "message" in err) {
          errorMsg = String((err as { message: unknown }).message);
        }
        setError(`error: ${errorMsg}`);
        setIsLoggingIn(false);
      }
    },
    []
  );

  const cancelLogin = useCallback(async () => {
    try {
      await invoke("cancel_kiro_login");
      setIsLoggingIn(false);
      setDeviceCode(null);
    } catch {
      // Ignore cancel errors
    }
  }, []);

  const reset = useCallback(() => {
    setIsLoggingIn(false);
    setIsLoggedIn(false);
    setDeviceCode(null);
    setVerificationUrl(null);
    setError(null);
    setAccessToken(null);
    setRefreshToken(null);
    setClientId(null);
    setClientSecret(null);
    setStartUrl(null);
    setRegion(null);
    setExpiresAt(null);
  }, []);

  const openWebviewWithFallback = useCallback(
    async (url?: string) => {
      const urlToOpen = url || verificationUrl;
      if (!urlToOpen) return;

      if (!containerRef?.current) {
        window.open(urlToOpen, "_blank");
        return;
      }

      try {
        await openWebview(urlToOpen);
      } catch {
        window.open(urlToOpen, "_blank");
      }
    },
    [verificationUrl, containerRef, openWebview]
  );

  return {
    isLoggingIn,
    isLoggedIn,
    deviceCode,
    verificationUrl,
    error,
    accessToken,
    refreshToken,
    clientId,
    clientSecret,
    startUrl,
    region,
    expiresAt,
    isWebviewOpen,
    isWebviewLoading,
    currentUrl,
    startLogin,
    cancelLogin,
    reset,
    openWebview: openWebviewWithFallback,
    closeWebview,
    updatePosition,
  };
}

export default useKiroSessionCapture;
