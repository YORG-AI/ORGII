/**
 * useContrastJs Hook
 *
 * Description: Integrates Contrast.js for automatic text color adjustment
 * based on background brightness
 *
 * Features:
 * - Automatically initializes Contrast.js on target elements
 * - Respects user's adaptiveColors setting
 * - Cleans up on unmount
 */
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import { backgroundConfigAtom } from "@src/store/ui/backgroundConfigAtom";
import { getRelativeLuminance } from "@src/util/ui/theme/luminance";

// Hook configuration options
export interface UseContrastJsOptions {
  /** CSS selector for elements to apply adaptive colors */
  selector?: string;
  /** Default text color for light backgrounds */
  lightColor?: string;
  /** Default text color for dark backgrounds */
  darkColor?: string;
  /** Whether to auto-initialize on mount */
  autoInit?: boolean;
}

// Hook return value type
export interface UseContrastJsReturn {
  /** Whether adaptive colors are enabled */
  enabled: boolean;
  /** Manually reapply contrast adjustments */
  reapply: () => void;
  /** Check if an element is on a light or dark background */
  isLightBackground: (element: HTMLElement) => boolean;
}

// Default configuration
const DEFAULT_OPTIONS: Required<UseContrastJsOptions> = {
  selector: ".adaptive-text",
  lightColor: "rgba(0, 0, 0, 0.9)",
  darkColor: "rgba(255, 255, 255, 0.95)",
  autoInit: true,
};

/**
 * Get the background color of an element (including computed styles)
 */
function getBackgroundColor(
  element: HTMLElement
): { r: number; g: number; b: number } | null {
  const style = window.getComputedStyle(element);
  const bgColor = style.backgroundColor;

  // Parse rgba/rgb color
  const match = bgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (match) {
    return {
      r: parseInt(match[1], 10),
      g: parseInt(match[2], 10),
      b: parseInt(match[3], 10),
    };
  }

  return null;
}

/**
 * Check if background is light (luminance > 0.5)
 */
function isBackgroundLight(element: HTMLElement): boolean {
  let current: HTMLElement | null = element;

  while (current) {
    const bgColor = getBackgroundColor(current);
    if (bgColor) {
      const luminance = getRelativeLuminance(bgColor.r, bgColor.g, bgColor.b);
      // If we found a non-transparent background, return its luminance check
      const style = window.getComputedStyle(current);
      const opacity = parseFloat(style.opacity);
      const bgAlpha = style.backgroundColor.includes("rgba")
        ? parseFloat(style.backgroundColor.split(",")[3] || "1")
        : 1;

      if (bgAlpha > 0.1 && opacity > 0.1) {
        return luminance > 0.5;
      }
    }
    current = current.parentElement;
  }

  // Default to dark background assumption
  return false;
}

/**
 * Apply contrast colors to elements matching selector
 */
function applyContrast(
  selector: string,
  lightColor: string,
  darkColor: string
): void {
  const elements = document.querySelectorAll<HTMLElement>(selector);

  elements.forEach((element) => {
    const isLight = isBackgroundLight(element);
    element.style.color = isLight ? lightColor : darkColor;
  });
}

/**
 * Hook for adaptive color adjustment based on background
 */
export function useContrastJs(
  options: UseContrastJsOptions = {}
): UseContrastJsReturn {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { selector, lightColor, darkColor, autoInit } = opts;

  const config = useAtomValue(backgroundConfigAtom);
  const enabled = config.adaptiveColors ?? true;
  const observerRef = useRef<MutationObserver | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const reapply = useCallback(() => {
    if (!enabled) return;

    // Use requestAnimationFrame for smooth updates
    requestAnimationFrame(() => {
      applyContrast(selector, lightColor, darkColor);
    });
  }, [enabled, selector, lightColor, darkColor]);

  const isLightBackground = useCallback((element: HTMLElement): boolean => {
    return isBackgroundLight(element);
  }, []);

  useEffect(() => {
    // Only initialize if adaptive colors are enabled and autoInit is true
    if (!enabled || !autoInit) {
      return;
    }

    // Initial application
    reapply();

    // Set up mutation observer to watch for DOM changes
    observerRef.current = new MutationObserver((mutations) => {
      let shouldReapply = false;

      mutations.forEach((mutation) => {
        if (mutation.type === "childList" || mutation.type === "attributes") {
          shouldReapply = true;
        }
      });

      if (shouldReapply) {
        reapply();
      }
    });

    observerRef.current.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    // Listen for background config changes
    const handleBackgroundChange = () => {
      setTimeout(reapply, 100); // Small delay to let background render
    };

    window.addEventListener("backgroundConfigChange", handleBackgroundChange);
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }
      window.removeEventListener(
        "backgroundConfigChange",
        handleBackgroundChange
      );
    };
  }, [enabled, autoInit, reapply, selector]);

  return {
    enabled,
    reapply,
    isLightBackground,
  };
}

export default useContrastJs;
