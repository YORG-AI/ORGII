import { useRef } from "react";
import { useTranslation } from "react-i18next";

import {
  useCodexOAuthCapture,
  useWebviewPositionSync,
} from "@src/hooks/workStation/sessionCapture";

import { OAuthSessionSetupShell } from "../OAuthSessionSetupShell";

export interface CodexSessionValues {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresIn?: number;
}

export interface CodexSessionSetupProps {
  onSessionCaptured?: (values: CodexSessionValues) => void;
  onBrowserStateChange?: (isOpen: boolean) => void;
  debug?: boolean;
  tokenDetected?: boolean;
  tokenError?: string | null;
  onClearTokenError?: () => void;
  closeSignal?: number;
  autoStart?: boolean;
}

export default function CodexSessionSetup({
  onSessionCaptured,
  onBrowserStateChange,
  debug = false,
  tokenDetected = false,
  tokenError = null,
  onClearTokenError,
  closeSignal = 0,
  autoStart = false,
}: CodexSessionSetupProps) {
  const { t } = useTranslation("integrations");
  const containerRef = useRef<HTMLDivElement>(null);
  const capture = useCodexOAuthCapture({
    containerRef,
    debug,
    onTokenCaptured: (response) => {
      onSessionCaptured?.({
        accessToken: response.accessToken,
        refreshToken: response.refreshToken,
        idToken: response.idToken,
        expiresIn: response.expiresIn ?? undefined,
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
      providerId="codex"
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
      initiallyOpen={autoStart}
      startLogin={capture.startLogin}
      closeWebview={capture.closeWebview}
      reset={capture.reset}
      copy={{
        signInTitle: t("keyVault.codexSignInTitle"),
        signInDescription: t("keyVault.codexSignInDesc"),
        signInButton: t("keyVault.signInWithCodex"),
        signedInTitle: t("keyVault.codexSignedIn"),
        signedInStatus: t("keyVault.signedIn"),
        loginStep: t("keyVault.loginStep"),
        browserHint: t("keyVault.codexBrowserHint"),
        readyTitle: t("keyVault.codexReadyToSignIn"),
        oauthHint: t("keyVault.codexOAuthHint"),
        loading: t("keyVault.loadingText"),
        failedToLoadBrowser: t("keyVault.failedToLoadBrowser"),
        retry: t("common:actions.retry"),
        close: t("common:actions.close"),
        errorHint: t("keyVault.codexSignInErrorHint"),
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
            <div>
              Id Token:{" "}
              {capture.idToken ? `${capture.idToken.slice(0, 24)}...` : "null"}
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
