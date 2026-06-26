import { type RefObject } from "react";

import {
  exchangeGeminiOauthCode,
  startGeminiOauthLogin,
} from "@src/api/services/keyValidation";
import type { GeminiOauthExchangeResponse } from "@src/api/tauri/rpc/schemas/validation";

import type { OAuthCaptureConfig } from "./useOAuthCapture";
import { useOAuthCapture } from "./useOAuthCapture";

interface UseGeminiOAuthCaptureOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  onTokenCaptured?: (response: GeminiOauthExchangeResponse) => void;
  debug?: boolean;
}

interface UseGeminiOAuthCaptureReturn {
  isSigningIn: boolean;
  isSignedIn: boolean;
  isWebviewOpen: boolean;
  isWebviewLoading: boolean;
  currentUrl: string;
  authUrl: string | null;
  error: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  projectId: string | null;
  expiresIn: number | null;
  startLogin: () => Promise<void>;
  closeWebview: () => Promise<void>;
  reset: () => void;
  updatePosition: () => Promise<void>;
}

const GEMINI_OAUTH_CONFIG: OAuthCaptureConfig<GeminiOauthExchangeResponse> = {
  labelPrefix: "gemini-oauth",
  commands: {
    create: "create_gemini_oauth_webview",
    close: "close_gemini_oauth_webview",
    updatePosition: "update_inline_webview_position",
    urlChangedEvent: "gemini-oauth-url-changed",
  },
  navigateNewWindowEvent: "gemini-oauth-navigate-new-window",
  allowedDomains: [
    "accounts.google.com",
    "google.com",
    "gstatic.com",
    "cloud.google.com",
    "cloudcode-pa.googleapis.com",
  ],
  callbackOrigin: "http://127.0.0.1:1456",
  callbackPath: "/oauth2callback",
  e2eMockUrl: "https://accounts.google.com/o/oauth2/v2/auth/e2e-mock",
  e2eMockFlag: "__ORGII_E2E_GEMINI_OAUTH_MOCK__",
  startLogin: startGeminiOauthLogin,
  exchangeCode: ({ code, state, expectedState, codeVerifier, redirectUri }) =>
    exchangeGeminiOauthCode(
      code,
      state,
      expectedState,
      codeVerifier,
      redirectUri!
    ),
  closeWebviewOnExchangeError: true,
  setSigningInBeforeExchange: true,
};

export function useGeminiOAuthCapture({
  containerRef,
  onTokenCaptured,
  debug = false,
}: UseGeminiOAuthCaptureOptions): UseGeminiOAuthCaptureReturn {
  const { lastResponse, ...rest } = useOAuthCapture(GEMINI_OAUTH_CONFIG, {
    containerRef,
    onTokenCaptured,
    debug,
  });

  return {
    ...rest,
    accessToken: lastResponse?.accessToken ?? null,
    refreshToken: lastResponse?.refreshToken ?? null,
    projectId: lastResponse?.projectId ?? null,
    expiresIn: lastResponse?.expiresIn ?? null,
  };
}
