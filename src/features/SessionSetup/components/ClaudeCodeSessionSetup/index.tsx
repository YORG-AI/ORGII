import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import SessionSetupStepIndicator from "@src/features/SessionSetup/components/SessionSetupStepIndicator";
import { useClaudeCodeOAuthCapture } from "@src/features/SessionSetup/hooks/useClaudeCodeOAuthCapture";
import { useOAuthBrowserAutoStart } from "@src/features/SessionSetup/hooks/useOAuthBrowserAutoStart";
import { useWebviewPositionSync } from "@src/features/SessionSetup/hooks/useWebviewPositionSync";
import {
  AlertCircleIcon,
  ArrowRight01Icon,
  Cancel01Icon,
  CheckmarkCircle01Icon,
  HugeiconsIcon,
  Loading03Icon,
  Login01Icon,
  Refresh04Icon,
} from "@src/icons";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

export interface ClaudeCodeSessionValues {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  accountMetadata?: Record<string, string>;
}

interface ClaudeCodeSessionSetupProps {
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

const ClaudeCodeSessionSetup: React.FC<ClaudeCodeSessionSetupProps> = ({
  onSessionCaptured,
  onBrowserStateChange,
  debug = false,
  tokenDetected = false,
  tokenError = null,
  onClearTokenError,
  closeSignal = 0,
}) => {
  const { t } = useTranslation("integrations");
  const [showBrowser, setShowBrowser] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const {
    isSigningIn,
    isSignedIn,
    isWebviewOpen,
    isWebviewLoading,
    currentUrl,
    authUrl,
    error,
    accessToken,
    refreshToken,
    expiresIn,
    startLogin,
    closeWebview,
    reset,
    updatePosition,
  } = useClaudeCodeOAuthCapture({
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

  useEffect(() => {
    onBrowserStateChange?.(showBrowser);
  }, [showBrowser, onBrowserStateChange]);

  useEffect(() => {
    if (!isWebviewOpen && isSignedIn) {
      queueMicrotask(() => setShowBrowser(false));
    }
  }, [isSignedIn, isWebviewOpen]);

  useOAuthBrowserAutoStart(showBrowser, startLogin);

  useWebviewPositionSync(containerRef, isWebviewOpen, updatePosition);

  const handleCloseBrowser = useCallback(() => {
    void closeWebview();
    setShowBrowser(false);
  }, [closeWebview]);

  useEffect(() => {
    if (closeSignal <= 0 || !showBrowser) return;
    queueMicrotask(() => handleCloseBrowser());
  }, [closeSignal, handleCloseBrowser, showBrowser]);

  const handleRetry = useCallback(() => {
    reset();
    setShowBrowser(true);
    void startLogin();
  }, [reset, startLogin]);

  const hasToken = tokenDetected || isSignedIn || Boolean(accessToken);
  const displayError = error ?? tokenError;
  const currentStep = hasToken ? 2 : 1;

  return (
    <div
      className="flex h-full min-h-0 w-full flex-1 flex-col gap-3"
      data-testid="claude-code-session-setup"
    >
      {!showBrowser ? (
        <SectionContainer>
          <SectionRow
            label={
              hasToken
                ? t("keyVault.claudeCodeSignedIn")
                : t("keyVault.claudeCodeSignInTitle")
            }
            description={
              hasToken
                ? t("keyVault.signedIn")
                : t("keyVault.claudeCodeSignInDesc")
            }
            required
          >
            <Button
              variant={hasToken ? "success" : "primary"}
              appearance={hasToken ? "outline" : "solid"}
              size="default"
              loading={isSigningIn || isWebviewLoading}
              disabled={isSigningIn || isWebviewLoading}
              onClick={() => setShowBrowser(true)}
              className="h-8 min-h-8"
              data-testid="claude-code-oauth-signin"
            >
              {hasToken
                ? `✓ ${t("keyVault.signedIn")}`
                : t("keyVault.signInWithClaudeCode")}
            </Button>
          </SectionRow>
        </SectionContainer>
      ) : (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden bg-fill-2"
          data-testid="claude-code-oauth-browser-shell"
        >
          <div className="flex h-10 items-center border-b border-border-2 bg-fill-2 px-3">
            <div
              className="flex-1 overflow-hidden text-[12px] text-ellipsis whitespace-nowrap text-text-1"
              data-testid="claude-code-oauth-current-url"
            >
              {currentUrl || authUrl || t("keyVault.claudeCodeReadyToSignIn")}
            </div>
            <Button
              variant="tertiary"
              size="mini"
              icon={
                <HugeiconsIcon
                  icon={Refresh04Icon}
                  data-icon="refresh-cw"
                  size={12}
                />
              }
              iconOnly
              onClick={handleRetry}
            />
            <Button
              variant="tertiary"
              size="mini"
              icon={
                <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={14} />
              }
              iconOnly
              onClick={handleCloseBrowser}
              data-testid="claude-code-oauth-browser-close"
            />
          </div>

          <div className="flex h-9 items-center justify-between gap-2 border-b border-border-2 bg-fill-2 px-4">
            <div className="flex items-center gap-2">
              <SessionSetupStepIndicator
                step={1}
                currentStep={currentStep}
                label={t("keyVault.loginStep")}
                completed={hasToken}
              />
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                data-icon="chevron-right"
                size={14}
                className="text-text-3"
              />
              <SessionSetupStepIndicator
                step={2}
                currentStep={currentStep}
                label={t("keyVault.signedIn")}
                completed={hasToken}
              />
            </div>
            {!hasToken && (
              <span className="text-[12px] text-text-2">
                {t("keyVault.claudeCodeBrowserHint")}
              </span>
            )}
          </div>

          <div
            ref={containerRef}
            className="relative min-h-0 w-full flex-1 overflow-hidden bg-bg-1"
            data-testid="claude-code-oauth-webview-container"
          >
            {(isSigningIn || isWebviewLoading) && (
              <div className="absolute inset-0 flex items-center justify-center bg-bg-1">
                <HugeiconsIcon
                  icon={Loading03Icon}
                  data-icon="loader-2"
                  size={SPINNER_TOKENS.default}
                  className="animate-spin text-primary-6"
                />
                <span className="ml-2 text-text-2">
                  {t("keyVault.loadingText")}
                </span>
              </div>
            )}
            {displayError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-bg-1 p-6 text-center">
                <HugeiconsIcon
                  icon={AlertCircleIcon}
                  data-icon="alert-circle"
                  size={32}
                  className="mb-3 text-danger-6"
                />
                <div className="mb-2 text-[14px] text-text-2">
                  {t("keyVault.failedToLoadBrowser")}
                </div>
                <div className="mb-4 text-[12px] text-text-3">
                  {displayError}
                </div>
                <Button variant="primary" size="default" onClick={handleRetry}>
                  {t("common:actions.retry")}
                </Button>
              </div>
            )}
            {!isWebviewOpen && !isSigningIn && !displayError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-bg-1 p-6 text-center">
                {hasToken ? (
                  <HugeiconsIcon
                    icon={CheckmarkCircle01Icon}
                    data-icon="check-circle"
                    size={32}
                    className="mb-3 text-success-6"
                  />
                ) : (
                  <HugeiconsIcon
                    icon={Login01Icon}
                    data-icon="log-in"
                    size={32}
                    className="mb-3 text-text-3"
                  />
                )}
                <div className="mb-2 text-[14px] font-medium text-text-1">
                  {hasToken
                    ? t("keyVault.claudeCodeSignedIn")
                    : t("keyVault.claudeCodeReadyToSignIn")}
                </div>
                <div className="max-w-sm text-[12px] text-text-3">
                  {t("keyVault.claudeCodeOAuthHint")}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {hasToken && !showBrowser && (
        <InlineAlert type="success">
          {t("keyVault.claudeCodeSignedIn")}
        </InlineAlert>
      )}

      {displayError && !showBrowser && (
        <InlineAlert
          type="danger"
          title={displayError}
          onClose={error ? reset : onClearTokenError}
        >
          {t("keyVault.claudeCodeSignInErrorHint")}
        </InlineAlert>
      )}

      {debug && (
        <div className="mt-4 rounded-lg bg-bg-3 p-3 text-[11px] text-text-3">
          <div>
            Access Token:{" "}
            {accessToken ? `${accessToken.slice(0, 24)}...` : "null"}
          </div>
          <div>
            Refresh Token:{" "}
            {refreshToken ? `${refreshToken.slice(0, 24)}...` : "null"}
          </div>
          <div>Expires In: {expiresIn ?? "null"}</div>
          <div>Is Webview Open: {String(isWebviewOpen)}</div>
          <div>Current URL: {currentUrl || "null"}</div>
        </div>
      )}
    </div>
  );
};

export default ClaudeCodeSessionSetup;
