/**
 * useWebviewVisibility Hook
 *
 * Description: Consolidates all WebView visibility checks into a single hook
 * to reduce atom subscriptions and prevent unnecessary re-renders.
 *
 * Features:
 * - Single subscription for all overlay states
 * - Memoized visibility calculation
 * - Reduces 6+ useAtomValue calls to 1
 *
 * Note: webviewBlockedAtom has been moved to @src/store/workspaceAtom
 * for better organization (all UI state atoms should be in store/).
 */
import { useAtomValue } from "jotai";

import { webviewBlockedAtom } from "@src/store/ui/overlayAtom";

// ============================================
// Hook Options
// ============================================

export interface UseWebviewVisibilityOptions {
  /** Whether the parent component/tab is active */
  isTabActive?: boolean;
  /** Whether the webview has content to show */
  hasContent?: boolean;
}

export interface UseWebviewVisibilityReturn {
  /** Whether the WebView should be visible (not blocked by overlays) */
  isVisible: boolean;
  /** Whether any overlay is blocking WebViews */
  isBlocked: boolean;
  /** Full isActive value for useInlineWebview */
  isActive: boolean;
}

// ============================================
// Hook Implementation
// ============================================

/**
 * Hook for determining WebView visibility state.
 * Consolidates overlay checks to reduce re-renders.
 *
 * @example
 * ```tsx
 * const { isActive } = useWebviewVisibility({
 *   isTabActive: true,
 *   hasContent: !!url,
 * });
 *
 * useInlineWebview({
 *   isActive,
 *   // ...other options
 * });
 * ```
 */
export function useWebviewVisibility(
  options: UseWebviewVisibilityOptions = {}
): UseWebviewVisibilityReturn {
  const { isTabActive = true, hasContent = true } = options;

  // Single atom subscription for all overlay states
  const isBlocked = useAtomValue(webviewBlockedAtom);

  // Compute visibility
  const isVisible = !isBlocked;
  const isActive = isTabActive && hasContent && isVisible;

  return {
    isVisible,
    isBlocked,
    isActive,
  };
}

export default useWebviewVisibility;
