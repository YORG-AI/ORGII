import React, { Component, ReactNode } from "react";

import { createLogger } from "@src/hooks/logger";
import ErrorPage from "@src/modules/shared/Error";
import {
  hasGlobalErrorAtom,
  isAppQuittingAtom,
} from "@src/store/ui/overlayAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import {
  cleanUpBrowserStorage,
  isStorageQuotaError,
} from "@src/util/core/storage/quotaRecovery";

const log = createLogger("ErrorBoundary");

const getJotaiStore = () => {
  try {
    return getInstrumentedStore();
  } catch (error) {
    log.error("[ErrorBoundary] Failed to get instrumented store:", error);
    return null;
  }
};

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
  errorInfo?: React.ErrorInfo;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    const jotaiStore = getJotaiStore();
    if (jotaiStore) {
      jotaiStore.set(hasGlobalErrorAtom, true);
    }
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    log.error("React Error Boundary caught an error:", error, errorInfo);

    // Reveal the error UI: the HTML splash (z-index 99999) would otherwise
    // cover the rendered ErrorPage until the index.html watchdog fires. Hiding
    // it here surfaces the error immediately instead of looking like a hang.
    const splash = document.getElementById("splash");
    if (splash) {
      splash.style.display = "none";
    }
    const splashDone = (
      window as unknown as { __ORGII_SPLASH_DONE__?: () => void }
    ).__ORGII_SPLASH_DONE__;
    if (typeof splashDone === "function") {
      splashDone();
    }

    if (
      error.message?.includes("Loading chunk") ||
      error.message?.includes("ChunkLoadError") ||
      error.name === "ChunkLoadError"
    ) {
      log.warn(
        "Chunk loading error in React boundary, reloading page:",
        error.message
      );
      window.location.reload();
      return;
    }

    if (
      error.message?.includes(
        "A component suspended while responding to synchronous input"
      ) ||
      errorInfo.componentStack?.includes("throwException") ||
      errorInfo.componentStack?.includes("renderRootSync")
    ) {
      log.warn(
        "React Suspense error detected, redirecting to error page:",
        error.message
      );
      setTimeout(() => {
        window.location.href = window.location.origin + "/error.html";
      }, 100);
      return;
    }

    this.setState({
      hasError: true,
      error,
      errorInfo,
    });
  }

  render() {
    if (this.state.hasError) {
      return <ErrorPage error={this.state.error} />;
    }

    return this.props.children;
  }
}

const GlobalErrorHandler: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [globalError, setGlobalError] = React.useState<Error | null>(null);
  const hasLoggedQuotaRecovery = React.useRef(false);

  React.useEffect(() => {
    const recoverQuotaError = (error: unknown): boolean => {
      if (!isStorageQuotaError(error)) return false;
      const cleanup = cleanUpBrowserStorage("quota-recovery");
      if (!hasLoggedQuotaRecovery.current) {
        hasLoggedQuotaRecovery.current = true;
        log.warn(
          `[GlobalErrorHandler] Suppressed a recoverable browser-storage quota error; released ${cleanup.freedBytes} bytes of regenerable cache data.`,
          error
        );
      }
      return true;
    };

    const shouldSuppressError = (message?: string): boolean => {
      if (!message) return false;
      return (
        message.includes("ResizeObserver") ||
        message.includes("Script error.") ||
        (message.includes("window['_") &&
          (message.includes("is not a function") ||
            message.includes("is undefined"))) ||
        message.includes("Failed to load resource") ||
        message.includes("unsupported URL") ||
        message.includes("Failed to decode") ||
        message.includes("Image decode failed")
      );
    };

    const isChunkError = (message?: string, filename?: string): boolean => {
      return !!(
        message?.includes("Loading chunk") ||
        message?.includes("ChunkLoadError") ||
        filename?.includes("vendors-node_modules")
      );
    };

    const errorHandler = (event: ErrorEvent) => {
      const jotaiStore = getJotaiStore();
      if (jotaiStore?.get(isAppQuittingAtom)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (
        !event.message &&
        event.target instanceof HTMLElement &&
        event.target !== document.documentElement
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (isChunkError(event.message, event.filename)) {
        window.location.reload();
        return;
      }

      if (recoverQuotaError(event.error ?? event.message)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (shouldSuppressError(event.message)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const error =
        event.error instanceof Error
          ? event.error
          : new Error(event.message || "An unexpected error occurred");
      setGlobalError(error);
      if (jotaiStore) {
        jotaiStore.set(hasGlobalErrorAtom, true);
      }
    };

    const rejectionHandler = (event: PromiseRejectionEvent) => {
      const jotaiStore = getJotaiStore();
      if (jotaiStore?.get(isAppQuittingAtom)) {
        event.preventDefault();
        return;
      }

      const message = event.reason?.message;

      if (recoverQuotaError(event.reason ?? message)) {
        event.preventDefault();
        return;
      }

      if (shouldSuppressError(message)) {
        event.preventDefault();
        return;
      }

      // Soft-fail rejections that carry no diagnostic payload. These show up
      // when a Tauri `invoke()` is aborted mid-flight (e.g. user clicks Stop
      // and the backend drops the pending future) or when a library throws a
      // non-Error value. Escalating these to the full-screen ErrorPage makes
      // a transient cancel look like a fatal app crash.
      //
      // Real Error objects (with stack) still escalate so genuine bugs
      // remain visible.
      const reason = event.reason;
      const isMeaningfulError =
        reason instanceof Error &&
        typeof reason.message === "string" &&
        reason.message.length > 0;
      if (!isMeaningfulError) {
        log.warn(
          "[GlobalErrorHandler] Suppressing empty-reason unhandled rejection:",
          reason
        );
        event.preventDefault();
        return;
      }

      setGlobalError(reason);
      if (jotaiStore) {
        jotaiStore.set(hasGlobalErrorAtom, true);
      }
    };

    window.addEventListener("error", errorHandler, true);
    window.addEventListener("unhandledrejection", rejectionHandler);

    return () => {
      window.removeEventListener("error", errorHandler, true);
      window.removeEventListener("unhandledrejection", rejectionHandler);
    };
  }, []);

  if (globalError) {
    return <ErrorPage error={globalError} />;
  }

  return <>{children}</>;
};

const CombinedErrorBoundary: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  return (
    <ErrorBoundary>
      <GlobalErrorHandler>{children}</GlobalErrorHandler>
    </ErrorBoundary>
  );
};

export default CombinedErrorBoundary;
export { ErrorBoundary, GlobalErrorHandler };
