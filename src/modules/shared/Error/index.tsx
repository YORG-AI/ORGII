import Button from "@/src/components/Button";
import { invoke } from "@tauri-apps/api/core";
import { Check, Copy, RefreshCw } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { isRouteErrorResponse, useRouteError } from "react-router-dom";

import { stripAnsiCodes } from "@src/engines/TerminalCore/components/TerminalDisplay/utils/ansiProcessor";
import { createLogger } from "@src/hooks/logger";
import i18n from "@src/i18n";
import { copyText } from "@src/util/data/clipboard";

const logger = createLogger("ErrorPage");

/**
 * Truncate a string to a maximum length with ellipsis
 */
function truncateMessage(str: string, maxLength: number = 500): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + "...";
}

/**
 * Extract a user-friendly error message from any error
 */
function getErrorInfo(error: unknown): { title: string; message: string } {
  const t = i18n.t.bind(i18n);

  // No error provided
  if (!error) {
    return {
      title: t("errors.generic"),
      message: t("errors.unexpectedError"),
    };
  }

  // Handle React Router error responses (404, etc.)
  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      return {
        title: t("errors.pageNotFound"),
        message: `The page "${window.location.pathname}" doesn't exist.`,
      };
    }
    return {
      title: `${t("status.error")} ${error.status}`,
      message: error.statusText || t("errors.unexpectedError"),
    };
  }

  // Handle standard Error objects
  if (error instanceof Error) {
    // Check for common error types and provide friendly messages
    if (
      error.message.includes("ChunkLoadError") ||
      error.message.includes("Loading chunk")
    ) {
      return {
        title: t("errors.failedToLoadComponent"),
        message: t("errors.requiredFileCouldntLoad"),
      };
    }
    if (error.message.includes("Network") || error.message.includes("fetch")) {
      return {
        title: t("errors.networkErrorShort"),
        message: t("errors.couldntConnect"),
      };
    }
    if (error.message.includes("suspended")) {
      return {
        title: t("errors.componentLoadingFailed"),
        message: t("errors.failedToLoadProperly"),
      };
    }
    // Return the actual error message for other errors
    return {
      title: t("errors.applicationError"),
      message: error.message,
    };
  }

  // Handle string errors
  if (typeof error === "string") {
    return {
      title: t("status.error"),
      message: error,
    };
  }

  // Fallback for unknown error types
  return {
    title: t("errors.generic"),
    message: t("errors.unexpectedError"),
  };
}

interface ErrorPageProps {
  /** Error passed from ErrorBoundary (optional) */
  error?: Error;
}

/**
 * Inner component that tries to get route error from React Router
 * This is separate so the hook is always called unconditionally
 */
const ErrorPageWithRouter: React.FC<ErrorPageProps> = ({
  error: propError,
}) => {
  // Get error from React Router (works when used as errorElement)
  const routeError = useRouteError();

  // Use route error if available, otherwise use prop error
  const errorToShow = routeError || propError;

  return <ErrorPageContent error={errorToShow} />;
};

/**
 * Core error page content - receives error from either source
 */
const ErrorPageContent: React.FC<{ error?: unknown }> = ({ error }) => {
  // Extract user-friendly error info
  const { title, message: rawMessage } = useMemo(
    () => getErrorInfo(error),
    [error]
  );
  const [copied, setCopied] = useState(false);

  // Clean message for display (strip ANSI codes)
  const cleanMessage = useMemo(() => stripAnsiCodes(rawMessage), [rawMessage]);

  // Truncated message for display only
  const displayMessage = useMemo(
    () => truncateMessage(cleanMessage),
    [cleanMessage]
  );

  const handleCopy = useCallback(async () => {
    try {
      // Copy the full clean message (not truncated)
      await copyText(cleanMessage);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      logger.error("Failed to copy:", err);
    }
  }, [cleanMessage]);

  // Log error for debugging
  useEffect(() => {
    if (error) {
      logger.error("[ErrorPage] Error:", error);
    }
  }, [error]);

  // CRITICAL: Hide splash screen and native webviews that might be blocking the error page
  useEffect(() => {
    // Hide splash screen immediately - it may still be visible if error occurred early
    const splash = document.getElementById("splash");
    if (splash) {
      splash.style.display = "none";
    }

    const hideNativeWebviews = async () => {
      // Move the portal container off-screen first (works in both Tauri and web)
      const portalContainer = document.getElementById("persistent-portal-tabs");
      if (portalContainer) {
        portalContainer.style.left = "-9999px";
        portalContainer.style.top = "-9999px";
        portalContainer.style.pointerEvents = "none";
      }

      try {
        // Use the dedicated hide_all_inline_webviews command
        await invoke<string[]>("hide_all_inline_webviews");
      } catch (error) {
        logger.warn("[ErrorPage] Failed to hide webviews:", error);
        // This is expected to fail gracefully if no webviews exist
      }
    };

    hideNativeWebviews();
  }, []);

  const handleRestart = () => {
    // Navigate to root and let the app re-initialize
    window.location.href = window.location.origin;
  };

  return (
    // z-index must be higher than PersistentPortalTabs (z-index: 200) to ensure buttons are clickable
    <div
      className="fixed inset-0 z-[300] flex h-screen w-screen flex-col overflow-hidden bg-bg-2"
      style={{
        borderRadius: "var(--border-radius-window)",
        pointerEvents: "auto",
      }}
    >
      {/* Title bar - native traffic lights via macOS decorations */}
      <div
        data-tauri-drag-region
        className="flex h-[36px] flex-shrink-0 items-center bg-bg-2 pl-4"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />

      {/* Error content */}
      <div className="flex flex-1 items-center justify-center bg-bg-2">
        <div className="mx-auto w-full max-w-2xl px-6">
          <h1 className="mb-4 text-center text-xl font-semibold text-text-1">
            {title}
          </h1>

          {/* Error message container with better text handling */}
          <div className="mb-6 max-h-48 overflow-y-auto rounded-lg bg-bg-3 px-4 py-3">
            <p
              className="text-sm leading-relaxed text-text-3"
              style={{
                wordBreak: "break-word",
                overflowWrap: "anywhere",
                whiteSpace: "pre-wrap",
              }}
            >
              {displayMessage}
            </p>
          </div>

          <div className="flex items-center justify-center gap-3">
            <Button
              variant="primary"
              size="default"
              shape="round"
              icon={<RefreshCw size={16} />}
              onClick={handleRestart}
            >
              {i18n.t("actions.restart")}
            </Button>
            <Button
              variant="secondary"
              size="default"
              shape="round"
              icon={copied ? <Check size={16} /> : <Copy size={16} />}
              onClick={handleCopy}
            >
              {copied ? i18n.t("status.copied") : i18n.t("actions.copy")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * ErrorPage - Main export
 *
 * When used as React Router's errorElement: uses useRouteError internally
 * When used from ErrorBoundary: receives error as prop
 *
 * We default to ErrorPageWithRouter which handles both cases:
 * - If there's a route error, it uses that
 * - If an error prop is passed, it uses that as fallback
 */
const ErrorPage: React.FC<ErrorPageProps> = (props) => {
  // If we have an error prop (from ErrorBoundary), render content directly
  // This avoids calling useRouteError outside of a router context
  if (props.error) {
    return <ErrorPageContent error={props.error} />;
  }

  // Otherwise, try to get error from router (for errorElement usage)
  return <ErrorPageWithRouter {...props} />;
};

export default ErrorPage;
