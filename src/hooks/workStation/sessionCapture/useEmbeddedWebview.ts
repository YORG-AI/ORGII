/**
 * useEmbeddedWebview
 *
 * Base hook encapsulating the shared lifecycle of an inline Tauri webview:
 * - Unique label generation
 * - Open / close / updatePosition
 * - isOpen / isLoading / currentUrl state
 * - URL-change event listener with isMounted guard
 * - Observer-driven KeepAlive visibility (auto-close when host container is hidden)
 * - Unmount cleanup
 *
 * Consumers supply the Tauri command names and the URL-change event name
 * because each auth flow uses different Rust commands.
 */
import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { v4 as uuidv4 } from "uuid";

import { createLogger } from "@src/hooks/logger";
import { toNativeFrame } from "@src/util/platform/tauri/nativeFrame";

const moduleLog = createLogger("useEmbeddedWebview");

/** Tauri command names wired to a specific auth webview type. */
export interface EmbeddedWebviewCommands {
  /** Command to create the webview. Must accept: parentWindow, label, x, y, width, height + optional extra fields. */
  create: string;
  /** Command to close the webview. Must accept: label. */
  close: string;
  /**
   * Command to update the webview position in-place.
   * If not provided, updatePosition falls back to close+recreate.
   */
  updatePosition?: string;
  /** Tauri event name for URL changes. Payload must include { url: string }. */
  urlChangedEvent: string;
}

export interface UseEmbeddedWebviewOptions {
  labelPrefix: string;
  containerRef?: RefObject<HTMLDivElement | null>;
  commands: EmbeddedWebviewCommands;
  debug?: boolean;
  /** Extra fields merged into the create command payload (e.g. initial url). */
  extraCreateArgs?: Record<string, unknown>;
  ignoreAboutBlank?: boolean;
}

export interface UseEmbeddedWebviewReturn {
  isOpen: boolean;
  isLoading: boolean;
  currentUrl: string;
  label: string;
  openWebview: (url?: string) => Promise<void>;
  closeWebview: () => Promise<void>;
  updatePosition: () => Promise<void>;
  setCurrentUrl: (url: string) => void;
}

const INSET = 2;

export function useEmbeddedWebview({
  labelPrefix,
  containerRef,
  commands,
  debug = false,
  extraCreateArgs = {},
  ignoreAboutBlank = false,
}: UseEmbeddedWebviewOptions): UseEmbeddedWebviewReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [currentUrl, setCurrentUrl] = useState("");

  const labelRef = useRef(`${labelPrefix}-${uuidv4()}`);
  const urlListenerRef = useRef<UnlistenFn | null>(null);

  const log = useCallback(
    (...args: unknown[]) => {
      if (debug)
        moduleLog.debug(`[useEmbeddedWebview:${labelPrefix}]`, ...args);
    },
    [debug, labelPrefix]
  );

  const openWebview = useCallback(
    async (url?: string) => {
      if (!containerRef?.current) {
        log("Container ref not available");
        return;
      }

      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        log("Container has no dimensions");
        return;
      }

      try {
        setIsLoading(true);
        if (url) setCurrentUrl(url);

        const appWindow = getCurrentWindow();
        log("Creating webview at rect:", rect);

        const frame = toNativeFrame(rect, INSET);
        await invoke(commands.create, {
          parentWindow: appWindow.label,
          label: labelRef.current,
          ...frame,
          ...(url ? { url } : {}),
          ...extraCreateArgs,
        });

        setIsOpen(true);
        setIsLoading(false);
        log("Webview created successfully");
      } catch (err) {
        log("Failed to create webview:", err);
        setIsLoading(false);
        throw err;
      }
    },
    // extraCreateArgs intentionally excluded — callers should memoize it or pass a stable ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [containerRef, commands.create, log]
  );

  const closeWebview = useCallback(async () => {
    try {
      await invoke(commands.close, { label: labelRef.current });
      setIsOpen(false);
      setCurrentUrl("");
      log("Webview closed");
    } catch (err) {
      log("Failed to close webview:", err);
    }
  }, [commands.close, log]);

  const updatePosition = useCallback(async () => {
    if (!isOpen || !containerRef?.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    try {
      const frame = toNativeFrame(rect, INSET);
      if (commands.updatePosition) {
        await invoke(commands.updatePosition, {
          label: labelRef.current,
          ...frame,
        });
      } else {
        // Close + recreate at new position
        const savedUrl = currentUrl;
        await invoke(commands.close, { label: labelRef.current });
        const appWindow = getCurrentWindow();
        await invoke(commands.create, {
          parentWindow: appWindow.label,
          label: labelRef.current,
          url: savedUrl,
          ...frame,
          ...extraCreateArgs,
        });
      }
    } catch (err) {
      log("Failed to update position:", err);
    }
    // extraCreateArgs intentionally excluded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, containerRef, commands, currentUrl, log]);

  // URL-change event listener
  useEffect(() => {
    let isMounted = true;

    const setup = async () => {
      const unlisten = await listen<{ url: string; webviewLabel?: string }>(
        commands.urlChangedEvent,
        (event) => {
          if (!isMounted) return;
          const { url, webviewLabel } = event.payload;
          if (webviewLabel && webviewLabel !== labelRef.current) return;
          if (ignoreAboutBlank && url === "about:blank") return;
          setCurrentUrl(url);
          log("URL changed:", url);
        }
      );
      if (isMounted) urlListenerRef.current = unlisten;
    };

    setup().catch(() => {});

    return () => {
      isMounted = false;
      urlListenerRef.current?.();
      urlListenerRef.current = null;
    };
  }, [commands.urlChangedEvent, ignoreAboutBlank, log]);

  // KeepAlive visibility observation — auto-close when host container is hidden
  const wasHiddenWhileOpen = useRef(false);

  useEffect(() => {
    const container = containerRef?.current;
    if (!container) return;
    let transitioning = false;

    const checkVisibility = () => {
      if (transitioning) return;
      const isHidden =
        document.visibilityState !== "visible" ||
        container.offsetParent === null;

      if (isHidden && isOpen) {
        transitioning = true;
        invoke(commands.close, { label: labelRef.current })
          .catch(() => {})
          .finally(() => {
            transitioning = false;
          });
        setIsOpen(false);
        wasHiddenWhileOpen.current = true;
      } else if (!isHidden && wasHiddenWhileOpen.current) {
        transitioning = true;
        wasHiddenWhileOpen.current = false;
        openWebview(currentUrl || undefined)
          .catch(() => {})
          .finally(() => {
            transitioning = false;
          });
      }
    };

    const intersectionObserver = new IntersectionObserver(checkVisibility);
    intersectionObserver.observe(container);
    const resizeObserver = new ResizeObserver(checkVisibility);
    resizeObserver.observe(container);
    document.addEventListener("visibilitychange", checkVisibility);
    checkVisibility();

    return () => {
      intersectionObserver.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", checkVisibility);
    };
  }, [isOpen, containerRef, commands.close, currentUrl, openWebview]);

  // Cleanup on unmount
  useEffect(() => {
    const label = labelRef.current;
    return () => {
      invoke(commands.close, { label }).catch(() => {});
    };
    // Only run on mount/unmount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    isOpen,
    isLoading,
    currentUrl,
    label: labelRef.current,
    openWebview,
    closeWebview,
    updatePosition,
    setCurrentUrl,
  };
}
