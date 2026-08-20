import { type RefObject } from "react";

import {
  exchangeCodexOauthCode,
  startCodexOauthLogin,
} from "@src/api/services/keyValidation";
import type { CodexOauthExchangeResponse } from "@src/api/tauri/rpc/schemas/validation";

import type { OAuthCaptureConfig } from "./useOAuthCapture";
import { useOAuthCapture } from "./useOAuthCapture";

interface UseCodexOAuthCaptureOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  onTokenCaptured?: (response: CodexOauthExchangeResponse) => void;
  debug?: boolean;
}

interface UseCodexOAuthCaptureReturn {
  isSigningIn: boolean;
  isSignedIn: boolean;
  isWebviewOpen: boolean;
  isWebviewLoading: boolean;
  currentUrl: string;
  authUrl: string | null;
  error: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  expiresIn: number | null;
  startLogin: () => Promise<void>;
  closeWebview: () => Promise<void>;
  reset: () => void;
  updatePosition: () => Promise<void>;
}

const CODEX_OAUTH_CONFIG: OAuthCaptureConfig<CodexOauthExchangeResponse> = {
  labelPrefix: "codex-oauth",
  commands: {
    create: "create_codex_oauth_webview",
    close: "close_codex_oauth_webview",
    updatePosition: "update_inline_webview_position",
    urlChangedEvent: "codex-oauth-url-changed",
  },
  navigateNewWindowEvent: "codex-oauth-navigate-new-window",
  allowedDomains: [
    "auth.openai.com",
    "chatgpt.com",
    "chat.openai.com",
    "openai.com",
    "accounts.google.com",
    "github.com",
    "login.microsoftonline.com",
  ],
  callbackOrigin: "http://localhost:1455",
  callbackPath: "/auth/callback",
  e2eMockUrl: "https://auth.openai.com/oauth/e2e-mock",
  e2eMockFlag: "__ORGII_E2E_CODEX_OAUTH_MOCK__",
  startLogin: startCodexOauthLogin,
  exchangeCode: ({ code, state, expectedState, codeVerifier, redirectUri }) =>
    exchangeCodexOauthCode(
      code,
      state,
      expectedState,
      codeVerifier,
      redirectUri!
    ),
};

export function useCodexOAuthCapture({
  containerRef,
  onTokenCaptured,
  debug = false,
}: UseCodexOAuthCaptureOptions): UseCodexOAuthCaptureReturn {
  const { lastResponse, ...rest } = useOAuthCapture(CODEX_OAUTH_CONFIG, {
    containerRef,
    onTokenCaptured,
    debug,
  });

  return {
    ...rest,
    accessToken: lastResponse?.accessToken ?? null,
    refreshToken: lastResponse?.refreshToken ?? null,
    idToken: lastResponse?.idToken ?? null,
    expiresIn: lastResponse?.expiresIn ?? null,
  };
}
