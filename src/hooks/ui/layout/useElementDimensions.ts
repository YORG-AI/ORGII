import { RefObject, useEffect, useLayoutEffect, useState } from "react";

/**
 * useElementDimensions Hook
 *
 * Consolidated hook for measuring element dimensions (width, height, or both).
 * Replaces useWidth, useHeight, and provides base for viewport-relative calculations.
 *
 * Features:
 * - ResizeObserver for accurate dimension tracking
 * - SSR-safe with useIsomorphicLayoutEffect
 * - Supports measuring width, height, or both
 * - Handles nested ref objects
 * - Window resize fallback
 */

// Use useLayoutEffect on client, useEffect on server (SSR safety)
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export type DimensionType = "width" | "height" | "both";

export interface ElementDimensions {
  width: number;
  height: number;
}

export interface UseElementDimensionsOptions {
  /** What to measure: 'width', 'height', or 'both' */
  dimension?: DimensionType;
  /** Disable measurement and listener ownership while the element is absent. */
  enabled?: boolean;
  /** Additional dependency to trigger re-measurement */
  deps?: unknown[];
}

/**
 * Hook for measuring element dimensions with ResizeObserver
 *
 * @example
 * // Measure width only
 * const width = useElementDimensions(ref, { dimension: 'width' });
 *
 * @example
 * // Measure height only
 * const height = useElementDimensions(ref, { dimension: 'height' });
 *
 * @example
 * // Measure both dimensions
 * const { width, height } = useElementDimensions(ref, { dimension: 'both' });
 *
 * @example
 * // With additional dependencies
 * const width = useElementDimensions(ref, { dimension: 'width', deps: [isOpen] });
 */
export function useElementDimensions(
  ref: RefObject<HTMLElement | null | { current?: HTMLElement | null }>,
  options: UseElementDimensionsOptions & { dimension: "width" }
): number;

export function useElementDimensions(
  ref: RefObject<HTMLElement | null | { current?: HTMLElement | null }>,
  options: UseElementDimensionsOptions & { dimension: "height" }
): number;

export function useElementDimensions(
  ref: RefObject<HTMLElement | null | { current?: HTMLElement | null }>,
  options?: UseElementDimensionsOptions & { dimension?: "both" }
): ElementDimensions;

export function useElementDimensions(
  ref: RefObject<HTMLElement | null | { current?: HTMLElement | null }>,
  options: UseElementDimensionsOptions = {}
): number | ElementDimensions {
  const { dimension = "both", enabled = true, deps = [] } = options;

  const [dimensions, setDimensions] = useState<ElementDimensions>({
    width: 0,
    height: 0,
  });

  useIsomorphicLayoutEffect(() => {
    if (!enabled) return;

    const measureDimensions = () => {
      // Handle nested ref objects
      const element =
        ref.current instanceof HTMLElement
          ? ref.current
          : ref.current?.current instanceof HTMLElement
            ? ref.current.current
            : null;

      if (!element) return;

      const newDimensions: ElementDimensions = {
        width: element.clientWidth,
        height: element.clientHeight,
      };

      setDimensions((previousDimensions) => {
        if (
          previousDimensions.width === newDimensions.width &&
          previousDimensions.height === newDimensions.height
        ) {
          return previousDimensions;
        }
        return newDimensions;
      });
    };

    // Measure immediately
    measureDimensions();

    // Get the actual element
    const element =
      ref.current instanceof HTMLElement
        ? ref.current
        : ref.current?.current instanceof HTMLElement
          ? ref.current.current
          : null;

    // Set up ResizeObserver for accurate tracking
    let resizeObserver: ResizeObserver | null = null;
    if (element && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(measureDimensions);
      resizeObserver.observe(element);
    }

    // Listen for window resize as fallback
    window.addEventListener("resize", measureDimensions);

    return () => {
      window.removeEventListener("resize", measureDimensions);
      resizeObserver?.disconnect();
    };
  }, [ref, enabled, ...deps]);

  // Return based on requested dimension
  if (dimension === "width") return dimensions.width;
  if (dimension === "height") return dimensions.height;
  return dimensions;
}

/**
 * Calculate viewport-relative height
 *
 * @param offset - Pixels to subtract from viewport height
 * @param minHeight - Minimum height to return
 * @returns Calculated height
 */
const calculateViewportHeight = (offset: number, minHeight: number): number => {
  if (typeof window === "undefined") return minHeight;
  const windowHeight = window.innerHeight;
  const dynamicHeight = windowHeight - offset;
  return dynamicHeight > minHeight ? dynamicHeight : minHeight;
};

export interface UseViewportRelativeHeightOptions {
  /** Pixels to subtract from viewport height (default: 365) */
  offset?: number;
  /** Minimum height in pixels (default: 200) */
  minHeight?: number;
}

/**
 * Hook for calculating height relative to viewport
 * Useful for containers that should fill available space
 *
 * @example
 * const height = useViewportRelativeHeight({ offset: 365, minHeight: 200 });
 */
export function useViewportRelativeHeight(
  options: UseViewportRelativeHeightOptions = {}
): number {
  const { offset = 365, minHeight = 200 } = options;

  // Initialize with correct height immediately to avoid flash/gap
  const [height, setHeight] = useState<number>(() =>
    calculateViewportHeight(offset, minHeight)
  );

  useEffect(() => {
    const handleResize = () => {
      setHeight(calculateViewportHeight(offset, minHeight));
    };

    // Recalculate on offset/minHeight changes
    handleResize();

    // Listen for window resize
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [offset, minHeight]);

  return height;
}

export default useElementDimensions;
