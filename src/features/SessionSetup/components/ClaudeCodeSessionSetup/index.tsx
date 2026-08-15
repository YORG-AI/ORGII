import { useRef } from "react";
import { useTranslation } from "react-i18next";

import {
  useClaudeCodeOAuthCapture,
  useWebviewPositionSync,
} from "@src/hooks/workStation/sessionCapture";

import { OAuthSessionSetupShell } from "../OAuthSessionSetupShell";

export interface ClaudeCodeSessionValues {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  accountMetadata?: Record<string, string>;
}

export interface ClaudeCodeSessionSetupProps {
  onSessionCaptured?: (values: ClaudeCodeSessionValues) => void;
  onBrowserStateChange?: (isOpen: boolean) => void;
  debug?: boolean;
  tokenDetected?: boolean;
  tokenError?: string | null;
  onClearTokenError?: () => void;
  closeSignal?: number;
}

function toClaudeCodeAccountMetadata(
  metadata: Record<string, string | null | undefined> | null | undefined
): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const entries: Array<[string, string | null | undefined]> = [
    ["email", metadata.email],
    ["organization_uuid", metadata.organizationUuid],
    ["organization_name", metadata.organizationName],
    ["organization_type", metadata.organizationType],
    ["rate_limit_tier", metadata.rateLimitTier],
  ];
  const out = Object.fromEntries(
    entries.filter(
      ([, value]) => typeof value === "string" && value.trim() !== ""
    )
  ) as Record<string, string>;
  return Object.keys(out).length > 0 ? out : undefined;
}

export default function ClaudeCodeSessionSetup({
  onSessionCaptured,
  onBrowserStateChange,
  debug = false,
  tokenDetected = false,
  tokenError = null,
  onClearTokenError,
  closeSignal = 0,
}: ClaudeCodeSessionSetupProps) {
  const { t } = useTranslation("integrations");
  const containerRef = useRef<HTMLDivElement>(null);
  const capture = useClaudeCodeOAuthCapture({
    containerRef,
    debug,
    onTokenCaptured: (response) => {
      onSessionCaptured?.({
        accessToken: response.accessToken,
        refreshToken: response.refreshToken ?? undefined,
        expiresIn: response.expiresIn ?? undefined,
        accountMetadata: toClaudeCodeAccountMetadata(response.accountMetadata),
      });
    },
  });

  useWebviewPositionSync(
    containerRef,
    capture.isWebviewOpen,
    capture.updatePosition
  );

  const hasToken =
    tokenDetected || capture.isSignedIn || Boolean(capture.accessToken);

  return (
    <OAuthSessionSetupShell
      providerId="claude-code"
      containerRef={containerRef}
      hasToken={hasToken}
      isSigningIn={capture.isSigningIn}
      isSignedIn={capture.isSignedIn}
      isWebviewOpen={capture.isWebviewOpen}
      isWebviewLoading={capture.isWebviewLoading}
      currentUrl={capture.currentUrl}
      authUrl={capture.authUrl}
      captureError={capture.error}
      tokenError={tokenError}
      onClearTokenError={onClearTokenError}
      onBrowserStateChange={onBrowserStateChange}
      closeSignal={closeSignal}
      startLogin={capture.startLogin}
      closeWebview={capture.closeWebview}
      reset={capture.reset}
      copy={{
        signInTitle: t("keyVault.claudeCodeSignInTitle"),
        signInDescription: t("keyVault.claudeCodeSignInDesc"),
        signInButton: t("keyVault.signInWithClaudeCode"),
        signedInTitle: t("keyVault.claudeCodeSignedIn"),
        signedInStatus: t("keyVault.signedIn"),
        loginStep: t("keyVault.loginStep"),
        browserHint: t("keyVault.claudeCodeBrowserHint"),
        readyTitle: t("keyVault.claudeCodeReadyToSignIn"),
        oauthHint: t("keyVault.claudeCodeOAuthHint"),
        loading: t("keyVault.loadingText"),
        failedToLoadBrowser: t("keyVault.failedToLoadBrowser"),
        retry: t("common:actions.retry"),
        close: t("common:actions.close"),
        errorHint: t("keyVault.claudeCodeSignInErrorHint"),
      }}
      debugContent={
        debug ? (
          <>
            <div>
              Access Token:{" "}
              {capture.accessToken
                ? `${capture.accessToken.slice(0, 24)}...`
                : "null"}
            </div>
            <div>
              Refresh Token:{" "}
              {capture.refreshToken
                ? `${capture.refreshToken.slice(0, 24)}...`
                : "null"}
            </div>
            <div>Expires In: {capture.expiresIn ?? "null"}</div>
            <div>Is Webview Open: {String(capture.isWebviewOpen)}</div>
            <div>Current URL: {capture.currentUrl || "null"}</div>
          </>
        ) : undefined
      }
    />
  );
}
