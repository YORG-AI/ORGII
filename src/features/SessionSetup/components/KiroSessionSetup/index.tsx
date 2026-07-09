/**
 * KiroSessionSetup Component
 *
 * Guided setup for Kiro Pro authentication with embedded webview.
 * Flow:
 * 1. User enters AWS IAM Identity Center URL and region
 * 2. Click Login to Kiro → kiro-cli starts device flow
 * 3. Embedded webview opens with AWS login page
 * 4. User completes login → kiro-cli captures tokens
 * 5. Session tokens are returned to parent
 *
 * @example
 * <KiroSessionSetup
 *   onSessionCaptured={({ accessToken, refreshToken }) => {
 *     // Handle captured credentials
 *   }}
 * />
 */
import {
  AlertCircle,
  CheckCircle,
  Copy,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import IconButton from "@src/components/IconButton";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import Select from "@src/components/Select";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import { useKiroSessionCapture } from "@src/hooks/workStation/sessionCapture/useKiroSessionCapture";
import { useWebviewPositionSync } from "@src/hooks/workStation/sessionCapture/useWebviewPositionSync";
import {
  SECTION_CONTROL_STYLE,
  SECTION_GAP_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { copyText } from "@src/util/data/clipboard";

// ============================================
// Type Definitions
// ============================================

export interface KiroSessionValues {
  accessToken: string;
  refreshToken: string;
  clientId?: string;
  clientSecret?: string;
  startUrl?: string;
  region?: string;
  expiresAt?: string;
}

export interface KiroSessionSetupProps {
  /** Callback when credentials are captured */
  onSessionCaptured?: (values: KiroSessionValues) => void;
  /** Initial Identity Center Start URL */
  initialStartUrl?: string;
  /** Initial Region */
  initialRegion?: string;
  /** Show debug info */
  debug?: boolean;
  /** Callback when login state changes */
  onLoginStateChange?: (isLoggedIn: boolean) => void;
}

// ============================================
// Constants
// ============================================

const AWS_REGIONS = [
  { value: "us-east-1", label: "US East (N. Virginia)" },
  { value: "us-east-2", label: "US East (Ohio)" },
  { value: "us-west-1", label: "US West (N. California)" },
  { value: "us-west-2", label: "US West (Oregon)" },
  { value: "eu-west-1", label: "Europe (Ireland)" },
  { value: "eu-west-2", label: "Europe (London)" },
  { value: "eu-central-1", label: "Europe (Frankfurt)" },
  { value: "ap-northeast-1", label: "Asia Pacific (Tokyo)" },
  { value: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
  { value: "ap-southeast-2", label: "Asia Pacific (Sydney)" },
];

// ============================================
// Component Implementation
// ============================================

const KiroSessionSetup: React.FC<KiroSessionSetupProps> = ({
  onSessionCaptured,
  initialStartUrl = "",
  initialRegion = "us-east-1",
  debug = false,
  onLoginStateChange,
}) => {
  const { t } = useTranslation("integrations");

  // Form state
  const [startUrl, setStartUrl] = useState(initialStartUrl);
  const [region, setRegion] = useState(initialRegion);
  const [showBrowser, setShowBrowser] = useState(false);

  // Container ref for webview
  const containerRef = useRef<HTMLDivElement>(null);

  // Use credential capture hook with container ref
  const {
    isLoggingIn,
    isLoggedIn,
    deviceCode,
    verificationUrl,
    error,
    accessToken,
    refreshToken,
    clientId,
    clientSecret,
    startUrl: capturedStartUrl,
    region: capturedRegion,
    expiresAt,
    isWebviewOpen,
    isWebviewLoading,
    currentUrl,
    startLogin,
    cancelLogin,
    reset,
    openWebview,
    closeWebview,
    updatePosition,
  } = useKiroSessionCapture({ debug, containerRef });

  // Notify parent when login state changes
  useEffect(() => {
    onLoginStateChange?.(isLoggedIn);
  }, [isLoggedIn, onLoginStateChange]);

  // Track if we've already triggered the callback
  const hasTriggeredRef = useRef(false);
  const callbackRef = useRef(onSessionCaptured);

  // Update callback ref
  useEffect(() => {
    callbackRef.current = onSessionCaptured;
  }, [onSessionCaptured]);

  // Auto-trigger callback when credentials are captured
  useEffect(() => {
    if (isLoggedIn && accessToken && !hasTriggeredRef.current) {
      hasTriggeredRef.current = true;
      callbackRef.current?.({
        accessToken,
        refreshToken: refreshToken || "",
        clientId: clientId || undefined,
        clientSecret: clientSecret || undefined,
        startUrl: capturedStartUrl || startUrl || undefined,
        region: capturedRegion || region || undefined,
        expiresAt: expiresAt || undefined,
      });
    }
  }, [
    isLoggedIn,
    accessToken,
    refreshToken,
    clientId,
    clientSecret,
    capturedStartUrl,
    capturedRegion,
    startUrl,
    region,
    expiresAt,
  ]);

  // Reset trigger flag if login state resets
  useEffect(() => {
    if (!isLoggedIn) {
      hasTriggeredRef.current = false;
    }
  }, [isLoggedIn]);

  // Auto-open webview when verification URL is ready
  useEffect(() => {
    if (verificationUrl && showBrowser && !isWebviewOpen && !isLoggedIn) {
      openWebview(verificationUrl);
    }
  }, [verificationUrl, showBrowser, isWebviewOpen, isLoggedIn, openWebview]);

  useWebviewPositionSync(containerRef, isWebviewOpen, updatePosition, 0);

  // Validate form
  const isStartUrlValid = startUrl.includes(".awsapps.com/start");
  const isFormValid = isStartUrlValid && region;

  // Handle login click
  const handleLogin = useCallback(() => {
    if (!isFormValid) return;
    setShowBrowser(true);
    startLogin(startUrl, region);
  }, [isFormValid, startUrl, region, startLogin]);

  // Handle copy device code
  const handleCopyCode = useCallback(() => {
    if (deviceCode) {
      void copyText(deviceCode);
    }
  }, [deviceCode]);

  // Handle close browser
  const handleCloseBrowser = useCallback(() => {
    closeWebview();
    cancelLogin();
    setShowBrowser(false);
  }, [closeWebview, cancelLogin]);

  // Handle reset/try again
  const handleReset = useCallback(() => {
    reset();
    setShowBrowser(false);
  }, [reset]);

  return (
    <div className="flex flex-col gap-4">
      {/* Success State */}
      {isLoggedIn && (
        <div className="rounded-xl border border-success-6 bg-success-1 p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-success-6">
              <CheckCircle size={20} className="text-text-white" />
            </div>
            <div>
              <div className="text-[14px] font-medium text-success-6">
                {t("keyVault.kiroLoggedInSuccess")}
              </div>
              <div className="text-[12px] text-text-3">
                {t("keyVault.kiroKeysCaptured")}
              </div>
            </div>
          </div>
          <Button
            variant="tertiary"
            appearance="ghost"
            size="small"
            onClick={handleReset}
            className="mt-3 text-[12px]"
          >
            {t("keyVault.kiroLoginDifferentAccount")}
          </Button>
        </div>
      )}

      {/* Error State */}
      {error && !isLoggingIn && !isLoggedIn && (
        <div className="rounded-xl border border-danger-6 bg-danger-1 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle size={20} className="mt-0.5 text-danger-6" />
            <div>
              <div className="text-[13px] font-medium text-danger-6">
                {t("keyVault.kiroAuthFailed")}
              </div>
              <div className="mt-1 text-[12px] text-text-3">{error}</div>
              <Button
                variant="tertiary"
                appearance="ghost"
                size="small"
                onClick={handleReset}
                className="mt-2 text-[12px]"
              >
                {t("keyVault.kiroTryAgain")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Browser View - When logging in */}
      {showBrowser && !isLoggedIn && !error && (
        <div className="flex flex-col overflow-hidden bg-fill-2">
          {/* Browser Header */}
          <div className="flex h-10 items-center border-b border-border-2 bg-fill-2 px-3">
            <div className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-text-1">
              {currentUrl || verificationUrl || "Loading..."}
            </div>
            <IconButton
              onClick={() => verificationUrl && openWebview(verificationUrl)}
              title={t("common:actions.refresh")}
              size="sm"
              variant="default"
            >
              <RefreshCw size={12} />
            </IconButton>
            <IconButton
              onClick={handleCloseBrowser}
              title={t("keyVault.kiroCloseBrowser")}
              size="sm"
              variant="default"
            >
              <X size={14} />
            </IconButton>
          </div>

          {/* Device Code Display - While waiting for webview */}
          {deviceCode && !isWebviewOpen && (
            <div className="border-b border-border-2 bg-fill-1 p-3 text-center">
              <div className="mb-1 text-[12px] text-text-3">
                {t("keyVault.kiroEnterCodePrompt")}
              </div>
              <div className="flex items-center justify-center gap-2">
                <code className="rounded-lg bg-bg-1 px-3 py-1.5 text-[18px] font-bold tracking-wider text-primary-6">
                  {deviceCode}
                </code>
                <IconButton
                  onClick={handleCopyCode}
                  title={t("keyVault.kiroCopyCode")}
                  size="sm"
                  variant="default"
                >
                  <Copy size={14} />
                </IconButton>
              </div>
            </div>
          )}

          {/* Browser Container - for embedded webview */}
          <div
            ref={containerRef}
            className="relative min-h-[350px] w-full bg-bg-1"
          >
            {(isWebviewLoading || (isLoggingIn && !isWebviewOpen)) && (
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <Placeholder
                  variant="loading"
                  title={
                    isLoggingIn && !verificationUrl
                      ? t("keyVault.kiroStartingAuth")
                      : t("keyVault.kiroLoadingAwsPage")
                  }
                />
              </div>
            )}
          </div>

          {/* Waiting indicator */}
          {isWebviewOpen && (
            <div className="flex items-center justify-center gap-2 border-t border-border-2 bg-fill-1 p-2">
              <span className="flex items-center gap-2 text-[13px] text-text-3">
                <Loader2
                  size={SPINNER_TOKENS.default}
                  className="animate-spin"
                />
                {t("keyVault.kiroWaitingAuth")}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Login Form - Only show when not logging in and not logged in */}
      {!isLoggedIn && !showBrowser && (
        <div className={SECTION_GAP_CLASSES}>
          <SectionContainer>
            <SectionRow
              label={t("keyVault.kiroIdentityCenterUrl")}
              description={t("keyVault.kiroIdentityCenterUrlDesc")}
              required
            >
              <Input
                value={startUrl}
                onChange={setStartUrl}
                placeholder={t("keyVault.kiroIdentityCenterUrlPlaceholder")}
                size="default"
                style={SECTION_CONTROL_STYLE}
              />
            </SectionRow>

            <SectionRow
              label={t("keyVault.kiroRegion")}
              description={t("keyVault.kiroRegionDesc")}
              required
            >
              <Select
                value={region}
                onChange={(value) => setRegion(value as string)}
                options={AWS_REGIONS}
                size="small"
                style={SECTION_CONTROL_STYLE}
              />
            </SectionRow>

            <SectionRow label="" showHeader={false}>
              <Button
                variant="primary"
                size="default"
                disabled={!isFormValid}
                onClick={handleLogin}
              >
                {t("keyVault.openBrowser")}
              </Button>
            </SectionRow>
          </SectionContainer>

          {startUrl && !isStartUrlValid && (
            <InlineAlert type="danger" title={t("common:status.error")}>
              {t("keyVault.kiroIdentityCenterUrlInvalid")}
            </InlineAlert>
          )}

          <InlineAlert
            type="info"
            subtitle={t("keyVault.kiroRequiresCliHint", {
              models: t("categories.models"),
              installedClis: t("modelsTabs.installedClis"),
            })}
          >
            {t("keyVault.kiroRequiresCli")}
          </InlineAlert>
        </div>
      )}

      {/* Debug Info */}
      {debug && (
        <div className="mt-4 rounded-lg bg-bg-3 p-3 text-[11px] text-text-3">
          <div>Start URL: {startUrl || "null"}</div>
          <div>Region: {region || "null"}</div>
          <div>Is Form Valid: {String(isFormValid)}</div>
          <div>Is Logging In: {String(isLoggingIn)}</div>
          <div>Is Logged In: {String(isLoggedIn)}</div>
          <div>Show Browser: {String(showBrowser)}</div>
          <div>Device Code: {deviceCode || "null"}</div>
          <div>Verification URL: {verificationUrl || "null"}</div>
          <div>Is Webview Open: {String(isWebviewOpen)}</div>
          <div>Current URL: {currentUrl || "null"}</div>
          <div>
            Access Token:{" "}
            {accessToken ? `${accessToken.slice(0, 20)}...` : "null"}
          </div>
          <div>
            Refresh Token:{" "}
            {refreshToken ? `${refreshToken.slice(0, 20)}...` : "null"}
          </div>
          <div>Error: {error || "null"}</div>
        </div>
      )}
    </div>
  );
};

export default KiroSessionSetup;
