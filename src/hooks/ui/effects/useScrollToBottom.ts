/**
 * useScrollToBottom Hook
 *
 * Simple hook for auto-scrolling to bottom when content changes.
 * VS Code-style behavior for terminal, output, and test result panels.
 *
 * Features:
 * - Scrolls to bottom when dependency changes
 * - Respects user scroll position (only auto-scrolls if already at bottom)
 * - Optional force scroll regardless of position
 */
import { RefObject, useCallback, useEffect, useRef } from "react";

// ============================================
// Types
// ============================================

export interface UseScrollToBottomOptions {
  /** Reference to the scrollable container */
  containerRef: RefObject<HTMLElement | null>;
  /** Dependencies to trigger scroll (e.g., content array) */
  dependencies: readonly unknown[];
  /** Whether to always scroll or only when user is at bottom */
  forceScroll?: boolean;
  /** Threshold in pixels to consider "at bottom" (default: 50) */
  threshold?: number;
  /** Whether the feature is enabled (default: true) */
  enabled?: boolean;
}

export interface UseScrollToBottomReturn {
  /** Manually scroll to bottom */
  scrollToBottom: () => void;
  /** Check if currently at bottom */
  isAtBottom: () => boolean;
}

// ============================================
// Hook Implementation
// ============================================

/**
 * Hook for auto-scroll to bottom on content change
 * Similar to VS Code terminal/output panel behavior
 */
export function useScrollToBottom(
  options: UseScrollToBottomOptions
): UseScrollToBottomReturn {
  const {
    containerRef,
    dependencies,
    forceScroll = true,
    threshold = 50,
    enabled = true,
  } = options;

  // Track if user has manually scrolled up
  const userScrolledUpRef = useRef(false);
  const lastScrollTopRef = useRef(0);

  // Check if at bottom
  const isAtBottom = useCallback((): boolean => {
    const container = containerRef.current;
    if (!container) return true;

    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight <= threshold;
  }, [containerRef, threshold]);

  // Scroll to bottom
  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    container.scrollTop = container.scrollHeight;
    userScrolledUpRef.current = false;
  }, [containerRef]);

  // Keep threshold in a ref so the scroll listener never needs to be
  // re-registered when threshold changes (threshold is usually a constant,
  // but this also guards against dynamic callers).
  const thresholdRef = useRef(threshold);
  useEffect(() => {
    thresholdRef.current = threshold;
  }, [threshold]);

  // Track user scroll to detect manual scroll up.
  // Intentionally does NOT depend on `isAtBottom` (a useCallback) to avoid
  // remove+re-add on every threshold change. Inline the at-bottom check
  // using the live thresholdRef instead.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;

    const handleScroll = () => {
      const currentScrollTop = container.scrollTop;
      const atBottom =
        container.scrollHeight - currentScrollTop - container.clientHeight <=
        thresholdRef.current;

      if (currentScrollTop < lastScrollTopRef.current && !atBottom) {
        userScrolledUpRef.current = true;
      }
      if (atBottom) {
        userScrolledUpRef.current = false;
      }

      lastScrollTopRef.current = currentScrollTop;
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [containerRef, enabled]);

  // Auto-scroll when dependencies change
  useEffect(() => {
    if (!enabled) return;

    const container = containerRef.current;
    if (!container) return;

    // Only scroll if forceScroll is true or user hasn't scrolled up
    if (forceScroll || !userScrolledUpRef.current) {
      // Use requestAnimationFrame to ensure DOM has updated
      requestAnimationFrame(() => {
        scrollToBottom();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callers explicitly provide the content-change clock; the remaining lifecycle inputs are appended here and scrollToBottom reads the current ref
  }, [...dependencies, enabled, forceScroll, scrollToBottom]);

  return {
    scrollToBottom,
    isAtBottom,
  };
}

export default useScrollToBottom;
