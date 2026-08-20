/**
 * useCursorSessionCapture Hook
 *
 * Manages Cursor native OAuth capture via embedded browser.
 * Uses Cursor's CLI OAuth polling flow to obtain a native chat access token.
 *
 * @example
 * const {
 *   sessionToken,
 *   isCapturing,
 *   startCapture,
 *   stopCapture,
 *   clearToken
 * } = useCursorSessionCapture({
 *   containerRef,
 *   onTokenCaptured: (token) => */
import { invoke } from "@tauri-apps/api/core";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { rpc } from "@src/api/tauri/rpc";
import { createLogger } from "@src/hooks/logger";
import { useTauriListen } from "@src/hooks/platform/useTauriListen";
import { toNativeFrame } from "@src/util/platform/tauri/nativeFrame";

import { useEmbeddedWebview } from "./useEmbeddedWebview";

const logger = createLogger("CursorSessionCapture");

// ============================================
// Type Definitions
// ============================================

export interface CursorSessionTokenPayload {
  token: string;
  url: string;
  timestamp: number;
}

export interface CursorUrlChangePayload {
  url: string;
  timestamp: number;
}

export interface CursorLoginDetectedPayload {
  email: string;
  pseudoToken: string;
  isLoggedIn: boolean;
  timestamp: number;
}

export interface UseCursorSessionCaptureOptions {
  /** Ref to the container element for the webview */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Callback when native OAuth session token is captured */
  onTokenCaptured?: (sessionToken: string) => void;
  /** Callback when URL changes in the webview */
  onUrlChange?: (url: string) => void;
  /** Enable debug logging */
  debug?: boolean;
}

export interface UseCursorSessionCaptureReturn {
  /** Captured session token (null if not yet captured) */
  sessionToken: string | null;
  /** Current URL in the webview */
  currentUrl: string;
  /** Whether the capture webview is active */
  isCapturing: boolean;
  /** Whether the webview is loading */
  isLoading: boolean;
  /** Error message if any */
  error: string | null;
  /** Start the capture flow (creates webview) */
  startCapture: () => Promise<void>;
  /** Open a regular Cursor URL without starting token polling */
  openUrl: (url: string) => Promise<void>;
  /** Stop the capture flow (destroys webview) */
  stopCapture: () => Promise<void>;
  /** Clear the captured token */
  clearToken: () => void;
  /** Navigate the webview to a URL */
  navigate: (url: string) => Promise<void>;
  /** Update webview position (call on resize) */
  updatePosition: () => Promise<void>;
  /** Manually confirm login when automatic detection fails */
  confirmLogin: () => void;
  /** Parsed token info (user_id, expires_at) */
  tokenInfo: {
    userId: string | null;
    expiresAt: Date | null;
    isValid: boolean;
  };
}

// ============================================
// Helper Functions
// ============================================

/**
 * Parse Cursor session token to extract user ID and expiration
 */
function parseSessionToken(token: string): {
  userId: string | null;
  expiresAt: Date | null;
  isValid: boolean;
} {
  try {
    // Token format: {USER_ID}%3A%3A{JWT_TOKEN}
    const parts = token.split("%3A%3A");
    if (parts.length !== 2) {
      return { userId: null, expiresAt: null, isValid: false };
    }

    const [userId, jwtToken] = parts;

    // Decode JWT to get expiration
    const jwtParts = jwtToken.split(".");
    if (jwtParts.length < 2) {
      return { userId, expiresAt: null, isValid: false };
    }

    // Decode payload (base64url)
    let payloadB64 = jwtParts[1];
    // Add padding if needed
    payloadB64 += "=".repeat((4 - (payloadB64.length % 4)) % 4);
    const payload = JSON.parse(atob(payloadB64));

    const expTimestamp = payload.exp;
    const expiresAt = expTimestamp ? new Date(expTimestamp * 1000) : null;
    const isValid = expiresAt ? new Date() < expiresAt : false;

    return { userId, expiresAt, isValid };
  } catch (error) {
    logger.error("Failed to parse token:", error);
    return { userId: null, expiresAt: null, isValid: false };
  }
}

/**
 * Sentinel value stored in `sessionToken` when the user manually
 * confirms login via `confirmLogin()`. This is NOT a real Cursor
 * session token and must NOT be passed to the key vault. Callers
 * should check `tokenInfo.isValid` (which returns `false` for this
 * value) before treating `sessionToken` as persitable.
 */
export const CURSOR_CONFIRM_LOGIN_SENTINEL = "manual_confirmed";

const CURSOR_COMMANDS = {
  create: "create_cursor_session_webview",
  close: "close_cursor_session_webview",
  updatePosition: "update_inline_webview_position",
  urlChangedEvent: "cursor-webview-url-changed",
} as const;

// ============================================
// Hook Implementation
// ============================================

export function useCursorSessionCapture(
  options: UseCursorSessionCaptureOptions
): UseCursorSessionCaptureReturn {
  const { containerRef, onTokenCaptured, onUrlChange, debug = false } = options;

  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const {
    isOpen: isCapturing,
    isLoading,
    currentUrl,
    label,
    openWebview,
    closeWebview,
    updatePosition,
  } = useEmbeddedWebview({
    labelPrefix: "cursor-session",
    containerRef,
    commands: CURSOR_COMMANDS,
    debug,
  });

  // Keep callbacks in a ref to avoid stale closures in async event handlers
  const callbacksRef = useRef({ onTokenCaptured, onUrlChange });
  const authFlowIdRef = useRef(0);
  useEffect(() => {
    callbacksRef.current = { onTokenCaptured, onUrlChange };
  }, [onTokenCaptured, onUrlChange]);

  // Forward URL changes from the base hook to the consumer callback.
  // Only one forwarding path is needed — the Tauri event listener below
  // is the authoritative source; this effect is intentionally removed to
  // prevent onUrlChange from firing twice for the same navigation.
  const prevUrlRef = useRef(currentUrl);
  useEffect(() => {
    prevUrlRef.current = currentUrl;
  }, [currentUrl]);

  // ============================================
  // Auth event listeners (Cursor-specific)
  // ============================================

  useTauriListen<CursorSessionTokenPayload>(
    "cursor-session-token-captured",
    () => undefined
  );

  useTauriListen<{ token: string; source: string; timestamp: number }>(
    "cursor-cookie-found",
    () => undefined
  );

  useTauriListen<CursorLoginDetectedPayload>(
    "cursor-login-detected",
    () => undefined
  );

  useTauriListen<CursorUrlChangePayload>(
    "cursor-webview-url-changed",
    (payload) => {
      callbacksRef.current.onUrlChange?.(payload.url);
    }
  );

  useTauriListen<{ url: string; webviewLabel: string }>(
    "cursor-webview-navigate-oauth",
    (payload) => {
      if (payload.webviewLabel !== label) return;
      void invoke("navigate_inline_webview", {
        label,
        url: payload.url,
      }).catch(() => {
        // Ignore navigation errors
      });
    }
  );

  // ============================================
  // Webview management
  // ============================================

  // Track pending position-nudge timers so they can be cancelled on unmount
  // or if the webview is closed before the delays fire.
  const nudgeTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    return () => {
      for (const timer of nudgeTimersRef.current) {
        clearTimeout(timer);
      }
      nudgeTimersRef.current = [];
    };
  }, []);

  const nudgePosition = useCallback(() => {
    const INSET = 2;
    for (const timer of nudgeTimersRef.current) {
      clearTimeout(timer);
    }
    nudgeTimersRef.current = [50, 150, 300].map((delay) =>
      setTimeout(() => {
        if (!containerRef.current) return;
        const newRect = containerRef.current.getBoundingClientRect();
        const frame = toNativeFrame(newRect, INSET);
        void invoke("update_inline_webview_position", {
          label,
          ...frame,
        }).catch(() => {
          // Ignore — webview may have been closed before this fires.
        });
      }, delay)
    );
  }, [containerRef, label]);

  const ensureContainerReady = useCallback(() => {
    if (!containerRef.current) {
      setError("Container not available");
      return false;
    }

    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      setError("Container has no dimensions");
      return false;
    }

    return true;
  }, [containerRef]);

  const startCapture = useCallback(async () => {
    if (!ensureContainerReady()) return;

    const flowId = authFlowIdRef.current + 1;
    authFlowIdRef.current = flowId;
    setError(null);
    try {
      logger.info("starting native OAuth login");
      const oauth = await rpc.validation.startCursorNativeOauthLogin();
      await openWebview(oauth.loginUrl);
      logger.info("embedded browser opened");
      nudgePosition();

      logger.info("waiting for native OAuth token");
      const token = await rpc.validation.pollCursorNativeOauthToken({
        uuid: oauth.uuid,
        verifier: oauth.verifier,
      });
      if (authFlowIdRef.current !== flowId) return;
      logger.info("native OAuth token captured");
      setSessionToken(token.accessToken);
      callbacksRef.current.onTokenCaptured?.(token.accessToken);
    } catch (err) {
      if (authFlowIdRef.current !== flowId) return;
      const errorMsg = err instanceof Error ? err.message : String(err);
      setError(errorMsg);
    }
  }, [ensureContainerReady, openWebview, nudgePosition]);

  const openUrl = useCallback(
    async (url: string) => {
      if (!ensureContainerReady()) return;
      authFlowIdRef.current += 1;
      setError(null);
      await openWebview(url);
      nudgePosition();
    },
    [ensureContainerReady, nudgePosition, openWebview]
  );

  const stopCapture = useCallback(async () => {
    authFlowIdRef.current += 1;
    if (!isCapturing) return;
    await closeWebview();
  }, [isCapturing, closeWebview]);

  const clearToken = useCallback(() => {
    setSessionToken(null);
  }, []);

  // confirmLogin is intentionally a local UI signal only — it does NOT
  // call onTokenCaptured because there is no real token to persist.
  // Callers that need to react to a manual confirmation should check
  // `sessionToken === CURSOR_CONFIRM_LOGIN_SENTINEL` or `tokenInfo.isValid`.
  // The sentinel is never written to the key vault.
  const confirmLogin = useCallback(() => {
    setSessionToken(CURSOR_CONFIRM_LOGIN_SENTINEL);
  }, []);

  const navigate = useCallback(
    async (url: string) => {
      if (!isCapturing) return;
      try {
        await invoke("navigate_inline_webview", { label, url });
      } catch {
        // Ignore navigation errors
      }
    },
    [isCapturing, label]
  );

  const tokenInfo = sessionToken
    ? parseSessionToken(sessionToken)
    : { userId: null, expiresAt: null, isValid: false };

  return {
    sessionToken,
    currentUrl,
    isCapturing,
    isLoading,
    error,
    startCapture,
    openUrl,
    stopCapture,
    clearToken,
    navigate,
    updatePosition,
    confirmLogin,
    tokenInfo,
  };
}

export default useCursorSessionCapture;
