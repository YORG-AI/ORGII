/**
 * useChatPanelResize Hook
 *
 * Ultra-optimized resize logic using RAF (requestAnimationFrame).
 * - Only updates once per frame
 * - Updates one live width channel during drag: CHAT_WIDTH_CSS_VAR
 * - Persists the CSS variable width to atom/storage only on mouseup
 * - Ignores clicks without actual drag to prevent accidental resize
 *
 * INVARIANT: drag minimizes, never closes. The handle clamps to MIN_WIDTH
 * on both the live drag and the final commit — no combination of window
 * size, NaN delta, or stale pending width can persist a width below
 * MIN_WIDTH. Closing the chat panel is an explicit toolbar action, not a
 * resize outcome.
 *
 * OPTIMIZED: Uses useSetAtom to avoid subscribing to chatWidth changes
 * Width is read from CSS variable, not React state
 */
import { useSetAtom } from "jotai";
import {
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { DEFAULT_CHAT_WIDTH, chatWidthAtom } from "@src/store/ui/chatPanelAtom";

import {
  CHAT_WIDTH_CSS_VAR,
  MIN_WIDTH,
  RAPID_CLICK_THRESHOLD_MS,
  clampChatWidth,
  getChatMaxWidth,
} from "../config";

export interface UseChatPanelResizeOptions {
  /** Whether using external width control */
  useExternalWidth?: boolean;
  /** Panel position: left or right */
  position?: "left" | "right";
}

export interface UseChatPanelResizeResult {
  /** Whether currently dragging */
  isDragging: boolean;
  /** Ref to attach to the panel element */
  panelRef: RefObject<HTMLDivElement | null>;
  /** Mouse down handler for drag handle */
  handleMouseDown: (event: ReactMouseEvent) => void;
}

// Helper to get current width from CSS variable, clamped to the responsive max.
const getChatWidthFromCSS = (): number => {
  if (typeof document === "undefined") return DEFAULT_CHAT_WIDTH;
  const cssValue =
    document.documentElement.style.getPropertyValue(CHAT_WIDTH_CSS_VAR);
  if (cssValue) {
    const parsed = parseInt(cssValue, 10);
    if (!isNaN(parsed)) return clampChatWidth(parsed);
  }
  return DEFAULT_CHAT_WIDTH;
};

/**
 * Hook for managing ChatPanel resize behavior
 */
export function useChatPanelResize(
  options: UseChatPanelResizeOptions = {}
): UseChatPanelResizeResult {
  const { useExternalWidth = false, position = "right" } = options;
  const isLeftPosition = position === "left";

  // OPTIMIZED: Only use setter, don't subscribe to value changes
  // Width is read from CSS variable when needed
  const setChatWidth = useSetAtom(chatWidthAtom);
  const [isDragging, setIsDragging] = useState(false);

  // Refs for pure DOM resize (no React renders during drag)
  const panelRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const pendingWidthRef = useRef<number>(0);
  const hasDraggedRef = useRef<boolean>(false);
  const lastClickTimeRef = useRef<number>(0);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  /**
   * Handle mouse down on drag handle
   */
  const handleMouseDown = useCallback(
    (event: ReactMouseEvent) => {
      if (useExternalWidth) return;

      event.preventDefault();
      event.stopPropagation();

      // Ignore double-click (detail >= 2)
      if (event.detail >= 2) {
        return;
      }

      // Ignore clicks within threshold of last click (rapid click prevention)
      const now = Date.now();
      if (now - lastClickTimeRef.current < RAPID_CLICK_THRESHOLD_MS) {
        return;
      }
      lastClickTimeRef.current = now;

      // OPTIMIZED: Read current width from CSS variable instead of React state
      const currentWidth = getChatWidthFromCSS();
      const startX = event.clientX;
      const startWidth = currentWidth;
      pendingWidthRef.current = currentWidth;
      hasDraggedRef.current = false;

      const applyLiveWidth = (width: number) => {
        document.documentElement.style.setProperty(
          CHAT_WIDTH_CSS_VAR,
          `${width}px`
        );
      };

      const commitPendingWidth = () => {
        const rawFinal = pendingWidthRef.current;
        const finalWidth = clampChatWidth(
          Number.isFinite(rawFinal) && rawFinal >= MIN_WIDTH
            ? rawFinal
            : MIN_WIDTH
        );

        applyLiveWidth(finalWidth);
        setChatWidth(finalWidth);
      };

      const handleMouseMove = (moveEvent: globalThis.MouseEvent) => {
        // Only start "dragging" mode after first actual movement
        if (!hasDraggedRef.current) {
          hasDraggedRef.current = true;
          setIsDragging(true);

          // Set cursor globally - only when actually dragging
          document.body.style.cursor = "ew-resize";
          document.body.style.userSelect = "none";
        }

        const dynamicMaxWidth = getChatMaxWidth();

        // Calculate new width with constraints. Minimum is enforced as the
        // LAST step so nothing (negative delta, NaN, subzero dynamicMax, …)
        // can produce a width below MIN_WIDTH — drag minimizes, never closes.
        const delta = isLeftPosition
          ? moveEvent.clientX - startX
          : startX - moveEvent.clientX;
        const proposed = startWidth + delta;
        const clampedToMax = Math.min(dynamicMaxWidth, proposed);
        const newWidth = Math.max(MIN_WIDTH, clampedToMax);
        pendingWidthRef.current = newWidth;

        // Cancel previous RAF if pending
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
        }

        // Schedule DOM update for next frame
        rafRef.current = requestAnimationFrame(() => {
          applyLiveWidth(newWidth);
        });
      };

      const handleMouseUp = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);

        // Only do cleanup if we actually started dragging
        if (hasDraggedRef.current) {
          if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
          }

          document.body.style.cursor = "";
          document.body.style.userSelect = "";

          commitPendingWidth();
          setIsDragging(false);
          hasDraggedRef.current = false;
        }
      };

      // Store cleanup functions for unmount safety
      // Also reset body styles to prevent stuck user-select: none if unmount happens mid-drag
      dragCleanupRef.current = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        if (hasDraggedRef.current) {
          commitPendingWidth();
        }
        hasDraggedRef.current = false;
        setIsDragging(false);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [isLeftPosition, setChatWidth, useExternalWidth]
  );

  // Cleanup drag listeners on unmount
  useEffect(() => {
    const handleWindowBlur = () => {
      if (!hasDraggedRef.current) return;
      dragCleanupRef.current?.();
    };

    window.addEventListener("blur", handleWindowBlur);

    return () => {
      window.removeEventListener("blur", handleWindowBlur);
      dragCleanupRef.current?.();
    };
  }, []);

  return {
    isDragging,
    panelRef,
    handleMouseDown,
  };
}
