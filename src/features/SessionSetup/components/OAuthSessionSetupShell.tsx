import {
  AlertCircle,
  CheckCircle,
  ChevronRight,
  Loader2,
  LogIn,
  RefreshCw,
  X,
} from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

export interface OAuthSessionSetupCopy {
  signInTitle: string;
  signInDescription: string;
  signInButton: string;
  signedInTitle: string;
  signedInStatus: string;
  loginStep: string;
  browserHint: string;
  readyTitle: string;
  oauthHint: string;
  loading: string;
  failedToLoadBrowser: string;
  retry: string;
  close: string;
  errorHint: string;
}

interface OAuthSessionSetupViewProps {
  providerId: string;
  containerRef: RefObject<HTMLDivElement | null>;
  showBrowser: boolean;
  hasToken: boolean;
  isSigningIn: boolean;
  isWebviewOpen: boolean;
  isWebviewLoading: boolean;
  currentUrl: string;
  authUrl: string | null;
  displayError: string | null;
  copy: OAuthSessionSetupCopy;
  onOpenBrowser: () => void;
  onCloseBrowser: () => void;
  onRetry: () => void;
  onDismissError?: () => void;
  debugContent?: ReactNode;
}

export function OAuthSessionSetupView({
  providerId,
  containerRef,
  showBrowser,
  hasToken,
  isSigningIn,
  isWebviewOpen,
  isWebviewLoading,
  currentUrl,
  authUrl,
  displayError,
  copy,
  onOpenBrowser,
  onCloseBrowser,
  onRetry,
  onDismissError,
  debugContent,
}: OAuthSessionSetupViewProps) {
  const currentStep = hasToken ? 2 : 1;

  return (
    <div
      className="flex h-full min-h-0 w-full flex-1 flex-col gap-3"
      data-testid={`${providerId}-session-setup`}
    >
      {!showBrowser ? (
        <SectionContainer>
          <SectionRow
            label={hasToken ? copy.signedInTitle : copy.signInTitle}
            description={
              hasToken ? copy.signedInStatus : copy.signInDescription
            }
            required
          >
            <Button
              variant={hasToken ? "success" : "primary"}
              appearance={hasToken ? "outline" : "solid"}
              size="default"
              loading={isSigningIn || isWebviewLoading}
              disabled={isSigningIn || isWebviewLoading}
              onClick={onOpenBrowser}
              className="h-8 min-h-8"
              data-testid={`${providerId}-oauth-signin`}
            >
              {hasToken ? `✓ ${copy.signedInStatus}` : copy.signInButton}
            </Button>
          </SectionRow>
        </SectionContainer>
      ) : (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden bg-fill-2"
          data-testid={`${providerId}-oauth-browser-shell`}
        >
          <div className="flex h-10 items-center border-b border-border-2 bg-fill-2 px-3">
            <div
              className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-text-1"
              data-testid={`${providerId}-oauth-current-url`}
            >
              {currentUrl || authUrl || copy.readyTitle}
            </div>
            <Button
              variant="tertiary"
              size="mini"
              icon={<RefreshCw size={12} />}
              iconOnly
              aria-label={copy.retry}
              title={copy.retry}
              onClick={onRetry}
            />
            <Button
              variant="tertiary"
              size="mini"
              icon={<X size={14} />}
              iconOnly
              aria-label={copy.close}
              title={copy.close}
              onClick={onCloseBrowser}
              data-testid={`${providerId}-oauth-browser-close`}
            />
          </div>

          <div className="flex h-9 items-center justify-between gap-2 border-b border-border-2 bg-fill-2 px-4">
            <div className="flex items-center gap-2">
              <StepIndicator
                step={1}
                currentStep={currentStep}
                label={copy.loginStep}
                completed={hasToken}
              />
              <ChevronRight size={14} className="text-text-3" />
              <StepIndicator
                step={2}
                currentStep={currentStep}
                label={copy.signedInStatus}
                completed={hasToken}
              />
            </div>
            {!hasToken && (
              <span className="text-[12px] text-text-2">
                {copy.browserHint}
              </span>
            )}
          </div>

          <div
            ref={containerRef}
            className="relative min-h-0 w-full flex-1 overflow-hidden bg-bg-1"
            data-testid={`${providerId}-oauth-webview-container`}
          >
            {(isSigningIn || isWebviewLoading) && (
              <div
                className="absolute inset-0 flex items-center justify-center bg-bg-1"
                role="status"
              >
                <Loader2
                  size={SPINNER_TOKENS.default}
                  className="animate-spin text-primary-6"
                />
                <span className="ml-2 text-text-2">{copy.loading}</span>
              </div>
            )}
            {displayError && (
              <div
                className="absolute inset-0 flex flex-col items-center justify-center bg-bg-1 p-6 text-center"
                role="alert"
              >
                <AlertCircle size={32} className="mb-3 text-danger-6" />
                <div className="mb-2 text-[14px] text-text-2">
                  {copy.failedToLoadBrowser}
                </div>
                <div className="mb-4 text-[12px] text-text-3">
                  {displayError}
                </div>
                <Button variant="primary" size="default" onClick={onRetry}>
                  {copy.retry}
                </Button>
              </div>
            )}
            {!isWebviewOpen && !isSigningIn && !displayError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-bg-1 p-6 text-center">
                {hasToken ? (
                  <CheckCircle size={32} className="mb-3 text-success-6" />
                ) : (
                  <LogIn size={32} className="mb-3 text-text-3" />
                )}
                <div className="mb-2 text-[14px] font-medium text-text-1">
                  {hasToken ? copy.signedInTitle : copy.readyTitle}
                </div>
                <div className="max-w-sm text-[12px] text-text-3">
                  {copy.oauthHint}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {hasToken && !showBrowser && (
        <InlineAlert type="success">{copy.signedInTitle}</InlineAlert>
      )}

      {displayError && !showBrowser && (
        <InlineAlert
          type="danger"
          title={displayError}
          onClose={onDismissError}
        >
          {copy.errorHint}
        </InlineAlert>
      )}

      {debugContent && (
        <div className="mt-4 rounded-lg bg-bg-3 p-3 text-[11px] text-text-3">
          {debugContent}
        </div>
      )}
    </div>
  );
}

interface OAuthSessionSetupShellProps extends Omit<
  OAuthSessionSetupViewProps,
  | "showBrowser"
  | "displayError"
  | "onOpenBrowser"
  | "onCloseBrowser"
  | "onRetry"
  | "onDismissError"
> {
  isSignedIn: boolean;
  captureError: string | null;
  tokenError?: string | null;
  onClearTokenError?: () => void;
  onBrowserStateChange?: (isOpen: boolean) => void;
  closeSignal?: number;
  initiallyOpen?: boolean;
  startLogin: () => Promise<void>;
  closeWebview: () => Promise<void>;
  reset: () => void;
}

export function shouldCollapseOAuthBrowser(
  isWebviewOpen: boolean,
  isSignedIn: boolean
): boolean {
  return !isWebviewOpen && isSignedIn;
}

export function shouldStartOAuthLogin(
  showBrowser: boolean,
  isWebviewOpen: boolean,
  isSigningIn: boolean
): boolean {
  return showBrowser && !isWebviewOpen && !isSigningIn;
}

export function shouldHandleOAuthCloseSignal(
  closeSignal: number,
  showBrowser: boolean
): boolean {
  return closeSignal > 0 && showBrowser;
}

export function OAuthSessionSetupShell({
  isSignedIn,
  captureError,
  tokenError = null,
  onClearTokenError,
  onBrowserStateChange,
  closeSignal = 0,
  initiallyOpen = false,
  startLogin,
  closeWebview,
  reset,
  ...viewProps
}: OAuthSessionSetupShellProps) {
  const [showBrowser, setShowBrowser] = useState(initiallyOpen);
  const showBrowserRef = useRef(initiallyOpen);
  const retryInFlightRef = useRef(false);

  const setBrowserVisibility = useCallback(
    (isOpen: boolean) => {
      if (showBrowserRef.current === isOpen) return;
      showBrowserRef.current = isOpen;
      setShowBrowser(isOpen);
      onBrowserStateChange?.(isOpen);
    },
    [onBrowserStateChange]
  );

  // Synchronize the owning wizard layout on initial auto-start and whenever
  // its callback identity changes. All later visibility transitions notify at
  // their originating event or native WebView transition.
  useEffect(() => {
    onBrowserStateChange?.(showBrowserRef.current);
  }, [onBrowserStateChange]);

  useEffect(() => {
    if (shouldCollapseOAuthBrowser(viewProps.isWebviewOpen, isSignedIn)) {
      queueMicrotask(() => setBrowserVisibility(false));
    }
  }, [isSignedIn, setBrowserVisibility, viewProps.isWebviewOpen]);

  useEffect(() => {
    if (
      !shouldStartOAuthLogin(
        showBrowser,
        viewProps.isWebviewOpen,
        viewProps.isSigningIn
      )
    ) {
      return;
    }

    const timer = setTimeout(() => {
      void startLogin();
    }, 100);

    return () => clearTimeout(timer);
  }, [startLogin, showBrowser, viewProps.isSigningIn, viewProps.isWebviewOpen]);

  const handleCloseBrowser = useCallback(() => {
    if (!showBrowserRef.current) return;
    void closeWebview();
    setBrowserVisibility(false);
  }, [closeWebview, setBrowserVisibility]);

  useEffect(() => {
    if (!shouldHandleOAuthCloseSignal(closeSignal, showBrowser)) return;
    queueMicrotask(() => handleCloseBrowser());
  }, [closeSignal, handleCloseBrowser, showBrowser]);

  const handleRetry = useCallback(() => {
    if (retryInFlightRef.current) return;
    retryInFlightRef.current = true;
    reset();
    setBrowserVisibility(true);
    void startLogin().finally(() => {
      retryInFlightRef.current = false;
    });
  }, [reset, setBrowserVisibility, startLogin]);

  const displayError = captureError ?? tokenError;

  return (
    <OAuthSessionSetupView
      {...viewProps}
      showBrowser={showBrowser}
      displayError={displayError}
      onOpenBrowser={() => setBrowserVisibility(true)}
      onCloseBrowser={handleCloseBrowser}
      onRetry={handleRetry}
      onDismissError={captureError ? reset : onClearTokenError}
    />
  );
}

interface StepIndicatorProps {
  step: number;
  currentStep: number;
  label: string;
  completed: boolean;
}

function StepIndicator({
  step,
  currentStep,
  label,
  completed,
}: StepIndicatorProps) {
  const isActive = step === currentStep;
  const isPast = step < currentStep || completed;

  return (
    <div className="flex items-center gap-1.5">
      <div
        className={[
          "flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold",
          isPast
            ? "bg-success-6 text-text-white"
            : isActive
              ? "bg-primary-6 text-text-white"
              : "border border-border-2 bg-bg-2 text-text-3",
        ].join(" ")}
        aria-current={isActive ? "step" : undefined}
      >
        {isPast ? <span className="text-[10px]">✓</span> : step}
      </div>
      <span
        className={[
          "text-[12px]",
          isActive ? "font-medium text-text-1" : "font-normal text-text-3",
        ].join(" ")}
      >
        {label}
      </span>
    </div>
  );
}
