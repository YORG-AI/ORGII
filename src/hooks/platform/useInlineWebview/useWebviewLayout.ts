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

import { WEBVIEW_LAYOUT_CHANGED_EVENT } from "./webviewLayoutEvents";

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
  updatePosition: (options?: {
    force?: boolean;
    show?: boolean;
  }) => Promise<void>;
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
  const lastResizeRect = useRef<{
    width: number;
    height: number;
    x: number;
    y: number;
  } | null>(null);

  const getContainerRect = useCallback(() => {
    if (!containerRef.current) return null;
    return containerRef.current.getBoundingClientRect();
  }, [containerRef]);

  const updatePosition = useCallback(
    async (options?: { force?: boolean; show?: boolean }) => {
      if (!isWebviewCreated || !isVisible || !containerRef.current) return;

      const rect = getContainerRect();
      if (!rect) return;

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
      lastResizeRect.current = nativeFrame;

      try {
        await invoke(
          options?.show
            ? "reposition_and_show_webview"
            : "update_inline_webview_position",
          {
            label: labelRef.current,
            ...nativeFrame,
          }
        );
        log("Position updated:", { rect, nativeFrame });
      } catch (err) {
        log("Failed to update position:", err);
      }
    },
    [isWebviewCreated, isVisible, containerRef, getContainerRect, labelRef, log]
  );

  const debouncedUpdatePosition = useDebouncedCallback(() => {
    void updatePosition();
  }, DEBOUNCE_DELAYS.FRAME);

  useEffect(() => {
    if (!containerRef.current || !isWebviewAvailable || !isVisible) return;

    resizeObserverRef.current = new ResizeObserver(() => {
      debouncedUpdatePosition();
    });

    resizeObserverRef.current.observe(containerRef.current);

    return () => {
      resizeObserverRef.current?.disconnect();
      debouncedUpdatePosition.cancel();
    };
  }, [containerRef, isWebviewAvailable, isVisible, debouncedUpdatePosition]);

  useEffect(() => {
    if (!isWebviewCreated || !isWebviewAvailable || !isVisible) return;

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
    isVisible,
    debouncedUpdatePosition,
    updatePosition,
  ]);

  return { getContainerRect, updatePosition };
}
