/**
 * BrowserCore Component
 *
 * Reusable browser component that can work with:
 * 1. BrowserContext (for main browser page)
 * 2. Prop-based state (for simulator or standalone use)
 *
 * Features:
 * - Multiple sessions (tabs)
 * - URL navigation
 * - Loading states
 * - Error handling
 * - Native webview rendering
 */
import { useAtomValue } from "jotai";
import {
  CloudOff,
  ExternalLink,
  Globe,
  HatGlasses,
  Monitor,
  RefreshCw,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { EDITOR_TAB_CANVAS_BG_CLASS } from "@src/config/workstation/tokens";
import { createLogger } from "@src/hooks/logger";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { webviewBlockedAtom } from "@src/store/ui/overlayAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import { openExternalLink } from "@src/util/platform/ipcRenderer";

import BrowserSessionWebview from "./BrowserSessionWebview";
import type { UseBrowserStateReturn } from "./hooks/useBrowserState";
import "./index.scss";
import { BROWSER_WEBVIEW_FRAME_ANCHOR_ATTRIBUTE } from "./nativeFrameAnchor";

const log = createLogger("BrowserCore");

const ABOUT_BLANK_URL = "about:blank";
const SHOW_WEBVIEW_FRAME_ANCHOR = false;
const EMBEDDED_BROWSER_WARNING_DELAY_MS = 3000;
const EMBEDDED_BROWSER_SENSITIVE_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "accounts.google.com",
  "google.com",
  "www.google.com",
]);

function isBlankBrowserUrl(url?: string): boolean {
  const normalizedUrl = url?.trim().toLowerCase();
  return !normalizedUrl || normalizedUrl.startsWith(ABOUT_BLANK_URL);
}

function shouldShowEmbeddedBrowserFallback(url?: string): boolean {
  if (!url || isBlankBrowserUrl(url)) return false;

  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return EMBEDDED_BROWSER_SENSITIVE_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

// ============================================
// Props
// ============================================

export interface BrowserCoreProps {
  /** Browser state (sessions, active session, handlers) */
  browserState: UseBrowserStateReturn;
  /** Whether to show modal-blocking detection (for hiding webview) */
  respectModalBlocking?: boolean;
  /** Custom className */
  className?: string;
  /** Show simulator-specific notice */
  showSimulatorNotice?: boolean;
  /** Force hide all webviews (e.g., when designer mode is active) */
  hidden?: boolean;
  /**
   * Whether this BrowserCore instance owns and manages the native webview
   * lifecycle (create / destroy / position).  Defaults to true.
   *
   * Set to false for secondary viewers that share the same BrowserContext
   * sessions — only one instance should own the webviews; the other just
   * renders the chrome (tab bar, URL bar).
   */
  manageWebviews?: boolean;
  /**
   * Shared browser runtime owns the native webviews outside a specific station
   * subtree, so station-mode hiding is driven by host registration instead.
   */
  bypassStationModeBlocking?: boolean;
}

// ============================================
// Component
// ============================================

export const BrowserCore: React.FC<BrowserCoreProps> = ({
  browserState,
  respectModalBlocking = true,
  className = "",
  showSimulatorNotice = false,
  hidden = false,
  manageWebviews = true,
  bypassStationModeBlocking = false,
}) => {
  const { t } = useTranslation();
  const { sessions, activeSessionId, updateSession, addSession } = browserState;

  // Check if webviews should be blocked (modals, dropdowns, wrong view mode, etc.)
  const isWebviewBlocked = useAtomValue(webviewBlockedAtom);

  const stationMode = useAtomValue(stationModeAtom);
  const isSecondaryStationHidden =
    !respectModalBlocking &&
    !bypassStationModeBlocking &&
    stationMode !== "agent-station";

  // Refs for the browser content host and the exact native WebView anchor.
  const contentAreaRef = useRef<HTMLDivElement>(null);
  const webviewFrameAnchorRef = useRef<HTMLDivElement>(null);
  const webviewFrameAnchorDataAttr = useMemo(
    () => ({ [BROWSER_WEBVIEW_FRAME_ANCHOR_ATTRIBUTE]: "" }),
    []
  );

  // Find current session
  const currentSession = sessions.find((s) => s.id === activeSessionId);

  // Suppress ResizeObserver errors from multiple webviews
  useEffect(() => {
    const errorHandler = (event: ErrorEvent) => {
      if (
        event.message &&
        (event.message.includes("ResizeObserver loop") ||
          event.message.includes("ResizeObserver") ||
          event.message.includes(
            "loop completed with undelivered notifications"
          ))
      ) {
        log.warn("[BrowserCore] Suppressed ResizeObserver error");
        event.stopImmediatePropagation();
        event.preventDefault();
        return true;
      }
    };

    window.addEventListener("error", errorHandler, true);
    return () => window.removeEventListener("error", errorHandler, true);
  }, []);

  // Check if webview is available (Tauri environment)
  const isWebviewAvailable = useMemo(() => {
    if (typeof window === "undefined") return false;
    const win = window as unknown as Record<string, unknown>;
    return !!(win.__TAURI_INTERNALS__ || win.__TAURI_IPC__ || win.__TAURI__);
  }, []);

  // Determine if tab is really active (not blocked by modals, view mode, or hidden prop)
  const isTabReallyActive = useMemo(() => {
    // Force hide when hidden prop is true (e.g., designer mode active, or not in code view)
    if (hidden) return false;
    if (isSecondaryStationHidden) return false;
    // Skip modal blocking check if not requested
    if (!respectModalBlocking) return true;
    // Check consolidated webview blocking state (includes view mode, modals, etc.)
    return !isWebviewBlocked;
  }, [
    hidden,
    isSecondaryStationHidden,
    respectModalBlocking,
    isWebviewBlocked,
  ]);

  const isLoadingRaw = currentSession?.isLoading || false;
  const isIncognito = currentSession?.incognito || false;
  const displayError = currentSession?.error || null;
  const currentUrl = currentSession?.url;
  const [embeddedFallbackUrl, setEmbeddedFallbackUrl] = React.useState<
    string | null
  >(null);
  const hasSessionWithUrl = sessions.some(
    (session) => !isBlankBrowserUrl(session.url)
  );
  const shouldShowUrlPlaceholder =
    isTabReallyActive && isBlankBrowserUrl(currentSession?.url);
  const shouldRenderContentArea = hasSessionWithUrl || shouldShowUrlPlaceholder;

  // Delay showing the loading overlay by 500ms to avoid flash on fast loads
  const [isLoading, setIsLoading] = React.useState(false);
  React.useEffect(() => {
    if (!isLoadingRaw) {
      setIsLoading(false);
      return;
    }
    const timer = setTimeout(() => setIsLoading(true), 500);
    return () => clearTimeout(timer);
  }, [isLoadingRaw]);

  useEffect(() => {
    if (
      !isWebviewAvailable ||
      !isTabReallyActive ||
      displayError ||
      !shouldShowEmbeddedBrowserFallback(currentUrl)
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      setEmbeddedFallbackUrl(currentUrl ?? null);
    }, EMBEDDED_BROWSER_WARNING_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [currentUrl, displayError, isTabReallyActive, isWebviewAvailable]);

  const showEmbeddedBrowserFallback =
    Boolean(currentUrl) && embeddedFallbackUrl === currentUrl;

  const handleOpenExternal = useCallback(() => {
    if (!currentUrl) return;
    void openExternalLink(currentUrl);
  }, [currentUrl]);

  return (
    <div
      className={`browser-core flex h-full min-h-0 w-full flex-col p-px ${className}`}
    >
      {/* Content area — one full-height host for both native webviews and
          React overlays. Empty-URL tabs render the placeholder inside this same
          host so an existing webview session cannot split the panel underneath. */}
      {shouldRenderContentArea && (
        <div className="browser-content" ref={contentAreaRef}>
          <div
            ref={webviewFrameAnchorRef}
            {...webviewFrameAnchorDataAttr}
            className={`browser-webview-frame-anchor ${
              SHOW_WEBVIEW_FRAME_ANCHOR ? "debug-visible" : ""
            }`}
            aria-hidden="true"
          />
          {shouldShowUrlPlaceholder && (
            <div
              className={`browser-native-info ${EDITOR_TAB_CANVAS_BG_CLASS}`}
            >
              <div className="browser-native-placeholder">
                {isIncognito ? (
                  <HatGlasses
                    size={64}
                    strokeWidth={1.5}
                    className="text-warning-6 opacity-80"
                  />
                ) : (
                  <Globe
                    size={64}
                    strokeWidth={1.5}
                    className="text-primary-6 opacity-80"
                  />
                )}
                <h3>
                  {isIncognito
                    ? t("workstation.browserCore.privateBrowsingEmptyTitle")
                    : t("workstation.browserCore.enterUrlToStart")}
                </h3>
                {showSimulatorNotice && (
                  <p className="mt-2 text-xs font-semibold text-text-3">
                    {t("workstation.browserCore.simulatorBrowserNotice")}
                  </p>
                )}
                <p className="mt-2 text-xs text-text-3">
                  {t("workstation.browserCore.tlsDevNote")}
                </p>
              </div>
            </div>
          )}

          {/* Only the owning instance renders BrowserSessionWebview. */}
          {manageWebviews &&
            sessions.map((session) => (
              <BrowserSessionWebview
                key={session.id}
                session={session}
                isActive={session.id === activeSessionId}
                isTabActive={isTabReallyActive}
                containerRef={webviewFrameAnchorRef}
                onSessionUpdate={updateSession}
                onNewTab={addSession}
              />
            ))}

          {/* Desktop-only notice */}
          {!isWebviewAvailable && (
            <div className="browser-native-info">
              <div className="browser-native-placeholder">
                <Monitor size={48} className="text-text-2 opacity-60" />
                <h3>{t("workstation.browserCore.desktopOnlyTitle")}</h3>
                <p>{t("workstation.browserCore.desktopOnlyBody")}</p>
                <div className="mt-4 text-left text-xs text-text-3">
                  <div>
                    {t("workstation.browserCore.debugWebviewAvailable", {
                      value: String(isWebviewAvailable),
                    })}
                  </div>
                  <div>
                    {t("workstation.browserCore.debugTauriInternals", {
                      value: String(
                        !!(window as unknown as Record<string, unknown>)
                          .__TAURI_INTERNALS__
                      ),
                    })}
                  </div>
                  <div>
                    {t("workstation.browserCore.debugTauriIpc", {
                      value: String(
                        !!(window as unknown as Record<string, unknown>)
                          .__TAURI_IPC__
                      ),
                    })}
                  </div>
                  <div>
                    {t("workstation.browserCore.debugTauri", {
                      value: String(
                        !!(window as unknown as Record<string, unknown>)
                          .__TAURI__
                      ),
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Loading overlay */}
          {isWebviewAvailable &&
            isTabReallyActive &&
            isLoading &&
            currentSession?.url && (
              <div className="browser-loading-overlay">
                <Placeholder variant="loading" />
              </div>
            )}

          {/* Embedded browser fallback */}
          {isWebviewAvailable &&
            isTabReallyActive &&
            showEmbeddedBrowserFallback &&
            currentUrl &&
            !displayError && (
              <div className="browser-native-info browser-embedded-fallback">
                <div className="browser-native-placeholder">
                  <CloudOff
                    size={64}
                    strokeWidth={1.5}
                    className="text-text-3 opacity-60"
                  />
                  <h3 className="mt-4">
                    {t("workstation.browserCore.embeddedFallbackTitle")}
                  </h3>
                  <p>{t("workstation.browserCore.embeddedFallbackBody")}</p>
                  <div className="allow-select browser-current-url">
                    <span className="label">
                      {t("workstation.browserCore.currentUrl")}
                    </span>
                    <span className="url">{currentUrl}</span>
                  </div>
                  <div className="mt-6 flex justify-center gap-2">
                    <Button
                      variant="primary"
                      size="small"
                      icon={<ExternalLink size={14} strokeWidth={1.75} />}
                      htmlType="button"
                      onClick={handleOpenExternal}
                    >
                      {t("previews.openInBrowser")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="small"
                      htmlType="button"
                      onClick={() => setEmbeddedFallbackUrl(null)}
                    >
                      {t("actions.dismiss")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="small"
                      icon={<RefreshCw size={14} strokeWidth={1.75} />}
                      htmlType="button"
                      onClick={() => {
                        if (!currentSession) return;
                        setEmbeddedFallbackUrl(null);
                        updateSession(currentSession.id, {
                          isLoading: true,
                          error: null,
                        });
                      }}
                    >
                      {t("actions.reload")}
                    </Button>
                  </div>
                </div>
              </div>
            )}

          {/* Error overlay */}
          {isWebviewAvailable && isTabReallyActive && displayError && (
            <div className="browser-native-info">
              <div className="browser-native-placeholder">
                <CloudOff
                  size={64}
                  strokeWidth={1.5}
                  className="text-text-3 opacity-60"
                />
                <h3 className="mt-4">
                  {t("workstation.browserCore.siteUnreachableTitle")}
                </h3>
                <div className="allow-select mt-3 w-full max-w-md rounded-lg bg-fill-2 px-3 py-2 text-left text-[12px] leading-relaxed text-text-2">
                  {displayError}
                </div>
                <div className="mt-6 flex justify-center">
                  <Button
                    variant="primary"
                    size="small"
                    icon={<RefreshCw size={14} strokeWidth={1.75} />}
                    htmlType="button"
                    onClick={() => {
                      if (!currentSession) return;
                      updateSession(currentSession.id, {
                        isLoading: true,
                        error: null,
                      });
                    }}
                  >
                    {t("actions.reload")}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default BrowserCore;
