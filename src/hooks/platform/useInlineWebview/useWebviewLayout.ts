import { invoke } from "@tauri-apps/api/core";
import {
  type MutableRefObject,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";

import { createLogger } from "@src/hooks/logger";
import {
  DEBOUNCE_DELAYS,
  useDebouncedCallback,
} from "@src/hooks/perf/useDebouncedCallback";
import { toNativeFrame } from "@src/util/platform/tauri/nativeFrame";

import { getVisibleWebviewRect } from "./visibleWebviewRect";
import {
  WEBVIEW_LAYOUT_CHANGED_EVENT,
  dispatchWebviewNativeFrameUpdated,
} from "./webviewLayoutEvents";

const OFFSCREEN_FRAME = {
  x: -10000,
  y: -10000,
  width: 1,
  height: 1,
} as const;

const logger = createLogger("InlineWebviewLayout");

export interface UseWebviewLayoutParams {
  containerRef: RefObject<HTMLDivElement | null>;
  isWebviewCreated: boolean;
  isWebviewAvailable: boolean;
  isVisible: boolean;
  labelRef: MutableRefObject<string>;
  log: (...args: unknown[]) => void;
}

export interface UseWebviewLayoutReturn {
  getContainerRect: () => DOMRect | null;
  updatePosition: (options?: { force?: boolean }) => Promise<void>;
  repositionAndShow: () => Promise<boolean>;
  stageOffscreen: (options?: { force?: boolean }) => Promise<void>;
}

export function useWebviewLayout(
  params: UseWebviewLayoutParams
): UseWebviewLayoutReturn {
  const {
    containerRef,
    isWebviewCreated,
    isWebviewAvailable,
    isVisible,
    labelRef,
    log,
  } = params;

  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const scrollListenerRef = useRef<(() => void) | null>(null);
  const isVisibleRef = useRef(isVisible);
  const surfaceCommandQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastResizeRect = useRef<{
    width: number;
    height: number;
    x: number;
    y: number;
  } | null>(null);

  const getContainerRect = useCallback(() => {
    if (!containerRef.current) return null;
    return getVisibleWebviewRect(containerRef.current);
  }, [containerRef]);

  useEffect(() => {
    isVisibleRef.current = isVisible;
  }, [isVisible]);

  const enqueueSurfaceCommand = useCallback(
    (operation: () => Promise<void>): Promise<void> => {
      const queued = surfaceCommandQueueRef.current
        .catch(() => undefined)
        .then(operation);
      surfaceCommandQueueRef.current = queued.catch(() => undefined);
      return queued;
    },
    []
  );

  const applyOffscreenPosition = useCallback(
    async (force = false) => {
      const lastRect = lastResizeRect.current;
      if (
        !force &&
        lastRect?.x === OFFSCREEN_FRAME.x &&
        lastRect.y === OFFSCREEN_FRAME.y &&
        lastRect.width === OFFSCREEN_FRAME.width &&
        lastRect.height === OFFSCREEN_FRAME.height
      ) {
        return;
      }

      await invoke("update_inline_webview_position", {
        label: labelRef.current,
        ...OFFSCREEN_FRAME,
      });
      // Commit only after native success so a failed IPC remains retryable.
      lastResizeRect.current = OFFSCREEN_FRAME;
    },
    [labelRef]
  );

  const stageOffscreen = useCallback(
    async (options?: { force?: boolean }) => {
      if (!isWebviewCreated) return;

      try {
        await enqueueSurfaceCommand(() =>
          applyOffscreenPosition(options?.force)
        );
      } catch (err) {
        log("Failed to stage WebView offscreen:", err);
      }
    },
    [applyOffscreenPosition, enqueueSurfaceCommand, isWebviewCreated, log]
  );

  const updatePosition = useCallback(
    async (options?: { force?: boolean }) => {
      if (!isWebviewCreated || !containerRef.current) return;

      try {
        await enqueueSurfaceCommand(async () => {
          // Re-check the latest desired state at execution time. This also
          // makes stale ResizeObserver and timer callbacks fail closed.
          if (!isVisibleRef.current) {
            await applyOffscreenPosition(options?.force);
            return;
          }

          const rect = getContainerRect();
          if (!rect) {
            await applyOffscreenPosition(options?.force);
            return;
          }

          const nativeFrame = toNativeFrame(rect);
          logger.rateLimited("native-frame", 1000, "measured frame", {
            label: labelRef.current,
            rect: {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
            },
            nativeFrame,
          });

          const lastRect = lastResizeRect.current;
          if (
            !options?.force &&
            lastRect &&
            Math.abs(lastRect.width - nativeFrame.width) < 2 &&
            Math.abs(lastRect.height - nativeFrame.height) < 2 &&
            Math.abs(lastRect.x - nativeFrame.x) < 2 &&
            Math.abs(lastRect.y - nativeFrame.y) < 2
          ) {
            return;
          }

          await invoke("update_inline_webview_position", {
            label: labelRef.current,
            ...nativeFrame,
          });
          // Commit only after native success so a failed IPC remains retryable.
          lastResizeRect.current = nativeFrame;
          dispatchWebviewNativeFrameUpdated(labelRef.current);
          log("Position updated:", { rect, nativeFrame });
        });
      } catch (err) {
        log("Failed to update position:", err);
      }
    },
    [
      isWebviewCreated,
      containerRef,
      applyOffscreenPosition,
      enqueueSurfaceCommand,
      getContainerRect,
      labelRef,
      log,
    ]
  );

  const repositionAndShow = useCallback(async (): Promise<boolean> => {
    if (!isWebviewCreated || !containerRef.current) return false;

    let shown = false;
    try {
      await enqueueSurfaceCommand(async () => {
        if (!isVisibleRef.current) {
          await applyOffscreenPosition();
          return;
        }

        const rect = getContainerRect();
        if (!rect) {
          await applyOffscreenPosition();
          return;
        }

        const nativeFrame = toNativeFrame(rect);
        // One native command guarantees the frame is current before show(), so
        // an overlay close cannot flash the WebView at its previous position.
        await invoke("reposition_and_show_webview", {
          label: labelRef.current,
          ...nativeFrame,
        });
        lastResizeRect.current = nativeFrame;
        dispatchWebviewNativeFrameUpdated(labelRef.current);
        shown = true;
        log("WebView repositioned and shown:", { rect, nativeFrame });
      });
    } catch (err) {
      log("Failed to reposition and show WebView:", err);
    }
    return shown;
  }, [
    applyOffscreenPosition,
    containerRef,
    enqueueSurfaceCommand,
    getContainerRect,
    isWebviewCreated,
    labelRef,
    log,
  ]);

  const debouncedUpdatePosition = useDebouncedCallback(() => {
    void updatePosition();
  }, DEBOUNCE_DELAYS.FRAME);

  useEffect(() => {
    if (!isVisible) {
      debouncedUpdatePosition.cancel();
    }
  }, [debouncedUpdatePosition, isVisible]);

  useEffect(() => {
    if (!containerRef.current || !isWebviewAvailable) return;

    resizeObserverRef.current = new ResizeObserver(() => {
      debouncedUpdatePosition();
    });

    resizeObserverRef.current.observe(containerRef.current);

    return () => {
      resizeObserverRef.current?.disconnect();
      debouncedUpdatePosition.cancel();
    };
  }, [containerRef, isWebviewAvailable, debouncedUpdatePosition]);

  useEffect(() => {
    if (!isWebviewCreated || !isWebviewAvailable) return;

    const scaleUpdateTimers = new Set<number>();

    const handleScroll = () => {
      debouncedUpdatePosition();
    };

    const scheduleForcedPositionUpdate = (delay: number) => {
      const timer = window.setTimeout(() => {
        scaleUpdateTimers.delete(timer);
        void updatePosition({ force: true });
      }, delay);
      scaleUpdateTimers.add(timer);
    };

    const handleForcedLayoutChange = () => {
      void updatePosition({ force: true });
      [16, 50, 120, 240].forEach(scheduleForcedPositionUpdate);
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("orgii-ui-scale-applied", handleForcedLayoutChange);
    window.addEventListener(
      WEBVIEW_LAYOUT_CHANGED_EVENT,
      handleForcedLayoutChange
    );

    const scrollableParents: Element[] = [];
    let parent: Element | null = containerRef.current?.parentElement || null;
    while (parent) {
      const style = window.getComputedStyle(parent);
      if (
        style.overflow === "auto" ||
        style.overflow === "scroll" ||
        style.overflowY === "auto" ||
        style.overflowY === "scroll" ||
        style.overflowX === "auto" ||
        style.overflowX === "scroll"
      ) {
        scrollableParents.push(parent);
        parent.addEventListener("scroll", handleScroll, { passive: true });
      }
      parent = parent.parentElement;
    }

    scrollListenerRef.current = () => {
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener(
        "orgii-ui-scale-applied",
        handleForcedLayoutChange
      );
      window.removeEventListener(
        WEBVIEW_LAYOUT_CHANGED_EVENT,
        handleForcedLayoutChange
      );
      scrollableParents.forEach((el) => {
        el.removeEventListener("scroll", handleScroll);
      });
      scaleUpdateTimers.forEach((timer) => window.clearTimeout(timer));
      scaleUpdateTimers.clear();
    };

    return () => {
      if (scrollListenerRef.current) {
        scrollListenerRef.current();
        scrollListenerRef.current = null;
      }
    };
  }, [
    containerRef,
    isWebviewCreated,
    isWebviewAvailable,
    debouncedUpdatePosition,
    updatePosition,
  ]);

  return {
    getContainerRect,
    updatePosition,
    repositionAndShow,
    stageOffscreen,
  };
}
