import { type RefObject } from "react";

import {
  exchangeClaudeCodeOauthCode,
  startClaudeCodeOauthLogin,
} from "@src/api/services/keyValidation";
import type { ClaudeCodeOauthExchangeResponse } from "@src/api/tauri/rpc/schemas/validation";

import type { OAuthCaptureConfig } from "./useOAuthCapture";
import { useOAuthCapture } from "./useOAuthCapture";

interface UseClaudeCodeOAuthCaptureOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  onTokenCaptured?: (response: ClaudeCodeOauthExchangeResponse) => void;
  debug?: boolean;
}

interface UseClaudeCodeOAuthCaptureReturn {
  isSigningIn: boolean;
  isSignedIn: boolean;
  isWebviewOpen: boolean;
  isWebviewLoading: boolean;
  currentUrl: string;
  authUrl: string | null;
  error: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresIn: number | null;
  startLogin: () => Promise<void>;
  closeWebview: () => Promise<void>;
  reset: () => void;
  updatePosition: () => Promise<void>;
}

const CLAUDE_CODE_OAUTH_CONFIG: OAuthCaptureConfig<ClaudeCodeOauthExchangeResponse> =
  {
    labelPrefix: "claude-code-oauth",
    commands: {
      create: "create_claude_code_oauth_webview",
      close: "close_claude_code_oauth_webview",
      updatePosition: "update_inline_webview_position",
      urlChangedEvent: "claude-code-oauth-url-changed",
    },
    navigateNewWindowEvent: "claude-code-oauth-navigate-new-window",
    allowedDomains: [
      "accounts.google.com",
      "github.com",
      "login.microsoftonline.com",
      "workos.com",
      "claude.ai",
      "claude.com",
      "platform.claude.com",
    ],
    callbackOrigin: "https://platform.claude.com",
    callbackPath: "/oauth/code/callback",
    e2eMockUrl: "https://claude.ai/oauth/e2e-mock",
    e2eMockFlag: "__ORGII_E2E_CLAUDE_OAUTH_MOCK__",
    startLogin: startClaudeCodeOauthLogin,
    exchangeCode: ({ code, state, expectedState, codeVerifier }) =>
      exchangeClaudeCodeOauthCode(code, state, expectedState, codeVerifier),
  };

export function useClaudeCodeOAuthCapture({
  containerRef,
  onTokenCaptured,
  debug = false,
}: UseClaudeCodeOAuthCaptureOptions): UseClaudeCodeOAuthCaptureReturn {
  const { lastResponse, ...rest } = useOAuthCapture(CLAUDE_CODE_OAUTH_CONFIG, {
    containerRef,
    onTokenCaptured,
    debug,
  });

  return {
    ...rest,
    accessToken: lastResponse?.accessToken ?? null,
    refreshToken: lastResponse?.refreshToken ?? null,
    expiresIn: lastResponse?.expiresIn ?? null,
  };
}
