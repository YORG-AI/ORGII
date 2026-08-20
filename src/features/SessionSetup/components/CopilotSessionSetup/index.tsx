/**
 * CopilotSessionSetup Component
 *
 * Embedded browser for GitHub Copilot PAT creation.
 * Follows the same pattern as CursorSessionSetup.
 *
 * Flow:
 * 1. User clicks "Create Token on GitHub" → Opens embedded browser
 * 2. User logs in and creates PAT with Copilot permission
 * 3. User copies token and pastes it in the input field
 */
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertCircle, ChevronRight, RefreshCw, X } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { v4 as uuidv4 } from "uuid";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import { useWebviewPositionSync } from "@src/features/SessionSetup/hooks/useWebviewPositionSync";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { toNativeFrame } from "@src/util/platform/tauri/nativeFrame";

// ============================================
// Type Definitions
// ============================================

export interface CopilotSessionSetupProps {
  /** Callback when token is entered */
  onTokenCaptured?: (token: string) => void;
  /** Initial token value */
  initialToken?: string;
  /** Show debug info */
  debug?: boolean;
  /** Hide the token input field */
  hideTokenInput?: boolean;
  /** Callback when browser state changes */
  onBrowserStateChange?: (isOpen: boolean) => void;
}

// ============================================
// Constants
// ============================================

const GITHUB_PAT_URL = "https://github.com/settings/personal-access-tokens/new";

// ============================================
// Component Implementation
// ============================================

const CopilotSessionSetup: React.FC<CopilotSessionSetupProps> = ({
  onTokenCaptured,
  initialToken = "",
  debug = false,
  hideTokenInput = false,
  onBrowserStateChange,
}) => {
  const { t } = useTranslation("integrations");

  // Local state
  const [token, setToken] = useState(initialToken);
  const [showBrowser, setShowBrowser] = useState(false);
  const [currentUrl, setCurrentUrl] = useState(GITHUB_PAT_URL);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const webviewLabelRef = useRef<string>(`copilot-session-${uuidv4()}`);

  // Notify parent when browser state changes
  useEffect(() => {
    onBrowserStateChange?.(showBrowser);
  }, [showBrowser, onBrowserStateChange]);

  // Validate token format (GitHub PATs start with github_pat_ or ghp_)
  const isTokenValid =
    (token.startsWith("github_pat_") || token.startsWith("ghp_")) &&
    token.length > 20;

  // Track if we've already triggered the callback
  const hasTriggeredRef = useRef(false);
  const callbackRef = useRef(onTokenCaptured);

  // Update callback ref
  useEffect(() => {
    callbackRef.current = onTokenCaptured;
  }, [onTokenCaptured]);

  // Auto-trigger callback when token is valid (only once)
  useEffect(() => {
    if (isTokenValid && token && !hasTriggeredRef.current) {
      hasTriggeredRef.current = true;
      callbackRef.current?.(token);
    }
  }, [isTokenValid, token]);

  // Reset trigger flag if token becomes invalid
  useEffect(() => {
    if (!isTokenValid) {
      hasTriggeredRef.current = false;
    }
  }, [isTokenValid]);

  // Handle token change
  const handleTokenChange = useCallback(
    (value: string) => {
      setToken(value);
      if (hasTriggeredRef.current && value !== token) {
        hasTriggeredRef.current = false;
      }
    },
    [token]
  );

  // Start capture - create webview
  const startCapture = useCallback(async () => {
    if (!containerRef.current) {
      setError("Container not available");
      return;
    }

    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      setError("Container has no dimensions");
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const appWindow = getCurrentWindow();
      const parentLabel = appWindow.label;

      const INSET = 2;

      await invoke("create_inline_webview", {
        parentWindow: parentLabel,
        label: webviewLabelRef.current,
        url: GITHUB_PAT_URL,
        ...toNativeFrame(rect, INSET),
        incognito: true, // Fresh login
      });

      setIsCapturing(true);
      setIsLoading(false);
      setCurrentUrl(GITHUB_PAT_URL);

      // Update position after layout stabilizes
      const updateAfterDelay = async (delay: number) => {
        setTimeout(async () => {
          if (containerRef.current) {
            const newRect = containerRef.current.getBoundingClientRect();
            try {
              await invoke("update_inline_webview_position", {
                label: webviewLabelRef.current,
                ...toNativeFrame(newRect, INSET),
              });
            } catch {
              // Ignore - webview might be closed
            }
          }
        }, delay);
      };

      updateAfterDelay(50);
      updateAfterDelay(150);
      updateAfterDelay(300);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      setError(errorMsg);
      setIsLoading(false);
    }
  }, []);

  // Stop capture - close webview
  const stopCapture = useCallback(async () => {
    if (!isCapturing) return;

    try {
      await invoke("close_inline_webview", {
        label: webviewLabelRef.current,
      });
      setIsCapturing(false);
    } catch {
      // Ignore - webview might already be closed
    }
  }, [isCapturing]);

  // Navigate webview
  const navigate = useCallback(
    async (url: string) => {
      if (!isCapturing) return;

      try {
        await invoke("navigate_inline_webview", {
          label: webviewLabelRef.current,
          url,
        });
        setCurrentUrl(url);
      } catch {
        // Ignore navigation errors
      }
    },
    [isCapturing]
  );

  // Update webview position
  const updatePosition = useCallback(async () => {
    if (!isCapturing || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const INSET = 2;

    try {
      await invoke("update_inline_webview_position", {
        label: webviewLabelRef.current,
        ...toNativeFrame(rect, INSET),
      });
    } catch {
      // Ignore - webview might be closed
    }
  }, [isCapturing]);

  useWebviewPositionSync(containerRef, isCapturing, updatePosition);

  // Start browser when showBrowser changes to true
  useEffect(() => {
    if (showBrowser && !isCapturing) {
      const timer = setTimeout(() => {
        startCapture();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [showBrowser, isCapturing, startCapture]);

  // Close browser
  const handleCloseBrowser = useCallback(() => {
    stopCapture();
    setShowBrowser(false);
  }, [stopCapture]);

  // Cleanup on unmount
  useEffect(() => {
    const label = webviewLabelRef.current;
    return () => {
      if (isCapturing && label) {
        invoke("close_inline_webview", { label }).catch(() => {});
      }
    };
  }, [isCapturing]);

  // Determine current step
  const currentStep = !isTokenValid ? 1 : 2;

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-3">
      {/* Browser Section */}
      {!showBrowser ? (
        <SectionContainer>
          <SectionRow
            label={
              isTokenValid
                ? t("keyVault.copilotTokenValidated")
                : t("keyVault.copilotCreatePat")
            }
            description={
              isTokenValid
                ? `${token.slice(0, 20)}...`
                : t("keyVault.copilotCreatePatDesc")
            }
            required
          >
            <Button
              variant={isTokenValid ? "success" : "primary"}
              appearance={isTokenValid ? "outline" : "solid"}
              size="default"
              onClick={() => setShowBrowser(true)}
              className="h-8 min-h-8"
            >
              {isTokenValid
                ? `✓ ${t("keyVault.loggedIn")}`
                : t("keyVault.openBrowser")}
            </Button>
          </SectionRow>
        </SectionContainer>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-fill-2">
            {/* Minimal Browser Header */}
            <div className="flex h-10 items-center border-b border-border-2 bg-fill-2 px-3">
              <div className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-text-1">
                {currentUrl}
              </div>
              <Button
                variant="tertiary"
                size="mini"
                icon={<RefreshCw size={12} />}
                iconOnly
                onClick={() => navigate(GITHUB_PAT_URL)}
              />
              <Button
                variant="tertiary"
                size="mini"
                icon={<X size={14} />}
                iconOnly
                onClick={handleCloseBrowser}
              />
            </div>

            {/* Progress Steps */}
            <div className="flex h-9 items-center justify-between gap-2 border-b border-border-2 bg-fill-2 px-4">
              <div className="flex items-center gap-2">
                <StepIndicator
                  step={1}
                  currentStep={currentStep}
                  label={t("keyVault.copilotStepCreate")}
                  completed={isTokenValid}
                />
                <ChevronRight size={14} className="text-text-3" />
                <StepIndicator
                  step={2}
                  currentStep={currentStep}
                  label={t("keyVault.copilotStepPaste")}
                  completed={isTokenValid}
                />
              </div>

              {currentStep === 1 && !isTokenValid && (
                <div className="flex items-center gap-1.5">
                  <span
                    className="text-[12px] text-text-2"
                    dangerouslySetInnerHTML={{
                      __html: t("keyVault.copilotPermissionHint"),
                    }}
                  />
                </div>
              )}
            </div>

            {/* Browser Container */}
            <div
              ref={containerRef}
              className="relative min-h-0 w-full flex-1 overflow-hidden bg-bg-1"
            >
              {isLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-bg-1">
                  <Placeholder variant="loading" />
                </div>
              )}
              {error && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-bg-1 p-6 text-center">
                  <AlertCircle size={32} className="mb-3 text-danger-6" />
                  <div className="mb-2 text-[14px] text-text-2">
                    {t("keyVault.failedToLoadBrowser")}
                  </div>
                  <div className="mb-4 text-[12px] text-text-3">{error}</div>
                  <Button variant="primary" size="small" onClick={startCapture}>
                    {t("common:actions.retry")}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Token Input */}
      {!hideTokenInput && (
        <>
          <SectionContainer>
            <SectionRow
              label={t("keyVault.copilotStepPaste")}
              description={t("keyVault.copilotPasteTokenDesc")}
              layout="vertical"
            >
              <Input
                value={token}
                onChange={handleTokenChange}
                placeholder="github_pat_..."
                className="w-full"
              />
            </SectionRow>
          </SectionContainer>
          {token && !isTokenValid && (
            <InlineAlert type="danger">
              {t("keyVault.copilotInvalidTokenFormat")}
            </InlineAlert>
          )}
          {isTokenValid && (
            <InlineAlert type="success">
              {t("keyVault.copilotValidTokenFormat")}
            </InlineAlert>
          )}
        </>
      )}

      {/* Debug Info */}
      {debug && (
        <div className="mt-4 rounded-lg bg-bg-3 p-3 text-[11px] text-text-3">
          <div>Token: {token ? `${token.slice(0, 20)}...` : "null"}</div>
          <div>Token Valid: {String(isTokenValid)}</div>
          <div>Show Browser: {String(showBrowser)}</div>
          <div>Is Capturing: {String(isCapturing)}</div>
          <div>Current URL: {currentUrl}</div>
        </div>
      )}
    </div>
  );
};

// ============================================
// Helper Components
// ============================================

interface StepIndicatorProps {
  step: number;
  currentStep: number;
  label: string;
  completed: boolean;
}

const StepIndicator: React.FC<StepIndicatorProps> = ({
  step,
  currentStep,
  label,
  completed,
}) => {
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
};

export default CopilotSessionSetup;
