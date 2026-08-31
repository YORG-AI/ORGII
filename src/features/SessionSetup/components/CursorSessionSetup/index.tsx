/**
 * CursorSessionSetup Component
 *
 * Embedded browser for Cursor login.
 * Flow:
 * 1. User opens the internal browser and signs in to Cursor.
 * 2. Native OAuth token is captured automatically.
 * 3. Browser collapses back into the wizard.
 */
import React, {
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import { useCursorSessionCapture } from "@src/features/SessionSetup/hooks/useCursorSessionCapture";
import { useWebviewPositionSync } from "@src/features/SessionSetup/hooks/useWebviewPositionSync";
import {
  AlertCircleIcon,
  Cancel01Icon,
  CheckmarkCircle01Icon,
  HugeiconsIcon,
  Loading03Icon,
  Refresh04Icon,
} from "@src/icons";
import {
  SECTION_GAP_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

const CURSOR_API_KEYS_URL = "https://cursor.com/dashboard/integrations";

export interface CursorSessionValues {
  sessionToken: string;
}

export interface CursorSessionSetupProps {
  onSessionCaptured?: (values: CursorSessionValues) => void;
  onSessionTokenCaptured?: (sessionToken: string) => void;
  onUrlChange?: (url: string) => void;
  debug?: boolean;
  onBrowserStateChange?: (isOpen: boolean) => void;
  closeSignal?: number;
}

const CursorSessionSetup: React.FC<CursorSessionSetupProps> = ({
  onSessionCaptured,
  onSessionTokenCaptured,
  onUrlChange,
  debug = false,
  onBrowserStateChange,
  closeSignal = 0,
}) => {
  const { t } = useTranslation("integrations");
  const [showBrowser, setShowBrowser] = useState(false);
  const shouldStartCaptureRef = useRef(false);

  useEffect(() => {
    onBrowserStateChange?.(showBrowser);
  }, [showBrowser, onBrowserStateChange]);

  const containerRef = useRef<HTMLDivElement>(null);

  const {
    sessionToken,
    currentUrl,
    isCapturing,
    isLoading,
    error,
    startCapture,
    openUrl,
    stopCapture,
    navigate,
    updatePosition,
    tokenInfo,
  } = useCursorSessionCapture({
    containerRef,
    onTokenCaptured: (capturedSessionToken) => {
      onSessionTokenCaptured?.(capturedSessionToken);
      onSessionCaptured?.({
        sessionToken: capturedSessionToken,
      });
    },
    debug,
  });

  const apiKeyRedirectedRef = useRef(false);

  const closeBrowser = useCallback(async () => {
    shouldStartCaptureRef.current = false;
    await stopCapture();
    setShowBrowser(false);
  }, [stopCapture]);

  const handleCloseBrowser = useCallback(
    (event?: MouseEvent<HTMLButtonElement>) => {
      event?.preventDefault();
      event?.stopPropagation();
      void closeBrowser();
    },
    [closeBrowser]
  );

  const openLoginBrowser = useCallback(() => {
    shouldStartCaptureRef.current = true;
    setShowBrowser(true);
  }, []);

  const openApiKeysPage = useCallback(() => {
    shouldStartCaptureRef.current = false;
    setShowBrowser(true);
    if (isCapturing) {
      void navigate(CURSOR_API_KEYS_URL);
      return;
    }
    window.setTimeout(() => {
      void openUrl(CURSOR_API_KEYS_URL);
    }, 100);
  }, [isCapturing, navigate, openUrl]);

  useEffect(() => {
    if (!sessionToken || !showBrowser || apiKeyRedirectedRef.current) return;
    apiKeyRedirectedRef.current = true;
    shouldStartCaptureRef.current = false;
    void navigate(CURSOR_API_KEYS_URL);
  }, [navigate, sessionToken, showBrowser]);

  useEffect(() => {
    if (currentUrl) {
      onUrlChange?.(currentUrl);
    }
  }, [currentUrl, onUrlChange]);

  useWebviewPositionSync(containerRef, isCapturing, updatePosition);

  useEffect(() => {
    if (!showBrowser || isCapturing || !shouldStartCaptureRef.current) return;
    const timer = window.setTimeout(() => {
      void startCapture();
    }, 100);
    return () => window.clearTimeout(timer);
  }, [isCapturing, showBrowser, startCapture]);
  useEffect(() => {
    if (closeSignal <= 0 || !showBrowser) return;
    queueMicrotask(() => {
      void closeBrowser();
    });
  }, [closeSignal, closeBrowser, showBrowser]);

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      {!showBrowser ? (
        <div className={SECTION_GAP_CLASSES}>
          <SectionContainer>
            <SectionRow
              label={
                sessionToken
                  ? t("keyVault.cursorSessionTokenCapturedTitle")
                  : t("keyVault.signInToCaptureToken")
              }
              description={
                sessionToken && tokenInfo.userId
                  ? t("keyVault.cursorSessionTokenCapturedDesc", {
                      user: tokenInfo.userId.slice(0, 12),
                    })
                  : !sessionToken
                    ? t("keyVault.opensEmbeddedBrowser")
                    : t("keyVault.cursorLoginReadyDesc")
              }
              required
            >
              <div className="flex items-center gap-2">
                <Button
                  variant={sessionToken ? "success" : "primary"}
                  appearance={sessionToken ? "outline" : "solid"}
                  size="default"
                  onClick={openLoginBrowser}
                  disabled={Boolean(sessionToken)}
                  className="h-8 min-h-8"
                >
                  {sessionToken
                    ? `✓ ${t("keyVault.sessionTokenCaptured")}`
                    : t("keyVault.openBrowser")}
                </Button>
                {sessionToken && (
                  <Button
                    variant="primary"
                    appearance="solid"
                    size="default"
                    onClick={openApiKeysPage}
                    className="h-8 min-h-8"
                  >
                    {t("keyVault.openCursorApiKeys")}
                  </Button>
                )}
              </div>
            </SectionRow>
          </SectionContainer>

          {sessionToken && (
            <div className="rounded-lg border border-success-3 bg-success-1 px-3 py-2">
              <div className="flex items-start gap-2">
                <HugeiconsIcon
                  icon={CheckmarkCircle01Icon}
                  data-icon="check-circle"
                  size={15}
                  className="mt-0.5 shrink-0 text-success-6"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-success-7 text-[12px] font-medium">
                    {t("keyVault.cursorLoginReadyTitle")}
                  </div>
                  <div className="mt-0.5 text-[11px] leading-4 text-text-2">
                    {t("keyVault.cursorLoginReadyDesc")}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-fill-2">
          <div className="flex h-10 items-center border-b border-border-2 bg-fill-2 px-3">
            <div className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-text-1">
              {currentUrl || t("keyVault.cursorLoginBrowserTitle")}
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
              onClick={openLoginBrowser}
            />
            <Button
              variant="tertiary"
              size="mini"
              icon={
                <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={14} />
              }
              iconOnly
              onClick={handleCloseBrowser}
            />
          </div>

          <div className="flex h-9 items-center justify-between gap-2 border-b border-border-2 bg-fill-2 px-4">
            <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-text-2">
              <span>
                {sessionToken
                  ? t("keyVault.cursorApiKeyBrowserHint")
                  : t("keyVault.signInToCursorHint")}
              </span>
            </div>
            {sessionToken && (
              <Button
                variant="secondary"
                appearance="outline"
                size="mini"
                onClick={openApiKeysPage}
              >
                {t("keyVault.openCursorApiKeys")}
              </Button>
            )}
          </div>

          <div
            ref={containerRef}
            className="relative min-h-[300px] w-full flex-1 overflow-hidden bg-bg-1"
          >
            {isLoading && (
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
            {error && (
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
                <div className="mb-4 text-[12px] text-text-3">{error}</div>
                <button
                  onClick={startCapture}
                  className="rounded-lg bg-primary-6 px-4 py-2 text-sm font-medium text-text-white transition-colors hover:bg-primary-7"
                >
                  {t("common:actions.retry")}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {debug && (
        <div className="mt-4 rounded-lg bg-bg-3 p-3 text-[11px] text-text-3">
          <div>
            Session Token:{" "}
            {sessionToken ? `${sessionToken.slice(0, 30)}...` : "null"}
          </div>
          <div>Token Valid: {String(tokenInfo.isValid)}</div>
          <div>User ID: {tokenInfo.userId || "null"}</div>
          <div>Expires: {tokenInfo.expiresAt?.toISOString() || "null"}</div>
          <div>Is Capturing: {String(isCapturing)}</div>
          <div>Current URL: {currentUrl}</div>
        </div>
      )}
    </div>
  );
};

export default CursorSessionSetup;
